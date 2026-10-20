// ---------------- Hustle Idle: blackjack multigiocatore ----------------
//
// Blackjack contro il banco, da 1 a 7 giocatori, con i soldi del gioco. Il banco è il server: sabot di 6 mazzi
// (rimescolato quando ne resta un quarto), il mazziere si ferma su 17 anche morbido, blackjack pagato 3 a 2, il
// mazziere controlla subito se ha blackjack (con asso o figura scoperti), raddoppio su due carte qualsiasi (anche dopo
// aver diviso), divisione fino a 4 mani (assi divisi: una carta sola ciascuno), niente assicurazione.
// Gli amici siedono allo stesso tavolo ma ognuno gioca contro il banco: i soldi non passano tra giocatori.
//
// Come il poker: chi entra compra le fiches (le toglie dal suo conto nel gioco); chi esce, o viene tolto perché non
// risponde più, riceve le fiches rimaste come "vincita da ritirare" nella stessa lista del poker
// ("hustle:poker:cash:<player_id>", ritirata da /hustle/poker/claim). Chi esce a metà mano perde quello che ha puntato.
//
// Chiavi (tutte "hustle:bj:…", mai quelle di Magic Trip):
//   - STRING "hustle:bj:room:<CODICE>": il tavolo in JSON (scade dopo ROOM_TTL senza movimenti).
//   - STRING "hustle:bj:at:<player_id>": il codice del tavolo in cui siede.
// Un tavolo alla volta tra poker e blackjack (`tables`, collegato in server.js).
const crypto = require("crypto");
const { STAKES, STAKE_FAME } = require("./hustle-poker");

const MAX_SEATS = 7;
// puntata minima del tavolo = grande buio del poker allo stesso livello; massima 50 volte tanto
const MAX_BET_X = 50;
// fiches da portare: da 10 a 200 puntate minime
const MIN_BUY_X = 10;
const MAX_BUY_X = 200;
const DECKS = 6;
const TURN_MS = Number(process.env.BJ_TURN_MS) || 20000;
const GONE_MS = Number(process.env.BJ_GONE_MS) || 45000;
// dalla prima puntata, quanto aspettano gli altri per puntare
const BET_MS = Number(process.env.BJ_BET_MS) || 15000;
const NEXT_ROUND_MS = 5000;
// mani di fila senza puntare (con altri al tavolo) prima di non essere più aspettati
const SKIPS_TO_SITOUT = 2;
const WAIT_MUL = process.env.POKER_FAST ? 0.01 : 1;
// il mazziere dà le carte una alla volta (anche sul telefono): tempo per ogni carta, che si aggiunge al turno
const DEAL_MS = 450 * WAIT_MUL;
const ROOM_TTL = String(6 * 60 * 60);
const CASH_TTL = String(90 * 24 * 60 * 60);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RANKS = "23456789TJQKA";
const SUITS = "shdc";

module.exports = function blackjackRoutes({ upstash, upstashPipeline, sendJson, isValidPlayerId, cleanText, tables }) {
  const rooms = new Map();
  const queues = new Map();

  function serial(key, fn) {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(key, next);
    next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    }).catch(() => {});
    return next;
  }

  async function loadRoom(code) {
    if (rooms.has(code)) return rooms.get(code);
    const raw = await upstash(["GET", `hustle:bj:room:${code}`]);
    if (!raw) return null;
    try {
      const room = JSON.parse(raw);
      rooms.set(code, room);
      return room;
    } catch {
      return null;
    }
  }
  async function saveRoom(room) {
    if (room.closed) {
      rooms.delete(room.code);
      await upstash(["DEL", `hustle:bj:room:${room.code}`]);
      return;
    }
    await upstash(["SET", `hustle:bj:room:${room.code}`, JSON.stringify(room), "EX", ROOM_TTL]);
  }

  const players = (room) => room.seats.filter(Boolean);
  const bump = (room, text) => {
    room.v++;
    if (text) {
      room.log.push({ t: Date.now(), text });
      if (room.log.length > 12) room.log.shift();
    }
  };
  const fmt = (n) => "€" + Math.round(n).toLocaleString("it-IT");
  /** carte date (o girate) ora: il telefono le mostra una alla volta; turni e mano dopo partono quando ha finito */
  const dealt = (room, now, cards) => {
    room.anim = Math.max(room.anim || 0, now) + cards * DEAL_MS;
  };
  const after = (room, now) => Math.max(now, room.anim || 0);

  // ---------------- carte e punti ----------------

  function newShoe() {
    const d = [];
    for (let k = 0; k < DECKS; k++) for (const r of RANKS) for (const s of SUITS) d.push(r + s);
    for (let i = d.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
  }
  const cardValue = (c) => (c[0] === "A" ? 11 : "TJQK".includes(c[0]) ? 10 : Number(c[0]));
  /** punti di una mano: {t, soft} (soft = un asso conta ancora 11) */
  function total(cards) {
    let t = 0;
    let aces = 0;
    for (const c of cards) {
      t += cardValue(c);
      if (c[0] === "A") aces++;
    }
    while (t > 21 && aces) {
      t -= 10;
      aces--;
    }
    return { t, soft: aces > 0 };
  }
  const isBJ = (cards) => cards.length === 2 && total(cards).t === 21;
  function draw(room) {
    if (!room.shoe.length) room.shoe = newShoe();
    return room.shoe.pop();
  }

  // ---------------- mano ----------------

  const betting = (room) => players(room).filter((p) => p.bet > 0);
  const waitedFor = (room) => players(room).filter((p) => !p.sitOut);

  function newRound(room) {
    room.phase = "bet";
    room.betDeadline = 0;
    room.dealer = [];
    room.toAct = -1;
    room.hand = -1;
    room.deadline = 0;
    room.result = null;
    for (const p of players(room)) {
      p.bet = 0;
      p.hands = [];
    }
    bump(room, "");
  }

  function deal(room, now) {
    // sabot quasi finito: si rimescola prima di dare le carte
    if (room.shoe.length < DECKS * 52 * 0.25) {
      room.shoe = newShoe();
      bump(room, "Il banco rimescola le carte");
    }
    room.round = (room.round || 0) + 1;
    for (const p of players(room)) {
      if (p.bet > 0) {
        p.skips = 0;
        p.hands = [{ cards: [], bet: p.bet, done: false, doubled: false, fromAces: false, split: false, result: "", win: 0 }];
        p.bet = 0;
      } else {
        // con altri al tavolo, chi non punta per un paio di mani non viene più aspettato (torna puntando)
        p.skips = (p.skips || 0) + 1;
        if (p.skips >= SKIPS_TO_SITOUT) p.sitOut = true;
        p.hands = [];
      }
    }
    room.dealer = [];
    const inRound = players(room).filter((p) => p.hands.length);
    for (let k = 0; k < 2; k++) {
      for (const p of inRound) p.hands[0].cards.push(draw(room));
      room.dealer.push(draw(room));
    }
    dealt(room, now, 2 * inRound.length + 2);
    room.phase = "play";
    room.betDeadline = 0;
    for (const p of inRound) if (isBJ(p.hands[0].cards)) p.hands[0].done = true;
    // il mazziere guarda la carta coperta con asso o figura scoperti: se ha blackjack la mano finisce subito
    const up = room.dealer[0];
    if ((up[0] === "A" || cardValue(up) === 10) && isBJ(room.dealer)) {
      settle(room, now);
      return;
    }
    nextTurn(room, now, -1);
  }

  /** passa alla prossima mano da giocare (giocatore per giocatore, mano per mano); se non ce ne sono gioca il banco */
  function nextTurn(room, now) {
    for (let i = 0; i < MAX_SEATS; i++) {
      const p = room.seats[i];
      if (!p || !p.hands) continue;
      const h = p.hands.findIndex((x) => !x.done);
      if (h >= 0) {
        room.toAct = i;
        room.hand = h;
        room.deadline = after(room, now) + TURN_MS;
        bump(room, "");
        return;
      }
    }
    room.toAct = -1;
    room.hand = -1;
    settle(room, now);
  }

  function settle(room, now) {
    const live = players(room).some((p) => p.hands.some((h) => total(h.cards).t <= 21 && !(isBJ(h.cards) && !h.split)));
    const dealerBJ = isBJ(room.dealer);
    // il banco tira fino a 17 (si ferma anche su 17 morbido), solo se qualcuno può ancora battere il banco
    const had = room.dealer.length;
    if (live && !dealerBJ) while (total(room.dealer).t < 17) room.dealer.push(draw(room));
    // si gira la carta coperta del banco, poi le sue carte una alla volta
    dealt(room, now, 1 + room.dealer.length - had);
    const d = total(room.dealer).t;
    const lines = [];
    for (const p of players(room)) {
      let net = 0;
      for (const h of p.hands) {
        const t = total(h.cards).t;
        const bj = isBJ(h.cards) && !h.split;
        let back = 0;
        if (t > 21) h.result = "sballato";
        else if (dealerBJ) {
          h.result = bj ? "pari" : "perde";
          back = bj ? h.bet : 0;
        } else if (bj) {
          h.result = "blackjack";
          back = h.bet + Math.floor(h.bet * 1.5);
        } else if (d > 21 || t > d) {
          h.result = "vince";
          back = h.bet * 2;
        } else if (t === d) {
          h.result = "pari";
          back = h.bet;
        } else h.result = "perde";
        h.win = back;
        h.done = true;
        p.chips += back;
        net += back - h.bet;
      }
      if (p.hands.length) lines.push({ seat: room.seats.indexOf(p), name: p.name, net });
    }
    room.result = { dealer: d, dealerBJ, lines };
    room.phase = "done";
    room.toAct = -1;
    room.hand = -1;
    room.deadline = 0;
    room.nextAt = after(room, now) + NEXT_ROUND_MS * WAIT_MUL;
    bump(room, dealerBJ ? "Il banco ha blackjack" : d > 21 ? `Il banco sballa (${d})` : `Il banco fa ${d}`);
  }

  // un'azione: bet {amount} nella fase delle puntate; hit, stand, double, split sulla propria mano
  function act(room, seat, body, now, auto = false) {
    const p = room.seats[seat];
    const a = body.action;
    if (a === "bet") {
      if (room.phase !== "bet") return "Aspetta la prossima mano per puntare";
      if (p.bet > 0) return "Hai già puntato";
      const amount = Math.floor(Number(body.amount));
      if (!(amount >= room.min && amount <= room.max)) return `Puoi puntare da ${fmt(room.min)} a ${fmt(room.max)}`;
      if (amount > p.chips) return "Non hai abbastanza fiches";
      p.chips -= amount;
      p.bet = amount;
      p.sitOut = false;
      p.skips = 0;
      if (!room.betDeadline) room.betDeadline = now + BET_MS * WAIT_MUL;
      bump(room, `${p.name} punta ${fmt(amount)}`);
      if (waitedFor(room).every((x) => x.bet > 0)) deal(room, now);
      return null;
    }
    if (room.phase !== "play" || room.toAct !== seat) return "Non tocca a te";
    const h = p.hands[room.hand];
    if (!auto) p.missed = 0;
    if (a === "hit") {
      h.cards.push(draw(room));
      dealt(room, now, 1);
      if (total(h.cards).t >= 21) h.done = true;
    } else if (a === "stand") h.done = true;
    else if (a === "double") {
      if (h.cards.length !== 2 || h.fromAces) return "Puoi raddoppiare solo sulle prime due carte";
      if (p.chips < h.bet) return "Non hai abbastanza fiches per raddoppiare";
      p.chips -= h.bet;
      h.bet *= 2;
      h.doubled = true;
      h.cards.push(draw(room));
      dealt(room, now, 1);
      h.done = true;
    } else if (a === "split") {
      if (h.cards.length !== 2 || cardValue(h.cards[0]) !== cardValue(h.cards[1])) return "Puoi dividere solo due carte dello stesso valore";
      if (h.fromAces) return "Gli assi divisi non si dividono ancora";
      if (p.hands.length >= 4) return "Al massimo 4 mani";
      if (p.chips < h.bet) return "Non hai abbastanza fiches per dividere";
      p.chips -= h.bet;
      const aces = h.cards[0][0] === "A";
      const second = { cards: [h.cards.pop()], bet: h.bet, done: false, doubled: false, fromAces: aces, split: true, result: "", win: 0 };
      h.split = true;
      h.fromAces = aces;
      h.cards.push(draw(room));
      second.cards.push(draw(room));
      dealt(room, now, 2);
      p.hands.splice(room.hand + 1, 0, second);
      // assi divisi: una carta sola ciascuno; 21 su due carte dopo una divisione non è blackjack ma si ferma lì
      for (const x of [h, second]) if (aces || total(x.cards).t === 21) x.done = true;
    } else return "Azione non valida";
    bump(room, auto ? `${p.name} non risponde: sta` : "");
    if (h.done || p.hands[room.hand].done) nextTurn(room, now);
    else room.deadline = after(room, now) + TURN_MS;
    return null;
  }

  // ---------------- giocatori ----------------

  async function cashOut(room, p, why) {
    if (p.chips > 0) {
      const entry = JSON.stringify({ amount: p.chips, slot: p.slot, code: room.code, at: Date.now(), why, game: "bj" });
      await upstashPipeline([["RPUSH", `hustle:poker:cash:${p.id}`, entry], ["EXPIRE", `hustle:poker:cash:${p.id}`, CASH_TTL]]);
    }
    await upstash(["DEL", `hustle:bj:at:${p.id}`]);
  }

  // toglie un giocatore: se è in una mano la perde (quello che ha puntato resta al banco)
  async function removePlayer(room, seat, now, why) {
    const p = room.seats[seat];
    if (!p) return 0;
    // puntata fatta ma carte non ancora date: torna nelle fiches
    if (room.phase === "bet" && p.bet > 0) {
      p.chips += p.bet;
      p.bet = 0;
    }
    const chips = p.chips;
    await cashOut(room, p, why);
    room.seats[seat] = null;
    bump(room, why === "uscito" ? `${p.name} è uscito` : `${p.name} non risponde: tolto dal tavolo`);
    if (!players(room).length) {
      room.closed = "Il tavolo si è chiuso.";
      return chips;
    }
    if (room.phase === "play" && room.toAct === seat) nextTurn(room, now);
    else if (room.phase === "play" && !players(room).some((x) => x.hands.length)) settle(room, now);
    else if (room.phase === "bet" && betting(room).length && waitedFor(room).every((x) => x.bet > 0)) deal(room, now);
    return chips;
  }

  async function tick(room, now) {
    for (let i = 0; i < MAX_SEATS && !room.closed; i++) {
      const p = room.seats[i];
      if (p && now - p.lastSeen > GONE_MS) await removePlayer(room, i, now, "sparito");
    }
    if (room.closed) return;
    if (room.phase === "bet" && room.betDeadline && now >= room.betDeadline && betting(room).length) deal(room, now);
    else if (room.phase === "play" && room.toAct >= 0 && now > room.deadline) {
      const p = room.seats[room.toAct];
      p.missed = (p.missed || 0) + 1;
      act(room, room.toAct, { action: "stand" }, now, true);
    } else if (room.phase === "done" && now >= room.nextAt) newRound(room);
  }

  function view(room, me) {
    const now = Date.now();
    const hidden = room.phase === "play";
    const dealerCards = room.dealer.map((c, i) => (hidden && i === 1 ? null : c));
    const shown = dealerCards.filter(Boolean);
    const mySeat = room.seats.findIndex((p) => p && p.id === me);
    const v = {
      code: room.code, v: room.v, round: room.round || 0, min: room.min, max: room.max, minBuy: room.minBuy, maxBuy: room.maxBuy, fame: room.fame || 0,
      phase: room.phase,
      betLeft: room.phase === "bet" && room.betDeadline ? Math.max(0, room.betDeadline - now) : 0,
      betMs: BET_MS * WAIT_MUL,
      dealer: { cards: dealerCards, total: shown.length ? total(shown).t : 0, soft: shown.length ? total(shown).soft && total(shown).t < 21 : false },
      seats: room.seats.map((p) => p && {
        name: p.name, chips: p.chips, bet: p.bet, sitOut: !!p.sitOut, me: p.id === me,
        hands: p.hands.map((h) => { const t = total(h.cards); return { cards: h.cards, bet: h.bet, total: t.t, soft: t.soft && t.t < 21, done: h.done, doubled: h.doubled, bj: isBJ(h.cards) && !h.split, result: h.result, win: h.win }; }),
      }),
      mySeat, toAct: room.toAct, hand: room.hand,
      turnLeft: room.phase === "play" && room.toAct >= 0 ? Math.max(0, room.deadline - now) : 0, turnMs: TURN_MS,
      result: room.result, nextIn: room.phase === "done" ? Math.max(0, room.nextAt - now) : 0,
      log: room.log.slice(-6).map((l) => l.text),
    };
    if (mySeat >= 0 && room.phase === "play" && room.toAct === mySeat) {
      const p = room.seats[mySeat];
      const h = p.hands[room.hand];
      v.my = {
        canDouble: h.cards.length === 2 && !h.fromAces && p.chips >= h.bet,
        canSplit: h.cards.length === 2 && cardValue(h.cards[0]) === cardValue(h.cards[1]) && !h.fromAces && p.hands.length < 4 && p.chips >= h.bet,
      };
    }
    return v;
  }

  // ---------------- richieste ----------------

  const cleanName = (n) => (cleanText(n, 24) || "Giocatore");
  const validSlot = (s) => Number.isInteger(s) && s >= 1 && s <= 9;
  const roomCode = (c) => (typeof c === "string" ? c.trim().toUpperCase() : "");
  const validBody = (res, body) => {
    if (!isValidPlayerId(body.player_id)) {
      sendJson(res, 400, { error: "telefono non valido" });
      return false;
    }
    return true;
  };

  async function newCode() {
    for (let k = 0; k < 20; k++) {
      let c = "";
      for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!rooms.has(c) && !(await upstash(["EXISTS", `hustle:bj:room:${c}`]))) return c;
    }
    throw new Error("niente codici liberi");
  }

  function seatPlayer(room, body, buy, now) {
    const free = room.seats.findIndex((s) => !s);
    if (free < 0) return -1;
    room.seats[free] = { id: body.player_id, name: cleanName(body.nickname), slot: body.slot, chips: buy, bet: 0, hands: [], lastSeen: now, missed: 0, skips: 0, sitOut: false };
    bump(room, `${room.seats[free].name} si siede al tavolo`);
    return free;
  }

  /** codice del tavolo di blackjack in cui siede (null se nessuno): serve anche al poker per un tavolo alla volta */
  async function seatedCode(playerId) {
    const at = await upstash(["GET", `hustle:bj:at:${playerId}`]);
    const room = at ? await loadRoom(at) : null;
    return room && !room.closed && room.seats.some((p) => p && p.id === playerId) ? at : null;
  }
  async function busyElsewhere(res, playerId, except) {
    const bj = await seatedCode(playerId);
    if (bj && bj !== except) {
      sendJson(res, 409, { error: "sei già seduto a un altro tavolo", code: bj, game: "bj" });
      return true;
    }
    const pk = tables.poker ? await tables.poker(playerId) : null;
    if (pk) {
      sendJson(res, 409, { error: "sei già seduto a un tavolo di poker", code: pk, game: "poker" });
      return true;
    }
    return false;
  }

  async function handleCreate(res, body) {
    if (!validBody(res, body)) return;
    const stake = STAKES[body.stake];
    if (!stake) return sendJson(res, 400, { error: "tavolo non valido" });
    if (!validSlot(body.slot)) return sendJson(res, 400, { error: "partita non valida" });
    const fame = STAKE_FAME[body.stake];
    if (fame && !(Number(body.fame) >= fame)) return sendJson(res, 403, { error: `Per questo tavolo serve fama ${fame}` });
    const min = stake[1];
    const buy = Math.floor(Number(body.buy));
    if (!(buy >= min * MIN_BUY_X && buy <= min * MAX_BUY_X)) return sendJson(res, 400, { error: "fiches non valide" });
    if (await busyElsewhere(res, body.player_id)) return;
    const code = await newCode();
    const now = Date.now();
    const room = { code, v: 1, min, max: min * MAX_BET_X, fame, minBuy: min * MIN_BUY_X, maxBuy: min * MAX_BUY_X, created: now, seats: Array(MAX_SEATS).fill(null), shoe: newShoe(), dealer: [], phase: "bet", betDeadline: 0, toAct: -1, hand: -1, deadline: 0, result: null, nextAt: 0, log: [], closed: null };
    seatPlayer(room, body, buy, now);
    rooms.set(code, room);
    await saveRoom(room);
    await upstash(["SET", `hustle:bj:at:${body.player_id}`, code, "EX", ROOM_TTL]);
    sendJson(res, 200, { ok: true, code, bought: buy, state: view(room, body.player_id) });
  }

  async function handleInfo(res, body) {
    const code = roomCode(body.code);
    const room = /^[A-Z0-9]{5}$/.test(code) ? await loadRoom(code) : null;
    if (!room || room.closed) return sendJson(res, 404, { error: "Tavolo non trovato: controlla il codice" });
    const ps = players(room);
    sendJson(res, 200, { code, min: room.min, max: room.max, fame: room.fame || 0, minBuy: room.minBuy, maxBuy: room.maxBuy, players: ps.map((p) => p.name), free: MAX_SEATS - ps.length,
      seated: isValidPlayerId(body.player_id) && ps.some((p) => p.id === body.player_id) });
  }

  async function handleJoin(res, body) {
    if (!validBody(res, body)) return;
    const code = roomCode(body.code);
    if (!/^[A-Z0-9]{5}$/.test(code)) return sendJson(res, 404, { error: "Tavolo non trovato: controlla il codice" });
    await serial(code, async () => {
      const room = await loadRoom(code);
      if (!room || room.closed) return sendJson(res, 404, { error: "Tavolo non trovato: controlla il codice" });
      const now = Date.now();
      const mine = room.seats.find((p) => p && p.id === body.player_id);
      if (mine) {
        mine.lastSeen = now;
        return sendJson(res, 200, { ok: true, code, bought: 0, rejoined: true, state: view(room, body.player_id) });
      }
      if (!validSlot(body.slot)) return sendJson(res, 400, { error: "partita non valida" });
      if (room.fame && !(Number(body.fame) >= room.fame)) return sendJson(res, 403, { error: `Per questo tavolo serve fama ${room.fame}` });
      const buy = Math.floor(Number(body.buy));
      if (!(buy >= room.minBuy && buy <= room.maxBuy)) return sendJson(res, 400, { error: `Puoi portare da ${fmt(room.minBuy)} a ${fmt(room.maxBuy)}` });
      if (await busyElsewhere(res, body.player_id, code)) return;
      if (seatPlayer(room, body, buy, now) < 0) return sendJson(res, 409, { error: "Il tavolo è pieno (7 giocatori)" });
      await tick(room, now);
      await saveRoom(room);
      await upstash(["SET", `hustle:bj:at:${body.player_id}`, code, "EX", ROOM_TTL]);
      sendJson(res, 200, { ok: true, code, bought: buy, state: view(room, body.player_id) });
    });
  }

  async function handleState(res, body) {
    if (!validBody(res, body)) return;
    const code = roomCode(body.code);
    await serial(code, async () => {
      const room = /^[A-Z0-9]{5}$/.test(code) ? await loadRoom(code) : null;
      if (!room || room.closed) return sendJson(res, 200, { closed: "Il tavolo si è chiuso." });
      const now = Date.now();
      const me = room.seats.find((p) => p && p.id === body.player_id);
      if (!me) return sendJson(res, 200, { closed: "Non sei più seduto a questo tavolo." });
      me.lastSeen = now;
      const v = room.v;
      await tick(room, now);
      if (room.closed) {
        await saveRoom(room);
        return sendJson(res, 200, { closed: room.closed });
      }
      if (room.v !== v) await saveRoom(room);
      if (body.v === room.v) return sendJson(res, 200, { same: true, v: room.v, turnLeft: room.phase === "play" && room.toAct >= 0 ? Math.max(0, room.deadline - now) : 0, betLeft: room.phase === "bet" && room.betDeadline ? Math.max(0, room.betDeadline - now) : 0 });
      sendJson(res, 200, view(room, body.player_id));
    });
  }

  async function handleAct(res, body) {
    if (!validBody(res, body)) return;
    const code = roomCode(body.code);
    await serial(code, async () => {
      const room = await loadRoom(code);
      if (!room || room.closed) return sendJson(res, 404, { error: "Il tavolo si è chiuso" });
      const seat = room.seats.findIndex((p) => p && p.id === body.player_id);
      if (seat < 0) return sendJson(res, 403, { error: "Non sei seduto a questo tavolo" });
      const now = Date.now();
      room.seats[seat].lastSeen = now;
      await tick(room, now);
      if (room.closed) {
        await saveRoom(room);
        return sendJson(res, 200, { closed: room.closed });
      }
      const err = act(room, seat, body, now);
      await saveRoom(room);
      if (err) return sendJson(res, 409, { error: err, state: view(room, body.player_id) });
      sendJson(res, 200, view(room, body.player_id));
    });
  }

  // compra altre fiches quando non è in una mano (fino al massimo del tavolo)
  async function handleRebuy(res, body) {
    if (!validBody(res, body)) return;
    const code = roomCode(body.code);
    await serial(code, async () => {
      const room = await loadRoom(code);
      if (!room || room.closed) return sendJson(res, 404, { error: "Il tavolo si è chiuso" });
      const p = room.seats.find((x) => x && x.id === body.player_id);
      if (!p) return sendJson(res, 403, { error: "Non sei seduto a questo tavolo" });
      const now = Date.now();
      p.lastSeen = now;
      if (room.phase === "play" && p.hands.length) return sendJson(res, 409, { error: "Aspetta la fine della mano" });
      const buy = Math.floor(Number(body.buy));
      if (!(buy > 0 && p.chips + p.bet + buy <= room.maxBuy)) return sendJson(res, 400, { error: `Al tavolo puoi avere al massimo ${fmt(room.maxBuy)}` });
      p.chips += buy;
      bump(room, `${p.name} compra ${fmt(buy)} di fiches`);
      await saveRoom(room);
      sendJson(res, 200, { ok: true, bought: buy, state: view(room, body.player_id) });
    });
  }

  async function handleLeave(res, body) {
    if (!validBody(res, body)) return;
    const code = roomCode(body.code);
    await serial(code, async () => {
      const room = await loadRoom(code);
      if (!room || room.closed) return sendJson(res, 200, { ok: true, chips: 0 });
      const seat = room.seats.findIndex((p) => p && p.id === body.player_id);
      if (seat < 0) return sendJson(res, 200, { ok: true, chips: 0 });
      const chips = await removePlayer(room, seat, Date.now(), "uscito");
      await saveRoom(room);
      sendJson(res, 200, { ok: true, chips });
    });
  }

  async function handleWhere(res, body) {
    if (!validBody(res, body)) return;
    const code = await seatedCode(body.player_id);
    sendJson(res, 200, { code });
  }

  return {
    routes: {
      "/hustle/bj/create": handleCreate,
      "/hustle/bj/info": handleInfo,
      "/hustle/bj/join": handleJoin,
      "/hustle/bj/state": handleState,
      "/hustle/bj/act": handleAct,
      "/hustle/bj/rebuy": handleRebuy,
      "/hustle/bj/leave": handleLeave,
      "/hustle/bj/where": handleWhere,
    },
    seatedCode,
    // per le prove
    _test: { total, isBJ, rooms, act, tick, settle },
  };
};
