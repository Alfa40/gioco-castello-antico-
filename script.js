"use strict";

// CONFIG, OBJECT_TYPES/objectDamageStage, UPGRADES/MELEE_WEAPONS/
// RANGED_WEAPONS/THROWABLES/ENEMY_TYPES, clamp/rand/randInt/dist,
// createRunState/normalizeRun, and every gameplay class (FloatingText,
// Projectile, Pickup, Bomb, Player, Enemy, RemoteInputState, Simulation)
// now live in simulation.js, loaded just before this file (see index.html)
// — they're still ordinary globals here, shared between the two classic
// <script> tags exactly as if this were still one file.

// Top-down pixel-art sprites, pre-baked as PNGs with real alpha transparency
// (the black backgrounds from generation were chroma-keyed out offline, not
// at runtime) so they just draw() directly — no canvas pixel processing here.
// That matters because reading pixel data back out of a canvas that drew a
// file:// image throws a SecurityError ("tainted canvas"), which is exactly
// how most players open this game: unzip and double-click index.html. All
// sprites share the same "facing up" default orientation as the vector
// fallback shapes they replace, so the rotate-by-facing draw code is unchanged.
const SPRITE_SOURCES = {
  player: "generated-images/pixel/player_body.png", // body/head only — the equipped weapon is a separate overlay, see WEAPON keys below
  balordo: "generated-images/pixel/enemy_balordo.png",
  nervoso: "generated-images/pixel/enemy_nervoso.png",
  imprevedibile: "generated-images/pixel/enemy_imprevedibile.png",
  bruto: "generated-images/pixel/enemy_bruto.png",
  tiratore: "generated-images/pixel/enemy_tiratore.png",
  driveby: "generated-images/pixel/enemy_driveby.png",
  // Hands+weapon overlays, floating at chest height in front of the body sprite above — keyed by weapon id (see MELEE_WEAPONS / RANGED_WEAPONS)
  fists: "generated-images/pixel/weapon_fists.png",
  knife1: "generated-images/pixel/weapon_knife1.png",
  knife2: "generated-images/pixel/weapon_knife2.png",
  bat: "generated-images/pixel/weapon_bat.png",
  pole: "generated-images/pixel/weapon_pole.png",
  hammer: "generated-images/pixel/weapon_hammer.png",
  pistol: "generated-images/pixel/weapon_pistol.png",
  smg: "generated-images/pixel/weapon_smg.png",
  sniper: "generated-images/pixel/weapon_sniper.png",
  shotgun: "generated-images/pixel/weapon_shotgun.png",
  rocket: "generated-images/pixel/weapon_rocket.png",
};
// Park obstacles: 5 damage-stage sprites per object type (1 = intatto, 5 =
// quasi distrutto — see OBJECT_TYPES / objectDamageStage / ART_STYLE.md).
for (const name of Object.keys(OBJECT_TYPES)) {
  for (let stage = 1; stage <= 5; stage++) {
    SPRITE_SOURCES[`object_${name}_${stage}`] = `generated-images/pixel/object_${name}_${stage}.png`;
  }
}
// Park background (5 variants, see Simulation.generateParkLayout's
// parkBgIndex) and the drive-by path texture — see ART_STYLE.md's
// "SFONDO PARCO E SENTIERO" section.
for (let i = 1; i <= 5; i++) {
  SPRITE_SOURCES[`park_bg_${i}`] = `generated-images/pixel/park_bg_${i}.png`;
}
SPRITE_SOURCES.park_path = "generated-images/pixel/park_path.png";

const Sprites = {
  ready: {},
  load() {
    for (const [key, src] of Object.entries(SPRITE_SOURCES)) {
      const img = new Image();
      img.onload = () => { this.ready[key] = img; };
      img.src = src;
    }
  },
  get(key) {
    return this.ready[key] || null;
  },
};
Sprites.load();

// Most weapon-hand icons are authored pointing straight "up" (the convention
// Player.draw() rotates around), but a few of the supplied reference images
// were drawn at an angle instead — this corrects just those so every weapon
// still visually points in the aim/facing direction. Value = how far
// clockwise (radians) the art's own barrel/blade points away from "up".
const WEAPON_SPRITE_ANGLE_CORRECTION = {
  smg: 32.5 * Math.PI / 180,
  sniper: 65.5 * Math.PI / 180,
  shotgun: 43.7 * Math.PI / 180,
  rocket: 75.5 * Math.PI / 180,
};

// The humanoid enemy reference portraits hold their arms/item toward the
// BOTTOM of their own frame (their forward/attack direction), unlike the
// weapon icons above and the driveby car — those need a 180deg correction on
// top of the usual facing rotation, or they visually walk/attack backwards.
const ENEMY_SPRITE_ANGLE_CORRECTION = {
  balordo: Math.PI,
  nervoso: Math.PI,
  imprevedibile: Math.PI,
  bruto: Math.PI,
  tiratore: Math.PI,
};

// Draws `img` centered at the current origin, scaled so its longer side
// equals targetMax while preserving its own aspect ratio — the top-down
// sprites have very different width/height ratios (a knife icon vs a car),
// unlike the old front-view sprites which were all authored square.
function drawSpriteFit(ctx, img, targetMax, yOffset = 0) {
  const scale = targetMax / Math.max(img.width, img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, -w / 2, -h / 2 + yOffset, w, h);
  return { w, h };
}

/* =========================================================
   SOUND (tiny synthesized SFX, no external assets)
========================================================= */
const SoundManager = {
  ctx: null,
  muted: false,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  },
  beep(freq, duration, type = "square", volume = 0.05) {
    if (this.muted || !this.ctx) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration);
  },
  attack() { this.beep(180, 0.08, "square", 0.04); },
  hitEnemy() { this.beep(340, 0.06, "square", 0.05); },
  hitPlayer() { this.beep(120, 0.15, "sawtooth", 0.07); },
  ko() { this.beep(90, 0.2, "triangle", 0.08); },
  coin() { this.beep(760, 0.08, "square", 0.04); },
  dash() { this.beep(500, 0.07, "sine", 0.03); },
  shoot() { this.beep(880, 0.05, "square", 0.045); },
  emptyClick() { this.beep(140, 0.05, "square", 0.03); },
  heal() { this.beep(520, 0.12, "sine", 0.05); },
  ammoPickup() { this.beep(660, 0.06, "square", 0.04); },
  throwBomb() { this.beep(300, 0.08, "sine", 0.04); },
  explosion() { this.beep(70, 0.35, "sawtooth", 0.09); },
  wave() { this.beep(220, 0.3, "triangle", 0.06); },
  gameover() { this.beep(80, 0.5, "sawtooth", 0.08); },
};
// Points the simulation code's sound calls (see simulation.js) at this real
// implementation — it defaults to a silent no-op otherwise, which is what
// runs server-side once the simulation also runs in Node (see server.js).
setSound(SoundManager);

/* =========================================================
   SAVE / RESUME
   The run only survives a death via this snapshot — see createRunState's
   own comment (simulation.js). Saved whenever the game actually pauses
   (see Game.openUpgradeMenu), so closing the tab mid-fight loses that wave
   but never the shop progress.
========================================================= */
const SAVE_KEY = "crazyTownSave";

function saveRunState(snapshot) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot));
  } catch (e) {
    // Private browsing / storage disabled: play on without persistence.
  }
}

function loadRunState() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearRunState() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
}

/* =========================================================
   INPUT
========================================================= */
// Standard Gamepad mapping (DualShock 4 over Bluetooth or USB is recognized
// as a "standard" gamepad by Chrome/Edge/Firefox): left stick + D-pad move,
// Cross attacks, R2 shoots, Circle dashes, Options opens the upgrade menu.
const GAMEPAD_BUTTONS = {
  attack: 0, // Cross
  dash: 1, // Circle
  ranged: 7, // R2
  menu: 9, // Options
  selectBomb: 4, // L1 — cycles the selected throwable
  throwBomb: 5, // R1
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
};
const GAMEPAD_STICK_DEADZONE = 0.25;

class InputHandler {
  constructor() {
    this.keys = new Set();
    this.map = {
      KeyW: "up", ArrowUp: "up",
      KeyS: "down", ArrowDown: "down",
      KeyA: "left", ArrowLeft: "left",
      KeyD: "right", ArrowRight: "right",
    };
    window.addEventListener("keydown", e => this.handleDown(e));
    window.addEventListener("keyup", e => this.handleUp(e));
    this.onAttack = null;
    this.onRangedAttack = null;
    this.onDash = null;
    this.onToggleMenu = null;
    this.onThrowBomb = null;
    this.onSelectBomb = null; // (delta) => void, cycles the selection

    this.gamepadConnected = false;
    this.gpMove = { up: false, down: false, left: false, right: false };
    this.gpMoveVec = null; // { x, y } continuous direction from the left stick/d-pad, or null when centered
    this.gpAim = null; // { x, y } unit vector from the right stick, or null when centered
    this.gpAttack = false;
    this.gpRanged = false;
    this.gpDash = false;
    this._gpMenuWasDown = false;
    this._gpSelectWasDown = false;
    this._gpThrowWasDown = false;

    // Touch controls (see Game.bindTouchControls): mutated directly from the
    // joystick/button DOM handlers, polled the same way as gamepad state.
    // There's no touch equivalent of gpAttack or gpRanged — melee is fully
    // automatic (see Player.autoMeleeAttack) and so is ranged fire whenever
    // the aim rests on a target (see Player.autoFireRanged); the right stick
    // only aims, to avoid a redundant manual-fire button on top of that.
    this.touchMove = { up: false, down: false, left: false, right: false };
    this.touchMoveVec = null; // { x, y } continuous direction from the movement stick, or null when centered
    this.touchAim = null; // { x, y } unit vector from the aim stick, or null when centered
    this.touchDash = false;

    window.addEventListener("gamepadconnected", () => this.onGamepadStatusChange());
    window.addEventListener("gamepaddisconnected", () => this.onGamepadStatusChange());
  }
  handleDown(e) {
    if (this.map[e.code]) { this.keys.add(this.map[e.code]); }
    if (e.code === "Space") { e.preventDefault(); if (this.onAttack) this.onAttack(); }
    if (e.code === "KeyF") { if (this.onRangedAttack) this.onRangedAttack(); }
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") { if (this.onDash) this.onDash(); }
    if (e.code === "KeyU" || e.code === "Escape") { if (this.onToggleMenu) this.onToggleMenu(); }
    if (e.code === "KeyG") { if (this.onThrowBomb) this.onThrowBomb(); }
    if (e.code.startsWith("Digit")) {
      const n = parseInt(e.code.slice(5), 10);
      if (n >= 1 && n <= THROWABLES.length && this.onSelectBomb) this.onSelectBomb(n - 1, true);
    }
  }
  handleUp(e) {
    if (this.map[e.code]) { this.keys.delete(this.map[e.code]); }
  }

  onGamepadStatusChange() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const connected = Array.from(pads).some(g => g && g.connected);
    const el = document.getElementById("gamepad-status");
    if (el) {
      el.textContent = connected
        ? "🎮 Controller connesso"
        : "🎮 Nessun controller — premi un tasto sul controller per attivarlo";
      el.classList.toggle("gamepad-connected", connected);
    }
  }

  // Polled once per frame (independent of game state, so Options can still
  // close the pause menu, and the connection status stays up to date).
  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(pads).find(g => g && g.connected);
    if (gp !== undefined && this.gamepadConnected !== !!gp) {
      this.gamepadConnected = !!gp;
      this.onGamepadStatusChange();
    }
    if (!gp) {
      this.gpMove = { up: false, down: false, left: false, right: false };
      this.gpMoveVec = null;
      this.gpAim = null;
      this.gpAttack = this.gpRanged = this.gpDash = false;
      return;
    }

    const lx = gp.axes[0] || 0;
    const ly = gp.axes[1] || 0;
    const b = idx => !!(gp.buttons[idx] && gp.buttons[idx].pressed);

    this.gpMove = {
      left: lx < -GAMEPAD_STICK_DEADZONE || b(GAMEPAD_BUTTONS.dpadLeft),
      right: lx > GAMEPAD_STICK_DEADZONE || b(GAMEPAD_BUTTONS.dpadRight),
      up: ly < -GAMEPAD_STICK_DEADZONE || b(GAMEPAD_BUTTONS.dpadUp),
      down: ly > GAMEPAD_STICK_DEADZONE || b(GAMEPAD_BUTTONS.dpadDown),
    };

    // Continuous direction for true 360° movement: the analog stick wins
    // when tilted past the deadzone; the d-pad (digital, 8-way) is only a
    // fallback for controllers/players who prefer it.
    const stickMag = Math.hypot(lx, ly);
    if (stickMag > GAMEPAD_STICK_DEADZONE) {
      this.gpMoveVec = { x: lx / stickMag, y: ly / stickMag };
    } else {
      const dx = (this.gpMove.right ? 1 : 0) - (this.gpMove.left ? 1 : 0);
      const dy = (this.gpMove.down ? 1 : 0) - (this.gpMove.up ? 1 : 0);
      const dpadMag = Math.hypot(dx, dy);
      this.gpMoveVec = dpadMag > 0 ? { x: dx / dpadMag, y: dy / dpadMag } : null;
    }

    // Right stick steers where the player looks/aims, independent of movement.
    const rx = gp.axes[2] || 0;
    const ry = gp.axes[3] || 0;
    const rMag = Math.hypot(rx, ry);
    this.gpAim = rMag > GAMEPAD_STICK_DEADZONE ? { x: rx / rMag, y: ry / rMag } : null;

    this.gpAttack = b(GAMEPAD_BUTTONS.attack);
    this.gpRanged = b(GAMEPAD_BUTTONS.ranged);
    this.gpDash = b(GAMEPAD_BUTTONS.dash);

    const menuDown = b(GAMEPAD_BUTTONS.menu);
    if (menuDown && !this._gpMenuWasDown && this.onToggleMenu) this.onToggleMenu();
    this._gpMenuWasDown = menuDown;

    const selectDown = b(GAMEPAD_BUTTONS.selectBomb);
    if (selectDown && !this._gpSelectWasDown && this.onSelectBomb) this.onSelectBomb(1, false);
    this._gpSelectWasDown = selectDown;

    const throwDown = b(GAMEPAD_BUTTONS.throwBomb);
    if (throwDown && !this._gpThrowWasDown && this.onThrowBomb) this.onThrowBomb();
    this._gpThrowWasDown = throwDown;
  }

  isDown(dir) { return this.keys.has(dir) || this.gpMove[dir] || this.touchMove[dir]; }

  // Continuous 360° movement direction, when the active input device
  // supports one (gamepad stick or touch joystick) — see Player.update(),
  // which falls back to the digital 8-way isDown() combination otherwise
  // (keyboard has no analog direction to offer).
  get moveVec() { return this.gpMoveVec || this.touchMoveVec || null; }
}

// RemoteInputState (input-shaped adapter fed by messages from the remote
// peer) moved to simulation.js — see Simulation.applyRemoteState.

/* =========================================================
   MULTIPLAYER (WebSocket relay)
========================================================= */
// Talks to server.js, a dumb relay that only pairs two sockets into a room
// (by a short numeric code) and forwards whatever JSON they send each
// other — no game logic lives there. Whoever calls createRoom() is "host"
// and runs the real simulation for both players; whoever calls joinRoom()
// is "guest" and becomes a thin client: it only ships its input over the
// socket and renders the periodic snapshots the host sends back (see
// Game.applySnapshot / Game.sendSnapshot).
class NetworkManager {
  constructor(game) {
    this.game = game;
    this.ws = null;
    this.role = null; // null | "host" | "guest"
    this.roomCode = null;
    this.myId = null; // server-assigned id, unique per connected socket (host included)
    this.hostId = null; // the room's host id — always known once created/joined, ourselves if we are the host
    this.onStatusChange = null; // () => void, hooked up by the UI
  }

  get isMultiplayer() { return this.role !== null; }
  get isHost() { return this.role === "host"; }
  get isGuest() { return this.role === "guest"; }

  wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this.wsUrl());
      } catch (e) { reject(e); return; }
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws-connect-failed"));
      ws.onclose = () => {
        const wasMultiplayer = this.isMultiplayer;
        this.role = null;
        this.roomCode = null;
        this.myId = null;
        this.hostId = null;
        // Only notify the UI when we were actually in an established room:
        // a close that follows a failed *initial* connection attempt (role
        // never got assigned) is already handled by the connect() promise
        // rejecting into the button's own catch — calling notify() here too
        // would race it and immediately blank out that error message.
        if (wasMultiplayer) {
          this.game.onNetworkClosed();
          this.notify();
        }
      };
      ws.onmessage = e => this.handleMessage(e.data);
    });
  }

  notify() { if (this.onStatusChange) this.onStatusChange(); }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async createRoom() {
    await this.connect();
    this.send({ type: "create" });
  }

  async joinRoom(code) {
    await this.connect();
    this.send({ type: "join", code });
  }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    switch (msg.type) {
      case "created":
        this.role = "host";
        this.roomCode = msg.code;
        this.myId = msg.id;
        this.hostId = msg.id; // we are the host
        this.notify();
        break;
      case "joined":
        this.role = "guest";
        this.roomCode = msg.code;
        this.myId = msg.id;
        this.hostId = msg.hostId;
        this.notify();
        break;
      case "join-error":
        this.game.onRoomJoinError(msg.reason);
        break;
      case "peer-joined":
        // Order matters: onPeerJoined() updates the roster the status UI
        // reads the size of — notifying first would show a stale count.
        this.game.onPeerJoined(msg.id);
        this.notify();
        break;
      case "peer-left":
        this.game.onPeerLeft(msg.id);
        this.notify();
        break;
      // "state"/"action" are only ever SENT by a client (to the server,
      // which is the sole simulation authority — see server.js) — a client
      // never receives them. "snapshot" is the one thing every connected
      // client (room creator included) receives and renders from.
      case "snapshot":
        this.game.applySnapshot(msg.state);
        break;
    }
  }

  disconnect() {
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    this.role = null;
    this.roomCode = null;
    this.myId = null;
    this.hostId = null;
  }
}

/* =========================================================
   GAME
========================================================= */
class Game {
  constructor() {
    this.canvas = document.getElementById("gameCanvas");
    this.ctx = this.canvas.getContext("2d");

    // Everything that used to live directly on Game (player, enemies,
    // projectiles, zone/wave state, ...) now lives on this.sim — see
    // simulation.js. The getters below are thin proxies so all the
    // rendering/DOM/shop code further down keeps reading/writing
    // this.player / this.enemies / etc exactly as before.
    this.sim = new Simulation();

    this.network = new NetworkManager(this);
    this.connectedPeerIds = new Set(); // just for the "N/4 connected" status text, see onPeerJoined/onPeerLeft
    this._stateSendTimer = 0;
    // Any multiplayer client: raw snapshots (see applySnapshot) used to
    // interpolate positions smoothly in drawFromSnapshot() instead of teleporting.
    this._snapPrev = null;
    this._snapCurr = null;
    this._snapReceivedAt = 0;
    this._snapInterpDuration = 1 / 100;

    this.input = new InputHandler();
    // In multiplayer these callbacks fork on role: the host (or a solo
    // player) executes the action directly against its own local
    // Simulation exactly as solo play always has; ANY multiplayer client —
    // the room creator included, there is no more "host browser" running
    // the game for everyone — has no local simulation to act on at all, so
    // it always ships the action to the server instead (see NetworkManager
    // / server.js). Every action is also gated on this.player.shopOpen:
    // opening your own shop freezes only your own movement/actions —
    // everyone else keeps playing in real time.
    this.input.onAttack = () => {
      if (this.network.isMultiplayer) { if (this.state === "playing" && !this.player.shopOpen) this.network.send({ type: "action", action: "attack" }); return; }
      if (this.state === "playing" && !this.player.shopOpen) this.player.tryAttack(this.sim);
    };
    this.input.onRangedAttack = () => {
      if (this.network.isMultiplayer) { if (this.state === "playing" && !this.player.shopOpen) this.network.send({ type: "action", action: "rangedAttack" }); return; }
      if (this.state === "playing" && !this.player.shopOpen) this.player.tryRangedAttack(this.sim);
    };
    this.input.onDash = () => {
      if (this.network.isMultiplayer) { if (this.state === "playing" && !this.player.shopOpen) this.network.send({ type: "action", action: "dash" }); return; }
      if (this.state === "playing" && !this.player.shopOpen) this.player.tryDash();
    };
    // Solo play opens the local shop (toggleUpgradeMenu, operates on
    // this.sim directly); any multiplayer client opens its own networked
    // panel instead (toggleGuestShop — the name predates this generalizing
    // to every role, but the mechanism was always role-agnostic: it mirrors
    // this.player.run from the latest snapshot and ships purchases to the
    // server, exactly the same whether you created the room or joined it).
    this.input.onToggleMenu = () => { if (this.network.isMultiplayer) this.toggleGuestShop(); else this.toggleUpgradeMenu(); };
    this.input.onThrowBomb = () => {
      if (this.network.isMultiplayer) { if (this.state === "playing" && !this.player.shopOpen) this.network.send({ type: "action", action: "throwBomb" }); return; }
      if (this.state === "playing" && !this.player.shopOpen) this.sim.throwBomb(this.player);
    };
    this.input.onSelectBomb = (value, absolute) => {
      if (this.network.isMultiplayer) { if (this.state === "playing" && !this.player.shopOpen) this.network.send({ type: "action", action: "selectBomb", value, absolute }); return; }
      if (this.state === "playing" && !this.player.shopOpen) this.sim.selectBomb(value, absolute, this.player);
    };

    this._guestShopMode = null; // guest-only: 'pause' | 'zoneComplete', see openGuestShop
    this._readyRequestPending = false; // guest-only: see closeGuestShop/applyGuestShopSync

    this.state = "menu"; // menu | playing | gameover
    this.lastTime = performance.now();
    this._tickAccumulator = 0; // see loop()'s fixed-timestep accumulator
    this.activeShopSection = null; // null | "house" | "melee" | "ranged" | "bombs" — see openUpgradeMenu()/bindShopTabs()

    this.bindUI();
    this.bindShopTabs();
    this.detectTouchDevice();
    this.bindTouchControls();
    this.bindMultiplayerUI();
    this.setupResponsiveScaling();
    this.updateHUDStatic();
    this.refreshSaveSummary();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // Thin proxies onto this.sim's simulation state (see simulation.js) — the
  // object references themselves are never reassigned from here (only
  // mutated, or replaced wholesale inside Simulation's own methods), so a
  // getter is enough for most; zone/parkPaths/zoneClearPending are also
  // written directly by the guest snapshot-mirroring path below (see
  // applySnapshot/applyGuestShopSync), so those three get setters too.
  get player() { return this.sim.player; }
  get remotePlayers() { return this.sim.remotePlayers; }
  get enemies() { return this.sim.enemies; }
  get projectiles() { return this.sim.projectiles; }
  get pickups() { return this.sim.pickups; }
  get bombs() { return this.sim.bombs; }
  get floatingTexts() { return this.sim.floatingTexts; }
  get parkObjects() { return this.sim.parkObjects; }
  get moneyThisRun() { return this.sim.moneyThisRun; }
  get waveTotalEnemies() { return this.sim.waveTotalEnemies; }
  get waveEnemiesDefeated() { return this.sim.waveEnemiesDefeated; }
  get zone() { return this.sim.zone; }
  set zone(v) { this.sim.zone = v; }
  get parkPaths() { return this.sim.parkPaths; }
  set parkPaths(v) { this.sim.parkPaths = v; }
  get parkBgIndex() { return this.sim.parkBgIndex; }
  set parkBgIndex(v) { this.sim.parkBgIndex = v; }
  get zoneClearPending() { return this.sim.zoneClearPending; }
  set zoneClearPending(v) { this.sim.zoneClearPending = v; }

  bindUI() {
    // In multiplayer, starting/restarting a run is the server's call (it's
    // the sole simulation authority now, see server.js) — a client just
    // asks for it. Solo play stays exactly as before: fully local, no
    // network involved at all. Only the room creator's tab even shows
    // these buttons enabled while connected (see enterGuestWaiting), but
    // the server itself also only honors "startRun" from that same socket.
    document.getElementById("start-btn").addEventListener("click", () => {
      SoundManager.ensure();
      if (this.network.isMultiplayer) { this.network.send({ type: "startRun" }); return; }
      clearRunState(); // starting fresh deliberately abandons any saved run
      this.startRun();
    });
    document.getElementById("continue-btn").addEventListener("click", () => {
      SoundManager.ensure();
      if (this.network.isMultiplayer) { this.network.send({ type: "startRun" }); return; }
      this.resumeRun();
    });
    document.getElementById("restart-btn").addEventListener("click", () => {
      if (this.network.isMultiplayer) { this.network.send({ type: "startRun" }); return; }
      this.startRun();
    });
    document.getElementById("upgrade-continue-btn").addEventListener("click", () => {
      if (this.network.isMultiplayer) this.closeGuestShop();
      else this.closeUpgradeMenu();
    });
    document.getElementById("upgrade-exit-btn").addEventListener("click", () => {
      this.exitRun();
    });
    document.getElementById("mute-btn").addEventListener("click", () => {
      SoundManager.muted = !SoundManager.muted;
      document.getElementById("mute-btn").textContent = SoundManager.muted ? "🔇" : "🔊";
    });
  }

  // Each tab toggles its own section open/closed — clicking the active tab
  // again (or opening a different one) collapses it, so only one section's
  // content (or none, showing just the stats home screen) is visible at a
  // time and nothing needs scrolling past to reach it.
  bindShopTabs() {
    document.querySelectorAll(".shop-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const section = btn.dataset.section;
        this.activeShopSection = this.activeShopSection === section ? null : section;
        this.applyShopSectionVisibility();
      });
    });
  }

  applyShopSectionVisibility() {
    for (const section of ["house", "melee", "ranged", "bombs"]) {
      document.getElementById(`shop-section-${section}`).classList.toggle("hidden", this.activeShopSection !== section);
    }
    document.querySelectorAll(".shop-tab-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.section === this.activeShopSection);
    });
  }

  // Looks up a weapon/throwable's display name by id, regardless of which
  // table it lives in — used by renderShopStats() for "arma con più uccisioni".
  weaponNameById(id) {
    const all = [...MELEE_WEAPONS, ...RANGED_WEAPONS, ...THROWABLES];
    const w = all.find(w => w.id === id);
    return w ? w.name : id;
  }

  // Home screen of the shop: this run's stats for the player currently
  // looking at it — see Player.runStats, updated in damageEnemy().
  renderShopStats() {
    const stats = this.player.runStats;
    document.getElementById("stat-zone").textContent = this.zone;
    document.getElementById("stat-kills").textContent = stats.kills;
    document.getElementById("stat-money-earned").textContent = `${stats.moneyEarned} €`;
    let topWeapon = null, topCount = 0;
    for (const [weaponId, count] of Object.entries(stats.killsByWeapon)) {
      if (count > topCount) { topCount = count; topWeapon = weaponId; }
    }
    document.getElementById("stat-top-weapon").textContent = topWeapon ? `${this.weaponNameById(topWeapon)} (${topCount})` : "—";
  }

  // Shows/hides the "Continua partita" button on the start screen depending
  // on whether a paused run was saved (see saveGame()).
  refreshSaveSummary() {
    const saved = loadRunState();
    const btn = document.getElementById("continue-btn");
    const summary = document.getElementById("save-summary");
    if (saved) {
      btn.classList.remove("hidden");
      summary.classList.remove("hidden");
      summary.textContent = `Partita salvata — Zona ${saved.zone}, € ${saved.run.money}`;
    } else {
      btn.classList.add("hidden");
      summary.classList.add("hidden");
    }
  }

  // Backfills any run fields introduced after a save was written, so an
  // older save doesn't crash against newer content (new upgrade ids, etc.).
  // Restores the shop progress (money, upgrades, weapons, zone reached) from
  // the last save; the wave in progress when it was saved is not replayed,
  // the zone simply restarts fresh — see the SAVE / RESUME header comment.
  // normalizeRun() lives in simulation.js — pure, shared with Simulation.
  resumeRun() {
    const saved = loadRunState();
    if (!saved) { this.startRun(); return; }
    this.sim.resumeRun(saved.run, saved.zone, saved.playerHp);
    this.setState("playing");
    this.startZone();
  }

  // See the SAVE / RESUME header comment: called every time the game
  // actually pauses (openUpgradeMenu), not continuously.
  saveGame() {
    saveRunState({ zone: this.zone, run: this.player.run, playerHp: this.player.hp });
  }

  detectTouchDevice() {
    const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    this.isTouchDevice = isTouch;
    if (isTouch) document.documentElement.classList.add("touch-device");
  }

  // Scales the fixed 960x600 game box to fit the viewport, keeping aspect
  // ratio, via a CSS transform — the canvas keeps its native resolution and
  // every pixel-based HUD/panel style stays correct at any screen size.
  //
  // On a phone/tablet, HUD text and touch controls always live OUTSIDE the
  // field, in strips above/below (portrait) or panels left/right
  // (landscape) — see the .portrait-controls / .landscape-controls CSS,
  // which also owns the fixed pixel size of #game-container for each case
  // (this function just has to know those same totals to compute a
  // matching scale). In portrait specifically, the field itself (canvas
  // only — HUD/controls are untouched) is rotated 90° and scaled up to
  // fill the same width the strips use, instead of being squeezed down to
  // fit a portrait phone's native landscape shape — see
  // #canvas-rotate-wrap in the CSS. A narrow desktop *browser window* (no
  // touch) keeps the old whole-container 90deg-rotate trick instead, since
  // there's no touch UI to place outside the field there.
  setupResponsiveScaling() {
    const container = document.getElementById("game-container");
    // Must match the #game-container width/height in the corresponding CSS class.
    const PORTRAIT_TOTAL = { w: 960, h: 1916 };
    const LANDSCAPE_TOTAL = { w: 1740, h: 700 };

    // env(safe-area-inset-*) is CSS-only — there's no JS API for the real
    // notch/status-bar size — so a hidden probe element with padding driven
    // by env() lets getComputedStyle read back the actual device pixel
    // value. Needed because #game-container itself gets scaled down below:
    // an env()-based padding placed INSIDE it (as CSS) would only end up
    // `inset * scale` real pixels once rendered, not the real inset —
    // nowhere near enough clearance on an actual notch/Dynamic Island. This
    // reads the true value once per fit() and compensates at the container
    // level instead (see below), in real, unscaled pixels.
    const insetProbe = document.createElement("div");
    insetProbe.style.cssText = "position:fixed; top:0; left:0; width:0; height:0; visibility:hidden; pointer-events:none; padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);";
    document.body.appendChild(insetProbe);
    const readInset = () => {
      const cs = getComputedStyle(insetProbe);
      return {
        top: parseFloat(cs.paddingTop) || 0,
        left: parseFloat(cs.paddingLeft) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0,
      };
    };

    const fit = () => {
      const isTouch = document.documentElement.classList.contains("touch-device");
      const portrait = window.innerHeight > window.innerWidth;
      document.documentElement.classList.toggle("portrait-controls", isTouch && portrait);
      document.documentElement.classList.toggle("landscape-controls", isTouch && !portrait);
      if (isTouch) {
        // Touch devices rotate the field visually via CSS (#canvas-rotate-wrap,
        // see style.css) whenever portrait-controls is active, not via this
        // container transform — but bindJoystick()/bindAimStick() still need to
        // know when that CSS rotation is in effect, so they can counter-rotate
        // raw drag input back into the field's own (unrotated) coordinate space.
        this.portraitRotated = portrait;
        const total = portrait ? PORTRAIT_TOTAL : LANDSCAPE_TOTAL;
        if (portrait) {
          // Real notch/status-bar clearance: env() can't be read directly in
          // JS, so insetProbe's computed padding reports the actual device
          // pixel value (see its own comment above). Shrink the space we
          // scale into by that amount, then shift the whole scaled
          // container down by that same real amount so nothing ends up
          // underneath it.
          const inset = readInset();
          // Fill the full device width exactly, edge to edge — no safety
          // margin. PORTRAIT_TOTAL's height (see above) is deliberately
          // sized close to a real phone's proportions at this scale (see
          // style.css's portrait touch-controls comment), clearing both the
          // status bar/notch (inset.top) AND the home-indicator bar on
          // notched iPhones (inset.bottom) — on a real device without a
          // touch-controls cutoff bug, that static budget alone is already
          // enough. As a last-resort safety net for any device whose real
          // insets turn out bigger than that budget assumed, clamp the
          // scale down just enough to keep the whole container on-screen —
          // trading a sliver of width match (still far better than before)
          // for the controls never being cut off below the fold, which
          // matters more.
          let scale = window.innerWidth / total.w;
          const overflow = inset.top + total.h * scale + inset.bottom - window.innerHeight;
          if (overflow > 0) scale = (window.innerHeight - inset.top - inset.bottom) / total.h;
          container.style.transform = `translate(0px, ${inset.top}px) scale(${scale})`;
        } else {
          // Landscape: unchanged fit-both-dimensions behavior, no notch
          // compensation here (that's still handled by the #hud/joystick
          // env(safe-area-inset-left) padding in style.css, same as before).
          const scale = Math.min(window.innerWidth / total.w, window.innerHeight / total.h);
          container.style.transform = `scale(${scale})`;
        }
      } else {
        this.portraitRotated = portrait; // desktop-window-narrow fallback only (no touch UI involved)
        const scale = portrait
          ? Math.min(window.innerWidth / CONFIG.height, window.innerHeight / CONFIG.width)
          : Math.min(window.innerWidth / CONFIG.width, window.innerHeight / CONFIG.height);
        container.style.transform = `rotate(${portrait ? 90 : 0}deg) scale(${scale})`;
      }
    };
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    fit();
  }

  // Touch controls only matter on touch devices, but binding them is harmless
  // elsewhere (the buttons simply never receive touch events on a desktop).
  bindTouchControls() {
    const holdButton = (id, prop) => {
      const el = document.getElementById(id);
      const start = e => { e.preventDefault(); this.input[prop] = true; };
      const end = e => { e.preventDefault(); this.input[prop] = false; };
      el.addEventListener("touchstart", start, { passive: false });
      el.addEventListener("touchend", end, { passive: false });
      el.addEventListener("touchcancel", end, { passive: false });
    };
    holdButton("touch-dash", "touchDash");

    // Routed through the same input.onX callbacks as keyboard/gamepad (see
    // the constructor) rather than calling this.throwBomb()/etc. directly,
    // so a guest's touch controls correctly ship a network action instead
    // of touching a local simulation that doesn't exist on that tab.
    document.getElementById("touch-bomb-throw").addEventListener("touchstart", e => {
      e.preventDefault();
      this.input.onThrowBomb();
    }, { passive: false });
    document.getElementById("touch-bomb-select").addEventListener("touchstart", e => {
      e.preventDefault();
      this.input.onSelectBomb(1, false);
    }, { passive: false });
    document.getElementById("touch-pause").addEventListener("touchstart", e => {
      e.preventDefault();
      this.input.onToggleMenu();
    }, { passive: false });

    this.bindJoystick();
    this.bindAimStick();
  }

  bindJoystick() {
    const base = document.getElementById("joystick-base");
    const knob = document.getElementById("joystick-knob");
    const knobTravel = 74; // logical px the knob can drift from center, independent of screen scale (matches the 2x joystick-base size)
    let touchId = null;

    const update = (clientX, clientY) => {
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const realMaxRadius = rect.width / 2;
      const dx = clientX - cx, dy = clientY - cy;
      const mag = Math.hypot(dx, dy) || 1;
      const clampedFrac = Math.min(mag, realMaxRadius) / realMaxRadius; // 0..1, scale-independent
      // Knob follows the raw finger drag on screen, unrotated — it must visually
      // track the touch itself regardless of how the field underneath is rotated.
      const fx = (dx / mag) * clampedFrac;
      const fy = (dy / mag) * clampedFrac;
      knob.style.transform = `translate(${fx * knobTravel}px, ${fy * knobTravel}px)`;

      // Separately, undo the field's 90deg CSS rotation for the SIMULATION
      // input only: a real on-screen drag has to be mapped back onto the
      // game's own (unrotated) up/down/left/right.
      const [ix, iy] = this.portraitRotated ? [dy, -dx] : [dx, dy];
      const ifx = (ix / mag) * clampedFrac;
      const ify = (iy / mag) * clampedFrac;

      const knobMag = Math.hypot(ifx, ify);
      if (knobMag < 0.2) {
        this.input.touchMove = { up: false, down: false, left: false, right: false };
        this.input.touchMoveVec = null;
      } else {
        this.input.touchMove = { left: ifx < -0.3, right: ifx > 0.3, up: ify < -0.3, down: ify > 0.3 };
        // True 360° direction (unit vector) — see Player.update(), preferred
        // over the 8-way touchMove booleans above whenever it's available.
        this.input.touchMoveVec = { x: ifx / knobMag, y: ify / knobMag };
      }
    };
    const reset = () => {
      touchId = null;
      knob.style.transform = "translate(0, 0)";
      this.input.touchMove = { up: false, down: false, left: false, right: false };
      this.input.touchMoveVec = null;
    };

    base.addEventListener("touchstart", e => {
      e.preventDefault();
      const t = e.changedTouches[0];
      touchId = t.identifier;
      update(t.clientX, t.clientY);
    }, { passive: false });
    base.addEventListener("touchmove", e => {
      e.preventDefault();
      for (const t of e.changedTouches) if (t.identifier === touchId) update(t.clientX, t.clientY);
    }, { passive: false });
    const onEnd = e => {
      e.preventDefault();
      for (const t of e.changedTouches) if (t.identifier === touchId) reset();
    };
    base.addEventListener("touchend", onEnd, { passive: false });
    base.addEventListener("touchcancel", onEnd, { passive: false });
  }

  // Right-hand stick: sets input.touchAim, read the same way as the
  // gamepad's right stick (see Player.update) — direction only (magnitude is
  // just how far the knob is dragged, not an aim-speed), independent of the
  // movement joystick, so ranged auto-fire can be pointed anywhere regardless
  // of where the player walks. There's no touch manual-fire button (removed
  // to avoid confusion alongside auto-fire) — keyboard/gamepad still have one.
  bindAimStick() {
    const base = document.getElementById("aim-stick-base");
    const knob = document.getElementById("aim-stick-knob");
    const knobTravel = 74;
    let touchId = null;

    const update = (clientX, clientY) => {
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const realMaxRadius = rect.width / 2;
      const dx = clientX - cx, dy = clientY - cy;
      const mag = Math.hypot(dx, dy) || 1;
      const clampedFrac = Math.min(mag, realMaxRadius) / realMaxRadius;
      // Knob follows the raw finger drag on screen, unrotated (see bindJoystick).
      const fx = (dx / mag) * clampedFrac;
      const fy = (dy / mag) * clampedFrac;
      knob.style.transform = `translate(${fx * knobTravel}px, ${fy * knobTravel}px)`;

      // Simulation input uses the field-rotation-compensated vector instead.
      const [ix, iy] = this.portraitRotated ? [dy, -dx] : [dx, dy];
      const ifx = (ix / mag) * clampedFrac;
      const ify = (iy / mag) * clampedFrac;
      const knobMag = Math.hypot(ifx, ify);
      this.input.touchAim = knobMag < 0.2 ? null : { x: ifx / knobMag, y: ify / knobMag };
    };
    const reset = () => {
      touchId = null;
      knob.style.transform = "translate(0, 0)";
      this.input.touchAim = null;
    };

    base.addEventListener("touchstart", e => {
      e.preventDefault();
      const t = e.changedTouches[0];
      touchId = t.identifier;
      update(t.clientX, t.clientY);
    }, { passive: false });
    base.addEventListener("touchmove", e => {
      e.preventDefault();
      for (const t of e.changedTouches) if (t.identifier === touchId) update(t.clientX, t.clientY);
    }, { passive: false });
    const onEnd = e => {
      e.preventDefault();
      for (const t of e.changedTouches) if (t.identifier === touchId) reset();
    };
    base.addEventListener("touchend", onEnd, { passive: false });
    base.addEventListener("touchcancel", onEnd, { passive: false });
  }

  /* =======================================================
     MULTIPLAYER
  ======================================================= */

  bindMultiplayerUI() {
    const createBtn = document.getElementById("mp-create-btn");
    const joinBtn = document.getElementById("mp-join-btn");
    const codeInput = document.getElementById("mp-join-code");
    const statusEl = document.getElementById("mp-status");
    const idleRow = document.getElementById("mp-idle-row");
    const leaveBtn = document.getElementById("mp-leave-btn");

    const setStatus = (text, kind) => {
      statusEl.classList.remove("mp-ok", "mp-error");
      if (!text) { statusEl.classList.add("hidden"); statusEl.textContent = ""; return; }
      statusEl.classList.remove("hidden");
      if (kind) statusEl.classList.add(kind);
      statusEl.textContent = text;
    };

    this.network.onStatusChange = () => {
      const net = this.network;
      if (!net.isMultiplayer) {
        idleRow.classList.remove("hidden");
        leaveBtn.classList.add("hidden");
        setStatus("");
        return;
      }
      idleRow.classList.add("hidden");
      leaveBtn.classList.remove("hidden");
      if (net.isHost) {
        const count = this.connectedPeerIds.size + 1; // +1 for ourselves
        setStatus(
          count > 1
            ? `Stanza ${net.roomCode} — ${count}/4 giocatori connessi, condividi il codice per farne entrare altri`
            : `Stanza ${net.roomCode} — condividi il codice, in attesa di altri giocatori (fino a 4 in totale)...`,
          count > 1 ? "mp-ok" : null
        );
      } else if (net.isGuest) {
        setStatus(`Connesso alla stanza ${net.roomCode}. In attesa che l'host avvii la partita...`, "mp-ok");
        this.enterGuestWaiting();
      }
    };

    createBtn.addEventListener("click", async () => {
      setStatus("Connessione al server multiplayer...");
      try { await this.network.createRoom(); }
      catch (e) { setStatus("Impossibile connettersi al server multiplayer.", "mp-error"); }
    });

    joinBtn.addEventListener("click", async () => {
      const code = codeInput.value.trim();
      if (!/^\d{4}$/.test(code)) { setStatus("Inserisci un codice a 4 cifre.", "mp-error"); return; }
      setStatus("Connessione al server multiplayer...");
      try { await this.network.joinRoom(code); }
      catch (e) { setStatus("Impossibile connettersi al server multiplayer.", "mp-error"); }
    });

    leaveBtn.addEventListener("click", () => {
      this.network.disconnect();
      this.connectedPeerIds.clear();
      this._snapPrev = null;
      this._snapCurr = null;
      document.getElementById("mp-wait-overlay").classList.add("hidden");
      this.network.onStatusChange();
      // Neither role has a local fallback simulation anymore (see
      // onNetworkClosed) — leaving the room always means back to the menu.
      this.setState("menu");
    });
  }

  // Shows a plain "waiting for the host" panel in place of the normal
  // start-screen content once we've joined as guest — a guest never runs
  // startRun()/resumeRun() itself, it just waits for snapshots to arrive.
  enterGuestWaiting() {
    document.getElementById("save-summary").classList.add("hidden");
    document.getElementById("continue-btn").classList.add("hidden");
    document.getElementById("start-btn").classList.add("hidden");
  }

  onRoomJoinError(reason) {
    const statusEl = document.getElementById("mp-status");
    statusEl.classList.remove("hidden");
    statusEl.classList.remove("mp-ok");
    statusEl.classList.add("mp-error");
    statusEl.textContent = reason === "full" ? "Quella stanza è già piena." : "Codice stanza non valido.";
  }

  // Purely a lightweight roster for the "N/4 giocatori connessi" status
  // text (see bindMultiplayerUI) — no real Player objects live client-side
  // for multiplayer anymore; the server's own Simulation (see server.js) is
  // the only place those exist now, for every participant including
  // whoever created the room.
  onPeerJoined(id) {
    this.connectedPeerIds.add(id);
  }

  onPeerLeft(id) {
    this.connectedPeerIds.delete(id);
    // No special handling needed even if it was the room's original
    // creator — the server keeps the simulation going for whoever's left
    // (see server.js's promoteRemoteToPrimary), and every client only ever
    // depended on its OWN connection to the server, never on a peer.
  }

  // Our own socket closed (not a "peer-left" relay message about someone
  // else — our actual connection to the server dropped). Every multiplayer
  // client is an equally thin client with no local fallback simulation
  // (the room creator included), so this always means heading back to the
  // menu, regardless of role.
  onNetworkClosed() {
    this.connectedPeerIds.clear();
    this._snapPrev = null;
    this._snapCurr = null;
    document.getElementById("mp-wait-overlay").classList.add("hidden");
    this.setState("menu");
  }

  // spawnOffsetFor/repositionRemotePlayers/activePlayers/combinedPlayerLevel/
  // nearestPlayerTo all moved to Simulation (simulation.js) — reach them via
  // this.sim.X where still needed below.

  // applyRemoteState/applyRemoteAction/sendSnapshot all moved to the
  // server (see server.js and Simulation.applyRemoteState/
  // applyRemoteAction/toSnapshot in simulation.js) — no client ever runs
  // the multiplayer simulation anymore, so there's nothing here to apply
  // incoming input to or broadcast a snapshot of.

  // Every multiplayer client (room creator included): stashes the raw
  // snapshot (prev + newly arrived) with a
  // wall-clock timestamp, so drawFromSnapshot() can interpolate positions
  // between the two rather than teleporting to the new one every ~10ms
  // (see the id-matched lerp in interpolatedList). HUD/UI state itself
  // isn't interpolated — it just tracks the latest snapshot directly.
  applySnapshot(state) {
    if (!this.network.isMultiplayer) return;

    const now = performance.now();
    if (this._snapCurr) {
      this._snapPrev = this._snapCurr;
      // Measured, not assumed: real arrival gaps jitter with network
      // conditions, so blending against the configured send rate would
      // drift out of sync with actual delivery timing.
      this._snapInterpDuration = clamp((now - this._snapReceivedAt) / 1000, 0.001, 0.5);
    } else {
      this._snapPrev = state; // first snapshot ever: nothing to blend from yet
      this._snapInterpDuration = 1 / 100;
    }
    this._snapCurr = state;
    this._snapReceivedAt = now;

    this.zone = state.zone; // lets drawBackground()'s darkness-by-zone logic work unmodified
    this.parkPaths = state.parkPaths || []; // static, so drawBackground()'s path strips just work unmodified too
    this.parkBgIndex = state.parkBgIndex || 1;
    this.applyGuestUIState();
  }

  // Drives the start-screen/HUD/gameover overlays purely off the latest
  // snapshot, since the guest has no independent notion of game state.
  applyGuestUIState() {
    const s = this._snapCurr;
    if (!s) return;
    if (s.gameState === "menu") {
      this.setState("menu");
      this.enterGuestWaiting();
    } else if (s.gameState === "gameover") {
      this.setState("gameover");
      document.getElementById("final-zone").textContent = s.finalZone;
      document.getElementById("final-money").textContent = s.finalMoney;
      // Only the room creator's tab can start a new run (mirrors
      // server.js's startRun guard) — everyone else just waits for it.
      document.getElementById("gameover-guest-note").classList.toggle("hidden", this.network.isHost);
      document.getElementById("restart-btn").classList.toggle("hidden", !this.network.isHost);
    } else {
      this.setState("playing");
      this.updateHUDFromSnapshot(s);
      this.applyGuestShopSync(s);
    }
  }

  // Raw snapshot fields only (flat meleeName/rangedName/ammo, not the
  // nested shape mkPlayer() builds for drawing) — HUD text doesn't need
  // interpolation, the latest value is always fine to show immediately.
  updateHUDFromSnapshot(s) {
    const me = s.players.find(p => p.id === this.network.myId);
    if (me) {
      const hpFrac = clamp(me.hp / me.maxHp, 0, 1);
      document.getElementById("hp-fill").style.width = `${hpFrac * 100}%`;
      document.getElementById("hp-label").textContent = `${Math.round(me.hp)} / ${me.maxHp}`;
      const weaponLabel = document.getElementById("weapon-label");
      weaponLabel.textContent = me.rangedName
        ? `${me.meleeName} · ${me.rangedName} (${me.ammo}/${me.maxAmmo})`
        : me.meleeName;
      if (me.run) document.getElementById("money-label").textContent = `€ ${me.run.money}`;
    }
    document.getElementById("zone-label").textContent = `Zona ${s.zone} — ${s.zoneName}`;
    document.getElementById("wave-label").textContent = `Nemici rimasti: ${Math.max(0, s.waveTotal - s.waveDefeated)}`;
  }

  // Any multiplayer client: keeps this.player mirroring MY OWN entry from
  // the latest snapshot (run/ammo/ranged + derived stats via
  // refreshLoadout) so every render*/buy* method below works unchanged
  // whether the shop is open on the room creator's tab or a joiner's — see
  // openGuestShop/closeGuestShop and the isMultiplayer fork at the top of
  // each buyX() handler.
  applyGuestShopSync(s) {
    const me = s.players.find(p => p.id === this.network.myId);
    if (me && me.run) {
      this.player.run = me.run;
      this.player.ammo = me.ammo;
      this.player.ranged = me.rangedName ? { name: me.rangedName, maxAmmo: me.maxAmmo } : null;
      // Seed refreshLoadout's tier-change tracking from the host's real
      // values first — otherwise the very first sync on a fresh mirror
      // (both start null) reads as "just switched weapons" and stomps the
      // ammo count above back to full.
      this.player._rangedWeaponId = me.rangedId;
      this.player._rangedMaxAmmo = me.maxAmmo;
      this.player.refreshLoadout(this.player.run);
      this.player.readyForNextZone = !!me.ready;
    }
    this.zoneClearPending = !!s.zoneClearPending;
    // Once the server confirms our ready state (or the zone has actually
    // advanced), the optimistic "don't reopen" window from closeGuestShop
    // is no longer needed.
    if (!this.zoneClearPending || (me && me.ready)) this._readyRequestPending = false;

    const shopScreenHidden = document.getElementById("upgrade-screen").classList.contains("hidden");
    if (this.zoneClearPending && shopScreenHidden && !(me && me.ready) && !this._readyRequestPending) {
      this.openGuestShop("zoneComplete");
    } else if (!shopScreenHidden && this._guestShopMode) {
      this.renderShopContent(); // keep the open panel's numbers fresh as new snapshots arrive
    }
    this.updateWaitOverlay(s);
  }

  // Shown on both host and guest tabs whenever the wave is cleared and at
  // least one active (alive) player hasn't confirmed ready yet, so nobody's
  // left wondering why the field is still empty while someone else shops.
  updateWaitOverlay(s) {
    const overlay = document.getElementById("mp-wait-overlay");
    const shopOpen = !document.getElementById("upgrade-screen").classList.contains("hidden");
    if (!this.zoneClearPending || shopOpen) { overlay.classList.add("hidden"); return; }
    const alive = s ? s.players.filter(p => p.hp > 0) : this.sim.activePlayers;
    const readyCount = s ? alive.filter(p => p.ready).length : alive.filter(p => p.readyForNextZone).length;
    overlay.querySelector(".desc").textContent =
      `In attesa che tutti i giocatori siano pronti per la prossima zona… (${readyCount}/${alive.length})`;
    overlay.classList.remove("hidden");
  }

  // Guest-only mirror of openUpgradeMenu/closeUpgradeMenu/toggleUpgradeMenu:
  // there's no host-authoritative pause to flip, just this tab's own
  // overlay — this.player.run/stats are kept fresh by applyGuestShopSync.
  openGuestShop(mode) {
    this._guestShopMode = mode;
    this.player.shopOpen = true;
    const title = document.getElementById("upgrade-title");
    const subtitle = document.getElementById("upgrade-subtitle");
    const btn = document.getElementById("upgrade-continue-btn");
    if (mode === "zoneComplete") {
      title.textContent = `Zona ${this.zone} completata!`;
      subtitle.textContent = "Spendi i tuoi soldi, poi conferma di essere pronto per la prossima zona.";
      btn.textContent = "Pronto";
    } else {
      title.textContent = "Pausa — Potenzia casa";
      subtitle.textContent = "";
      btn.textContent = "Riprendi";
    }
    this.renderShopStats();
    this.activeShopSection = null;
    this.applyShopSectionVisibility();
    this.renderShopContent();
    document.getElementById("upgrade-screen").classList.remove("hidden");
    document.getElementById("mp-wait-overlay").classList.add("hidden");
  }

  closeGuestShop() {
    document.getElementById("upgrade-screen").classList.add("hidden");
    this.player.shopOpen = false;
    if (this._guestShopMode === "zoneComplete") {
      this.network.send({ type: "action", action: "readyForNextZone" });
      // The server hasn't echoed our own "ready" back in a snapshot yet —
      // without this flag, a snapshot arriving in that gap still shows
      // zoneClearPending && !me.ready, and applyGuestShopSync would pop the
      // shop panel back open right after we just closed it.
      this._readyRequestPending = true;
    }
    this._guestShopMode = null;
    this.updateWaitOverlay(this._snapCurr);
  }

  // "Esci" in the shop screen (either pause or zoneComplete, host or guest):
  // leaves the current run entirely and returns to the start screen. Solo
  // play is saved first so "Continua partita" can pick it back up later —
  // multiplayer has no equivalent mid-run save, so it just disconnects
  // (same cleanup as the "Lascia la stanza" button; the server keeps the
  // room going for whoever's left, see onPeerLeft).
  exitRun() {
    if (this.network.isMultiplayer) {
      this.network.disconnect();
      this.connectedPeerIds.clear();
      this._snapPrev = null;
      this._snapCurr = null;
      this.network.onStatusChange();
    } else {
      this.player.shopOpen = false;
      this.saveGame();
    }
    this.menuMode = null;
    this._guestShopMode = null;
    this.setState("menu");
    this.refreshSaveSummary();
  }

  toggleGuestShop() {
    if (this.state !== "playing") return;
    const hidden = document.getElementById("upgrade-screen").classList.contains("hidden");
    if (hidden) this.openGuestShop(this._guestShopMode || "pause");
    else this.closeGuestShop();
  }

  lerp(a, b, t) { return a + (b - a) * t; }

  // Shortest-path angle blend, so e.g. facing -3.1 -> 3.1 rad doesn't spin
  // the long way around through 0 — it should visibly barely turn at all.
  lerpAngle(a, b, t) {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  // Blends `posKeys`/`angleKeys` from the matching (by id) entry in
  // prevList into currList at fraction t; an entity with no match (just
  // spawned) is used as-is — nothing to blend from yet, so it simply pops
  // in rather than sliding from nowhere.
  interpolatedList(prevList, currList, t, posKeys, angleKeys) {
    const prevById = new Map((prevList || []).map(e => [e.id, e]));
    return currList.map(curr => {
      const prev = prevById.get(curr.id);
      if (!prev) return curr;
      const merged = { ...curr };
      for (const k of posKeys) merged[k] = this.lerp(prev[k], curr[k], t);
      for (const k of angleKeys) merged[k] = this.lerpAngle(prev[k], curr[k], t);
      return merged;
    });
  }

  // Reconstruct lightweight, draw()-able instances from (interpolated)
  // snapshot data, reusing the exact same class draw() methods rather than
  // duplicating any rendering logic. Called fresh every frame in
  // drawFromSnapshot() since the interpolated numbers change every frame.
  mkEnemy(e) {
    return Object.assign(Object.create(Enemy.prototype), {
      x: e.x, y: e.y, facing: e.facing, hp: e.hp, maxHp: e.maxHp, radius: e.radius,
      type: ENEMY_TYPES.find(t => t.id === e.typeId) || ENEMY_TYPES[0],
      hitFlash: e.hitFlash, isMoving: e.isMoving, walkPhase: e.walkPhase,
      ccTimer: e.ccTimer, ccType: e.ccType, drivebyDir: e.drivebyDir, dead: false,
    });
  }
  mkProjectile(p) {
    return Object.assign(Object.create(Projectile.prototype), {
      x: p.x, y: p.y, radius: p.radius, owner: p.owner, splashRadius: p.splashRadius, dead: false,
    });
  }
  mkPickup(p) {
    return Object.assign(Object.create(Pickup.prototype), {
      x: p.x, y: p.y, kind: p.kind, life: p.life, radius: CONFIG.pickup.radius, dead: false,
    });
  }
  mkBomb(b) {
    return Object.assign(Object.create(Bomb.prototype), {
      x: b.x, y: b.y, type: THROWABLES.find(t => t.id === b.typeId) || THROWABLES[0],
      exploded: b.exploded, effectTimer: b.effectTimer, fuse: b.fuseDuration, dead: false,
    });
  }
  mkText(ft) {
    return Object.assign(Object.create(FloatingText.prototype), {
      x: ft.x, y: ft.y, text: ft.text, color: ft.color, life: ft.life, maxLife: ft.maxLife,
    });
  }
  mkPlayer(p) {
    return Object.assign(Object.create(Player.prototype), {
      x: p.x, y: p.y, facing: p.facing, aimAngle: p.aimAngle, radius: p.radius,
      hp: p.hp, maxHp: p.maxHp,
      melee: { id: p.meleeId, name: p.meleeName, range: p.meleeRange || 0 },
      ranged: p.rangedName ? { name: p.rangedName } : null,
      _rangedWeaponId: p.rangedId, ammo: p.ammo,
      hitFlash: p.hitFlash, isMoving: p.isMoving, walkPhase: p.walkPhase,
      attackActiveTimer: p.attackActiveTimer, invulnTimer: p.isInvulnerable ? 1 : 0,
    });
  }

  // zoneName/enemyStatsForZone/startZone/generateParkLayout/
  // damageParkObject/resolveObjectCollisions/spawnEnemy/spawnDriveby/
  // spawnProjectile/spawnEnemyProjectile/selectBomb/grenadeDamageForZone/
  // throwBomb/findNearestInCone/aimAssist/findAutoFireAngle/damageEnemy/
  // onDrivebyExit/rollPickupDrop/collectPickup/onPlayerHit all moved to
  // Simulation (simulation.js) — reach them via this.sim.X.
  startRun() {
    this.sim.startRun();
    this.setState("playing");
  }

  toggleUpgradeMenu() {
    if (this.state !== "playing") return;
    if (!this.player.shopOpen) this.openUpgradeMenu("pause");
    else this.closeUpgradeMenu();
  }

  // Host's own local shop panel. Opening it no longer pauses the whole
  // game (see this.player.shopOpen and update()'s per-player gating) — it
  // only freezes the host's own movement/actions, everyone else (other
  // players, enemies, spawns) keeps going in real time.
  openUpgradeMenu(mode) {
    this.menuMode = mode; // 'pause' | 'zoneComplete'
    this.player.shopOpen = true;
    const title = document.getElementById("upgrade-title");
    const subtitle = document.getElementById("upgrade-subtitle");
    const btn = document.getElementById("upgrade-continue-btn");
    if (mode === "zoneComplete") {
      title.textContent = `Zona ${this.zone} completata!`;
      subtitle.textContent = "Spendi i tuoi soldi, poi conferma di essere pronto per la prossima zona.";
      btn.textContent = "Pronto";
    } else {
      title.textContent = "Pausa — Potenzia casa";
      subtitle.textContent = "";
      btn.textContent = "Riprendi";
    }
    this.renderShopStats();
    this.activeShopSection = null; // always land on the stats home screen first
    this.applyShopSectionVisibility();
    this.renderShopContent();
    document.getElementById("upgrade-screen").classList.remove("hidden");
    document.getElementById("mp-wait-overlay").classList.add("hidden");
    this.saveGame();
  }

  // Shared by openUpgradeMenu (host) and applyGuestShopSync (guest, on every
  // fresh snapshot while their panel stays open) — everything here reads
  // off this.player.run/this.player, which is either the real thing (host)
  // or a mirror kept fresh from the network (guest).
  renderShopContent() {
    const run = this.player.run;
    this.renderUpgradeList();
    this.renderWeaponList("melee-weapon-list", MELEE_WEAPONS, run.meleeTier, run.meleeWeaponUpgrades, (idx) => this.buyMeleeWeapon(idx));
    this.renderWeaponUpgrades("melee-weapon-upgrades-section", "melee-weapon-upgrades", MELEE_WEAPONS, run.meleeTier, run.meleeWeaponUpgrades, (id, cost) => this.buyMeleeWeaponUpgrade(id, cost));
    this.renderWeaponList("ranged-weapon-list", RANGED_WEAPONS, run.rangedTier, run.rangedWeaponUpgrades, (idx) => this.buyRangedWeapon(idx));
    if (run.rangedTier >= 0) {
      this.renderWeaponUpgrades("ranged-weapon-upgrades-section", "ranged-weapon-upgrades", RANGED_WEAPONS, run.rangedTier, run.rangedWeaponUpgrades, (id, cost) => this.buyRangedWeaponUpgrade(id, cost));
    } else {
      document.getElementById("ranged-weapon-upgrades-section").classList.add("hidden");
    }
    this.renderAmmoShop();
    this.renderBombShop();
  }

  closeUpgradeMenu() {
    document.getElementById("upgrade-screen").classList.add("hidden");
    this.player.shopOpen = false;
    if (this.menuMode === "zoneComplete") {
      this.player.readyForNextZone = true;
      this.sim.tryAdvanceZone();
    }
    this.menuMode = null;
    this.updateWaitOverlay();
  }

  // beginZoneClear/tryAdvanceZone moved to Simulation — see
  // this.sim.tryAdvanceZone() above; beginZoneClear() is called internally
  // by Simulation.tick() (see justEnteredZoneClear in update() below).

  renderUpgradeList() {
    const run = this.player.run;
    const list = document.getElementById("upgrade-list");
    list.innerHTML = "";
    UPGRADES.forEach(upg => {
      const level = run.upgrades[upg.id] || 0;
      const maxed = level >= upg.maxLevel;
      const cost = maxed ? null : this.sim.costFor(upg, level);

      const card = document.createElement("div");
      card.className = "upgrade-card";
      card.innerHTML = `
        <h3>${upg.name}</h3>
        <p>${upg.desc}</p>
        <div class="row">
          <span class="level">Lv. ${level}/${upg.maxLevel}</span>
          <button ${maxed || cost > run.money ? "disabled" : ""}>
            ${maxed ? "MAX" : `Acquista — ${cost}€`}
          </button>
        </div>
      `;
      if (!maxed) {
        card.querySelector("button").addEventListener("click", () => this.buyUpgrade(upg.id));
      }
      list.appendChild(card);
    });
    document.getElementById("upgrade-money").textContent = `€ ${run.money}`;
  }

  // applyUpgradePurchase (pure mutation, no UI/network side effects) moved
  // to Simulation — shared by this handler and applyRemoteAction (guest
  // purchases, applied host-side to that guest's own player).
  buyUpgrade(id) {
    if (this.network.isMultiplayer) { this.network.send({ type: "action", action: "buyUpgrade", id }); return; }
    this.sim.applyUpgradePurchase(this.player, id);
    this.renderUpgradeList();
    this.updateHUDStatic();
  }

  // Shared renderer for the sequential melee/ranged weapon tracks: only the
  // next tier is ever purchasable, earlier tiers show as owned, later ones
  // as locked (behind a minimum zone reached this run, or behind fully
  // upgrading the weapon currently in hand).
  renderWeaponList(containerId, weapons, currentTier, ownedUpgradeIds, onBuy) {
    const list = document.getElementById(containerId);
    list.innerHTML = "";
    weapons.forEach((weapon, idx) => {
      const owned = idx <= currentTier;
      const isNext = idx === currentTier + 1;
      const zoneLocked = weapon.minZone && this.zone < weapon.minZone;
      const currentWeapon = weapons[currentTier];
      const upgradesComplete = allWeaponUpgradesOwned(currentWeapon, ownedUpgradeIds);

      const card = document.createElement("div");
      card.className = "upgrade-card";
      let statusHtml;
      if (owned) {
        statusHtml = `<span class="level">${idx === currentTier ? "In uso" : "Sbloccata"}</span><button disabled>Posseduta</button>`;
      } else if (!isNext) {
        statusHtml = `<span class="level">Bloccata</span><button disabled>Compra prima l'arma precedente</button>`;
      } else if (!upgradesComplete) {
        statusHtml = `<span class="level">Bloccata</span><button disabled>Completa prima i potenziamenti di ${currentWeapon.name}</button>`;
      } else if (zoneLocked) {
        statusHtml = `<span class="level">Bloccata</span><button disabled>Si sblocca alla zona ${weapon.minZone}</button>`;
      } else {
        const affordable = weapon.cost <= this.player.run.money;
        statusHtml = `<span class="level">&nbsp;</span><button ${affordable ? "" : "disabled"}>Acquista — ${weapon.cost}€</button>`;
      }

      card.innerHTML = `<h3>${weapon.name}</h3><p>${weapon.desc}</p><div class="row">${statusHtml}</div>`;
      if (isNext && !zoneLocked && upgradesComplete) {
        card.querySelector("button").addEventListener("click", () => onBuy(idx));
      }
      list.appendChild(card);
    });
  }

  // Per-tier weapon upgrades (grip/blade/spikes/scope/stock/barrel/mag...),
  // shown for whichever tier is currently equipped. Buying every upgrade
  // here is what unlocks the next weapon tier in the list above.
  renderWeaponUpgrades(sectionId, containerId, weapons, currentTier, ownedUpgradeIds, onBuyUpgrade) {
    const weapon = weapons[currentTier];
    const section = document.getElementById(sectionId);
    const container = document.getElementById(containerId);
    if (!weapon || !weapon.upgrades || weapon.upgrades.length === 0) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");
    const heading = section.querySelector(".section-title");
    if (heading) heading.textContent = `Potenzia: ${weapon.name}`;

    const owned = new Set(ownedUpgradeIds);
    container.innerHTML = "";
    weapon.upgrades.forEach(upg => {
      const isOwned = owned.has(upg.id);
      const affordable = upg.cost <= this.player.run.money;
      const card = document.createElement("div");
      card.className = "upgrade-card";
      card.innerHTML = `
        <h3>${upg.name}</h3>
        <p>${upg.desc}</p>
        <div class="row">
          <span class="level">&nbsp;</span>
          <button ${isOwned || !affordable ? "disabled" : ""}>${isOwned ? "Posseduto" : `Acquista — ${upg.cost}€`}</button>
        </div>
      `;
      if (!isOwned) {
        card.querySelector("button").addEventListener("click", () => onBuyUpgrade(upg.id, upg.cost));
      }
      container.appendChild(card);
    });
  }

  // applyMeleeWeaponPurchase/applyRangedWeaponPurchase/
  // applyMeleeWeaponUpgradePurchase/applyRangedWeaponUpgradePurchase all
  // moved to Simulation — same pattern as buyUpgrade above.
  buyMeleeWeapon(idx) {
    if (this.network.isMultiplayer) { this.network.send({ type: "action", action: "buyMeleeWeapon", idx }); return; }
    this.sim.applyMeleeWeaponPurchase(this.player, idx);
    this.renderShopContent();
    this.updateHUDStatic();
  }

  buyRangedWeapon(idx) {
    if (this.network.isMultiplayer) { this.network.send({ type: "action", action: "buyRangedWeapon", idx }); return; }
    this.sim.applyRangedWeaponPurchase(this.player, idx);
    this.renderShopContent();
    this.updateHUDStatic();
  }

  buyMeleeWeaponUpgrade(id, cost) {
    if (this.network.isMultiplayer) { this.network.send({ type: "action", action: "buyMeleeWeaponUpgrade", id, cost }); return; }
    this.sim.applyMeleeWeaponUpgradePurchase(this.player, id, cost);
    this.renderShopContent();
    this.updateHUDStatic();
  }

  buyRangedWeaponUpgrade(id, cost) {
    if (this.network.isMultiplayer) { this.network.send({ type: "action", action: "buyRangedWeaponUpgrade", id, cost }); return; }
    this.sim.applyRangedWeaponUpgradePurchase(this.player, id, cost);
    this.renderShopContent();
    this.updateHUDStatic();
  }

  // Ammo is a separate consumable purchase (not a permanent tier): refills
  // the equipped gun's pool by a fixed chunk, capped at its max capacity.
  renderAmmoShop() {
    const section = document.getElementById("ammo-shop-section");
    const container = document.getElementById("ammo-shop");
    if (!this.player.ranged) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");
    const run = this.player.run;
    const weapon = RANGED_WEAPONS[run.rangedTier];
    const cap = weapon.maxAmmo;
    const current = this.player.ammo;
    const chunk = Math.min(10, cap - current);
    const cost = Math.ceil(chunk * weapon.costPerAmmo);

    container.innerHTML = "";
    const card = document.createElement("div");
    card.className = "upgrade-card";
    card.innerHTML = `
      <h3>Munizioni — ${weapon.name}</h3>
      <p>Scorta attuale: ${current}/${cap}</p>
      <div class="row">
        <span class="level">&nbsp;</span>
        <button ${chunk <= 0 || cost > run.money ? "disabled" : ""}>
          ${chunk <= 0 ? "Scorta piena" : `Rifornisci +${chunk} — ${cost}€`}
        </button>
      </div>
    `;
    if (chunk > 0) {
      card.querySelector("button").addEventListener("click", () => this.buyAmmo());
    }
    container.appendChild(card);
  }

  // applyAmmoPurchase moved to Simulation.
  buyAmmo() {
    if (this.network.isMultiplayer) { this.network.send({ type: "action", action: "buyAmmo" }); return; }
    this.sim.applyAmmoPurchase(this.player);
    this.renderAmmoShop();
    this.updateHUDStatic();
  }

  renderBombShop() {
    const run = this.player.run;
    const container = document.getElementById("bomb-shop");
    container.innerHTML = "";
    THROWABLES.forEach(type => {
      const count = run.bombs[type.id] || 0;
      const cap = this.sim.bombCapacityFor(type, this.player);
      const atCap = count >= cap;
      const affordable = type.cost <= run.money;
      const card = document.createElement("div");
      card.className = "upgrade-card";
      card.innerHTML = `
        <h3>${type.name}</h3>
        <p>${type.desc}</p>
        <div class="row">
          <span class="level">In tasca: ${count}/${cap}</span>
          <button ${atCap || !affordable ? "disabled" : ""}>
            ${atCap ? "Scorta piena" : `Acquista — ${type.cost}€`}
          </button>
        </div>
      `;
      if (!atCap) {
        card.querySelector("button").addEventListener("click", () => this.buyBomb(type.id));
      }
      container.appendChild(card);
    });
  }

  // applyBombPurchase moved to Simulation.
  buyBomb(id) {
    if (this.network.isMultiplayer) { this.network.send({ type: "action", action: "buyBomb", id }); return; }
    this.sim.applyBombPurchase(this.player, id);
    this.renderBombShop();
    this.updateHUDStatic();
  }

  setState(state) {
    this.state = state;
    document.getElementById("start-screen").classList.toggle("hidden", state !== "menu");
    document.getElementById("gameover-screen").classList.toggle("hidden", state !== "gameover");
    document.getElementById("hud").classList.toggle("hidden", state === "menu");
    document.getElementById("pause-hint").classList.toggle("hidden", state === "menu" || state === "gameover");
    // Shop visibility is no longer tied to a global "paused" state (see
    // this.player.shopOpen) — only force it closed when leaving a run
    // entirely, so nobody's left staring at a stale shop screen.
    if (state === "menu" || state === "gameover") {
      document.getElementById("upgrade-screen").classList.add("hidden");
      document.getElementById("mp-wait-overlay").classList.add("hidden");
    }
  }

  triggerGameOver() {
    this.setState("gameover");
    SoundManager.gameover();
    clearRunState(); // death wipes the run — nothing left worth resuming
    document.getElementById("final-zone").textContent = this.zone;
    document.getElementById("final-money").textContent = Math.max(0, this.moneyThisRun);
  }

  updateHUDStatic() {
    document.getElementById("money-label").textContent = `€ ${this.player.run.money}`;
  }

  updateHUD() {
    const hpFrac = clamp(this.player.hp / this.player.maxHp, 0, 1);
    document.getElementById("hp-fill").style.width = `${hpFrac * 100}%`;
    document.getElementById("hp-label").textContent = `${Math.round(this.player.hp)} / ${this.player.maxHp}`;
    document.getElementById("zone-label").textContent = `Zona ${this.zone} — ${zoneName(this.zone)}`;
    const remaining = this.waveTotalEnemies - this.waveEnemiesDefeated;
    document.getElementById("wave-label").textContent = `Nemici rimasti: ${remaining}`;
    document.getElementById("money-label").textContent = `€ ${this.player.run.money}`;

    const dashFrac = 1 - clamp(this.player.dashCooldownTimer / this.player.stats.dashCooldown, 0, 1);
    let fill = document.querySelector("#dash-indicator .fill");
    if (!fill) {
      fill = document.createElement("div");
      fill.className = "fill";
      document.getElementById("dash-indicator").appendChild(fill);
    }
    fill.style.width = `${dashFrac * 100}%`;

    const weaponLabel = document.getElementById("weapon-label");
    weaponLabel.textContent = this.player.ranged
      ? `${this.player.melee.name} · ${this.player.ranged.name} (${this.player.ammo}/${this.player.ranged.maxAmmo})`
      : this.player.melee.name;

    const rangedIndicator = document.getElementById("ranged-indicator");
    if (this.player.ranged) {
      rangedIndicator.classList.remove("hidden");
      const rFrac = 1 - clamp(this.player.rangedCooldownTimer / this.player.ranged.cooldown, 0, 1);
      let rFill = rangedIndicator.querySelector(".fill");
      if (!rFill) {
        rFill = document.createElement("div");
        rFill.className = "fill ranged-fill";
        rangedIndicator.appendChild(rFill);
      }
      rFill.style.width = `${rFrac * 100}%`;
    } else {
      rangedIndicator.classList.add("hidden");
    }
    const bombType = THROWABLES[this.player.selectedThrowable];
    const bombCount = this.player.run.bombs[bombType.id] || 0;
    document.getElementById("bomb-label").textContent = `${bombType.name} x${bombCount}`;
  }

  // Guest: no local simulation at all — just poll our own input and ship it
  // to the server at a fixed rate (CONFIG.tickRate, same clock the loop()
  // below steps solo play's own simulation at) — this, not this device's
  // own display framerate, is what determines how often our input actually
  // reaches the game, so a weaker phone doesn't feel less responsive than a
  // powerful one. Everything on screen instead comes from
  // applySnapshot()/draw()'s drawFromSnapshot() path. Used by every
  // multiplayer client alike — the room creator included, since nobody's
  // own device simulates anymore (see server.js).
  updateNetworked(dt) {
    this._stateSendTimer -= dt;
    if (this._stateSendTimer <= 0) {
      this._stateSendTimer = 1 / CONFIG.tickRate;
      // My own shop is open: send neutral input so the server holds my
      // character still (autoFireRanged/autoMeleeAttack act on proximity
      // alone, not held input, so a flag is needed — see applyRemoteState).
      const shopOpen = this.player.shopOpen;
      const move = shopOpen
        ? { up: false, down: false, left: false, right: false }
        : {
            up: this.input.isDown("up"), down: this.input.isDown("down"),
            left: this.input.isDown("left"), right: this.input.isDown("right"),
          };
      const moveVec = shopOpen ? null : this.input.moveVec; // continuous 360° direction, or null (keyboard-only)
      const stickAim = this.input.gpAim || this.input.touchAim;
      const aim = shopOpen ? null : (stickAim ? { x: stickAim.x, y: stickAim.y } : null);
      this.network.send({ type: "state", move, moveVec, aim, shopOpen, isTouchDevice: this.isTouchDevice });
    }
  }

  update(dt) {
    // Any multiplayer client (room creator included) is a thin client:
    // send input, render whatever the server's snapshot says — see
    // server.js, the sole simulation authority once a room exists. Only
    // fully offline/solo play runs a local Simulation.tick() below.
    if (this.network.isMultiplayer) { this.updateNetworked(dt); return; }

    if (this.state !== "playing") return;

    // Everything that used to happen inline here (player/enemy/projectile/
    // pickup/bomb updates, spawning, zone progression) now lives in
    // Simulation.tick() — see simulation.js. gameOver/justEnteredZoneClear
    // are edge-triggered flags tick() sets for us to react to below.
    this.sim.tick(dt, this.input, this.isTouchDevice);

    if (this.sim.gameOver && this.state !== "gameover") {
      this.triggerGameOver();
      return;
    }
    if (this.sim.justEnteredZoneClear) {
      this.sim.justEnteredZoneClear = false;
      this.openUpgradeMenu("zoneComplete");
    }

    this.updateWaitOverlay();
    this.updateHUD();
  }

  drawBackground() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CONFIG.width, CONFIG.height);

    // Park lawn — one of 5 generated variants (see generateParkLayout's
    // parkBgIndex / ART_STYLE.md), stretched to fill the field. Falls back
    // to the old flat gradient + grid until the sprite has loaded (or if
    // it's missing entirely), so there's never a blank frame.
    const bgSprite = Sprites.get(`park_bg_${this.parkBgIndex}`);
    if (bgSprite) {
      ctx.drawImage(bgSprite, 0, 0, CONFIG.width, CONFIG.height);
    } else {
      const grd = ctx.createRadialGradient(
        CONFIG.width / 2, CONFIG.height / 2, 60,
        CONFIG.width / 2, CONFIG.height / 2, 520
      );
      grd.addColorStop(0, "rgba(26, 30, 40, 1)");
      grd.addColorStop(1, "rgba(6, 7, 10, 1)");
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, CONFIG.width, CONFIG.height);

      ctx.strokeStyle = "rgba(255,255,255,0.03)";
      ctx.lineWidth = 1;
      for (let x = 0; x < CONFIG.width; x += 48) {
        ctx.beginPath(); ctx.moveTo(x, 60); ctx.lineTo(x, CONFIG.height); ctx.stroke();
      }
      for (let y = 60; y < CONFIG.height; y += 48) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CONFIG.width, y); ctx.stroke();
      }
    }

    // Park paths: the lanes the drive-by car travels (see
    // generateParkLayout) — the pavement texture tiled edge-to-edge in
    // square tiles matching the strip's own height, same load-fallback
    // idea as the lawn above (a plain lighter strip until it's ready).
    const pathSprite = Sprites.get("park_path");
    for (const path of this.parkPaths) {
      const top = path.y - path.height / 2;
      if (pathSprite) {
        for (let x = 0; x < CONFIG.width; x += path.height) {
          ctx.drawImage(pathSprite, x, top, path.height, path.height);
        }
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(0, top, CONFIG.width, path.height);
      }
    }

    // Darkens and red-tints the whole field as zones get deeper — layered
    // on top of the lawn/path art either way, same atmospheric effect it
    // always had.
    const darkness = clamp((this.zone - 1) * 0.06, 0, 0.55);
    if (darkness > 0) {
      const vignette = ctx.createRadialGradient(
        CONFIG.width / 2, CONFIG.height / 2, 60,
        CONFIG.width / 2, CONFIG.height / 2, 520
      );
      vignette.addColorStop(0, "rgba(6, 7, 10, 0)");
      vignette.addColorStop(1, `rgba(6, 7, 10, ${darkness * 0.6})`);
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, CONFIG.width, CONFIG.height);

      ctx.fillStyle = `rgba(120, 20, 30, ${darkness * 0.12})`;
      ctx.fillRect(0, 0, CONFIG.width, CONFIG.height);
    }
  }

  // Trees and benches are park furniture anchored to the path — their sprite
  // art always faces the path, so it must stay fixed relative to the field
  // (letting the field's own CSS rotation carry them, same as the path
  // itself) instead of counter-rotating to face the viewer.
  static PATH_FACING_OBJECT_TYPES = new Set(["albero", "panchina"]);

  // Shared by both the host's live draw() and the guest's drawFromSnapshot()
  // — park objects are static (no interpolation needed), so both paths can
  // draw straight from whatever list (live this.parkObjects, or the latest
  // snapshot's) is handed in.
  drawParkObjects(ctx, objects) {
    for (const obj of objects) {
      if (obj.hp <= 0) continue;
      const stage = objectDamageStage(obj.hp, obj.maxHp);
      const sprite = Sprites.get(`object_${obj.typeKey}_${stage}`);
      ctx.save();
      ctx.translate(obj.x, obj.y);
      // Bins/fences/etc are freestanding props (not tied to the path's
      // direction) — counter-rotate them so they always look upright to the
      // viewer, the same way the field's portrait rotation is undone for
      // touch input (see bindJoystick/bindAimStick).
      if (this.portraitRotated && !Game.PATH_FACING_OBJECT_TYPES.has(obj.typeKey)) {
        ctx.rotate(-Math.PI / 2);
      }
      if (sprite) {
        drawSpriteFit(ctx, sprite, obj.radius * 2.6);
      } else {
        ctx.fillStyle = "#4a4438";
        ctx.beginPath();
        ctx.arc(0, 0, obj.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#00000055";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  draw() {
    if (this.network.isMultiplayer) { this.drawFromSnapshot(); return; }
    this.drawBackground();
    this.drawParkObjects(this.ctx, this.parkObjects);
    for (const bomb of this.bombs) bomb.draw(this.ctx);
    for (const pickup of this.pickups) pickup.draw(this.ctx);
    for (const enemy of this.enemies) enemy.draw(this.ctx);
    for (const proj of this.projectiles) proj.draw(this.ctx);
    this.player.draw(this.ctx);
    for (const entry of this.remotePlayers.values()) entry.player.draw(this.ctx);
    for (const ft of this.floatingTexts) ft.draw(this.ctx);
  }

  // Guest-only render path: draws whatever the last snapshot reconstructed
  // (see applySnapshot), reusing the exact same class draw() methods so
  // there's no separate rendering implementation to keep in sync.
  drawFromSnapshot() {
    this.drawBackground();
    const curr = this._snapCurr;
    if (!curr) return;
    const prev = this._snapPrev;
    // How far between the previous and current snapshot "now" sits, based
    // on real elapsed wall-clock time — not on frame count, so it stays
    // correct regardless of the display's refresh rate or a jittery network.
    const t = clamp((performance.now() - this._snapReceivedAt) / 1000 / this._snapInterpDuration, 0, 1);

    const players = this.interpolatedList(prev.players, curr.players, t, ["x", "y"], ["facing", "aimAngle"]);
    const enemies = this.interpolatedList(prev.enemies, curr.enemies, t, ["x", "y"], ["facing"]);
    const projectiles = this.interpolatedList(prev.projectiles, curr.projectiles, t, ["x", "y"], []);
    const me = players.find(p => p.id === this.network.myId);
    const others = players.filter(p => p.id !== this.network.myId);

    // Bombs/pickups/park objects/floating texts don't move (or barely do),
    // so they're drawn straight from the latest snapshot with no
    // interpolation. this.parkPaths is updated in applySnapshot() so
    // drawBackground() (called above) already drew the right path strips.
    this.drawParkObjects(this.ctx, curr.parkObjects || []);
    for (const bomb of curr.bombs) this.mkBomb(bomb).draw(this.ctx);
    for (const pickup of curr.pickups) this.mkPickup(pickup).draw(this.ctx);
    for (const enemy of enemies) this.mkEnemy(enemy).draw(this.ctx);
    for (const proj of projectiles) this.mkProjectile(proj).draw(this.ctx);
    for (const other of others) this.mkPlayer(other).draw(this.ctx);
    if (me) this.mkPlayer(me).draw(this.ctx);
    for (const ft of curr.floatingTexts) this.mkText(ft).draw(this.ctx);
  }

  // Fixed-timestep accumulator: the simulation always advances in identical
  // CONFIG.tickRate steps (see its comment in simulation.js) regardless of
  // the actual render framerate, so game speed can never depend on how
  // fast/slow a given device renders. draw() still runs once per rendered
  // frame for smooth visuals — it just shows the sim state after however
  // many fixed steps happened to run that frame (usually one).
  loop(now) {
    const FIXED_DT = 1 / CONFIG.tickRate;
    // Clamp a long stall (tab backgrounded, phone locked, ...) to at most a
    // handful of ticks' worth, so the game "loses" that time instead of
    // trying to fast-forward through it in a burst once it resumes.
    const frameDt = Math.min(FIXED_DT * 8, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.input.pollGamepad();
    this._tickAccumulator += frameDt;
    while (this._tickAccumulator >= FIXED_DT) {
      this.update(FIXED_DT);
      this._tickAccumulator -= FIXED_DT;
    }
    this.draw();
    requestAnimationFrame(this.loop);
  }
}

window.addEventListener("load", () => {
  window.__game = new Game();
});
