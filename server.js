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
//   - ZSET "hustle:lb:<money|jobs|biz|served>": altre classifiche (soldi guadagnati, lavoretti,
//     attività aperte, clienti serviti); member = player_id.
//   - SET "hustle:req:<player_id>": codici di chi gli ha chiesto l'amicizia (in attesa).
//   Proposte dei tester (chiavi "hustle:prop…"): vedi la sezione più sotto.
//   Account senza progressi da più di 30 giorni ("updated" vecchio): nascosti dalle classifiche
//   (i dati restano; tornando a giocare ricompaiono). Da più di 90 giorni: cancellati (tranne chi
//   ha creato l'account con la password).
//   Nomi unici e account con le partite salvate (chiavi "hustle:name…", "hustle:acct…"): hustle-account.js.
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

// Classifiche di Hustle Idle: la fama è la principale, le altre hanno una chiave ciascuna.
const HUSTLE_KINDS = { fame: HUSTLE_KEY, money: "hustle:lb:money", jobs: "hustle:lb:jobs", biz: "hustle:lb:biz", served: "hustle:lb:served" };
const MAX_REQUESTS = 100;

// Statistiche principali della partita (per l'anteprima del profilo vista dagli amici): solo numeri.
function cleanStats(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "{}";
  const out = {};
  for (const [k, v] of Object.entries(raw).slice(0, 30)) {
    const n = Number(v);
    if (/^[a-zA-Z0-9_]{1,24}$/.test(k) && Number.isFinite(n)) out[k] = Math.max(-1e12, Math.min(1e12, Math.round(n * 100) / 100));
  }
  return JSON.stringify(out);
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

// Account inattivi: senza progressi (nessun invio) da più di 30 giorni non compaiono in classifica.
// I dati restano: appena il giocatore torna e il gioco invia di nuovo, ricompare da solo.
const HUSTLE_INACTIVE_MS = 30 * 24 * 60 * 60 * 1000;
const isActive = (row, now) => {
  const t = Number(row.updated);
  return !Number.isFinite(t) || t <= 0 || now - t < HUSTLE_INACTIVE_MS;
};

async function handleGetHustle(res, limit, playerId, kind) {
  const key = HUSTLE_KINDS[kind] || HUSTLE_KEY;
  // se ne leggono di più: gli inattivi si saltano e la classifica resta piena
  const fetchN = Math.min(limit * 3, 300);
  const ids = await upstash(["ZREVRANGE", key, "0", String(fetchN - 1), "WITHSCORES"]);
  const flat = Array.isArray(ids) ? ids : [];
  const list = [];
  const scores = [];
  for (let i = 0; i < flat.length; i += 2) {
    list.push(flat[i]);
    scores.push(Number(flat[i + 1]) || 0);
  }
  const rows = list.length ? await upstashPipeline(list.map((id) => ["HGETALL", `hustle:player:${id}`])) : [];
  // valore della classifica scelta (la fama è salvata ×10)
  const value = (score) => (key === HUSTLE_KEY ? score / 10 : score);
  const toEntry = (row, rank, score) => ({
    rank,
    nickname: row.nickname,
    fame: parseFloat(row.fame) || 0,
    money: parseInt(row.money, 10) || 0,
    value: value(score),
    title: row.title || "",
    logo: publicLogo(parseJson(row.logo, null)),
  });
  const now = Date.now();
  const visible = [];
  // quanti inattivi ci sono prima di ogni posizione (per la posizione del giocatore fuori dai primi)
  let hiddenBefore = 0;
  const hiddenAt = [];
  list.forEach((id, i) => {
    const row = hashArrayToObject(rows[i]);
    hiddenAt.push(hiddenBefore);
    // il giocatore vede sempre se stesso, anche se è fermo da tanto
    if (!row.nickname || (id !== playerId && !isActive(row, now))) {
      hiddenBefore++;
      return;
    }
    visible.push({ id, row, score: scores[i] });
  });
  const entries = visible.slice(0, limit).map((v, i) => ({ ...toEntry(v.row, i + 1, v.score), me: v.id === playerId }));
  // la posizione del giocatore anche se è fuori dai primi
  let me = null;
  if (isValidPlayerId(playerId)) {
    const [pos, row, score] = await upstashPipeline([["ZREVRANK", key, playerId], ["HGETALL", `hustle:player:${playerId}`], ["ZSCORE", key, playerId]]);
    const obj = hashArrayToObject(row);
    if (pos !== null && pos !== undefined && obj.nickname) {
      const p = Number(pos);
      const skipped = p < hiddenAt.length ? hiddenAt[p] : hiddenBefore;
      me = toEntry(obj, p + 1 - skipped, Number(score) || 0);
    }
  }
  const total = Number(await upstash(["ZCARD", key])) || 0;
  sendJson(res, 200, { entries, me, total: list.length >= total ? visible.length : total - hiddenBefore });
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
  // un nome = un giocatore: se è di un altro, il gioco chiede di sceglierne un altro
  if ((await account.nameForSubmit(playerId, nickname)) === "taken") {
    sendJson(res, 409, { error: "nome già usato" });
    return;
  }
  const f = Math.round(fame * 10) / 10;
  const code = friendCode(playerId);
  const stats = cleanStats(body.stats);
  const st = parseJson(stats, {});
  const bizs = cleanBizs(body.bizs);
  const num = (v) => String(Math.max(0, Math.floor(Number(v) || 0)));
  await upstashPipeline([
    ["HSET", `hustle:player:${playerId}`, "nickname", nickname, "fame", String(f), "money", String(money), "title", title,
      "logo", cleanLogo(body.logo), "bizs", bizs, "stats", stats, "code", code, "updated", String(Date.now())],
    ["ZADD", HUSTLE_KEY, String(Math.round(f * 10)), playerId],
    ["ZADD", HUSTLE_KINDS.money, num(money), playerId],
    ["ZADD", HUSTLE_KINDS.jobs, num(st.jobs), playerId],
    ["ZADD", HUSTLE_KINDS.biz, num(parseJson(bizs, []).length), playerId],
    ["ZADD", HUSTLE_KINDS.served, num(st.served), playerId],
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
        stats: parseJson(row.stats, {}),
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

// Richiesta di amicizia: chi aggiunge un codice lo segnala al proprietario, che può ricambiare con un tocco.
async function handleFriendRequest(res, body) {
  const code = String((body && body.code) || "").toUpperCase();
  if (!body || body.game !== "hustle" || !isValidPlayerId(body.player_id) || !isValidCode(code)) {
    sendJson(res, 400, { error: "dati non validi" });
    return;
  }
  const from = friendCode(body.player_id);
  const target = await upstash(["GET", `hustle:code:${code}`]);
  if (!isValidPlayerId(target)) {
    sendJson(res, 404, { error: "codice non trovato" });
    return;
  }
  if (target === body.player_id) {
    sendJson(res, 400, { error: "è il tuo codice" });
    return;
  }
  const n = await upstash(["SCARD", `hustle:req:${target}`]);
  if (Number(n) < MAX_REQUESTS) await upstash(["SADD", `hustle:req:${target}`, from]);
  sendJson(res, 200, { ok: true });
}

// Richieste di amicizia ricevute, con nome, logo e fama di chi le ha mandate.
async function handleFriendRequests(res, url) {
  const playerId = url.searchParams.get("player_id");
  if (url.searchParams.get("game") !== "hustle" || !isValidPlayerId(playerId)) {
    sendJson(res, 400, { error: "dati non validi" });
    return;
  }
  const codes = ((await upstash(["SMEMBERS", `hustle:req:${playerId}`])) || []).filter(isValidCode).slice(0, MAX_REQUESTS);
  const ids = codes.length ? await upstashPipeline(codes.map((c) => ["GET", `hustle:code:${c}`])) : [];
  const rows = ids.length ? await upstashPipeline(ids.map((id) => (isValidPlayerId(id) ? ["HGETALL", `hustle:player:${id}`] : ["GET", "hustle:none"]))) : [];
  const requests = codes
    .map((code, i) => {
      const row = hashArrayToObject(rows[i]);
      if (!row.nickname) return null;
      return { code, nickname: row.nickname, fame: parseFloat(row.fame) || 0, title: row.title || "", logo: parseJson(row.logo, null) };
    })
    .filter((r) => r !== null);
  sendJson(res, 200, { requests });
}

// Risposta a una richiesta (accettata o rifiutata): esce dalla lista. Accettando, il gioco aggiunge l'amico.
async function handleFriendAnswer(res, body) {
  const code = String((body && body.code) || "").toUpperCase();
  if (!body || body.game !== "hustle" || !isValidPlayerId(body.player_id) || !isValidCode(code)) {
    sendJson(res, 400, { error: "dati non validi" });
    return;
  }
  await upstash(["SREM", `hustle:req:${body.player_id}`, code]);
  sendJson(res, 200, { ok: true });
}

async function handleGetLeaderboard(req, res, url) {
  let limit = parseInt(url.searchParams.get("limit"), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);
  if (url.searchParams.get("game") === "hustle") {
    await handleGetHustle(res, limit, url.searchParams.get("player_id"), url.searchParams.get("kind"));
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

function readBody(req, max = 60000) {
  return new Promise((resolve, reject) => {
    let chunks = "";
    req.on("data", (chunk) => {
      chunks += chunk;
      if (chunks.length > max) {
        reject(new Error("body troppo grande"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(chunks));
    req.on("error", reject);
  });
}

// ---------------- Hustle Idle: proposte dei tester ----------------
//
// I tester (link segreto nel gioco) scrivono una proposta di modifica dalle Opzioni: arriva qui e resta
// privata finché lo sviluppatore (partita developer) non la approva. Solo allora un workflow di GitHub
// (chiave "robot") la trasforma in una issue e Claude ci lavora. Nessuna chiave in chiaro: solo le impronte
// SHA-256 (il codice del gioco è pubblico, le chiavi no).
//   - HASH "hustle:prop:<id>": status (nuova|approvata|scartata|importata|rifiutata|accettata|pubblicata), text, why,
//     where, ctx, nickname, player, created, decided, issue, photo ("1" se c'è la foto), mergeError (unione non riuscita).
//   - STRING "hustle:propimg:<id>": foto dello schermo (data URL JPEG).
//   - STRING "hustle:propvid:<id>": video (data URL mp4/webm, già rimpicciolito dal telefono) e
//     "hustle:propframes:<id>": 4 fotogrammi del video in una sola foto (per Claude, che i video non li vede).
//     Campi del hash: video ("mp4"|"webm"|"scaduto"), frames ("1"). Si tengono solo gli ultimi PROP_VIDEO_KEEP
//     (ZSET "hustle:propvids"): sono pesanti e il database è condiviso.
//   - ZSET "hustle:props": tutte le proposte (score = data di invio), le ultime PROP_KEEP.
//   - SET "hustle:props:approved": approvate in attesa di diventare issue.
//   - SET "hustle:props:toclose": rifiutate dopo l'anteprima, la cui issue il robot deve chiudere.
//   - SET "hustle:props:tomerge": accettate dopo l'anteprima, che il robot deve unire al gioco e pubblicare.
//   - STRING "hustle:proprate:<player|all>:<giorno>": quante proposte inviate oggi.
//   - HASH "hustle:propvote:<id>": voti dei tester sull'anteprima (campo = id del telefono, valore = JSON
//     {n: nome, v: "si"|"no", c: commento, t: quando}). Sono un parere: decide sempre lo sviluppatore.
const crypto = require("crypto");
const PROP_TESTER_HASHES = ["29fd6a5f47282398df31aa65c6a6b6fb3ebe6c5182ef93ddea156a7c9af9556a"];
const PROP_DEV_HASH = "c9973361080da099481708145340d318dc2f5bb1b66009b5207ed4b7a6ee41a5";
const PROP_ROBOT_HASH = "deb0fcb441319a779d444716293ac17896df82bde703b06b2feb847bec0e0d3c";
const PROP_MAX_TEXT = 2000;
const PROP_MAX_PHOTO = 400000;
const PROP_MAX_VIDEO = 3500000;
const PROP_MAX_FRAMES = 250000;
const PROP_VIDEO_KEEP = 20;
const PROP_VIDEO_TTL = String(60 * 24 * 60 * 60);
const PROP_PER_DAY = 15;
const PROP_ALL_PER_DAY = 200;
const PROP_KEEP = 300;
const PROP_TTL = String(180 * 24 * 60 * 60);
const PROP_MAX_COMMENT = 500;
const PROP_MAX_VOTES = 60;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const keyIs = (key, hashes) => typeof key === "string" && key.length <= 100 && hashes.includes(sha256(key.trim()));
const isDevKey = (key) => keyIs(key, [PROP_DEV_HASH]);

// testo libero: via i caratteri di controllo (tranne gli a capo), lunghezza massima
function cleanText(raw, max = PROP_MAX_TEXT) {
  if (typeof raw !== "string") return "";
  let out = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0);
    if (c === 10 || (c >= 32 && c !== 127)) out += ch;
  }
  return out.trim().slice(0, max);
}

// contesto raccolto dal gioco (posto, versione, schermo): solo coppie brevi di testo o numeri
function cleanCtx(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "{}";
  const out = {};
  for (const [k, v] of Object.entries(raw).slice(0, 20)) {
    if (!/^[a-zA-Z0-9_]{1,24}$/.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string") out[k] = cleanText(v, 120);
  }
  return JSON.stringify(out);
}

function propOut(id, row) {
  return {
    id: Number(id),
    status: row.status,
    text: row.text || "",
    why: row.why || "",
    where: row.where || "",
    ctx: parseJson(row.ctx, {}),
    nickname: row.nickname || "",
    created: Number(row.created) || 0,
    decided: Number(row.decided) || 0,
    issue: Number(row.issue) || 0,
    photo: row.photo === "1",
    video: row.video || "",
    frames: row.frames === "1",
    mergeError: row.mergeError || "",
    // modifiche chieste dallo sviluppatore dopo aver provato l'anteprima: testo, quando, e se il robot le ha già
    // passate a Claude ("attesa" / "inviata")
    change: row.change || "",
    changeAt: Number(row.changeAt) || 0,
    changeState: row.change ? (row.changeSent === "1" ? "inviata" : "attesa") : "",
  };
}

async function handlePropSend(res, body) {
  if (!keyIs(body.key, PROP_TESTER_HASHES) && !isDevKey(body.key)) return sendJson(res, 403, { error: "chiave tester non valida" });
  const text = cleanText(body.text);
  if (text.length < 3) return sendJson(res, 400, { error: "scrivi cosa vorresti cambiare" });
  const player = isValidPlayerId(body.player_id) ? body.player_id : "anonimo";
  const photo =
    typeof body.photo === "string" && body.photo.length <= PROP_MAX_PHOTO && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(body.photo) ? body.photo : "";
  const vm = typeof body.video === "string" && body.video.length <= PROP_MAX_VIDEO && /^data:video\/(mp4|webm);base64,[A-Za-z0-9+/=]+$/.exec(body.video);
  const video = vm ? body.video : "";
  const frames =
    video && typeof body.frames === "string" && body.frames.length <= PROP_MAX_FRAMES && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(body.frames) ? body.frames : "";
  const dayKey = new Date().toISOString().slice(0, 10);
  const [mine, all] = await upstashPipeline([
    ["INCR", `hustle:proprate:${player}:${dayKey}`],
    ["INCR", `hustle:proprate:all:${dayKey}`],
    ["EXPIRE", `hustle:proprate:${player}:${dayKey}`, "172800"],
    ["EXPIRE", `hustle:proprate:all:${dayKey}`, "172800"],
  ]);
  if (Number(mine) > PROP_PER_DAY || Number(all) > PROP_ALL_PER_DAY) return sendJson(res, 429, { error: "troppe proposte oggi, riprova domani" });
  const id = String(await upstash(["INCR", "hustle:props:seq"]));
  const now = Date.now();
  const cmds = [
    ["HSET", `hustle:prop:${id}`, "status", "nuova", "text", text, "why", cleanText(body.why), "where", cleanText(body.where, 200),
      "ctx", cleanCtx(body.ctx), "nickname", sanitizeNickname(body.nickname) || "Tester", "player", player, "created", String(now), "photo", photo ? "1" : "0",
      "video", vm ? vm[1] : "", "frames", frames ? "1" : "0"],
    ["EXPIRE", `hustle:prop:${id}`, PROP_TTL],
    ["ZADD", "hustle:props", String(now), id],
  ];
  if (photo) cmds.push(["SET", `hustle:propimg:${id}`, photo, "EX", PROP_TTL]);
  if (video) {
    cmds.push(["SET", `hustle:propvid:${id}`, video, "EX", PROP_VIDEO_TTL], ["ZADD", "hustle:propvids", String(now), id]);
    if (frames) cmds.push(["SET", `hustle:propframes:${id}`, frames, "EX", PROP_VIDEO_TTL]);
  }
  await upstashPipeline(cmds);
  // video: solo gli ultimi PROP_VIDEO_KEEP (quelli prima restano proposte, senza video)
  if (video) {
    const oldVid = await upstash(["ZRANGE", "hustle:propvids", "0", String(-PROP_VIDEO_KEEP - 1)]);
    if (Array.isArray(oldVid) && oldVid.length) {
      await upstashPipeline([["ZREM", "hustle:propvids", ...oldVid], ...oldVid.flatMap((o) => [["DEL", `hustle:propvid:${o}`], ["DEL", `hustle:propframes:${o}`], ["HSET", `hustle:prop:${o}`, "video", "scaduto", "frames", "0"]])]);
    }
  }
  // tiene solo le ultime PROP_KEEP (le più vecchie si cancellano)
  const old = await upstash(["ZRANGE", "hustle:props", "0", String(-PROP_KEEP - 1)]);
  if (Array.isArray(old) && old.length) {
    await upstashPipeline([["ZREM", "hustle:props", ...old], ["SREM", "hustle:props:approved", ...old], ["SREM", "hustle:props:toclose", ...old], ["SREM", "hustle:props:tomerge", ...old], ...old.flatMap((o) => [["DEL", `hustle:prop:${o}`], ["DEL", `hustle:propimg:${o}`], ["DEL", `hustle:propvid:${o}`], ["DEL", `hustle:propframes:${o}`], ["DEL", `hustle:propvote:${o}`]])]);
  }
  sendJson(res, 200, { ok: true, id: Number(id) });
}

// sviluppatore: le proposte, dalla più recente
// tutte le proposte tenute, con i voti dei tester sulle anteprime
async function propRows() {
  const ids = (await upstash(["ZREVRANGE", "hustle:props", "0", String(PROP_KEEP - 1)])) || [];
  const rows = ids.length ? await upstashPipeline(ids.flatMap((id) => [["HGETALL", `hustle:prop:${id}`], ["HGETALL", `hustle:propvote:${id}`]])) : [];
  return ids
    .map((id, i) => {
      const votes = Object.entries(hashArrayToObject(rows[i * 2 + 1]))
        .map(([player, raw]) => ({ player, ...parseJson(raw, {}) }))
        .sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0));
      // risposte alle domande di chiarimento di Claude: campo "note:<telefono>", una per telefono (si può cambiare)
      const notes = votes.filter((v) => v.v === "nota" && v.player.startsWith("note:")).map((v) => ({ ...v, player: v.player.slice(5) }));
      return { id, row: hashArrayToObject(rows[i * 2]), votes: votes.filter((v) => v.v === "si" || v.v === "no"), notes };
    })
    .filter((p) => p.row.status);
}
const voteOut = (v, me) => ({ name: v.n || "", vote: v.v, comment: v.c || "", at: Number(v.t) || 0, ...(me !== undefined ? { mine: v.player === me } : {}) });
const noteOut = (v, me) => ({ name: v.n || "", comment: v.c || "", at: Number(v.t) || 0, ...(me !== undefined ? { mine: v.player === me } : {}) });

async function handlePropList(res, body) {
  if (!isDevKey(body.key)) return sendJson(res, 403, { error: "solo lo sviluppatore" });
  // "player": inizio dell'id anonimo del telefono, per contare le proposte di ogni tester anche se cambia nome
  const list = (await propRows()).map(({ id, row, votes, notes }) => ({ ...propOut(id, row), player: String(row.player || "").slice(0, 12), votes: votes.map((v) => voteOut(v)), notes: notes.map((v) => noteOut(v)) }));
  sendJson(res, 200, { proposals: list });
}

// app dei tester: le proposte già lette dallo sviluppatore (non le nuove), senza foto né dettagli del telefono (perché
// e posto ci sono: sono scritti anche nella proposta pubblica su GitHub); al posto dell'id del telefono un'impronta,
// per raggruppare le proposte di ogni tester
async function handlePropBoard(res, body) {
  if (!keyIs(body.key, PROP_TESTER_HASHES) && !isDevKey(body.key)) return sendJson(res, 403, { error: "chiave tester non valida" });
  const me = isValidPlayerId(body.player_id) ? body.player_id : "";
  const list = (await propRows())
    .filter(({ row }) => row.status !== "nuova")
    .map(({ id, row, votes, notes }) => ({
      id: Number(id), status: row.status, text: row.text || "", nickname: row.nickname || "", created: Number(row.created) || 0,
      issue: Number(row.issue) || 0, mergeError: row.mergeError || "", change: row.change || "", changeAt: Number(row.changeAt) || 0,
      changeState: row.change ? (row.changeSent === "1" ? "inviata" : "attesa") : "", why: row.why || "", where: row.where || "", player: sha256("hustle-tester:" + (row.player || "")).slice(0, 12),
      votes: votes.map((v) => voteOut(v, me)),
      notes: notes.map((v) => noteOut(v, me)),
    }));
  sendJson(res, 200, { proposals: list });
}

// voto di un tester su un'anteprima da provare: approvo / boccio, con un commento (si può cambiare)
async function handlePropVote(res, body) {
  if (!keyIs(body.key, PROP_TESTER_HASHES) && !isDevKey(body.key)) return sendJson(res, 403, { error: "chiave tester non valida" });
  if (!isValidPlayerId(body.player_id)) return sendJson(res, 400, { error: "telefono non valido" });
  // "nota": risposta a una domanda di chiarimento di Claude (serve il testo), non è un voto
  if (body.vote !== "si" && body.vote !== "no" && body.vote !== "nota") return sendJson(res, 400, { error: "voto non valido" });
  const comment = cleanText(body.comment, PROP_MAX_COMMENT);
  if (body.vote === "nota" && !comment) return sendJson(res, 400, { error: "scrivi la risposta" });
  const id = String(parseInt(body.id, 10));
  const key = `hustle:propvote:${id}`;
  const field = body.vote === "nota" ? `note:${body.player_id}` : body.player_id;
  const [status, has, count] = await upstashPipeline([["HGET", `hustle:prop:${id}`, "status"], ["HEXISTS", key, field], ["HLEN", key]]);
  if (!status) return sendJson(res, 404, { error: "proposta non trovata" });
  if (status !== "importata") return sendJson(res, 409, { error: body.vote === "nota" ? "questa proposta non aspetta più risposte" : "questa anteprima non si può più votare" });
  if (!Number(has) && Number(count) >= PROP_MAX_VOTES) return sendJson(res, 429, { error: "troppi voti su questa anteprima" });
  const vote = { n: cleanText(body.nickname, 40) || "Tester", v: body.vote, c: comment, t: Date.now() };
  await upstashPipeline([["HSET", key, field, JSON.stringify(vote)], ["EXPIRE", key, PROP_TTL]]);
  // risposta a un chiarimento: il robot la passa subito a Claude
  if (body.vote === "nota") wakeRobot();
  sendJson(res, 200, { ok: true });
}

// sveglia subito il robot di GitHub (proposte.yml) quando lo sviluppatore decide qualcosa, invece di aspettare il
// giro ogni 10 minuti. Serve GH_DISPATCH_TOKEN: token "fine-grained" solo per il repo del gioco con il solo permesso
// Actions (lettura e scrittura). Più decisioni di fila partono insieme dopo qualche secondo.
const GH_DISPATCH_TOKEN = process.env.GH_DISPATCH_TOKEN || "";
const GAME_REPO = "Alfa40/hustle-idle";
let robotTimer = null;
function wakeRobot() {
  if (!GH_DISPATCH_TOKEN || robotTimer) return;
  robotTimer = setTimeout(async () => {
    robotTimer = null;
    try {
      const r = await fetch(`https://api.github.com/repos/${GAME_REPO}/actions/workflows/proposte.yml/dispatches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "hustle-server", "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main" }),
      });
      if (!r.ok) console.error("robot di GitHub non svegliato:", r.status, (await r.text()).slice(0, 200));
    } catch (e) {
      console.error("robot di GitHub non svegliato:", e.message);
    }
  }, 8000);
}

async function handlePropDecide(res, body) {
  if (!isDevKey(body.key)) return sendJson(res, 403, { error: "solo lo sviluppatore" });
  const id = String(parseInt(body.id, 10));
  const action = body.action;
  if (!["approve", "reject", "reopen", "reject_preview", "accept_preview", "request_changes"].includes(action)) return sendJson(res, 400, { error: "azione non valida" });
  const status = await upstash(["HGET", `hustle:prop:${id}`, "status"]);
  if (!status) return sendJson(res, 404, { error: "proposta non trovata" });
  // anteprima provata, da cambiare: il robot di GitHub passa la richiesta a Claude, che aggiorna lo stesso ramo
  if (action === "request_changes") {
    if (status !== "importata") return sendJson(res, 409, { error: "non è un'anteprima da provare" });
    const text = cleanText(body.text, PROP_MAX_TEXT);
    if (text.length < 3) return sendJson(res, 400, { error: "scrivi cosa cambiare" });
    await upstashPipeline([
      ["HSET", `hustle:prop:${id}`, "change", text, "changeAt", String(Date.now()), "changeSent", "0", "mergeError", ""],
      ["SADD", "hustle:props:tochange", id],
    ]);
    wakeRobot();
    return sendJson(res, 200, { ok: true, status });
  }
  // anteprima provata e piaciuta: accettata; il robot di GitHub unisce la modifica al gioco e la pubblica
  if (action === "accept_preview") {
    if (status === "accettata" || status === "pubblicata") return sendJson(res, 200, { ok: true, status });
    if (status !== "importata") return sendJson(res, 409, { error: "non è un'anteprima da provare" });
    await upstashPipeline([
      ["HSET", `hustle:prop:${id}`, "status", "accettata", "decided", String(Date.now()), "mergeError", ""],
      ["SADD", "hustle:props:tomerge", id],
    ]);
    wakeRobot();
    return sendJson(res, 200, { ok: true, status: "accettata" });
  }
  // anteprima provata e non piaciuta: rifiutata; il robot di GitHub chiude la issue
  if (action === "reject_preview") {
    if (status === "importata" || status === "accettata") {
      await upstashPipeline([
        ["HSET", `hustle:prop:${id}`, "status", "rifiutata", "decided", String(Date.now())],
        ["SADD", "hustle:props:toclose", id],
        ["SREM", "hustle:props:tomerge", id],
      ]);
      wakeRobot();
      return sendJson(res, 200, { ok: true, status: "rifiutata" });
    }
    if (status !== "approvata") return sendJson(res, 409, { error: "non è un'anteprima" });
  }
  if (status === "importata") return sendJson(res, 409, { error: "già su GitHub" });
  if (status === "rifiutata") return sendJson(res, 409, { error: "già rifiutata" });
  if (status === "accettata" || status === "pubblicata") return sendJson(res, 409, { error: "già accettata" });
  const next = action === "approve" ? "approvata" : action === "reopen" ? "nuova" : "scartata";
  await upstashPipeline([
    ["HSET", `hustle:prop:${id}`, "status", next, "decided", String(Date.now())],
    action === "approve" ? ["SADD", "hustle:props:approved", id] : ["SREM", "hustle:props:approved", id],
  ]);
  if (action === "approve") wakeRobot();
  sendJson(res, 200, { ok: true, status: next });
}

// robot di GitHub: le approvate da trasformare in issue, e la conferma dopo averla creata
async function handlePropApproved(res, body) {
  if (!keyIs(body.key, [PROP_ROBOT_HASH])) return sendJson(res, 403, { error: "chiave non valida" });
  const ids = ((await upstash(["SMEMBERS", "hustle:props:approved"])) || []).slice(0, 10);
  const rows = ids.length ? await upstashPipeline(ids.map((id) => ["HGETALL", `hustle:prop:${id}`])) : [];
  const list = ids.map((id, i) => propOut(id, hashArrayToObject(rows[i]))).filter((p) => p.status === "approvata");
  sendJson(res, 200, { proposals: list });
}

async function handlePropImported(res, body) {
  if (!keyIs(body.key, [PROP_ROBOT_HASH])) return sendJson(res, 403, { error: "chiave non valida" });
  const id = String(parseInt(body.id, 10));
  const issue = String(parseInt(body.issue, 10) || 0);
  await upstashPipeline([
    ["HSET", `hustle:prop:${id}`, "status", "importata", "issue", issue],
    ["SREM", "hustle:props:approved", id],
  ]);
  sendJson(res, 200, { ok: true });
}

// robot: le issue da chiudere (anteprime rifiutate) e la conferma dopo averle chiuse
async function handlePropToClose(res, body) {
  if (!keyIs(body.key, [PROP_ROBOT_HASH])) return sendJson(res, 403, { error: "chiave non valida" });
  const ids = ((await upstash(["SMEMBERS", "hustle:props:toclose"])) || []).slice(0, 20);
  const issues = ids.length ? await upstashPipeline(ids.map((id) => ["HGET", `hustle:prop:${id}`, "issue"])) : [];
  sendJson(res, 200, { proposals: ids.map((id, i) => ({ id: Number(id), issue: Number(issues[i]) || 0 })) });
}

async function handlePropClosed(res, body) {
  if (!keyIs(body.key, [PROP_ROBOT_HASH])) return sendJson(res, 403, { error: "chiave non valida" });
  await upstash(["SREM", "hustle:props:toclose", String(parseInt(body.id, 10))]);
  sendJson(res, 200, { ok: true });
}

// robot: le anteprime accettate da unire al gioco, e l'esito dell'unione (ok, oppure errore e torna da provare)
async function handlePropToMerge(res, body) {
  if (!keyIs(body.key, [PROP_ROBOT_HASH])) return sendJson(res, 403, { error: "chiave non valida" });
  const ids = ((await upstash(["SMEMBERS", "hustle:props:tomerge"])) || []).slice(0, 10);
  const issues = ids.length ? await upstashPipeline(ids.map((id) => ["HGET", `hustle:prop:${id}`, "issue"])) : [];
  sendJson(res, 200, { proposals: ids.map((id, i) => ({ id: Number(id), issue: Number(issues[i]) || 0 })) });
}

// robot di GitHub: modifiche chieste dallo sviluppatore da passare a Claude, e la conferma dopo averle passate
async function handlePropToChange(res, body) {
  if (!keyIs(body.key, [PROP_ROBOT_HASH])) return sendJson(res, 403, { error: "chiave non valida" });
  const ids = ((await upstash(["SMEMBERS", "hustle:props:tochange"])) || []).slice(0, 10);
  const rows = ids.length ? await upstashPipeline(ids.map((id) => ["HGETALL", `hustle:prop:${id}`])) : [];
  const list = ids.map((id, i) => ({ id: Number(id), row: hashArrayToObject(rows[i]) }))
    .filter((x) => x.row.status === "importata" && x.row.change)
    .map((x) => ({ id: x.id, issue: Number(x.row.issue) || 0, text: x.row.change, at: Number(x.row.changeAt) || 0 }));
  // risposte alle domande di chiarimento arrivate dopo l'ultima volta che il robot le ha passate a Claude
  const answers = (await propRows())
    .filter(({ row, notes }) => row.status === "importata" && notes.length && Math.max(...notes.map((n) => Number(n.t) || 0)) > (Number(row.answerSent) || 0))
    .map(({ id, row, notes }) => ({
      id: Number(id),
      issue: Number(row.issue) || 0,
      text: notes.slice().reverse().map((n) => `${n.n || "Tester"}: ${n.c}`).join("\n\n"),
      at: Math.max(...notes.map((n) => Number(n.t) || 0)),
    }));
  sendJson(res, 200, { proposals: list, answers, wake: !!GH_DISPATCH_TOKEN });
}

// robot di GitHub: risposte al chiarimento passate a Claude (fino a quella delle `at`; le più nuove restano da passare)
async function handlePropAnswered(res, body) {
  if (!keyIs(body.key, [PROP_ROBOT_HASH])) return sendJson(res, 403, { error: "chiave non valida" });
  const id = String(parseInt(body.id, 10));
  const at = Number(body.at) || 0;
  if (at > 0) await upstash(["HSET", `hustle:prop:${id}`, "answerSent", String(at)]);
  sendJson(res, 200, { ok: true });
}

async function handlePropChanged(res, body) {
  if (!keyIs(body.key, [PROP_ROBOT_HASH])) return sendJson(res, 403, { error: "chiave non valida" });
  const id = String(parseInt(body.id, 10));
  // solo se nel frattempo non ne è arrivata un'altra (quella resta da passare)
  const at = await upstash(["HGET", `hustle:prop:${id}`, "changeAt"]);
  if (String(body.at || "") === String(at || "")) await upstashPipeline([["SREM", "hustle:props:tochange", id], ["HSET", `hustle:prop:${id}`, "changeSent", "1"]]);
  sendJson(res, 200, { ok: true });
}

async function handlePropMerged(res, body) {
  if (!keyIs(body.key, [PROP_ROBOT_HASH])) return sendJson(res, 403, { error: "chiave non valida" });
  const id = String(parseInt(body.id, 10));
  const ok = body.ok === true;
  await upstashPipeline([
    ["SREM", "hustle:props:tomerge", id],
    ok ? ["HSET", `hustle:prop:${id}`, "status", "pubblicata", "mergeError", ""]
      : ["HSET", `hustle:prop:${id}`, "status", "importata", "mergeError", cleanText(String(body.error || "unione non riuscita"), 200)],
  ]);
  sendJson(res, 200, { ok: true });
}

// foto, video e fotogrammi della proposta: pubblici solo dopo l'approvazione (servono nella issue), prima solo
// con la chiave developer. I video rispondono anche a "Range" (Safari non li fa partire senza).
const PROP_MEDIA = { photo: ["propimg", "image/jpeg"], frames: ["propframes", "image/jpeg"], mp4: ["propvid", "video/mp4"], webm: ["propvid", "video/webm"] };
async function handlePropPhoto(req, res, url, id, kind = "photo") {
  const [key, type] = PROP_MEDIA[kind];
  const status = await upstash(["HGET", `hustle:prop:${id}`, "status"]);
  const open = ["approvata", "importata", "accettata", "pubblicata"].includes(status);
  if (!status || (!open && !isDevKey(url.searchParams.get("k")))) return sendJson(res, 404, { error: "non trovata" });
  const data = await upstash(["GET", `hustle:${key}:${id}`]);
  const head = `data:${type};base64,`;
  if (typeof data !== "string" || !data.startsWith(head)) return sendJson(res, 404, { error: "non trovata" });
  const buf = Buffer.from(data.slice(head.length), "base64");
  const hdr = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": open ? "public, max-age=86400" : "private, no-store", ...corsHeaders() };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && (range[1] || range[2])) {
    let a = range[1] ? Number(range[1]) : buf.length - Number(range[2]);
    let b = range[1] && range[2] ? Number(range[2]) : buf.length - 1;
    a = Math.max(0, a);
    b = Math.min(buf.length - 1, b);
    if (a > b) {
      res.writeHead(416, { "Content-Range": `bytes */${buf.length}`, ...corsHeaders() });
      return res.end();
    }
    res.writeHead(206, { ...hdr, "Content-Range": `bytes ${a}-${b}/${buf.length}`, "Content-Length": b - a + 1 });
    return res.end(buf.subarray(a, b + 1));
  }
  res.writeHead(200, { ...hdr, "Content-Length": buf.length });
  res.end(buf);
}

const PROP_ROUTES = {
  "/hustle/proposal": handlePropSend,
  "/hustle/proposals/list": handlePropList,
  "/hustle/proposals/board": handlePropBoard,
  "/hustle/proposals/vote": handlePropVote,
  "/hustle/proposals/decide": handlePropDecide,
  "/hustle/proposals/approved": handlePropApproved,
  "/hustle/proposals/imported": handlePropImported,
  "/hustle/proposals/toclose": handlePropToClose,
  "/hustle/proposals/closed": handlePropClosed,
  "/hustle/proposals/tomerge": handlePropToMerge,
  "/hustle/proposals/merged": handlePropMerged,
  "/hustle/proposals/tochange": handlePropToChange,
  "/hustle/proposals/changed": handlePropChanged,
  "/hustle/proposals/answered": handlePropAnswered,
};

// poker multigiocatore di Hustle Idle (hustle-poker.js): stesse regole di invio delle proposte
// e blackjack contro il banco (hustle-blackjack.js); un tavolo alla volta tra i due giochi (`tables`)
const casinoTables = {};
const poker = require("./hustle-poker")({ upstash, upstashPipeline, sendJson, isValidPlayerId, cleanText, tables: casinoTables });
const blackjack = require("./hustle-blackjack")({ upstash, upstashPipeline, sendJson, isValidPlayerId, cleanText, tables: casinoTables });
casinoTables.poker = poker.seatedCode;
casinoTables.bj = blackjack.seatedCode;
Object.assign(PROP_ROUTES, poker.routes, blackjack.routes);
// nomi unici e account (nome + password) con le partite salvate (hustle-account.js)
const account = require("./hustle-account")({ upstash, upstashPipeline, sendJson, isValidPlayerId, sanitizeNickname });
Object.assign(PROP_ROUTES, account.routes);

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

  // proposte dei tester di Hustle Idle (corpo più grande: c'è la foto dello schermo) e poker
  if (req.method === "POST" && PROP_ROUTES[url.pathname]) {
    readBody(req, url.pathname === "/hustle/proposal" ? 4200000 : url.pathname === "/hustle/account/save" ? account.MAX_SAVE_LEN + 2000 : 500000)
      .then((raw) => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "JSON non valido" });
          return;
        }
        return PROP_ROUTES[url.pathname](res, body || {});
      })
      .catch((err) => {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: "errore interno" });
      });
    return;
  }

  const photo = req.method === "GET" && /^\/hustle\/proposal-(photo|frames|video)\/(\d{1,9})\.(jpg|mp4|webm)$/.exec(url.pathname);
  const kind = photo && (photo[1] === "video" ? (photo[3] === "jpg" ? "" : photo[3]) : photo[3] === "jpg" ? photo[1] : "");
  if (photo && kind) {
    handlePropPhoto(req, res, url, photo[2], kind).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: "errore interno" });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/leaderboard/friends") {
    handleFriends(res, url).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: "errore interno" });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/leaderboard/friend-requests") {
    handleFriendRequests(res, url).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: "errore interno" });
    });
    return;
  }

  // richieste di amicizia: invio e risposta (stessa lettura del corpo JSON)
  if (req.method === "POST" && (url.pathname === "/leaderboard/friend-request" || url.pathname === "/leaderboard/friend-answer")) {
    readBody(req)
      .then((raw) => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "JSON non valido" });
          return;
        }
        return url.pathname === "/leaderboard/friend-request" ? handleFriendRequest(res, body) : handleFriendAnswer(res, body);
      })
      .catch((err) => {
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

// Cancella del tutto alcuni giocatori di Hustle Idle: da tutte le classifiche, i loro dati, le richieste
// di amicizia e il codice amico (solo se punta proprio a loro). Solo chiavi "hustle:".
async function deleteHustlePlayers(ids) {
  if (!ids.length) return;
  const keys = Object.values(HUSTLE_KINDS);
  const cmds = [];
  for (const id of ids) {
    for (const k of keys) cmds.push(["ZREM", k, id]);
    cmds.push(["DEL", `hustle:player:${id}`], ["DEL", `hustle:req:${id}`], ["DEL", `hustle:seen:${id}`]);
  }
  await upstashPipeline(cmds);
  const codes = ids.map((id) => friendCode(id));
  const owners = await upstashPipeline(codes.map((c) => ["GET", `hustle:code:${c}`]));
  const dels = codes.filter((c, i) => owners[i] === ids[i]).map((c) => ["DEL", `hustle:code:${c}`]);
  if (dels.length) await upstashPipeline(dels);
}

/** Tutti i giocatori di Hustle Idle in classifica, con i loro dati (nickname, updated…). */
async function allHustlePlayers() {
  const keys = Object.values(HUSTLE_KINDS);
  const lists = await upstashPipeline(keys.map((k) => ["ZRANGE", k, "0", "-1"]));
  const ids = [...new Set(lists.flat().filter((id) => isValidPlayerId(id)))];
  if (!ids.length) return [];
  const rows = await upstashPipeline(ids.map((id) => ["HGETALL", `hustle:player:${id}`]));
  return ids.map((id, i) => ({ id, row: hashArrayToObject(rows[i]) }));
}

// Pulizia una tantum: le partite di prova automatiche (nickname esattamente "Tester") finite in
// classifica. Gira una volta sola (la chiave "hustle:cleanup:testers:v1" lo ricorda).
async function cleanupHustleTesters() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  const first = await upstash(["SET", "hustle:cleanup:testers:v1", String(Date.now()), "NX"]);
  if (first !== "OK") return;
  const testers = (await allHustlePlayers()).filter((p) => p.row.nickname === "Tester").map((p) => p.id);
  await deleteHustlePlayers(testers);
  if (testers.length) console.log(`Hustle Idle: tolti ${testers.length} giocatori di prova ("Tester") dalle classifiche`);
}

// Account fermi da più di 90 giorni (nessun progresso inviato): cancellati. Dai 30 giorni sono già
// nascosti dalle classifiche (vedi isActive). Gira all'avvio e poi una volta al giorno.
const HUSTLE_DELETE_MS = 90 * 24 * 60 * 60 * 1000;
async function cleanupHustleInactive() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  const now = Date.now();
  const stale = (await allHustlePlayers())
    .filter((p) => {
      const t = Number(p.row.updated);
      return Number.isFinite(t) && t > 0 && now - t > HUSTLE_DELETE_MS;
    })
    .map((p) => p.id);
  // chi ha creato l'account (nome e password) non si cancella: le partite salvate restano
  const keep = stale.length ? await upstashPipeline(stale.map((id) => ["EXISTS", `hustle:acct:${id}`])) : [];
  const old = stale.filter((_, i) => !Number(keep[i]));
  await deleteHustlePlayers(old);
  await account.releaseNames(old);
  if (old.length) console.log(`Hustle Idle: cancellati ${old.length} account inattivi da più di 90 giorni`);
}

server.listen(PORT, () => {
  console.log(`Classifica globale in ascolto sulla porta ${PORT}`);
  cleanupHustleTesters().catch((err) => console.error("pulizia Tester:", err));
  const inactive = () => cleanupHustleInactive().catch((err) => console.error("pulizia inattivi:", err));
  inactive();
  setInterval(inactive, 24 * 60 * 60 * 1000);
});
