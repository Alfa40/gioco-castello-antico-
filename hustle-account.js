// Hustle Idle: nomi unici e account (nome + password) per salvare le partite sul server.
//
// Chiavi su Redis (solo "hustle:", mai quelle degli altri giochi):
//   - STRING "hustle:name:<nome normalizzato>": player_id di chi ha quel nome (un nome = un giocatore).
//   - STRING "hustle:nameof:<player_id>": il nome normalizzato del giocatore (per liberarlo se lo cambia).
//   - HASH   "hustle:acct:<player_id>": name, salt, hash (scrypt della password), created, savedAt.
//   - STRING "hustle:save:<player_id>": le partite del giocatore (testo compresso dal gioco).
//   - STRING "hustle:sess:<token>": player_id (accesso fatto con nome e password; scade dopo 180 giorni).
//   - STRING "hustle:loginfail:<nome normalizzato>": tentativi sbagliati (dopo 10 si aspetta 15 minuti).
// Il nome si normalizza (minuscole, spazi unici): "Mario Rossi" e "mario  rossi" sono lo stesso nome.
"use strict";

const crypto = require("crypto");

const SESSION_TTL = 180 * 24 * 60 * 60;
const MAX_SAVE_LEN = 1400000;
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 100;
const MAX_FAILS = 10;

module.exports = function hustleAccount({ upstash, upstashPipeline, sendJson, isValidPlayerId, sanitizeNickname }) {
  const nameKey = (n) => sanitizeNickname(String(n || "")).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
  const newToken = () => crypto.randomBytes(24).toString("hex");
  const isToken = (t) => typeof t === "string" && /^[a-f0-9]{48}$/.test(t);
  const okPassword = (p) => typeof p === "string" && p.length >= MIN_PASSWORD && p.length <= MAX_PASSWORD;

  async function session(token) {
    if (!isToken(token)) return null;
    const pid = await upstash(["GET", `hustle:sess:${token}`]);
    return isValidPlayerId(pid) ? pid : null;
  }

  async function startSession(pid) {
    const token = newToken();
    await upstash(["SET", `hustle:sess:${token}`, pid, "EX", String(SESSION_TTL)]);
    return token;
  }

  /**
   * Prende un nome per un giocatore (se è libero o è già suo) e libera quello vecchio.
   * Ritorna "ok", "taken" o "bad".
   */
  async function claim(pid, name) {
    const key = nameKey(name);
    if (!isValidPlayerId(pid) || !key) return "bad";
    const owner = await upstash(["GET", `hustle:name:${key}`]);
    if (owner && owner !== pid) return "taken";
    if (!owner) {
      const r = await upstash(["SET", `hustle:name:${key}`, pid, "NX"]);
      if (r !== "OK") return "taken";
    }
    const old = await upstash(["GET", `hustle:nameof:${pid}`]);
    const cmds = [["SET", `hustle:nameof:${pid}`, key]];
    if (old && old !== key) {
      const oldOwner = await upstash(["GET", `hustle:name:${old}`]);
      if (oldOwner === pid) cmds.push(["DEL", `hustle:name:${old}`]);
    }
    // l'account (se c'è) prende il nome nuovo così com'è scritto
    if (await upstash(["EXISTS", `hustle:acct:${pid}`])) cmds.push(["HSET", `hustle:acct:${pid}`, "name", sanitizeNickname(name)]);
    await upstashPipeline(cmds);
    return "ok";
  }

  // il nome è libero? (prima di sceglierlo)
  async function handleNameCheck(res, body) {
    const key = nameKey(body.name);
    if (!key) return sendJson(res, 400, { error: "nome non valido" });
    const owner = await upstash(["GET", `hustle:name:${key}`]);
    sendJson(res, 200, { free: !owner || owner === body.player_id });
  }

  // sceglie (o cambia) il nome del giocatore
  async function handleNameClaim(res, body) {
    const r = await claim(body.player_id, body.name);
    if (r === "bad") return sendJson(res, 400, { error: "dati non validi" });
    if (r === "taken") return sendJson(res, 409, { error: "nome già usato" });
    sendJson(res, 200, { ok: true });
  }

  // crea l'account col nome già scelto e una password
  async function handleRegister(res, body) {
    const pid = body.player_id;
    if (!isValidPlayerId(pid) || !okPassword(body.password)) return sendJson(res, 400, { error: "dati non validi" });
    const r = await claim(pid, body.name);
    if (r === "taken") return sendJson(res, 409, { error: "nome già usato" });
    if (r === "bad") return sendJson(res, 400, { error: "nome non valido" });
    if (await upstash(["EXISTS", `hustle:acct:${pid}`])) return sendJson(res, 409, { error: "account già creato" });
    const salt = crypto.randomBytes(16).toString("hex");
    await upstash(["HSET", `hustle:acct:${pid}`, "name", sanitizeNickname(body.name), "salt", salt, "hash", hashPw(body.password, salt), "created", String(Date.now())]);
    sendJson(res, 200, { ok: true, token: await startSession(pid) });
  }

  // entra con nome e password: ridà l'identità (player_id) e le partite salvate
  async function handleLogin(res, body) {
    const key = nameKey(body.name);
    if (!key || typeof body.password !== "string") return sendJson(res, 400, { error: "dati non validi" });
    const failKey = `hustle:loginfail:${key}`;
    const fails = Number(await upstash(["GET", failKey])) || 0;
    if (fails >= MAX_FAILS) return sendJson(res, 429, { error: "troppi tentativi: riprova tra 15 minuti" });
    const pid = await upstash(["GET", `hustle:name:${key}`]);
    const row = isValidPlayerId(pid) ? await upstash(["HGETALL", `hustle:acct:${pid}`]) : null;
    const acct = {};
    if (Array.isArray(row)) for (let i = 0; i < row.length; i += 2) acct[row[i]] = row[i + 1];
    const good = acct.hash && crypto.timingSafeEqual(Buffer.from(hashPw(body.password.slice(0, MAX_PASSWORD), acct.salt), "hex"), Buffer.from(acct.hash, "hex"));
    if (!good) {
      await upstashPipeline([["INCR", failKey], ["EXPIRE", failKey, "900"]]);
      return sendJson(res, 401, { error: "nome o password sbagliati" });
    }
    await upstash(["DEL", failKey]);
    const save = await upstash(["GET", `hustle:save:${pid}`]);
    sendJson(res, 200, { ok: true, token: await startSession(pid), player_id: pid, name: acct.name, save: save || null, savedAt: Number(acct.savedAt) || 0 });
  }

  // salva le partite (dal gioco, ogni tanto e quando si chiude)
  async function handleSave(res, body) {
    const pid = await session(body.token);
    if (!pid) return sendJson(res, 401, { error: "accesso scaduto" });
    if (typeof body.data !== "string" || !body.data.length || body.data.length > MAX_SAVE_LEN) return sendJson(res, 400, { error: "salvataggio non valido" });
    const at = Date.now();
    await upstashPipeline([["SET", `hustle:save:${pid}`, body.data], ["HSET", `hustle:acct:${pid}`, "savedAt", String(at)]]);
    sendJson(res, 200, { ok: true, savedAt: at });
  }

  // com'è l'account adesso (nome, ultimo salvataggio)
  async function handleStatus(res, body) {
    const pid = await session(body.token);
    if (!pid) return sendJson(res, 401, { error: "accesso scaduto" });
    const [name, savedAt] = await upstashPipeline([["HGET", `hustle:acct:${pid}`, "name"], ["HGET", `hustle:acct:${pid}`, "savedAt"]]);
    sendJson(res, 200, { ok: true, name, savedAt: Number(savedAt) || 0 });
  }

  // cambia la password (serve quella vecchia)
  async function handlePassword(res, body) {
    const pid = await session(body.token);
    if (!pid) return sendJson(res, 401, { error: "accesso scaduto" });
    if (!okPassword(body.password)) return sendJson(res, 400, { error: "password troppo corta" });
    const [salt, hash] = await upstashPipeline([["HGET", `hustle:acct:${pid}`, "salt"], ["HGET", `hustle:acct:${pid}`, "hash"]]);
    if (!salt || typeof body.old !== "string" || hashPw(body.old.slice(0, MAX_PASSWORD), salt) !== hash) return sendJson(res, 401, { error: "password attuale sbagliata" });
    const ns = crypto.randomBytes(16).toString("hex");
    await upstash(["HSET", `hustle:acct:${pid}`, "salt", ns, "hash", hashPw(body.password, ns)]);
    sendJson(res, 200, { ok: true });
  }

  async function handleLogout(res, body) {
    if (isToken(body.token)) await upstash(["DEL", `hustle:sess:${body.token}`]);
    sendJson(res, 200, { ok: true });
  }

  /** Un giocatore che manda il punteggio prende il suo nome se è libero; se è di un altro, "taken". */
  async function nameForSubmit(pid, name) {
    return claim(pid, name);
  }

  /** Ha un account? (gli account con password non si cancellano per inattività) */
  async function hasAccount(pid) {
    return !!(await upstash(["EXISTS", `hustle:acct:${pid}`]));
  }

  /** Libera i nomi dei giocatori cancellati (senza account). */
  async function releaseNames(ids) {
    if (!ids.length) return;
    const keys = await upstashPipeline(ids.map((id) => ["GET", `hustle:nameof:${id}`]));
    const owners = await upstashPipeline(keys.map((k) => (k ? ["GET", `hustle:name:${k}`] : ["GET", "hustle:none"])));
    const cmds = [];
    ids.forEach((id, i) => {
      if (keys[i] && owners[i] === id) cmds.push(["DEL", `hustle:name:${keys[i]}`]);
      cmds.push(["DEL", `hustle:nameof:${id}`]);
    });
    await upstashPipeline(cmds);
  }

  return {
    routes: {
      "/hustle/name/check": handleNameCheck,
      "/hustle/name/claim": handleNameClaim,
      "/hustle/account/register": handleRegister,
      "/hustle/account/login": handleLogin,
      "/hustle/account/save": handleSave,
      "/hustle/account/status": handleStatus,
      "/hustle/account/password": handlePassword,
      "/hustle/account/logout": handleLogout,
    },
    nameForSubmit,
    hasAccount,
    releaseNames,
    MAX_SAVE_LEN,
  };
};
