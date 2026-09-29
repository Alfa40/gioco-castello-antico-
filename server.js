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
//
// Classifica di Hustle Idle (stesso servizio, chiavi separate, ?game=hustle):
//   - ZSET "hustle:leaderboard": member = player_id, score = fama*10 (intero)
//   - HASH "hustle:player:<player_id>": nickname, fame, money, title, logo, bizs, code, updated.
//   - STRING "hustle:code:<CODICE>": player_id (codice amico di 6 caratteri, derivato dall'id).
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
const HUSTLE_KEY = "hustle:leaderboard";
const MAX_TITLE_LEN = 32;
const MAX_FAME = 1e9;
const MAX_FRIENDS = 50;
const MAX_PHOTO_LEN = 40000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// Codice amico: 6 caratteri dai primi 30 bit dell'id (lo stesso calcolo è nel gioco).
function friendCode(playerId) {
  const n = parseInt(playerId.slice(0, 8), 16) >>> 2;
  let code = "";
  for (let i = 5; i >= 0; i--) code += CODE_ALPHABET[(n >>> (i * 5)) & 31];
  return code;
}

function isValidCode(c) {
  return typeof c === "string" && /^[A-HJ-NP-Z2-9]{6}$/.test(c);
}

// Logo: forma, colori, simbolo e iniziali, ricostruito campo per campo (niente dati estranei).
function cleanLogo(raw) {
  if (!raw || typeof raw !== "object") return "";
  const hex = (v) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : "#ff8a3d");
  const shapes = ["cerchio", "scudo", "quadrato", "stella", "esagono"];
  const logo = {
    shape: shapes.includes(raw.shape) ? raw.shape : "cerchio",
    bg: hex(raw.bg),
    fg: hex(raw.fg),
    symbol: sanitizeNickname(String(raw.symbol || "")).slice(0, 8),
    text: sanitizeNickname(String(raw.text || "")).slice(0, 3),
  };
  // foto del giocatore: solo JPEG piccolo (160×160); la vedono solo gli amici
  if (typeof raw.photo === "string" && raw.photo.length <= MAX_PHOTO_LEN && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(raw.photo)) {
    logo.photo = raw.photo;
  }
  return JSON.stringify(logo);
}

// Attività del giocatore (per mostrarle sulla mappa degli amici): lotto, tipo, livello.
function cleanBizs(raw) {
  if (!Array.isArray(raw)) return "[]";
  const ok = (v) => typeof v === "string" && /^[a-z0-9_-]{1,20}$/.test(v);
  const list = raw
    .slice(0, 30)
    .filter((b) => b && ok(b.lot) && ok(b.type))
    .map((b) => ({ lot: b.lot, type: b.type, lvl: Math.max(0, Math.min(9, parseInt(b.lvl, 10) || 0)) }));
  return JSON.stringify(list);
}

// Nella classifica mondiale (pubblica) niente foto: solo il logo disegnato.
function publicLogo(logo) {
  if (!logo || typeof logo !== "object") return null;
  const { photo, ...rest } = logo;
  return rest;
}

function parseJson(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

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

async function handleGetHustle(res, limit, playerId) {
  const ids = await upstash(["ZREVRANGE", HUSTLE_KEY, "0", String(limit - 1)]);
  const list = Array.isArray(ids) ? ids : [];
  const rows = list.length ? await upstashPipeline(list.map((id) => ["HGETALL", `hustle:player:${id}`])) : [];
  const toEntry = (row, rank) => ({
    rank,
    nickname: row.nickname,
    fame: parseFloat(row.fame) || 0,
    money: parseInt(row.money, 10) || 0,
    title: row.title || "",
    logo: publicLogo(parseJson(row.logo, null)),
  });
  const entries = list
    .map((id, i) => {
      const row = hashArrayToObject(rows[i]);
      if (!row.nickname) return null;
      return { ...toEntry(row, i + 1), me: id === playerId };
    })
    .filter((e) => e !== null);
  // la posizione del giocatore anche se è fuori dai primi
  let me = null;
  if (isValidPlayerId(playerId)) {
    const [pos, row] = await upstashPipeline([["ZREVRANK", HUSTLE_KEY, playerId], ["HGETALL", `hustle:player:${playerId}`]]);
    const obj = hashArrayToObject(row);
    if (pos !== null && pos !== undefined && obj.nickname) me = toEntry(obj, Number(pos) + 1);
  }
  const total = await upstash(["ZCARD", HUSTLE_KEY]);
  sendJson(res, 200, { entries, me, total: Number(total) || 0 });
}

async function handleSubmitHustle(res, body) {
  const playerId = body.player_id;
  const nickname = sanitizeNickname(body.nickname);
  const fame = Number(body.fame);
  const money = parseInt(body.money, 10);
  const title = sanitizeNickname(String(body.title || "")).slice(0, MAX_TITLE_LEN);
  if (!isValidPlayerId(playerId) || nickname.length === 0 || !Number.isFinite(fame) || !Number.isFinite(money) || fame < 0 || fame > MAX_FAME || money < 0) {
    sendJson(res, 400, { error: "dati non validi" });
    return;
  }
  const f = Math.round(fame * 10) / 10;
  const code = friendCode(playerId);
  await upstashPipeline([
    ["HSET", `hustle:player:${playerId}`, "nickname", nickname, "fame", String(f), "money", String(money), "title", title,
      "logo", cleanLogo(body.logo), "bizs", cleanBizs(body.bizs), "code", code, "updated", String(Date.now())],
    ["ZADD", HUSTLE_KEY, String(Math.round(f * 10)), playerId],
    ["SET", `hustle:code:${code}`, playerId, "NX"],
  ]);
  sendJson(res, 200, { ok: true, code });
}

// Classifica tra amici: i codici amico passati (più il giocatore stesso), con logo e attività.
async function handleFriends(res, url) {
  const playerId = url.searchParams.get("player_id");
  const codes = [...new Set((url.searchParams.get("codes") || "").split(",").map((c) => c.trim().toUpperCase()).filter(isValidCode))].slice(0, MAX_FRIENDS);
  const ids = codes.length ? await upstashPipeline(codes.map((c) => ["GET", `hustle:code:${c}`])) : [];
  const all = [...new Set([...(isValidPlayerId(playerId) ? [playerId] : []), ...ids.filter(isValidPlayerId)])];
  if (!all.length) {
    sendJson(res, 200, { entries: [], missing: codes });
    return;
  }
  const rows = await upstashPipeline([
    ...all.map((id) => ["HGETALL", `hustle:player:${id}`]),
    ...all.map((id) => ["GET", `hustle:seen:${id}`]),
  ]);
  const entries = all
    .map((id, i) => {
      const row = hashArrayToObject(rows[i]);
      if (!row.nickname) return null;
      return {
        nickname: row.nickname,
        fame: parseFloat(row.fame) || 0,
        money: parseInt(row.money, 10) || 0,
        title: row.title || "",
        logo: parseJson(row.logo, null),
        bizs: parseJson(row.bizs, []),
        code: row.code || friendCode(id),
        // sta giocando adesso (segnale ricevuto negli ultimi 3 minuti)
        online: rows[all.length + i] !== null && rows[all.length + i] !== undefined,
        me: id === playerId,
      };
    })
    .filter((e) => e !== null)
    .sort((a, b) => b.fame - a.fame)
    .map((e, i) => ({ rank: i + 1, ...e }));
  const missing = codes.filter((c, i) => !isValidPlayerId(ids[i]));
  sendJson(res, 200, { entries, missing });
}

// "Sto giocando": il gioco lo manda ogni minuto; la chiave scade da sola dopo 3 minuti.
async function handlePing(res, body) {
  if (!body || body.game !== "hustle" || !isValidPlayerId(body.player_id)) {
    sendJson(res, 400, { error: "dati non validi" });
    return;
  }
  await upstash(["SET", `hustle:seen:${body.player_id}`, "1", "EX", "180"]);
  sendJson(res, 200, { ok: true });
}

async function handleGetLeaderboard(req, res, url) {
  let limit = parseInt(url.searchParams.get("limit"), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);
  if (url.searchParams.get("game") === "hustle") {
    await handleGetHustle(res, limit, url.searchParams.get("player_id"));
    return;
  }

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
      if (chunks.length > 60000) {
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
    res.end("Quartiere Ostile 3D + Hustle Idle — API classifica globale");
    return;
  }

  if (req.method === "GET" && url.pathname === "/leaderboard/friends") {
    handleFriends(res, url).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: "errore interno" });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/leaderboard") {
    handleGetLeaderboard(req, res, url).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: "errore interno" });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/leaderboard/ping") {
    readBody(req)
      .then((raw) => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "JSON non valido" });
          return;
        }
        return handlePing(res, body);
      })
      .catch((err) => {
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
        if (body && body.game === "hustle") return handleSubmitHustle(res, body);
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
