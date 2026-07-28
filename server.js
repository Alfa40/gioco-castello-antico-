// Crazy Town — multiplayer relay server.
//
// Serves the game's static files AND a WebSocket endpoint (/ws) on the same
// port. The server holds NO game logic: it only groups up to MAX_PLAYERS
// sockets into a room (via a short numeric code) and relays whatever JSON
// messages they send each other, tagging each relayed message with the
// sender's id so recipients can tell players apart. The host client runs
// the actual simulation for every player; every other client only sends
// input and renders snapshots — see script.js's NetworkManager/
// Game.applySnapshot for that side of the deal.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const MAX_PLAYERS = 4;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(ROOT, relative));

  // Guard against path traversal escaping the project root.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server, path: "/ws" });

// code -> array of up to MAX_PLAYERS sockets, index 0 is always the host
const rooms = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function makeRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function makeId() {
  return crypto.randomBytes(4).toString("hex");
}

function leaveRoom(ws) {
  if (!ws.room) return;
  const peers = rooms.get(ws.room);
  if (!peers) return;
  const remaining = peers.filter(p => p !== ws);
  if (remaining.length === 0) {
    rooms.delete(ws.room);
  } else {
    rooms.set(ws.room, remaining);
    for (const p of remaining) send(p, { type: "peer-left", id: ws.id });
  }
  ws.room = null;
}

wss.on("connection", ws => {
  ws.room = null;
  ws.role = null;
  ws.id = makeId();

  ws.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === "create") {
      const code = makeRoomCode();
      rooms.set(code, [ws]);
      ws.room = code;
      ws.role = "host";
      send(ws, { type: "created", code, id: ws.id });
      return;
    }

    if (msg.type === "join") {
      const code = String(msg.code || "").trim();
      const peers = rooms.get(code);
      if (!peers) {
        send(ws, { type: "join-error", reason: "not-found" });
        return;
      }
      if (peers.length >= MAX_PLAYERS) {
        send(ws, { type: "join-error", reason: "full" });
        return;
      }
      peers.push(ws);
      ws.room = code;
      ws.role = "guest";
      // Tell the host (and any other already-connected guests) about the
      // newcomer BEFORE confirming the join to the newcomer itself, so
      // whoever needs to react to "peer-joined" (only the host does, in
      // practice) has already done so by the time the newcomer could
      // possibly send its first message (e.g. "hello").
      for (const p of peers) {
        if (p !== ws) send(p, { type: "peer-joined", id: ws.id });
      }
      // peers[0] is always the host (the socket that called "create"), so
      // the newcomer can tell a future "peer-left" about the host apart
      // from one about some other guest — see Game.onPeerLeft.
      send(ws, { type: "joined", code, id: ws.id, hostId: peers[0].id });
      return;
    }

    // Anything else (state, snapshot, action, hello...) is relayed as-is
    // to every other socket in the room, tagged with the sender's id so
    // recipients (mainly the host, juggling several other players) can
    // tell who it came from.
    if (ws.room) {
      const peers = rooms.get(ws.room) || [];
      msg.from = ws.id;
      for (const p of peers) {
        if (p !== ws) send(p, msg);
      }
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

server.listen(PORT, () => {
  console.log(`Crazy Town server listening on http://localhost:${PORT}`);
});
