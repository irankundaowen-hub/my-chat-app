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

// ---------- Profiles and followers ----------
app.use(express.json());

// Checks the login token on every /api request
async function requireUser(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not logged in" });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return res.status(401).json({ error: "Not logged in" });
  req.user = data.user;
  next();
}

// Stops one error from freezing a request
const safe = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  });

// Gets your profile, or creates it the first time you open it
async function getOrCreateProfile(user) {
  const { data: existing } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (existing) return existing;

  const raw = (user.user_metadata && user.user_metadata.username) || String(user.email || "user").split("@")[0];
  const base = String(raw).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 16) || "user";

  for (let i = 0; i < 6; i++) {
    const name = i === 0 ? base : base + Math.floor(100 + Math.random() * 900);
    const { data, error } = await supabase
      .from("profiles")
      .insert({ id: user.id, username: name })
      .select()
      .single();
    if (!error) return data;
    if (error.code !== "23505") {
      console.error("Profile error:", error.message);
      return null;
    }
    const { data: again } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (again) return again;
  }
  return null;
}

// Cleans a phone number into one standard form like +250788123456
function cleanPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return "+" + digits;
}

// Turns a list of user ids into usernames
async function namesFor(ids) {
  const map = {};
  if (!ids.length) return map;
  const { data } = await supabase.from("profiles").select("id, username").in("id", ids);
  (data || []).forEach((p) => (map[p.id] = p.username));
  return map;
}

// My profile, followers, following, and follow requests
app.get("/api/me", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });

  const { data: inRows } = await supabase.from("follows").select("follower_id, status").eq("following_id", me.id);
  const { data: outRows } = await supabase.from("follows").select("following_id, status").eq("follower_id", me.id);
  const ins = inRows || [];
  const outs = outRows || [];
  const names = await namesFor([...ins.map((r) => r.follower_id), ...outs.map((r) => r.following_id)]);

  res.json({
    username: me.username,
    is_private: me.is_private,
    phone_hint: me.phone ? "ends in " + me.phone.slice(-3) : "",
    followers: ins.filter((r) => r.status === "accepted").map((r) => names[r.follower_id] || "unknown"),
    following: outs.filter((r) => r.status === "accepted").map((r) => names[r.following_id] || "unknown"),
    requests: ins
      .filter((r) => r.status === "pending")
      .map((r) => ({ id: r.follower_id, username: names[r.follower_id] || "unknown" })),
  });
}));

// Switch between public and private (easy, any time)
app.post("/api/me/privacy", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const isPrivate = !!req.body.is_private;
  await supabase.from("profiles").update({ is_private: isPrivate }).eq("id", me.id);
  // Going public: everyone waiting is accepted automatically
  if (!isPrivate) {
    await supabase.from("follows").update({ status: "accepted" }).eq("following_id", me.id).eq("status", "pending");
  }
  res.json({ ok: true });
}));

// Save (or remove) my phone number so friends can find me
app.post("/api/me/phone", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });

  const raw = String(req.body.phone || "").trim();
  if (!raw) {
    await supabase.from("profiles").update({ phone: null }).eq("id", me.id);
    return res.json({ message: "Phone number removed." });
  }
  const phone = cleanPhone(raw);
  if (!phone) return res.json({ message: "Use this format: +250788123456 (with country code)." });

  const { error } = await supabase.from("profiles").update({ phone }).eq("id", me.id);
  if (error) return res.json({ message: "Could not save that number." });
  res.json({ message: "Saved. Friends can now find you by this number." });
}));

// Follow someone by username, or by phone number (starts with +)
app.post("/api/follow", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });

  const typed = String(req.body.username || "").trim();
  if (!typed) return res.json({ message: "Type a username or phone number first." });

  let query = supabase.from("profiles").select("id, username, is_private");
  if (typed.startsWith("+")) {
    const phone = cleanPhone(typed);
    if (!phone) return res.json({ message: "That phone number doesn't look right." });
    query = query.eq("phone", phone);
  } else {
    query = query.eq("username", typed.toLowerCase().replace(/^@/, ""));
  }
  const { data: t } = await query.maybeSingle();
  if (!t) return res.json({ message: "No one found with that username or number." });
  if (t.id === me.id) return res.json({ message: "That's you!" });

  const { data: already } = await supabase
    .from("follows").select("status").eq("follower_id", me.id).eq("following_id", t.id).maybeSingle();
  if (already) {
    return res.json({ message: already.status === "pending" ? "Request already sent." : "You already follow them." });
  }

  const status = t.is_private ? "pending" : "accepted";
  await supabase.from("follows").insert({ follower_id: me.id, following_id: t.id, status });
  res.json({ message: status === "pending" ? "Request sent to @" + t.username : "You now follow @" + t.username });
}));

// Stop following someone
app.post("/api/unfollow", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const target = String(req.body.username || "").trim().toLowerCase();
  const { data: t } = await supabase.from("profiles").select("id").eq("username", target).maybeSingle();
  if (t) await supabase.from("follows").delete().eq("follower_id", me.id).eq("following_id", t.id);
  res.json({ ok: true });
}));

// Accept or decline a follow request
app.post("/api/requests/respond", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const who = String(req.body.follower_id || "");
  if (req.body.accept) {
    await supabase.from("follows").update({ status: "accepted" })
      .eq("follower_id", who).eq("following_id", me.id).eq("status", "pending");
  } else {
    await supabase.from("follows").delete()
      .eq("follower_id", who).eq("following_id", me.id).eq("status", "pending");
  }
  res.json({ ok: true });
}));

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
