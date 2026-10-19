// ---------------- Hustle Idle: poker multigiocatore ----------------
//
// Texas Hold'em senza limite, da 2 a 8 giocatori, con i soldi del gioco. Il server è l'unico a conoscere il mazzo e
// le carte coperte: ognuno vede solo le sue (e quelle girate allo showdown). Chi entra compra le fiches (le toglie dal
// suo conto nel gioco); chi esce, o viene tolto perché non risponde più, riceve le fiches rimaste come "vincita da
// ritirare", che il gioco aggiunge al conto della partita giusta (slot) appena può.
//
// Chiavi (tutte "hustle:poker:…", mai quelle di Magic Trip):
//   - STRING "hustle:poker:room:<CODICE>": la stanza in JSON (scade dopo POKER_ROOM_TTL senza movimenti).
//   - STRING "hustle:poker:at:<player_id>": il codice della stanza in cui siede (un tavolo alla volta).
//   - LIST   "hustle:poker:cash:<player_id>": vincite da ritirare, JSON {amount, slot, code, at}.
//
// Le stanze stanno anche in memoria (un solo processo su Render): ogni richiesta su una stanza passa da una coda,
// così due azioni insieme non si pestano i piedi. Il tempo (turni scaduti, mano successiva, giocatori spariti) avanza
// a ogni richiesta: i telefoni al tavolo chiedono lo stato ogni secondo.
const crypto = require("crypto");

const STAKES = [
  [10, 20], [100, 200], [1000, 2000], [10000, 20000], [100000, 200000], [1000000, 2000000], [10000000, 20000000], [100000000, 200000000],
];
// fama totale che serve per sedersi a ogni tavolo (stesso ordine di STAKES): i primi due sono liberi,
// poi circa ×2,5 a ogni tavolo (200 … 20000). La fama la manda il telefono.
const STAKE_FAME = [0, 0, 200, 500, 1200, 3000, 8000, 20000];
const MAX_SEATS = 8;
const MIN_BUY_BB = 20;
const MAX_BUY_BB = 100;
const TURN_MS = Number(process.env.POKER_TURN_MS) || 25000;
const GONE_MS = Number(process.env.POKER_GONE_MS) || 45000;
const NEXT_HAND_MS = 6000;
const NEXT_HAND_FOLD_MS = 3000;
const MISSED_TO_SITOUT = 2;
// solo per le prove automatiche: pause tra le mani più corte
const WAIT_MUL = process.env.POKER_FAST ? 0.01 : 1;
const POKER_ROOM_TTL = String(6 * 60 * 60);
const CASH_TTL = String(90 * 24 * 60 * 60);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RANKS = "23456789TJQKA";
const SUITS = "shdc";

module.exports = function pokerRoutes({ upstash, upstashPipeline, sendJson, isValidPlayerId, cleanText }) {
  const rooms = new Map();
  const queues = new Map();

  // una cosa alla volta per stanza (o per giocatore, per le vincite)
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
    const raw = await upstash(["GET", `hustle:poker:room:${code}`]);
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
      await upstash(["DEL", `hustle:poker:room:${room.code}`]);
      return;
    }
    await upstash(["SET", `hustle:poker:room:${room.code}`, JSON.stringify(room), "EX", POKER_ROOM_TTL]);
  }
  // le stanze chiuse restano in memoria un po', così chi era seduto vede perché si è chiusa
  const closedInfo = new Map();

  const players = (room) => room.seats.filter(Boolean);
  const bump = (room, text) => {
    room.v++;
    if (text) {
      room.log.push({ t: Date.now(), text });
      if (room.log.length > 12) room.log.shift();
    }
  };
  const fmt = (n) => "€" + Math.round(n).toLocaleString("it-IT");

  // ---------------- carte e punti ----------------

  function newDeck() {
    const d = [];
    for (const r of RANKS) for (const s of SUITS) d.push(r + s);
    for (let i = d.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
  }
  const rv = (c) => RANKS.indexOf(c[0]) + 2;

  // punteggio di 5 carte: categoria (0 carta alta … 8 scala colore) e poi le carte che contano, dalla più alta
  function score5(cs) {
    const v = cs.map(rv).sort((a, b) => b - a);
    const flush = cs.every((c) => c[1] === cs[0][1]);
    const uniq = [...new Set(v)];
    let straight = 0;
    if (uniq.length === 5) {
      if (v[0] - v[4] === 4) straight = v[0];
      else if (v[0] === 14 && v[1] === 5) straight = 5; // A-2-3-4-5
    }
    const counts = new Map();
    for (const x of v) counts.set(x, (counts.get(x) || 0) + 1);
    const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const ranks = groups.map((g) => g[0]);
    let cat;
    let tie;
    if (straight && flush) [cat, tie] = [8, [straight]];
    else if (groups[0][1] === 4) [cat, tie] = [7, ranks];
    else if (groups[0][1] === 3 && groups[1][1] === 2) [cat, tie] = [6, ranks];
    else if (flush) [cat, tie] = [5, v];
    else if (straight) [cat, tie] = [4, [straight]];
    else if (groups[0][1] === 3) [cat, tie] = [3, ranks];
    else if (groups[0][1] === 2 && groups[1][1] === 2) [cat, tie] = [2, ranks];
    else if (groups[0][1] === 2) [cat, tie] = [1, ranks];
    else [cat, tie] = [0, v];
    let s = cat;
    for (let i = 0; i < 5; i++) s = s * 15 + (tie[i] || 0);
    return { s, cat, top: tie[0] };
  }
  // la migliore combinazione di 5 tra 5, 6 o 7 carte
  function best7(cards) {
    let best = null;
    const pick = (start, chosen) => {
      if (chosen.length === 5) {
        const sc = score5(chosen);
        if (!best || sc.s > best.s) best = { ...sc, five: chosen.slice() };
        return;
      }
      for (let i = start; i <= cards.length - (5 - chosen.length); i++) pick(i + 1, [...chosen, cards[i]]);
    };
    pick(0, []);
    return best;
  }
  const CAT_NAMES = ["Carta alta", "Coppia", "Doppia coppia", "Tris", "Scala", "Colore", "Full", "Poker", "Scala colore"];
  const handName = (h) => (h.cat === 8 && h.top === 14 ? "Scala reale" : CAT_NAMES[h.cat]);

  // ---------------- mano ----------------

  const nextSeat = (room, from, ok) => {
    for (let k = 1; k <= MAX_SEATS; k++) {
      const i = (from + k + MAX_SEATS) % MAX_SEATS;
      const p = room.seats[i];
      if (p && ok(p)) return i;
    }
    return -1;
  };
  const canAct = (p) => p.inHand && !p.folded && !p.allin;
  const live = (room) => players(room).filter((p) => p.inHand && !p.folded);

  function post(p, amount) {
    const a = Math.min(amount, p.chips);
    p.chips -= a;
    p.bet += a;
    p.total += a;
    if (p.chips === 0) p.allin = true;
    return a;
  }

  function startHand(room, now) {
    const ready = (p) => p.chips > 0 && !p.sitOut;
    const n = players(room).filter(ready).length;
    if (n < 2) return false;
    for (const p of players(room)) Object.assign(p, { inHand: ready(p), folded: false, allin: false, bet: 0, total: 0, cards: [], acted: false, seenRaise: 0, last: "" });
    room.button = nextSeat(room, room.button, ready);
    const heads = n === 2;
    const sb = heads ? room.button : nextSeat(room, room.button, ready);
    const bb = nextSeat(room, sb, ready);
    const deck = newDeck();
    const h = { id: (room.hand?.id || 0) + 1, deck, board: [], street: "preflop", currentBet: room.bb, minRaise: room.bb, raiseSeq: 1, toAct: -1, deadline: 0, sb, bb };
    room.hand = h;
    room.result = null;
    room.started = true;
    const ps = room.seats[sb];
    const pb = room.seats[bb];
    post(ps, room.sb);
    ps.last = "piccolo buio";
    post(pb, room.bb);
    pb.last = "grande buio";
    for (const p of players(room)) if (p.inHand) p.cards = [deck.pop(), deck.pop()];
    bump(room, `Nuova mano: buio ${fmt(room.sb)} da ${ps.name}, ${fmt(room.bb)} da ${pb.name}`);
    setTurn(room, nextSeat(room, bb, canAct), now);
    // tutti già all-in con i bui (o uno solo può agire e ha già pareggiato): si girano le carte
    if (roundOver(room)) endRound(room, now);
    return true;
  }

  function setTurn(room, seat, now) {
    room.hand.toAct = seat;
    room.hand.deadline = seat >= 0 ? now + TURN_MS : 0;
  }

  function roundOver(room) {
    const h = room.hand;
    const act = players(room).filter(canAct);
    if (live(room).length <= 1) return true;
    if (act.length === 0) return true;
    // uno solo può ancora puntare e ha già messo quanto serve: niente da decidere
    if (act.length === 1 && act[0].bet >= h.currentBet && (act[0].acted || live(room).every((p) => p === act[0] || p.allin))) return true;
    return act.every((p) => p.acted && p.bet === h.currentBet);
  }

  function afterAction(room, seat, now) {
    if (live(room).length <= 1) return finishFold(room, now);
    if (roundOver(room)) return endRound(room, now);
    const h = room.hand;
    const nxt = nextSeat(room, seat, (p) => canAct(p) && (!p.acted || p.bet < h.currentBet));
    setTurn(room, nxt, now);
  }

  function endRound(room, now) {
    const h = room.hand;
    for (const p of players(room)) {
      p.bet = 0;
      if (canAct(p)) p.acted = false;
    }
    h.currentBet = 0;
    h.minRaise = room.bb;
    h.raiseSeq++;
    if (live(room).length <= 1) return finishFold(room, now);
    const deal = (n) => {
      h.deck.pop(); // carta bruciata
      for (let i = 0; i < n; i++) h.board.push(h.deck.pop());
    };
    const order = ["preflop", "flop", "turn", "river"];
    const more = players(room).filter(canAct).length >= 2;
    if (!more) {
      // al massimo uno può ancora puntare: si girano tutte le carte e si va allo showdown
      while (h.board.length < 5) deal(h.board.length === 0 ? 3 : 1);
      return showdown(room, now);
    }
    const next = order[order.indexOf(h.street) + 1];
    if (!next) return showdown(room, now);
    h.street = next;
    deal(next === "flop" ? 3 : 1);
    bump(room, next === "flop" ? "Flop" : next === "turn" ? "Turn" : "River");
    setTurn(room, nextSeat(room, room.button, canAct), now);
  }

  // tutti hanno lasciato tranne uno: prende il piatto senza mostrare le carte
  function finishFold(room, now) {
    const h = room.hand;
    const w = live(room)[0];
    const pot = players(room).reduce((a, p) => a + p.total, 0) + (h.dead || 0);
    if (w) w.chips += pot;
    room.result = { hand: h.id, winners: w ? [{ seat: room.seats.indexOf(w), name: w.name, amount: pot, hand: "" }] : [], shown: {}, board: h.board.slice() };
    bump(room, w ? `${w.name} vince ${fmt(pot)}` : "");
    closeHand(room, now, NEXT_HAND_FOLD_MS);
  }

  function showdown(room, now) {
    const h = room.hand;
    h.street = "showdown";
    const all = players(room).filter((p) => p.inHand || p.total > 0);
    const contenders = live(room);
    const scores = new Map(contenders.map((p) => [p, best7(p.cards.concat(h.board))]));
    const won = new Map();
    // piatti laterali: ogni livello di puntata dei giocatori rimasti è un piatto a parte
    const levels = [...new Set(contenders.map((p) => p.total))].sort((a, b) => a - b);
    let prev = 0;
    let given = 0;
    const total = all.reduce((a, p) => a + p.total, 0) + (h.dead || 0);
    levels.forEach((lv, li) => {
      let pot = all.reduce((a, p) => a + Math.max(0, Math.min(p.total, lv) - prev), 0);
      if (li === levels.length - 1) pot = total - given; // anche quello che resta (fiches di chi ha lasciato)
      const elig = contenders.filter((p) => p.total >= lv);
      const best = Math.max(...elig.map((p) => scores.get(p).s));
      const ws = elig.filter((p) => scores.get(p).s === best);
      // ordine dal primo dopo il bottone: a lui l'eventuale fiche che avanza
      ws.sort((a, b) => ((room.seats.indexOf(a) - room.button + MAX_SEATS - 1) % MAX_SEATS) - ((room.seats.indexOf(b) - room.button + MAX_SEATS - 1) % MAX_SEATS));
      const share = Math.floor(pot / ws.length);
      ws.forEach((p, i) => won.set(p, (won.get(p) || 0) + share + (i === 0 ? pot - share * ws.length : 0)));
      given += pot;
      prev = lv;
    });
    for (const [p, a] of won) p.chips += a;
    const shown = {};
    for (const p of contenders) shown[room.seats.indexOf(p)] = { cards: p.cards, hand: handName(scores.get(p)), best: scores.get(p).five };
    room.result = {
      hand: h.id,
      winners: [...won.entries()].filter(([, a]) => a > 0).map(([p, a]) => ({ seat: room.seats.indexOf(p), name: p.name, amount: a, hand: handName(scores.get(p)) })),
      shown,
      board: h.board.slice(),
    };
    bump(room, room.result.winners.map((w) => `${w.name} vince ${fmt(w.amount)} con ${w.hand}`).join(" · "));
    closeHand(room, now, NEXT_HAND_MS);
  }

  function closeHand(room, now, wait) {
    const h = room.hand;
    h.street = "done";
    h.toAct = -1;
    h.deadline = 0;
    for (const p of players(room)) {
      p.inHand = false;
      p.bet = 0;
      p.total = 0;
    }
    room.nextHandAt = now + wait * WAIT_MUL;
  }

  // ---------------- giocatori ----------------

  async function cashOut(room, p, why) {
    if (p.chips > 0) {
      const entry = JSON.stringify({ amount: p.chips, slot: p.slot, code: room.code, at: Date.now(), why });
      await upstashPipeline([["RPUSH", `hustle:poker:cash:${p.id}`, entry], ["EXPIRE", `hustle:poker:cash:${p.id}`, CASH_TTL]]);
    }
    await upstash(["DEL", `hustle:poker:at:${p.id}`]);
  }

  // toglie un giocatore dal tavolo: se è in una mano lascia (le fiches già puntate restano nel piatto)
  async function removePlayer(room, seat, now, why) {
    const p = room.seats[seat];
    if (!p) return 0;
    const h = room.hand;
    const inPlay = h && h.street !== "done" && p.inHand;
    if (inPlay) {
      // le sue fiches puntate restano nel piatto anche se lui non c'è più
      h.dead = (h.dead || 0) + p.total;
      p.total = 0;
      p.folded = true;
    }
    const chips = p.chips;
    await cashOut(room, p, why);
    room.seats[seat] = null;
    bump(room, why === "uscito" ? `${p.name} è uscito` : `${p.name} non risponde: tolto dal tavolo`);
    if (inPlay) {
      if (live(room).length <= 1) finishFold(room, now);
      else if (h.toAct === seat) afterAction(room, seat, now);
      else if (roundOver(room)) endRound(room, now);
    }
    await maybeClose(room);
    return chips;
  }

  // meno di 2 giocatori dopo che la partita è cominciata: la stanza chiude e chi resta ritira le fiches
  async function maybeClose(room) {
    if (room.closed) return;
    const left = players(room);
    if (left.length >= 2 || (!room.started && left.length === 1)) return;
    room.closed = left.length ? "Sei rimasto da solo al tavolo: la stanza si è chiusa." : "La stanza si è chiusa.";
    for (const p of left) {
      // se è a metà mano (non dovrebbe: con uno solo la mano è già finita) riprende quello che ha puntato
      p.chips += p.total;
      p.total = 0;
      await cashOut(room, p, "chiusa");
    }
    closedInfo.set(room.code, { why: room.closed, at: Date.now(), ids: left.map((p) => p.id) });
    bump(room, "");
  }

  // il tempo che passa: turni scaduti, giocatori spariti, mano successiva
  async function tick(room, now) {
    // chi non chiede lo stato da troppo (app chiusa, niente rete) viene tolto e ritira le fiches
    for (let i = 0; i < MAX_SEATS && !room.closed; i++) {
      const p = room.seats[i];
      if (p && now - p.lastSeen > GONE_MS) await removePlayer(room, i, now, "sparito");
    }
    if (room.closed) return;
    const h = room.hand;
    if (h && h.street !== "done" && h.toAct >= 0 && now > h.deadline) {
      const p = room.seats[h.toAct];
      const free = p.bet >= h.currentBet;
      p.missed = (p.missed || 0) + 1;
      if (p.missed >= MISSED_TO_SITOUT) p.sitOut = true;
      act(room, h.toAct, free ? { action: "check" } : { action: "fold" }, now, true);
    }
    if ((!room.hand || room.hand.street === "done") && now >= (room.nextHandAt || 0)) startHand(room, now);
  }

  // ---------------- azioni ----------------

  function act(room, seat, body, now, auto = false) {
    const h = room.hand;
    if (!h || h.street === "done" || h.street === "showdown") return "Nessuna mano in corso";
    if (h.toAct !== seat) return "Non è il tuo turno";
    const p = room.seats[seat];
    const toCall = h.currentBet - p.bet;
    const canRaise = !p.acted || p.seenRaise < h.raiseSeq;
    const a = body.action;
    if (a === "fold") {
      p.folded = true;
      p.last = auto ? "fuori (tempo scaduto)" : "lascia";
    } else if (a === "check") {
      if (toCall > 0) return "Devi chiamare o lasciare";
      p.last = "passa";
    } else if (a === "call") {
      if (toCall <= 0) return "Non c'è niente da chiamare";
      const paid = post(p, toCall);
      p.last = p.allin ? `all-in ${fmt(paid)}` : `chiama ${fmt(paid)}`;
    } else if (a === "raise") {
      const max = p.bet + p.chips;
      let to = Math.floor(Number(body.amount));
      if (!Number.isFinite(to)) return "Puntata non valida";
      if (!canRaise) return "Puoi solo chiamare o lasciare";
      if (p.chips <= toCall) return "Non hai fiches per rilanciare";
      to = Math.min(to, max);
      const minTo = h.currentBet + h.minRaise;
      if (to < minTo && to < max) return `Il minimo è ${fmt(minTo)}`;
      const inc = to - h.currentBet;
      const wasBet = h.currentBet === 0;
      post(p, to - p.bet);
      if (inc >= h.minRaise) {
        h.minRaise = inc;
        h.raiseSeq++;
      }
      h.currentBet = to;
      p.last = p.allin ? `all-in ${fmt(to)}` : wasBet ? `punta ${fmt(to)}` : `rilancia a ${fmt(to)}`;
    } else return "Azione non valida";
    if (!auto) p.missed = 0;
    p.acted = true;
    p.seenRaise = h.raiseSeq;
    bump(room, `${p.name}: ${p.last}`);
    afterAction(room, seat, now);
    return null;
  }

  // ---------------- cosa vede un giocatore ----------------

  function view(room, me) {
    const h = room.hand;
    const mySeat = room.seats.findIndex((p) => p && p.id === me);
    const running = h && h.street !== "done";
    const res = room.result && h && room.result.hand === h.id && h.street === "done" ? room.result : null;
    const seats = room.seats.map((p, i) => {
      if (!p) return null;
      const shown = res && res.shown[i];
      return {
        name: p.name, chips: p.chips, bet: running ? p.bet : 0, inHand: !!(running && p.inHand), folded: !!p.folded, allin: !!p.allin,
        sitOut: !!p.sitOut, last: running ? p.last || "" : "", me: i === mySeat,
        cards: i === mySeat && p.cards.length && (running || res) ? p.cards : shown ? shown.cards : null,
        hasCards: !!(running && p.inHand && !p.folded),
      };
    });
    const out = {
      code: room.code, v: room.v, sb: room.sb, bb: room.bb, minBuy: room.minBuy, maxBuy: room.maxBuy, seats, mySeat,
      button: room.button, board: h ? (running ? h.board : res ? res.board : []) : [], street: h ? h.street : "wait",
      pot: running ? players(room).reduce((a, p) => a + p.total, 0) + (h.dead || 0) : 0,
      toAct: running ? h.toAct : -1, turnLeft: running && h.toAct >= 0 ? Math.max(0, h.deadline - Date.now()) : 0, turnMs: TURN_MS,
      result: res ? { winners: res.winners, shown: Object.fromEntries(Object.entries(res.shown).map(([k, s]) => [k, { hand: s.hand, best: s.best }])) } : null,
      nextHandIn: !running && room.nextHandAt ? Math.max(0, room.nextHandAt - Date.now()) : 0,
      log: room.log.slice(-6).map((l) => l.text),
      started: !!room.started,
    };
    if (mySeat >= 0 && running && h.toAct === mySeat) {
      const p = room.seats[mySeat];
      const toCall = Math.min(h.currentBet - p.bet, p.chips);
      const canRaise = (!p.acted || p.seenRaise < h.raiseSeq) && p.chips > h.currentBet - p.bet;
      out.my = {
        toCall, canCheck: toCall <= 0, canRaise,
        minTo: Math.min(h.currentBet + h.minRaise, p.bet + p.chips), maxTo: p.bet + p.chips, isBet: h.currentBet === 0,
      };
    }
    if (mySeat >= 0 && running && room.seats[mySeat].inHand && room.seats[mySeat].cards.length) {
      const sc = h.board.length >= 3 ? best7(room.seats[mySeat].cards.concat(h.board)) : null;
      out.myHand = sc ? handName(sc) : room.seats[mySeat].cards[0][0] === room.seats[mySeat].cards[1][0] ? "Coppia" : "";
    }
    return out;
  }

  // ---------------- richieste ----------------

  const cleanName = (n) => (cleanText(n, 24) || "Giocatore");
  const validSlot = (s) => Number.isInteger(s) && s >= 1 && s <= 9;

  async function newCode() {
    for (let k = 0; k < 20; k++) {
      let c = "";
      for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!rooms.has(c) && !(await upstash(["EXISTS", `hustle:poker:room:${c}`]))) return c;
    }
    throw new Error("niente codici liberi");
  }

  function seatPlayer(room, body, buy, now) {
    const free = room.seats.findIndex((s) => !s);
    if (free < 0) return -1;
    room.seats[free] = { id: body.player_id, name: cleanName(body.nickname), slot: body.slot, chips: buy, inHand: false, folded: false, allin: false, bet: 0, total: 0, cards: [], acted: false, seenRaise: 0, last: "", lastSeen: now, missed: 0, sitOut: false };
    bump(room, `${room.seats[free].name} si siede al tavolo`);
    // tra una mano e l'altra (o prima della prima): qualche secondo per sedersi prima di dare le carte
    if (!room.hand || room.hand.street === "done") room.nextHandAt = Math.max(room.nextHandAt || 0, now + 3000 * WAIT_MUL);
    return free;
  }

  const validBody = (res, body) => {
    if (!isValidPlayerId(body.player_id)) {
      sendJson(res, 400, { error: "telefono non valido" });
      return false;
    }
    return true;
  };
  const roomCode = (c) => (typeof c === "string" ? c.trim().toUpperCase() : "");

  // crea una stanza e si siede: {player_id, nickname, slot, stake (indice), buy}
  async function handleCreate(res, body) {
    if (!validBody(res, body)) return;
    const stake = STAKES[body.stake];
    if (!stake) return sendJson(res, 400, { error: "puntate non valide" });
    if (!validSlot(body.slot)) return sendJson(res, 400, { error: "partita non valida" });
    const [sb, bb] = stake;
    const fame = STAKE_FAME[body.stake];
    if (!(Number(body.fame) >= fame)) return sendJson(res, 403, { error: `Per questo tavolo serve fama ${fame}` });
    const buy = Math.floor(Number(body.buy));
    if (!(buy >= bb * MIN_BUY_BB && buy <= bb * MAX_BUY_BB)) return sendJson(res, 400, { error: "fiches non valide" });
    const at = await upstash(["GET", `hustle:poker:at:${body.player_id}`]);
    if (at && (await loadRoom(at)) && !rooms.get(at).closed) return sendJson(res, 409, { error: "sei già seduto a un altro tavolo", code: at });
    const code = await newCode();
    const now = Date.now();
    const room = { code, v: 1, sb, bb, fame, minBuy: bb * MIN_BUY_BB, maxBuy: bb * MAX_BUY_BB, created: now, seats: Array(MAX_SEATS).fill(null), button: -1, hand: null, result: null, nextHandAt: 0, log: [], started: false, closed: null };
    seatPlayer(room, body, buy, now);
    rooms.set(code, room);
    await saveRoom(room);
    await upstash(["SET", `hustle:poker:at:${body.player_id}`, code, "EX", POKER_ROOM_TTL]);
    sendJson(res, 200, { ok: true, code, bought: buy, state: view(room, body.player_id) });
  }

  // informazioni di una stanza prima di entrare (puntate, posti liberi)
  async function handleInfo(res, body) {
    const code = roomCode(body.code);
    const room = /^[A-Z0-9]{5}$/.test(code) ? await loadRoom(code) : null;
    if (!room || room.closed) return sendJson(res, 404, { error: "Stanza non trovata: controlla il codice" });
    const ps = players(room);
    sendJson(res, 200, { code, sb: room.sb, bb: room.bb, fame: room.fame || 0, minBuy: room.minBuy, maxBuy: room.maxBuy, players: ps.map((p) => p.name), free: MAX_SEATS - ps.length, started: !!room.started,
      seated: isValidPlayerId(body.player_id) && ps.some((p) => p.id === body.player_id) });
  }

  // entra in una stanza (anche a partita iniziata): si gioca dalla mano dopo
  async function handleJoin(res, body) {
    if (!validBody(res, body)) return;
    const code = roomCode(body.code);
    if (!/^[A-Z0-9]{5}$/.test(code)) return sendJson(res, 404, { error: "Stanza non trovata: controlla il codice" });
    await serial(code, async () => {
      const room = await loadRoom(code);
      if (!room || room.closed) return sendJson(res, 404, { error: "Stanza non trovata: controlla il codice" });
      const now = Date.now();
      const mine = room.seats.find((p) => p && p.id === body.player_id);
      // già seduto (app riaperta): si torna al proprio posto, senza comprare altre fiches
      if (mine) {
        mine.lastSeen = now;
        return sendJson(res, 200, { ok: true, code, bought: 0, rejoined: true, state: view(room, body.player_id) });
      }
      if (!validSlot(body.slot)) return sendJson(res, 400, { error: "partita non valida" });
      const at = await upstash(["GET", `hustle:poker:at:${body.player_id}`]);
      if (at && at !== code && (await loadRoom(at)) && !rooms.get(at).closed) return sendJson(res, 409, { error: "sei già seduto a un altro tavolo", code: at });
      if (room.fame && !(Number(body.fame) >= room.fame)) return sendJson(res, 403, { error: `Per questo tavolo serve fama ${room.fame}` });
      const buy = Math.floor(Number(body.buy));
      if (!(buy >= room.minBuy && buy <= room.maxBuy)) return sendJson(res, 400, { error: `Puoi portare da ${fmt(room.minBuy)} a ${fmt(room.maxBuy)}` });
      if (seatPlayer(room, body, buy, now) < 0) return sendJson(res, 409, { error: "Il tavolo è pieno (8 giocatori)" });
      await tick(room, now);
      await saveRoom(room);
      await upstash(["SET", `hustle:poker:at:${body.player_id}`, code, "EX", POKER_ROOM_TTL]);
      sendJson(res, 200, { ok: true, code, bought: buy, state: view(room, body.player_id) });
    });
  }

  // lo stato del tavolo (ogni secondo): fa anche passare il tempo
  async function handleState(res, body) {
    if (!validBody(res, body)) return;
    const code = roomCode(body.code);
    await serial(code, async () => {
      const room = /^[A-Z0-9]{5}$/.test(code) ? await loadRoom(code) : null;
      const gone = closedInfo.get(code);
      if (!room || room.closed) return sendJson(res, 200, { closed: gone && gone.ids.includes(body.player_id) ? gone.why : "La stanza si è chiusa." });
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
      // niente di nuovo: risposta corta (il tempo del turno lo conta il telefono)
      if (body.v === room.v) return sendJson(res, 200, { same: true, v: room.v, turnLeft: room.hand && room.hand.toAct >= 0 ? Math.max(0, room.hand.deadline - now) : 0 });
      sendJson(res, 200, view(room, body.player_id));
    });
  }

  // un'azione nella mano: fold, check, call, raise {amount: puntata totale del giro}
  async function handleAct(res, body) {
    if (!validBody(res, body)) return;
    const code = roomCode(body.code);
    await serial(code, async () => {
      const room = await loadRoom(code);
      if (!room || room.closed) return sendJson(res, 404, { error: "La stanza si è chiusa" });
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

  // compra altre fiches tra una mano e l'altra (fino al massimo del tavolo) / torna a giocare dopo la pausa
  async function handleRebuy(res, body) {
    if (!validBody(res, body)) return;
    const code = roomCode(body.code);
    await serial(code, async () => {
      const room = await loadRoom(code);
      if (!room || room.closed) return sendJson(res, 404, { error: "La stanza si è chiusa" });
      const p = room.seats.find((x) => x && x.id === body.player_id);
      if (!p) return sendJson(res, 403, { error: "Non sei seduto a questo tavolo" });
      const now = Date.now();
      p.lastSeen = now;
      let bought = 0;
      if (body.buy) {
        if (p.inHand && room.hand && room.hand.street !== "done") return sendJson(res, 409, { error: "Aspetta la fine della mano" });
        const buy = Math.floor(Number(body.buy));
        if (!(buy > 0 && p.chips + buy <= room.maxBuy)) return sendJson(res, 400, { error: `Al tavolo puoi avere al massimo ${fmt(room.maxBuy)}` });
        p.chips += buy;
        bought = buy;
        bump(room, `${p.name} compra ${fmt(buy)} di fiches`);
      }
      if (body.back) {
        p.sitOut = false;
        p.missed = 0;
        bump(room, `${p.name} torna a giocare`);
      }
      await tick(room, now);
      await saveRoom(room);
      sendJson(res, 200, { ok: true, bought, state: view(room, body.player_id) });
    });
  }

  // esce quando vuole: le fiches rimaste diventano una vincita da ritirare (e la ritira subito con /claim)
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

  // vincite da ritirare per questa partita (slot): il gioco le aggiunge al conto
  async function handleClaim(res, body) {
    if (!validBody(res, body)) return;
    if (!validSlot(body.slot)) return sendJson(res, 400, { error: "partita non valida" });
    await serial(`cash:${body.player_id}`, async () => {
      const key = `hustle:poker:cash:${body.player_id}`;
      const list = ((await upstash(["LRANGE", key, "0", "-1"])) || []).map((x) => {
        try {
          return JSON.parse(x);
        } catch {
          return null;
        }
      }).filter(Boolean);
      const mine = list.filter((e) => e.slot === body.slot);
      if (!mine.length) return sendJson(res, 200, { amount: 0 });
      const rest = list.filter((e) => e.slot !== body.slot);
      await upstashPipeline([["DEL", key], ...rest.map((e) => ["RPUSH", key, JSON.stringify(e)]), ...(rest.length ? [["EXPIRE", key, CASH_TTL]] : [])]);
      sendJson(res, 200, { amount: mine.reduce((a, e) => a + (Number(e.amount) || 0), 0), items: mine.length });
    });
  }

  // dove sono seduto (per tornare al tavolo riaprendo il gioco)
  async function handleWhere(res, body) {
    if (!validBody(res, body)) return;
    const at = await upstash(["GET", `hustle:poker:at:${body.player_id}`]);
    const room = at ? await loadRoom(at) : null;
    const p = room && !room.closed && room.seats.find((x) => x && x.id === body.player_id);
    sendJson(res, 200, p ? { code: at, slot: p.slot, chips: p.chips } : { code: null });
  }

  return {
    routes: {
      "/hustle/poker/create": handleCreate,
      "/hustle/poker/info": handleInfo,
      "/hustle/poker/join": handleJoin,
      "/hustle/poker/state": handleState,
      "/hustle/poker/act": handleAct,
      "/hustle/poker/rebuy": handleRebuy,
      "/hustle/poker/leave": handleLeave,
      "/hustle/poker/claim": handleClaim,
      "/hustle/poker/where": handleWhere,
    },
    // per le prove
    _test: { score5, best7, handName, rooms },
  };
};
module.exports.STAKES = STAKES;
