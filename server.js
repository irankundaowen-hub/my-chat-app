// This is the "backend". It now does three jobs:
// 1. checks that each person is logged in
// 2. saves every message in the database
// 3. sends new messages to everyone who is online

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

// These secret values are NOT written in the code.
// You will paste them into Render (Environment settings).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
  console.error(
    "Missing settings. Add SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY in Render > Environment."
  );
  process.exit(1);
}

// The server talks to the database with the secret "service" key
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the chat page from the "public" folder
app.use(express.static("public"));

// The web page asks for these two PUBLIC values so it can show the login form.
// (The secret service key is never sent to the browser.)
app.get("/config", (req, res) => {
  res.json({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
});

// Every connection must prove who it is BEFORE it can chat
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error("Not logged in"));

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) return next(new Error("Not logged in"));

    const user = data.user;
    const name =
      (user.user_metadata && user.user_metadata.username) ||
      String(user.email || "user").split("@")[0];

    socket.data.userId = user.id;
    socket.data.username = String(name).slice(0, 20);
    next();
  } catch (e) {
    next(new Error("Not logged in"));
  }
});

// Runs every time a logged-in person opens the chat
io.on("connection", async (socket) => {
  // Send the last 50 saved messages to the person who just joined
  const { data, error } = await supabase
    .from("messages")
    .select("user_id, username, text, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("Could not load history:", error.message);
  } else {
    const history = data.reverse().map((m) => ({
      uid: m.user_id,
      user: m.username,
      text: m.text,
      time: m.created_at,
    }));
    socket.emit("history", history);
  }

  // When this person sends a message...
  socket.on("chat message", async (msg) => {
    const text = String((msg && msg.text) || "").slice(0, 500);
    if (!text.trim()) return; // ignore empty messages

    // The name comes from the login, so nobody can pretend to be someone else
    const row = {
      user_id: socket.data.userId,
      username: socket.data.username,
      text,
    };

    // ...save it in the database...
    const { data: saved, error: saveError } = await supabase
      .from("messages")
      .insert(row)
      .select("created_at")
      .single();

    if (saveError) {
      console.error("Could not save message:", saveError.message);
      return;
    }

    // ...and send it to EVERYONE connected
    io.emit("chat message", {
      uid: row.user_id,
      user: row.username,
      text: row.text,
      time: saved.created_at,
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat app running on port ${PORT}`);
});
