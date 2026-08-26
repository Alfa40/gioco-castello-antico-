// Classifica globale di Quartiere Ostile 3D — API REST.
//
// Questo servizio Render (ex "crazy-town", il beat 'em up non più
// utilizzato) è stato riconvertito in un semplice backend per la classifica
// globale di Quartiere Ostile 3D: nessun file statico, nessun WebSocket,
// solo due endpoint JSON che leggono/scrivono su Upstash Redis (via la sua
// REST API, così non serve alcuna dipendenza npm aggiuntiva).
//
// Modello dati su Redis:
//   - ZSET "leaderboard": member = player_id, score = zone*10_000_000+money
//     (ordina prima per zona, poi per soldi come spareggio).
//   - HASH "player:<player_id>": nickname, zone, money, updated.
"use strict";

const http = require("http");

const PORT = process.env.PORT || 8080;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const LEADERBOARD_KEY = "leaderboard";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_NICKNAME_LEN = 20;
const MAX_PLAYER_ID_LEN = 64;
const MONEY_SCORE_SPAN = 10000000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(body);
}

async function upstash(command) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error("Upstash non configurato (UPSTASH_REDIS_REST_URL/TOKEN mancanti)");
  }
  const resp = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const data = await resp.json();
  if (data.error) {
    throw new Error(`Upstash: ${data.error}`);
  }
  return data.result;
}

async function upstashPipeline(commands) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error("Upstash non configurato (UPSTASH_REDIS_REST_URL/TOKEN mancanti)");
  }
  const resp = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  const data = await resp.json();
  return data.map((entry) => entry.result);
}

function hashArrayToObject(arr) {
  const obj = {};
  if (!Array.isArray(arr)) return obj;
  for (let i = 0; i < arr.length; i += 2) {
    obj[arr[i]] = arr[i + 1];
  }
  return obj;
}

function sanitizeNickname(raw) {
  if (typeof raw !== "string") return "";
  // Toglie i caratteri di controllo (codice < 32, o 127) un carattere alla
  // volta, poi tronca alla lunghezza massima.
  let cleaned = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code !== 127) cleaned += ch;
  }
  return cleaned.trim().slice(0, MAX_NICKNAME_LEN);
}

function isValidPlayerId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_PLAYER_ID_LEN && /^[a-zA-Z0-9_-]+$/.test(id);
}

async function handleGetLeaderboard(req, res, url) {
  let limit = parseInt(url.searchParams.get("limit"), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  const ids = await upstash(["ZREVRANGE", LEADERBOARD_KEY, "0", String(limit - 1)]);
  if (!Array.isArray(ids) || ids.length === 0) {
    sendJson(res, 200, { entries: [] });
    return;
  }

  const rows = await upstashPipeline(ids.map((id) => ["HGETALL", `player:${id}`]));
  const entries = ids
    .map((id, i) => {
      const row = hashArrayToObject(rows[i]);
      if (!row.nickname) return null;
      return {
        rank: i + 1,
        nickname: row.nickname,
        zone: parseInt(row.zone, 10) || 0,
        money: parseInt(row.money, 10) || 0,
      };
    })
    .filter((e) => e !== null);
  sendJson(res, 200, { entries });
}

async function handleSubmit(req, res, body) {
  const playerId = body.player_id;
  const nickname = sanitizeNickname(body.nickname);
  const zone = parseInt(body.zone, 10);
  const money = parseInt(body.money, 10);

  if (!isValidPlayerId(playerId) || nickname.length === 0 || !Number.isFinite(zone) || !Number.isFinite(money) || zone < 0 || money < 0) {
    sendJson(res, 400, { error: "dati non validi" });
    return;
  }

  const score = zone * MONEY_SCORE_SPAN + Math.min(money, MONEY_SCORE_SPAN - 1);
  await upstashPipeline([
    ["HSET", `player:${playerId}`, "nickname", nickname, "zone", String(zone), "money", String(money), "updated", String(Date.now())],
    ["ZADD", LEADERBOARD_KEY, String(score), playerId],
  ]);
  sendJson(res, 200, { ok: true });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = "";
    req.on("data", (chunk) => {
      chunks += chunk;
      if (chunks.length > 10000) {
        reject(new Error("body troppo grande"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(chunks));
    req.on("error", reject);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() });
    res.end("Quartiere Ostile 3D — API classifica globale");
    return;
  }

  if (req.method === "GET" && url.pathname === "/leaderboard") {
    handleGetLeaderboard(req, res, url).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: "errore interno" });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/leaderboard/submit") {
    readBody(req)
      .then((raw) => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "JSON non valido" });
          return;
        }
        return handleSubmit(req, res, body);
      })
      .catch((err) => {
        console.error(err);
        sendJson(res, 500, { error: "errore interno" });
      });
    return;
  }

  sendJson(res, 404, { error: "non trovato" });
});

server.listen(PORT, () => {
  console.log(`Classifica globale in ascolto sulla porta ${PORT}`);
});
