// This is the "backend": it receives messages and sends them to everyone.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the files in the "public" folder (our chat page)
app.use(express.static("public"));

// Keep the last 50 messages so new people see recent history
const history = [];

// Runs every time someone opens the chat page
io.on("connection", (socket) => {
  // Send recent history to the person who just joined
  socket.emit("history", history);

  // When this person sends a message...
  socket.on("chat message", (msg) => {
    const message = {
      user: String(msg.user || "Anonymous").slice(0, 20),
      text: String(msg.text || "").slice(0, 500),
      time: new Date().toISOString(),
    };
    if (!message.text.trim()) return; // ignore empty messages

    history.push(message);
    if (history.length > 50) history.shift();

    // ...send it to EVERYONE connected
    io.emit("chat message", message);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat app running at http://localhost:${PORT}`);
});
