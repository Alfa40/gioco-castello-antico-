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
    baseMaxHP: 150,
    attackArc: Math.PI * 1.3, // visual swing only; hit detection is a full circle around the player
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

// Sequential melee tiers: each purchase replaces the previous weapon.
// Knives trade range for speed/damage; bats and poles trade speed for reach.
const MELEE_WEAPONS = [
  { id: "fists", name: "Pugni", desc: "Le tue mani. Gratis, ma poco convincenti.", cost: 0, damage: 18, range: 52, cooldown: 0.42 },
  { id: "knife1", name: "Coltello", desc: "Taglia in fretta: più danno e colpi più veloci.", cost: 70, damage: 26, range: 50, cooldown: 0.32 },
  { id: "knife2", name: "Coltello a serramanico", desc: "Lama migliore: ancora più danno e velocità.", cost: 170, damage: 36, range: 50, cooldown: 0.24 },
  { id: "bat", name: "Mazza da baseball", desc: "Più lenta, ma colpisce molto più lontano e più forte.", cost: 320, damage: 50, range: 78, cooldown: 0.55 },
  { id: "pole", name: "Palo d'acciaio", desc: "Portata e danno massimi. Non fa sconti.", cost: 520, damage: 68, range: 94, cooldown: 0.62 },
];

// Ranged weapons are a separate, optional loadout slot (key F) unlocked once
// you've reached a deep enough zone at least once. Also sequential.
const RANGED_WEAPONS = [
  { id: "pistol", name: "Pistola", desc: "Colpisce a distanza. Cadenza moderata.", cost: 250, damage: 22, cooldown: 0.6, projectileSpeed: 560, minZone: 3 },
  { id: "smg", name: "Mitra", desc: "Raffica rapida, danno per colpo minore.", cost: 600, damage: 13, cooldown: 0.14, projectileSpeed: 640, minZone: 5 },
];

// Three enemy archetypes with distinct movement/attack behavior, not just
// stat multipliers, so they read as different threats at a glance.
const ENEMY_TYPES = [
  {
    id: "balordo",
    label: "Balordo",
    color: "#8a7355",
    radiusMult: 1.12,
    speedMult: 0.72,
    hpMult: 1.25,
    damageMult: 1.0,
    cooldownMult: 1.0,
    behavior: "steady", // predictable, direct pursuit — the baseline threat
    minZone: 1,
    weight: (zone) => Math.max(0.15, 1.4 - zone * 0.12),
  },
  {
    id: "nervoso",
    label: "Nervoso",
    color: "#e0703d",
    radiusMult: 0.9,
    speedMult: 1.4,
    hpMult: 0.8,
    damageMult: 1.05,
    cooldownMult: 0.7,
    behavior: "aggressive", // beelines at you and swings fast
    minZone: 1,
    weight: (zone) => 0.4 + zone * 0.1,
  },
  {
    id: "imprevedibile",
    label: "Imprevedibile",
    color: "#9b59d0",
    radiusMult: 1.0,
    speedMult: 1.1,
    hpMult: 0.9,
    damageMult: 1.0,
    cooldownMult: 0.85,
    behavior: "erratic", // darts around, doesn't reliably chase
    minZone: 3,
    weight: (zone) => (zone < 3 ? 0 : 0.25 + (zone - 3) * 0.15),
  },
];

function pickEnemyType(zone) {
  const candidates = ENEMY_TYPES.filter(t => zone >= t.minZone);
  const total = candidates.reduce((sum, t) => sum + t.weight(zone), 0);
  let roll = rand(0, total);
  for (const t of candidates) {
    roll -= t.weight(zone);
    if (roll <= 0) return t;
  }
  return candidates[candidates.length - 1];
}

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
  shoot() { this.beep(880, 0.05, "square", 0.045); },
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
  return { money: 0, upgrades, bestZone: 1, meleeTier: 0, rangedTier: -1 };
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
   PROJECTILE (fired by ranged weapons)
========================================================= */
class Projectile {
  constructor(x, y, angle, speed, damage) {
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.damage = damage;
    this.radius = 6;
    this.dead = false;
  }
  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (this.x < -20 || this.x > CONFIG.width + 20 || this.y < -20 || this.y > CONFIG.height + 20) {
      this.dead = true;
    }
  }
  draw(ctx) {
    ctx.save();
    ctx.fillStyle = "#ffe27a";
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fill();
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
    this.rangedCooldownTimer = 0;
    this.dashTimer = 0;
    this.dashCooldownTimer = 0;
    this.invulnTimer = 0;
    this.hitFlash = 0;

    this.hp = 100;
    this.maxHp = 100;
    this.stats = null; // computed from upgrades
    this.melee = null; // computed from equipped melee weapon
    this.ranged = null; // computed from equipped ranged weapon, or null if unarmed
  }

  refreshLoadout(save) {
    const lvl = id => save.upgrades[id] || 0;
    const cfg = CONFIG.player;

    const gymBonus = lvl("gym") * UPGRADES.find(u => u.id === "gym").perLevel;
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
      defReduction: clamp(defReduction, 0, 0.75),
      stealReduction: clamp(stealReduction, 0, 0.9),
      doorHealFraction: clamp(doorHeal, 0, 0.9),
    };

    const meleeWeapon = MELEE_WEAPONS[save.meleeTier || 0];
    this.melee = {
      name: meleeWeapon.name,
      damage: meleeWeapon.damage + gymBonus,
      range: meleeWeapon.range,
      cooldown: meleeWeapon.cooldown,
      activeTime: Math.min(0.18, meleeWeapon.cooldown * 0.4),
    };

    const rangedIdx = save.rangedTier;
    if (rangedIdx != null && rangedIdx >= 0 && RANGED_WEAPONS[rangedIdx]) {
      const rw = RANGED_WEAPONS[rangedIdx];
      this.ranged = {
        name: rw.name,
        damage: rw.damage + gymBonus * 0.5,
        cooldown: rw.cooldown,
        projectileSpeed: rw.projectileSpeed,
      };
    } else {
      this.ranged = null;
    }
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
    this.attackCooldownTimer = this.melee.cooldown;
    this.attackActiveTimer = this.melee.activeTime;
    SoundManager.attack();

    // Hits everything in range around the player (short-range swing), not just
    // a narrow cone: with several enemies closing in from different sides at
    // once, requiring pixel-perfect facing made the fight unplayable.
    for (const enemy of game.enemies) {
      if (enemy.dead) continue;
      const d = dist(this.x, this.y, enemy.x, enemy.y);
      if (d > this.melee.range + enemy.radius) continue;
      game.damageEnemy(enemy, this.melee.damage);
    }
  }

  tryRangedAttack(game) {
    if (!this.ranged || this.rangedCooldownTimer > 0) return;
    this.rangedCooldownTimer = this.ranged.cooldown;
    // Facing only has 8 possible directions (derived from WASD combos), so
    // without a mouse to aim with, a bit of soft lock-on onto whatever enemy
    // is roughly ahead makes shooting feel intentional instead of hopeless.
    const angle = game.aimAssist(this.x, this.y, this.facing);
    const muzzle = this.radius + 8;
    game.spawnProjectile(
      this.x + Math.cos(angle) * muzzle,
      this.y + Math.sin(angle) * muzzle,
      angle,
      this.ranged.projectileSpeed,
      this.ranged.damage
    );
    SoundManager.shoot();
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
    if (this.rangedCooldownTimer > 0) this.rangedCooldownTimer -= dt;
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
      ctx.arc(0, 0, this.melee.range, -CONFIG.player.attackArc / 2, CONFIG.player.attackArc / 2);
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

    // facing indicator (length hints at the reach of the equipped weapon)
    const indicatorLen = this.radius * 1.2 + this.melee.range * 0.25;
    ctx.strokeStyle = "#e7e7ea";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(this.facing) * indicatorLen, Math.sin(this.facing) * indicatorLen);
    ctx.stroke();

    ctx.restore();
  }
}

/* =========================================================
   ENEMY
========================================================= */
class Enemy {
  constructor(x, y, stats, type) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.radius = CONFIG.enemy.radius * (type.radiusMult || 1);
    this.stats = stats;
    this.hp = stats.maxHP;
    this.maxHp = stats.maxHP;
    this.attackCooldownTimer = rand(0, 0.4);
    this.dead = false;
    this.hitFlash = 0;

    // "steady" / "aggressive" behavior
    this.jitterAngle = rand(0, Math.PI * 2);
    this.jitterTimer = rand(0, 1);

    // "erratic" behavior
    this.moveDir = { x: 0, y: 0 };
    this.moveSpeedMult = 1;
    this.erraticTimer = rand(0, 0.3);
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
    } else {
      this.moveTowardBehavior(dt, player, d);
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

  moveTowardBehavior(dt, player, d) {
    if (this.type.behavior === "erratic") {
      this.erraticTimer -= dt;
      if (this.erraticTimer <= 0) {
        this.erraticTimer = rand(0.25, 0.6);
        const dx = player.x - this.x, dy = player.y - this.y;
        const len = Math.hypot(dx, dy) || 1;
        if (d > this.stats.detectRange * 1.3) {
          // player far away: aimless wandering, not actively hunting
          const a = rand(0, Math.PI * 2);
          this.moveDir = { x: Math.cos(a), y: Math.sin(a) };
          this.moveSpeedMult = 0.4;
        } else {
          const roll = Math.random();
          if (roll < 0.45) {
            // lunge straight at the player
            this.moveDir = { x: dx / len, y: dy / len };
            this.moveSpeedMult = 1.3;
          } else if (roll < 0.8) {
            // dart off at a wide angle — sideways or backwards, not a retreat
            const baseAngle = Math.atan2(dy, dx);
            const off = rand(0.9, 2.4) * (Math.random() < 0.5 ? -1 : 1);
            const a = baseAngle + off;
            this.moveDir = { x: Math.cos(a), y: Math.sin(a) };
            this.moveSpeedMult = 1.1;
          } else {
            // dart straight away
            this.moveDir = { x: -dx / len, y: -dy / len };
            this.moveSpeedMult = 1.0;
          }
        }
      }
      this.x += this.moveDir.x * this.stats.speed * this.moveSpeedMult * dt;
      this.y += this.moveDir.y * this.stats.speed * this.moveSpeedMult * dt;
      return;
    }

    if (d > this.stats.detectRange) return;

    let dx = player.x - this.x;
    let dy = player.y - this.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;

    const aggressive = this.type.behavior === "aggressive";
    const jitterAmp = aggressive ? 0.12 : 0.4;

    this.jitterTimer -= dt;
    if (this.jitterTimer <= 0) {
      this.jitterAngle = rand(-1, 1) * jitterAmp;
      this.jitterTimer = aggressive ? rand(0.15, 0.3) : rand(0.2, 0.5);
    }
    const cos = Math.cos(this.jitterAngle), sin = Math.sin(this.jitterAngle);
    const jdx = dx * cos - dy * sin;
    const jdy = dx * sin + dy * cos;

    this.x += jdx * this.stats.speed * dt;
    this.y += jdy * this.stats.speed * dt;
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

    ctx.fillStyle = this.hitFlash > 0 ? "#ffffff" : this.type.color;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#00000055";
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
    this.onRangedAttack = null;
    this.onDash = null;
    this.onToggleMenu = null;
  }
  handleDown(e) {
    if (this.map[e.code]) { this.keys.add(this.map[e.code]); }
    if (e.code === "Space") { e.preventDefault(); if (this.onAttack) this.onAttack(); }
    if (e.code === "KeyF") { if (this.onRangedAttack) this.onRangedAttack(); }
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
    this.input.onRangedAttack = () => { if (this.state === "playing") this.player.tryRangedAttack(this); };
    this.input.onDash = () => { if (this.state === "playing") this.player.tryDash(); };
    this.input.onToggleMenu = () => this.toggleUpgradeMenu();

    this.save = loadSave() || defaultSave();
    if (this.save.meleeTier == null) this.save.meleeTier = 0;
    if (this.save.rangedTier == null) this.save.rangedTier = -1;
    this.player = new Player(CONFIG.width / 2, CONFIG.height / 2);
    this.player.refreshLoadout(this.save);
    this.player.resetForRun();

    this.enemies = [];
    this.projectiles = [];
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

  enemyStatsForZone(zone, type) {
    const s = CONFIG.enemy;
    const z = zone - 1;
    const sc = CONFIG.zoneScaling;
    return {
      speed: s.baseSpeed * (1 + sc.speedPerZone * z) * type.speedMult,
      maxHP: Math.round(s.baseMaxHP * (1 + sc.hpPerZone * z) * type.hpMult),
      damage: Math.round(s.baseDamage * (1 + sc.damagePerZone * z) * type.damageMult),
      attackCooldown: Math.max(
        sc.minCooldown,
        s.attackCooldown * (1 - sc.cooldownFactorPerZone * z) * type.cooldownMult
      ),
      attackRange: s.attackRange,
      detectRange: s.detectRange,
      moneyRange: [
        Math.round(s.baseMoneyDrop[0] * (1 + sc.moneyPerZone * z)),
        Math.round(s.baseMoneyDrop[1] * (1 + sc.moneyPerZone * z)),
      ],
    };
  }

  startRun() {
    this.player.refreshLoadout(this.save);
    this.player.resetForRun();
    this.player.x = CONFIG.width / 2;
    this.player.y = CONFIG.height / 2;
    this.zone = 1;
    this.moneyThisRun = 0;
    this.enemies = [];
    this.projectiles = [];
    this.floatingTexts = [];
    this.setState("playing");
    this.startZone();
  }

  startZone() {
    this.player.healOnNewZone();
    if (this.zone > this.save.bestZone) {
      this.save.bestZone = this.zone;
      this.persist();
    }
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

    const type = pickEnemyType(this.zone);
    const zoneStats = this.enemyStatsForZone(this.zone, type);
    this.enemies.push(new Enemy(x, y, zoneStats, type));
  }

  spawnProjectile(x, y, angle, speed, damage) {
    this.projectiles.push(new Projectile(x, y, angle, speed, damage));
  }

  // Snaps the firing angle onto the nearest enemy within a narrow cone ahead
  // of the player, if there is one; otherwise fires straight along facing.
  aimAssist(x, y, facing) {
    const maxAngle = Math.PI / 5;
    const maxDist = 480;
    let best = null;
    let bestDiff = Infinity;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const dx = enemy.x - x, dy = enemy.y - y;
      const d = Math.hypot(dx, dy);
      if (d > maxDist) continue;
      const angle = Math.atan2(dy, dx);
      let diff = Math.abs(angle - facing);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      if (diff <= maxAngle && diff < bestDiff) {
        bestDiff = diff;
        best = angle;
      }
    }
    return best !== null ? best : facing;
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
    this.renderWeaponList("melee-weapon-list", MELEE_WEAPONS, this.save.meleeTier, (idx) => this.buyMeleeWeapon(idx));
    this.renderWeaponList("ranged-weapon-list", RANGED_WEAPONS, this.save.rangedTier, (idx) => this.buyRangedWeapon(idx));
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
            this.player.refreshLoadout(this.save);
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

  // Shared renderer for the sequential melee/ranged weapon tracks: only the
  // next tier is ever purchasable, earlier tiers show as owned, later ones
  // as locked (optionally gated behind a minimum zone reached).
  renderWeaponList(containerId, weapons, currentTier, onBuy) {
    const list = document.getElementById(containerId);
    list.innerHTML = "";
    weapons.forEach((weapon, idx) => {
      const owned = idx <= currentTier;
      const isNext = idx === currentTier + 1;
      const zoneLocked = weapon.minZone && this.save.bestZone < weapon.minZone;

      const card = document.createElement("div");
      card.className = "upgrade-card";
      let statusHtml;
      if (owned) {
        statusHtml = `<span class="level">${idx === currentTier ? "In uso" : "Sbloccata"}</span><button disabled>Posseduta</button>`;
      } else if (!isNext) {
        statusHtml = `<span class="level">Bloccata</span><button disabled>Compra prima l'arma precedente</button>`;
      } else if (zoneLocked) {
        statusHtml = `<span class="level">Bloccata</span><button disabled>Si sblocca alla zona ${weapon.minZone}</button>`;
      } else {
        const affordable = weapon.cost <= this.save.money;
        statusHtml = `<span class="level">&nbsp;</span><button ${affordable ? "" : "disabled"}>Acquista — ${weapon.cost}€</button>`;
      }

      card.innerHTML = `<h3>${weapon.name}</h3><p>${weapon.desc}</p><div class="row">${statusHtml}</div>`;
      if (isNext && !zoneLocked) {
        card.querySelector("button").addEventListener("click", () => onBuy(idx));
      }
      list.appendChild(card);
    });
  }

  buyMeleeWeapon(idx) {
    const weapon = MELEE_WEAPONS[idx];
    if (idx !== this.save.meleeTier + 1 || this.save.money < weapon.cost) return;
    this.save.money -= weapon.cost;
    this.save.meleeTier = idx;
    this.player.refreshLoadout(this.save);
    this.persist();
    this.openUpgradeMenu(this.menuMode);
    this.updateHUDStatic();
  }

  buyRangedWeapon(idx) {
    const weapon = RANGED_WEAPONS[idx];
    if (idx !== this.save.rangedTier + 1 || this.save.money < weapon.cost) return;
    if (weapon.minZone && this.save.bestZone < weapon.minZone) return;
    this.save.money -= weapon.cost;
    this.save.rangedTier = idx;
    this.player.refreshLoadout(this.save);
    this.persist();
    this.openUpgradeMenu(this.menuMode);
    this.updateHUDStatic();
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

    const weaponLabel = document.getElementById("weapon-label");
    weaponLabel.textContent = this.player.ranged
      ? `${this.player.melee.name} · ${this.player.ranged.name}`
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

    for (const proj of this.projectiles) {
      if (proj.dead) continue;
      proj.update(dt);
      for (const enemy of this.enemies) {
        if (enemy.dead || proj.dead) continue;
        if (dist(proj.x, proj.y, enemy.x, enemy.y) <= proj.radius + enemy.radius) {
          this.damageEnemy(enemy, proj.damage);
          proj.dead = true;
        }
      }
    }
    this.projectiles = this.projectiles.filter(p => !p.dead);

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
    for (const proj of this.projectiles) proj.draw(this.ctx);
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
