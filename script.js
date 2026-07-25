"use strict";

/* =========================================================
   CONFIG
========================================================= */
const CONFIG = {
  width: 960,
  height: 600,
  maxConcurrentEnemies: 6,
  spawnInterval: 0.9,

  player: {
    baseSpeed: 220,
    baseMaxHP: 100,
    baseDamage: 18,
    attackRange: 52,
    attackArc: Math.PI * 1.3, // visual swing only; hit detection is a full circle around the player
    attackCooldown: 0.42,
    attackActiveTime: 0.12,
    dashSpeed: 640,
    dashDuration: 0.16,
    dashCooldown: 1.3,
    hitInvuln: 0.55,
    radius: 16,
  },

  enemy: {
    baseSpeed: 95,
    baseMaxHP: 38,
    baseDamage: 9,
    attackRange: 32,
    attackCooldown: 1.15,
    detectRange: 520,
    radius: 14,
    baseMoneyDrop: [8, 15],
  },

  zoneScaling: {
    speedPerZone: 0.07,
    hpPerZone: 0.13,
    damagePerZone: 0.09,
    cooldownFactorPerZone: 0.045, // reduces cooldown -> faster attacks
    minCooldown: 0.35,
    moneyPerZone: 0.10,
  },

  waves: {
    baseEnemies: 5,
    perZone: 2,
    maxEnemies: 16,
  },

  zoneNames: [
    "Ai margini del quartiere",
    "Vicoli stretti",
    "Cortili abbandonati",
    "Il blocco centrale",
    "Zona rossa",
    "Il fondo del quartiere",
  ],
};

const UPGRADES = [
  {
    id: "gym",
    name: "Palestra in cantina",
    desc: "Aumenta il danno dei tuoi colpi.",
    baseCost: 40,
    growth: 1.55,
    maxLevel: 6,
    perLevel: 3, // + damage
  },
  {
    id: "shoes",
    name: "Scarpe buone",
    desc: "Aumenta velocità di movimento e scatto.",
    baseCost: 35,
    growth: 1.5,
    maxLevel: 6,
    perLevel: 0.045, // multiplier bonus
  },
  {
    id: "jacket",
    name: "Giubbotto rinforzato",
    desc: "Riduce il danno che subisci.",
    baseCost: 45,
    growth: 1.6,
    maxLevel: 6,
    perLevel: 0.06, // damage reduction fraction
  },
  {
    id: "firstaid",
    name: "Kit pronto soccorso",
    desc: "Aumenta i punti vita massimi.",
    baseCost: 50,
    growth: 1.5,
    maxLevel: 6,
    perLevel: 14, // + max hp
  },
  {
    id: "safe",
    name: "Cassaforte",
    desc: "Riduce i soldi che i criminali riescono a rubarti.",
    baseCost: 55,
    growth: 1.6,
    maxLevel: 5,
    perLevel: 0.18, // steal reduction fraction
  },
  {
    id: "door",
    name: "Porta blindata",
    desc: "Recuperi un po' di vita all'inizio di ogni zona.",
    baseCost: 75,
    growth: 1.75,
    maxLevel: 3,
    perLevel: 0.12, // fraction of missing hp healed on new zone
  },
];

const SAVE_KEY = "quartiere_ostile_save_v1";

/* =========================================================
   UTILS
========================================================= */
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
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
  wave() { this.beep(220, 0.3, "triangle", 0.06); },
  gameover() { this.beep(80, 0.5, "sawtooth", 0.08); },
};

/* =========================================================
   SAVE / LOAD
========================================================= */
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data.money !== "number") return null;
    return data;
  } catch (e) {
    return null;
  }
}

function defaultSave() {
  const upgrades = {};
  UPGRADES.forEach(u => { upgrades[u.id] = 0; });
  return { money: 0, upgrades, bestZone: 1 };
}

/* =========================================================
   FLOATING TEXT (damage numbers, loot popups)
========================================================= */
class FloatingText {
  constructor(x, y, text, color) {
    this.x = x;
    this.y = y;
    this.text = text;
    this.color = color;
    this.life = 0.8;
    this.maxLife = 0.8;
    this.vy = -40;
  }
  update(dt) {
    this.y += this.vy * dt;
    this.life -= dt;
  }
  get dead() { return this.life <= 0; }
  draw(ctx) {
    const alpha = clamp(this.life / this.maxLife, 0, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.color;
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(this.text, this.x, this.y);
    ctx.restore();
  }
}

/* =========================================================
   PLAYER
========================================================= */
class Player {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.facing = -Math.PI / 2; // up
    this.radius = CONFIG.player.radius;

    this.attackCooldownTimer = 0;
    this.attackActiveTimer = 0;
    this.dashTimer = 0;
    this.dashCooldownTimer = 0;
    this.invulnTimer = 0;
    this.hitFlash = 0;

    this.hp = 100;
    this.maxHp = 100;
    this.stats = null; // computed from upgrades
  }

  applyUpgrades(upgradeLevels) {
    const lvl = id => upgradeLevels[id] || 0;
    const cfg = CONFIG.player;

    const dmgBonus = lvl("gym") * UPGRADES.find(u => u.id === "gym").perLevel;
    const speedMult = 1 + lvl("shoes") * UPGRADES.find(u => u.id === "shoes").perLevel;
    const defReduction = lvl("jacket") * UPGRADES.find(u => u.id === "jacket").perLevel;
    const hpBonus = lvl("firstaid") * UPGRADES.find(u => u.id === "firstaid").perLevel;
    const stealReduction = lvl("safe") * UPGRADES.find(u => u.id === "safe").perLevel;
    const doorHeal = lvl("door") * UPGRADES.find(u => u.id === "door").perLevel;

    const prevMax = this.maxHp;
    this.maxHp = Math.round(cfg.baseMaxHP + hpBonus);
    if (this.hp === 0 || prevMax === undefined) this.hp = this.maxHp;
    else this.hp = clamp(this.hp + (this.maxHp - (prevMax || this.maxHp)), 0, this.maxHp);

    this.stats = {
      speed: cfg.baseSpeed * speedMult,
      dashSpeed: cfg.dashSpeed * speedMult,
      damage: cfg.baseDamage + dmgBonus,
      defReduction: clamp(defReduction, 0, 0.75),
      stealReduction: clamp(stealReduction, 0, 0.9),
      doorHealFraction: clamp(doorHeal, 0, 0.9),
    };
  }

  resetForRun() {
    this.hp = this.maxHp;
  }

  healOnNewZone() {
    if (!this.stats) return;
    const missing = this.maxHp - this.hp;
    this.hp = clamp(this.hp + missing * this.stats.doorHealFraction, 0, this.maxHp);
  }

  get isDashing() { return this.dashTimer > 0; }
  get isInvulnerable() { return this.invulnTimer > 0; }

  tryAttack(game) {
    if (this.attackCooldownTimer > 0) return;
    this.attackCooldownTimer = CONFIG.player.attackCooldown;
    this.attackActiveTimer = CONFIG.player.attackActiveTime;
    SoundManager.attack();

    const cfg = CONFIG.player;
    // Hits everything in range around the player (short-range swing), not just
    // a narrow cone: with several enemies closing in from different sides at
    // once, requiring pixel-perfect facing made the fight unplayable.
    for (const enemy of game.enemies) {
      if (enemy.dead) continue;
      const d = dist(this.x, this.y, enemy.x, enemy.y);
      if (d > cfg.attackRange + enemy.radius) continue;
      game.damageEnemy(enemy, this.stats.damage);
    }
  }

  tryDash() {
    if (this.dashCooldownTimer > 0 || this.isDashing) return;
    this.dashTimer = CONFIG.player.dashDuration;
    this.dashCooldownTimer = CONFIG.player.dashCooldown;
    this.invulnTimer = Math.max(this.invulnTimer, CONFIG.player.dashDuration + 0.1);
    SoundManager.dash();
  }

  takeDamage(amount) {
    if (this.isInvulnerable) return false;
    const reduced = amount * (1 - this.stats.defReduction);
    this.hp = clamp(this.hp - reduced, 0, this.maxHp);
    this.invulnTimer = CONFIG.player.hitInvuln;
    this.hitFlash = 0.25;
    SoundManager.hitPlayer();
    return true;
  }

  update(dt, input) {
    if (this.attackCooldownTimer > 0) this.attackCooldownTimer -= dt;
    if (this.attackActiveTimer > 0) this.attackActiveTimer -= dt;
    if (this.dashCooldownTimer > 0) this.dashCooldownTimer -= dt;
    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;

    let mx = 0, my = 0;
    if (input.isDown("left")) mx -= 1;
    if (input.isDown("right")) mx += 1;
    if (input.isDown("up")) my -= 1;
    if (input.isDown("down")) my += 1;

    const moving = mx !== 0 || my !== 0;
    if (moving) {
      const len = Math.hypot(mx, my);
      mx /= len; my /= len;
      this.facing = Math.atan2(my, mx);
    }

    if (this.dashTimer > 0) {
      this.dashTimer -= dt;
      const dx = Math.cos(this.facing) * this.stats.dashSpeed * dt;
      const dy = Math.sin(this.facing) * this.stats.dashSpeed * dt;
      this.x += dx; this.y += dy;
    } else if (moving) {
      this.x += mx * this.stats.speed * dt;
      this.y += my * this.stats.speed * dt;
    }

    const margin = this.radius + 6;
    this.x = clamp(this.x, margin, CONFIG.width - margin);
    this.y = clamp(this.y, margin + 60, CONFIG.height - margin);
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);

    if (this.isInvulnerable && Math.floor(performance.now() / 60) % 2 === 0) {
      ctx.globalAlpha = 0.5;
    }

    // attack swing arc
    if (this.attackActiveTimer > 0) {
      ctx.save();
      ctx.rotate(this.facing);
      ctx.fillStyle = "rgba(232, 163, 61, 0.35)";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, CONFIG.player.attackRange, -CONFIG.player.attackArc / 2, CONFIG.player.attackArc / 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // body
    ctx.fillStyle = this.hitFlash > 0 ? "#ff8080" : "#4fa1e8";
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#1c2b3d";
    ctx.lineWidth = 2;
    ctx.stroke();

    // facing indicator
    ctx.strokeStyle = "#e7e7ea";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(this.facing) * this.radius * 1.4, Math.sin(this.facing) * this.radius * 1.4);
    ctx.stroke();

    ctx.restore();
  }
}

/* =========================================================
   ENEMY
========================================================= */
class Enemy {
  constructor(x, y, stats) {
    this.x = x;
    this.y = y;
    this.radius = CONFIG.enemy.radius;
    this.stats = stats;
    this.hp = stats.maxHP;
    this.maxHp = stats.maxHP;
    this.attackCooldownTimer = rand(0, 0.4);
    this.dead = false;
    this.hitFlash = 0;
    this.jitterAngle = rand(0, Math.PI * 2);
    this.jitterTimer = rand(0, 1);
  }

  update(dt, player, game) {
    if (this.dead) return;
    if (this.attackCooldownTimer > 0) this.attackCooldownTimer -= dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;

    const d = dist(this.x, this.y, player.x, player.y);

    if (d <= this.stats.attackRange + this.radius) {
      if (this.attackCooldownTimer <= 0) {
        this.attackCooldownTimer = this.stats.attackCooldown;
        const hit = player.takeDamage(this.stats.damage);
        if (hit) game.onPlayerHit(this.stats);
      }
    } else if (d <= this.stats.detectRange) {
      let dx = player.x - this.x;
      let dy = player.y - this.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;

      this.jitterTimer -= dt;
      if (this.jitterTimer <= 0) {
        this.jitterAngle = rand(-1, 1) * this.stats.aggression;
        this.jitterTimer = rand(0.2, 0.5);
      }
      const cos = Math.cos(this.jitterAngle), sin = Math.sin(this.jitterAngle);
      const jdx = dx * cos - dy * sin;
      const jdy = dx * sin + dy * cos;

      this.x += jdx * this.stats.speed * dt;
      this.y += jdy * this.stats.speed * dt;
    }

    // simple separation from other enemies
    for (const other of game.enemies) {
      if (other === this || other.dead) continue;
      const od = dist(this.x, this.y, other.x, other.y);
      const minD = this.radius + other.radius + 4;
      if (od > 0 && od < minD) {
        const push = (minD - od) / minD;
        const ax = (this.x - other.x) / od;
        const ay = (this.y - other.y) / od;
        this.x += ax * push * 40 * dt;
        this.y += ay * push * 40 * dt;
      }
    }

    const margin = this.radius + 4;
    this.x = clamp(this.x, margin, CONFIG.width - margin);
    this.y = clamp(this.y, margin + 60, CONFIG.height - margin);
  }

  takeDamage(amount) {
    this.hp -= amount;
    this.hitFlash = 0.15;
    if (this.hp <= 0 && !this.dead) {
      this.dead = true;
      return true;
    }
    return false;
  }

  draw(ctx) {
    if (this.dead) return;
    ctx.save();
    ctx.translate(this.x, this.y);

    ctx.fillStyle = this.hitFlash > 0 ? "#ffffff" : "#c0505f";
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#3a1418";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // hp bar
    const w = this.radius * 2;
    const hpFrac = clamp(this.hp / this.maxHp, 0, 1);
    ctx.save();
    ctx.translate(this.x - this.radius, this.y - this.radius - 10);
    ctx.fillStyle = "#2a1414";
    ctx.fillRect(0, 0, w, 4);
    ctx.fillStyle = hpFrac > 0.4 ? "#d9455f" : "#ff8a3d";
    ctx.fillRect(0, 0, w * hpFrac, 4);
    ctx.restore();
  }
}

/* =========================================================
   INPUT
========================================================= */
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
    this.onDash = null;
    this.onToggleMenu = null;
  }
  handleDown(e) {
    if (this.map[e.code]) { this.keys.add(this.map[e.code]); }
    if (e.code === "Space") { e.preventDefault(); if (this.onAttack) this.onAttack(); }
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") { if (this.onDash) this.onDash(); }
    if (e.code === "KeyU" || e.code === "Escape") { if (this.onToggleMenu) this.onToggleMenu(); }
  }
  handleUp(e) {
    if (this.map[e.code]) { this.keys.delete(this.map[e.code]); }
  }
  isDown(dir) { return this.keys.has(dir); }
}

/* =========================================================
   GAME
========================================================= */
class Game {
  constructor() {
    this.canvas = document.getElementById("gameCanvas");
    this.ctx = this.canvas.getContext("2d");

    this.input = new InputHandler();
    this.input.onAttack = () => { if (this.state === "playing") this.player.tryAttack(this); };
    this.input.onDash = () => { if (this.state === "playing") this.player.tryDash(); };
    this.input.onToggleMenu = () => this.toggleUpgradeMenu();

    this.save = loadSave() || defaultSave();
    this.player = new Player(CONFIG.width / 2, CONFIG.height / 2);
    this.player.applyUpgrades(this.save.upgrades);
    this.player.resetForRun();

    this.enemies = [];
    this.floatingTexts = [];

    this.zone = 1;
    this.moneyThisRun = 0;
    this.enemiesToSpawn = 0;
    this.spawnTimer = 0;
    this.waveTotalEnemies = 0;
    this.waveEnemiesDefeated = 0;

    this.state = "menu"; // menu | playing | paused | zoneComplete | gameover
    this.lastTime = performance.now();

    this.bindUI();
    this.updateHUDStatic();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  bindUI() {
    document.getElementById("start-btn").addEventListener("click", () => {
      SoundManager.ensure();
      this.startRun();
    });
    document.getElementById("restart-btn").addEventListener("click", () => {
      this.startRun();
    });
    document.getElementById("upgrade-continue-btn").addEventListener("click", () => {
      this.closeUpgradeMenu();
    });
    document.getElementById("mute-btn").addEventListener("click", () => {
      SoundManager.muted = !SoundManager.muted;
      document.getElementById("mute-btn").textContent = SoundManager.muted ? "🔇" : "🔊";
    });

    const saveSummary = document.getElementById("save-summary");
    if (this.save.money > 0 || this.save.bestZone > 1) {
      saveSummary.classList.remove("hidden");
      document.getElementById("save-money").textContent = this.save.money;
      document.getElementById("save-zone").textContent = this.save.bestZone;
    }
  }

  persist() {
    localStorage.setItem(SAVE_KEY, JSON.stringify(this.save));
  }

  zoneName(zone) {
    const names = CONFIG.zoneNames;
    if (zone <= names.length) return names[zone - 1];
    return `${names[names.length - 1]} (Lv. ${zone - names.length + 1})`;
  }

  enemyStatsForZone(zone) {
    const s = CONFIG.enemy;
    const z = zone - 1;
    const sc = CONFIG.zoneScaling;
    return {
      speed: s.baseSpeed * (1 + sc.speedPerZone * z),
      maxHP: Math.round(s.baseMaxHP * (1 + sc.hpPerZone * z)),
      damage: Math.round(s.baseDamage * (1 + sc.damagePerZone * z)),
      attackCooldown: Math.max(sc.minCooldown, s.attackCooldown * (1 - sc.cooldownFactorPerZone * z)),
      attackRange: s.attackRange,
      detectRange: s.detectRange,
      moneyRange: [
        Math.round(s.baseMoneyDrop[0] * (1 + sc.moneyPerZone * z)),
        Math.round(s.baseMoneyDrop[1] * (1 + sc.moneyPerZone * z)),
      ],
      aggression: clamp(0.5 + z * 0.12, 0.5, 2.2),
    };
  }

  startRun() {
    this.player.applyUpgrades(this.save.upgrades);
    this.player.resetForRun();
    this.player.x = CONFIG.width / 2;
    this.player.y = CONFIG.height / 2;
    this.zone = 1;
    this.moneyThisRun = 0;
    this.enemies = [];
    this.floatingTexts = [];
    this.setState("playing");
    this.startZone();
  }

  startZone() {
    this.player.healOnNewZone();
    const count = Math.min(
      CONFIG.waves.baseEnemies + (this.zone - 1) * CONFIG.waves.perZone,
      CONFIG.waves.maxEnemies
    );
    this.waveTotalEnemies = count;
    this.waveEnemiesDefeated = 0;
    this.enemiesToSpawn = count;
    this.spawnTimer = 0;
    SoundManager.wave();
  }

  spawnEnemy() {
    const edge = randInt(0, 3);
    let x, y;
    const m = 30;
    if (edge === 0) { x = rand(m, CONFIG.width - m); y = 70; }
    else if (edge === 1) { x = rand(m, CONFIG.width - m); y = CONFIG.height - m; }
    else if (edge === 2) { x = m; y = rand(90, CONFIG.height - m); }
    else { x = CONFIG.width - m; y = rand(90, CONFIG.height - m); }

    const zoneStats = this.enemyStatsForZone(this.zone);
    this.enemies.push(new Enemy(x, y, zoneStats));
  }

  damageEnemy(enemy, amount) {
    const killed = enemy.takeDamage(amount);
    this.floatingTexts.push(new FloatingText(enemy.x, enemy.y - 20, `-${Math.round(amount)}`, "#ffffff"));
    if (killed) {
      SoundManager.ko();
      const [minM, maxM] = enemy.stats.moneyRange;
      const reward = randInt(minM, maxM);
      this.moneyThisRun += reward;
      this.save.money += reward;
      this.floatingTexts.push(new FloatingText(enemy.x, enemy.y - 34, `+${reward}€`, "#4fd07a"));
      this.waveEnemiesDefeated++;
      SoundManager.coin();
      this.persist();
    } else {
      SoundManager.hitEnemy();
    }
  }

  onPlayerHit(enemyStats) {
    if (this.save.money <= 0) return;
    const stealFrac = 0.05;
    const reduction = this.player.stats.stealReduction;
    let stolen = Math.round(this.save.money * stealFrac * (1 - reduction));
    stolen = Math.min(stolen, this.save.money);
    if (stolen > 0) {
      this.save.money -= stolen;
      this.moneyThisRun -= Math.min(stolen, Math.max(0, this.moneyThisRun));
      this.floatingTexts.push(new FloatingText(this.player.x, this.player.y - 26, `-${stolen}€ rubati!`, "#d9455f"));
      this.persist();
    }
  }

  toggleUpgradeMenu() {
    if (this.state === "playing") {
      this.openUpgradeMenu("pause");
    } else if (this.state === "paused") {
      this.closeUpgradeMenu();
    }
  }

  openUpgradeMenu(mode) {
    this.menuMode = mode; // 'pause' | 'zoneComplete'
    this.state = "paused";
    const title = document.getElementById("upgrade-title");
    const subtitle = document.getElementById("upgrade-subtitle");
    const btn = document.getElementById("upgrade-continue-btn");
    if (mode === "zoneComplete") {
      title.textContent = `Zona ${this.zone} completata!`;
      subtitle.textContent = "Spendi i tuoi soldi per rinforzare casa tua prima di addentrarti ancora di più.";
      btn.textContent = "Addentrati nel quartiere";
    } else {
      title.textContent = "Pausa — Potenzia casa";
      subtitle.textContent = "";
      btn.textContent = "Riprendi";
    }
    this.renderUpgradeList();
    document.getElementById("upgrade-screen").classList.remove("hidden");
  }

  closeUpgradeMenu() {
    document.getElementById("upgrade-screen").classList.add("hidden");
    if (this.menuMode === "zoneComplete") {
      this.zone++;
      this.startZone();
    }
    this.state = "playing";
    this.menuMode = null;
  }

  costFor(upg, level) {
    return Math.round(upg.baseCost * Math.pow(upg.growth, level));
  }

  renderUpgradeList() {
    const list = document.getElementById("upgrade-list");
    list.innerHTML = "";
    UPGRADES.forEach(upg => {
      const level = this.save.upgrades[upg.id] || 0;
      const maxed = level >= upg.maxLevel;
      const cost = maxed ? null : this.costFor(upg, level);

      const card = document.createElement("div");
      card.className = "upgrade-card";
      card.innerHTML = `
        <h3>${upg.name}</h3>
        <p>${upg.desc}</p>
        <div class="row">
          <span class="level">Lv. ${level}/${upg.maxLevel}</span>
          <button ${maxed || cost > this.save.money ? "disabled" : ""}>
            ${maxed ? "MAX" : `Acquista — ${cost}€`}
          </button>
        </div>
      `;
      if (!maxed) {
        card.querySelector("button").addEventListener("click", () => {
          if (this.save.money >= cost) {
            this.save.money -= cost;
            this.save.upgrades[upg.id] = level + 1;
            this.player.applyUpgrades(this.save.upgrades);
            this.persist();
            this.renderUpgradeList();
            this.updateHUDStatic();
          }
        });
      }
      list.appendChild(card);
    });
    document.getElementById("upgrade-money").textContent = `€ ${this.save.money}`;
  }

  setState(state) {
    this.state = state;
    document.getElementById("start-screen").classList.toggle("hidden", state !== "menu");
    document.getElementById("gameover-screen").classList.toggle("hidden", state !== "gameover");
    document.getElementById("hud").classList.toggle("hidden", state === "menu");
    document.getElementById("pause-hint").classList.toggle("hidden", state === "menu" || state === "gameover");
    if (state !== "paused") {
      document.getElementById("upgrade-screen").classList.add("hidden");
    }
  }

  triggerGameOver() {
    this.setState("gameover");
    SoundManager.gameover();
    if (this.zone > this.save.bestZone) this.save.bestZone = this.zone;
    this.persist();
    document.getElementById("final-zone").textContent = this.zone;
    document.getElementById("final-money").textContent = Math.max(0, this.moneyThisRun);
    document.getElementById("final-total-money").textContent = this.save.money;
  }

  updateHUDStatic() {
    document.getElementById("money-label").textContent = `€ ${this.save.money}`;
  }

  updateHUD() {
    const hpFrac = clamp(this.player.hp / this.player.maxHp, 0, 1);
    document.getElementById("hp-fill").style.width = `${hpFrac * 100}%`;
    document.getElementById("hp-label").textContent = `${Math.round(this.player.hp)} / ${this.player.maxHp}`;
    document.getElementById("zone-label").textContent = `Zona ${this.zone} — ${this.zoneName(this.zone)}`;
    const remaining = this.waveTotalEnemies - this.waveEnemiesDefeated;
    document.getElementById("wave-label").textContent = `Nemici rimasti: ${remaining}`;
    document.getElementById("money-label").textContent = `€ ${this.save.money}`;

    const dashFrac = 1 - clamp(this.player.dashCooldownTimer / CONFIG.player.dashCooldown, 0, 1);
    let fill = document.querySelector("#dash-indicator .fill");
    if (!fill) {
      fill = document.createElement("div");
      fill.className = "fill";
      document.getElementById("dash-indicator").appendChild(fill);
    }
    fill.style.width = `${dashFrac * 100}%`;
  }

  update(dt) {
    if (this.state !== "playing") return;

    this.player.update(dt, this.input);

    if (this.enemiesToSpawn > 0) {
      this.spawnTimer -= dt;
      const concurrentCap = Math.min(2 + Math.floor((this.zone - 1) / 2), CONFIG.maxConcurrentEnemies);
      if (this.spawnTimer <= 0 && this.enemies.filter(e => !e.dead).length < concurrentCap) {
        this.spawnEnemy();
        this.enemiesToSpawn--;
        this.spawnTimer = CONFIG.spawnInterval;
      }
    }

    for (const enemy of this.enemies) {
      enemy.update(dt, this.player, this);
    }
    this.enemies = this.enemies.filter(e => !e.dead);

    for (const ft of this.floatingTexts) ft.update(dt);
    this.floatingTexts = this.floatingTexts.filter(ft => !ft.dead);

    if (this.player.hp <= 0) {
      this.triggerGameOver();
      return;
    }

    if (this.enemiesToSpawn === 0 && this.enemies.length === 0 && this.waveEnemiesDefeated >= this.waveTotalEnemies) {
      this.openUpgradeMenu("zoneComplete");
    }

    this.updateHUD();
  }

  drawBackground() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CONFIG.width, CONFIG.height);

    const darkness = clamp((this.zone - 1) * 0.06, 0, 0.55);
    const grd = ctx.createRadialGradient(
      CONFIG.width / 2, CONFIG.height / 2, 60,
      CONFIG.width / 2, CONFIG.height / 2, 520
    );
    grd.addColorStop(0, `rgba(26, 30, 40, ${1 - darkness * 0.3})`);
    grd.addColorStop(1, `rgba(6, 7, 10, 1)`);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, CONFIG.width, CONFIG.height);

    // simple ground grid for depth
    ctx.strokeStyle = "rgba(255,255,255,0.03)";
    ctx.lineWidth = 1;
    for (let x = 0; x < CONFIG.width; x += 48) {
      ctx.beginPath(); ctx.moveTo(x, 60); ctx.lineTo(x, CONFIG.height); ctx.stroke();
    }
    for (let y = 60; y < CONFIG.height; y += 48) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CONFIG.width, y); ctx.stroke();
    }

    // red tint overlay as zones get deeper
    if (darkness > 0) {
      ctx.fillStyle = `rgba(120, 20, 30, ${darkness * 0.12})`;
      ctx.fillRect(0, 0, CONFIG.width, CONFIG.height);
    }
  }

  draw() {
    this.drawBackground();
    for (const enemy of this.enemies) enemy.draw(this.ctx);
    this.player.draw(this.ctx);
    for (const ft of this.floatingTexts) ft.draw(this.ctx);
  }

  loop(now) {
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.update(dt);
    this.draw();
    requestAnimationFrame(this.loop);
  }
}

window.addEventListener("load", () => {
  new Game();
});
