// Crazy Town — multiplayer server.
//
// Serves the game's static files AND a WebSocket endpoint (/ws) on the same
// port. Every connected client (the room creator included — there is no
// more "host browser" running the game for everyone) is a thin client: it
// only ever sends its own input ("state"/"action" messages) and renders
// whatever "snapshot" the server broadcasts. This server is the sole
// simulation authority — see simulation.js, shared verbatim between here
// (via require) and the browser (via a classic <script> tag), so both run
// the exact same game logic. No player's own device ever simulates for
// anyone but themselves in single-player/offline mode (see script.js).
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const { Simulation, CONFIG } = require("./simulation.js");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const MAX_PLAYERS = 4;
const TICK_MS = 1000 / CONFIG.tickRate;

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

// code -> { sockets: ws[] (index 0 is always the creator), sim: Simulation|null, tickTimer, started: bool }
const rooms = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptWs = null) {
  for (const p of room.sockets) {
    if (p !== exceptWs) send(p, obj);
  }
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

// Starts (or restarts, on "Inizia"/"Continua" after a previous run ended)
// the room's authoritative simulation and its fixed-rate tick loop. Only
// the creator (sockets[0]) may trigger this — see the "startRun" handler.
function startRoomRun(room) {
  if (room.tickTimer) clearInterval(room.tickTimer);
  room.sim = new Simulation();
  room.sim.primaryId = room.sockets[0].id;
  // Every OTHER already-connected socket becomes a remote participant —
  // covers both "starting fresh with everyone already in the room" and
  // "restarting after a game over while people are still connected".
  for (const ws of room.sockets.slice(1)) {
    room.sim.addRemotePlayer(ws.id, !!ws.isTouchDevice);
  }
  room.sim.startRun();
  room.started = true;
  room.tickTimer = setInterval(() => tickRoom(room), TICK_MS);
}

function tickRoom(room) {
  if (!room.sim) return;
  const now = Date.now();
  const dt = Math.min(TICK_MS * 2, now - (room.lastTick || now)) / 1000;
  room.lastTick = now;
  room.sim.tick(dt);
  const gameState = room.sim.gameOver ? "gameover" : "playing";
  broadcast(room, { type: "snapshot", state: room.sim.toSnapshot(gameState) });
  if (room.sim.gameOver) {
    // The run is over — stop ticking (nothing left to simulate) until the
    // creator starts a new one. Sockets stay in the room so "Nuova partita"
    // doesn't require everyone to reconnect.
    clearInterval(room.tickTimer);
    room.tickTimer = null;
  }
}

function leaveRoom(ws) {
  if (!ws.room) return;
  const room = rooms.get(ws.room);
  if (!room) return;
  // Nobody's own device was ever doing the simulation work, so a
  // disconnect — creator or not — never has to pause or hand off anything
  // for the players who stay: if the departing player happened to be the
  // one mapped to sim.player, someone else who's still here just takes
  // over that slot (see promoteRemoteToPrimary) so there's no ghost player
  // left behind; everyone else's own state is untouched either way.
  const wasPrimary = room.sim && room.sim.primaryId === ws.id;
  room.sockets = room.sockets.filter(p => p !== ws);
  if (room.sim) {
    if (wasPrimary) {
      const next = room.sockets[0];
      if (next) room.sim.promoteRemoteToPrimary(next.id);
    } else {
      room.sim.removeRemotePlayer(ws.id);
    }
  }
  if (room.sockets.length === 0) {
    if (room.tickTimer) clearInterval(room.tickTimer);
    rooms.delete(ws.room);
  } else {
    broadcast(room, { type: "peer-left", id: ws.id });
  }
  ws.room = null;
}

wss.on("connection", ws => {
  ws.room = null;
  ws.id = makeId();
  ws.isTouchDevice = false;

  ws.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === "create") {
      const code = makeRoomCode();
      rooms.set(code, { sockets: [ws], sim: null, tickTimer: null, started: false, lastTick: 0 });
      ws.room = code;
      send(ws, { type: "created", code, id: ws.id });
      return;
    }

    if (msg.type === "join") {
      const code = String(msg.code || "").trim();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: "join-error", reason: "not-found" });
        return;
      }
      if (room.sockets.length >= MAX_PLAYERS) {
        send(ws, { type: "join-error", reason: "full" });
        return;
      }
      room.sockets.push(ws);
      ws.room = code;
      // Tell everyone already here about the newcomer BEFORE confirming the
      // join to the newcomer itself (message-arrival order across sockets
      // is otherwise not guaranteed).
      broadcast(room, { type: "peer-joined", id: ws.id }, ws);
      send(ws, { type: "joined", code, id: ws.id, hostId: room.sockets[0].id });
      // Joining mid-run: add them to the live simulation right away so the
      // very next tick already includes them, instead of waiting on their
      // first "state" message.
      if (room.sim) room.sim.addRemotePlayer(ws.id, false);
      return;
    }

    const room = ws.room && rooms.get(ws.room);
    if (!room) return;

    if (msg.type === "startRun") {
      // Only the creator can (re)start a run — mirrors the client UI, where
      // only the creator's tab shows an enabled "Inizia"/"Continua" button.
      if (room.sockets[0] !== ws) return;
      startRoomRun(room);
      return;
    }

    if (msg.type === "state") {
      ws.isTouchDevice = !!msg.isTouchDevice;
      if (room.sim) room.sim.applyRemoteState(Object.assign({}, msg, { from: ws.id }));
      return;
    }

    if (msg.type === "action") {
      if (room.sim) room.sim.applyRemoteAction(Object.assign({}, msg, { from: ws.id }));
      return;
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

server.listen(PORT, () => {
  console.log(`Crazy Town server listening on http://localhost:${PORT}`);
});
