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
    baseMaxHP: 500,
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
    baseMoneyDrop: [20, 36], // doubled from [10, 18]
  },

  // Pickups dropped by defeated enemies — the run has no progress carried
  // between playthroughs, so these are the in-run safety net.
  pickup: {
    medikitChance: 0.16,
    medikitHealFraction: 0.25, // of player maxHp
    ammoChance: 0.22, // only rolled if the player owns a ranged weapon
    ammoAmountRange: [3, 7],
    lifespan: 14,
    radius: 10,
  },

  zoneScaling: {
    speedPerZone: 0.07,
    hpPerZone: 0.13,
    damagePerZone: 0.09,
    cooldownFactorPerZone: 0.045, // reduces cooldown -> faster attacks
    minCooldown: 0.35,
    moneyPerZone: 0.10,
    // Separate, much slower scaling tied to the player's own power (see
    // Game.playerLevel): the more upgrades/weapons bought, the tougher
    // enemies get too, so fully kitting out doesn't trivialize the run.
    hpPerPlayerLevel: 0.02,
    damagePerPlayerLevel: 0.02,
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

const UPGRADES = [
  {
    id: "gym",
    name: "Palestra in cantina",
    desc: "Aumenta il danno dei tuoi colpi.",
    baseCost: 40,
    growth: 1.45,
    maxLevel: 10,
    perLevel: 3, // + damage
  },
  {
    id: "shoes",
    name: "Scarpe buone",
    desc: "Aumenta velocità di movimento e scatto.",
    baseCost: 35,
    growth: 1.4,
    maxLevel: 10,
    perLevel: 0.045, // multiplier bonus
  },
  {
    id: "jacket",
    name: "Giubbotto rinforzato",
    desc: "Riduce il danno che subisci.",
    baseCost: 45,
    growth: 1.48,
    maxLevel: 10,
    perLevel: 0.075, // damage reduction fraction — 10 levels exactly reach the 0.75 clamp in refreshLoadout()
  },
  {
    id: "firstaid",
    name: "Kit pronto soccorso",
    desc: "Aumenta i punti vita massimi.",
    baseCost: 50,
    growth: 1.42,
    maxLevel: 15,
    perLevel: 500 / 15, // + max hp — 15 levels reach exactly 1000 total (500 base + 500)
  },
  {
    id: "safe",
    name: "Cassaforte",
    desc: "Riduce i soldi che i criminali riescono a rubarti.",
    baseCost: 55,
    growth: 1.48,
    maxLevel: 10,
    perLevel: 0.09, // steal reduction fraction — 10 levels exactly reach the 0.9 clamp in refreshLoadout()
  },
  {
    id: "door",
    name: "Porta blindata",
    desc: "Recuperi un po' di vita all'inizio di ogni zona.",
    baseCost: 75,
    growth: 1.6,
    maxLevel: 10,
    perLevel: 0.09, // fraction of missing hp healed on new zone — 10 levels exactly reach the 0.9 clamp in refreshLoadout()
  },
];

// Sequential melee tiers: each purchase replaces the previous weapon. Every
// tier (but fists) has 1-2 small sub-upgrades that must ALL be bought before
// the next tier becomes purchasable. Within the same archetype (knife -> better
// knife, bat -> pole) a fully upgraded tier still stays behind the next tier's
// base stats, so there's always a reason to move on; across the knife -> bat
// jump the comparison is apples-to-oranges by design (knives trade range for
// attack speed, bats/poles trade speed for reach and burst), so a maxed-out
// knife can out-DPS a stock bat in a straight line — the bat's case is its
// much longer reach against groups, not raw single-target DPS.
const MELEE_WEAPONS = [
  {
    id: "fists", name: "Pugni", desc: "Le tue mani. Gratis, ma poco convincenti.",
    cost: 0, damage: 18, range: 52, cooldown: 0.42, upgrades: [],
  },
  {
    id: "knife1", name: "Coltello", desc: "Taglia in fretta: più danno e colpi più veloci.",
    cost: 60, damage: 26, range: 50, cooldown: 0.32,
    upgrades: [
      { id: "knife1_grip", name: "Impugnatura migliorata", desc: "Colpi leggermente più veloci.", cost: 45, cooldownMult: 0.9 },
      { id: "knife1_blade", name: "Lama più affilata", desc: "Più danno per colpo.", cost: 55, damage: 6 },
    ],
  },
  {
    id: "knife2", name: "Coltello a serramanico", desc: "Lama migliore: ancora più danno e velocità.",
    cost: 140, damage: 36, range: 50, cooldown: 0.24,
    upgrades: [
      { id: "knife2_grip", name: "Impugnatura rinforzata", desc: "Colpi ancora più veloci.", cost: 90, cooldownMult: 0.9 },
      { id: "knife2_blade", name: "Lama temprata", desc: "Più danno per colpo.", cost: 110, damage: 8 },
    ],
  },
  {
    id: "bat", name: "Mazza da baseball", desc: "Più lenta, ma colpisce molto più lontano e più forte.",
    cost: 260, damage: 50, range: 78, cooldown: 0.55,
    upgrades: [
      { id: "bat_spikes", name: "Mazza chiodata", desc: "Chiodi che aumentano il danno.", cost: 160, damage: 14 },
    ],
  },
  {
    id: "pole", name: "Palo d'acciaio", desc: "Portata e danno massimi tra le lame e i pali. Non fa sconti.",
    cost: 420, damage: 75, range: 94, cooldown: 0.6,
    upgrades: [
      { id: "pole_reinforced", name: "Palo rinforzato", desc: "Struttura rinforzata: ancora più danno.", cost: 220, damage: 18 },
    ],
  },
  {
    id: "hammer", name: "Martello", desc: "Il colpo più pesante di tutti: lentissimo da rialzare, ma devastante.",
    cost: 650, damage: 105, range: 86, cooldown: 0.78,
    upgrades: [
      { id: "hammer_reinforced", name: "Testa rinforzata", desc: "Testa più pesante: ancora più danno.", cost: 320, damage: 26 },
    ],
  },
];

// Ranged weapons are a separate, optional loadout slot (key F) unlocked once
// the current run has reached a deep enough zone. Also sequential, also
// gated behind fully upgrading the current gun. Each has a capped ammo pool
// (no unlimited spray) refilled by kills or the zone shop.
const RANGED_WEAPONS = [
  {
    id: "pistol", name: "Pistola", desc: "Colpisce a distanza. Cadenza moderata.",
    cost: 220, damage: 22, cooldown: 0.6, projectileSpeed: 560, minZone: 3, maxAmmo: 24, costPerAmmo: 6,
    upgrades: [
      { id: "pistol_sight", name: "Mirino", desc: "Aggancia i bersagli con più margine.", cost: 80, aimConeBonus: 0.06 },
      { id: "pistol_stock", name: "Calcio", desc: "Cadenza di fuoco più rapida.", cost: 90, cooldownMult: 0.9 },
      { id: "pistol_barrel", name: "Canna lunga", desc: "Più danno per colpo.", cost: 100, damage: 5 },
      { id: "pistol_mag", name: "Caricatore esteso", desc: "Più munizioni massime.", cost: 70, maxAmmo: 8 },
    ],
  },
  {
    id: "smg", name: "Mitra", desc: "Raffica rapida, danno per colpo minore.",
    cost: 480, damage: 13, cooldown: 0.14, projectileSpeed: 640, minZone: 5, maxAmmo: 60, costPerAmmo: 4,
    upgrades: [
      { id: "smg_sight", name: "Mirino", desc: "Aggancia i bersagli con più margine.", cost: 150, aimConeBonus: 0.06 },
      { id: "smg_stock", name: "Calcio", desc: "Cadenza di fuoco più rapida.", cost: 170, cooldownMult: 0.9 },
      { id: "smg_barrel", name: "Canna lunga", desc: "Più danno per colpo.", cost: 190, damage: 3 },
      { id: "smg_mag", name: "Caricatore esteso", desc: "Più munizioni massime.", cost: 140, maxAmmo: 15 },
    ],
  },
  {
    id: "sniper", name: "Cecchino", desc: "Un colpo lentissimo ma devastante: quasi sempre un one-shot.",
    cost: 850, damage: 90, cooldown: 1.4, projectileSpeed: 900, minZone: 7, maxAmmo: 8, costPerAmmo: 25,
    upgrades: [
      { id: "sniper_sight", name: "Mirino", desc: "Aggancia i bersagli con più margine.", cost: 220, aimConeBonus: 0.05 },
      { id: "sniper_stock", name: "Calcio", desc: "Cadenza di fuoco più rapida.", cost: 260, cooldownMult: 0.88 },
      { id: "sniper_barrel", name: "Canna lunga", desc: "Più danno per colpo.", cost: 300, damage: 20 },
      { id: "sniper_mag", name: "Caricatore esteso", desc: "Più munizioni massime.", cost: 200, maxAmmo: 3 },
    ],
  },
  // Fires several pellets per colpo in un piccolo cono: `damage` è il danno
  // di ogni singolo pallino, non del colpo intero — vicino fa malissimo,
  // a distanza i pallini si allargano e mancano più facilmente il bersaglio.
  {
    id: "shotgun", name: "Shotgun", desc: "Spara una rosa di pallini: devastante da vicino, un solo colpo per cartuccia.",
    cost: 1300, damage: 14, cooldown: 0.9, projectileSpeed: 520, minZone: 9, maxAmmo: 20, costPerAmmo: 10,
    pellets: 6, spread: Math.PI / 9,
    upgrades: [
      { id: "shotgun_sight", name: "Mirino", desc: "Aggancia i bersagli con più margine.", cost: 200, aimConeBonus: 0.06 },
      { id: "shotgun_stock", name: "Calcio", desc: "Cadenza di fuoco più rapida.", cost: 220, cooldownMult: 0.9 },
      { id: "shotgun_barrel", name: "Canna lunga", desc: "Più danno per pallino.", cost: 240, damage: 4 },
      { id: "shotgun_mag", name: "Caricatore esteso", desc: "Più cartucce massime.", cost: 170, maxAmmo: 6 },
    ],
  },
  // splashRadius: al contatto esplode danneggiando tutti i nemici nel raggio,
  // non solo quello colpito — vedi la gestione dedicata in Game.update().
  {
    id: "rocket", name: "Lanciarazzi", desc: "Razzo lento ma con danno ad area enorme: spazza via gruppi interi.",
    cost: 2200, damage: 140, cooldown: 1.8, projectileSpeed: 380, minZone: 11, maxAmmo: 4, costPerAmmo: 60,
    splashRadius: 90,
    upgrades: [
      { id: "rocket_sight", name: "Mirino", desc: "Aggancia i bersagli con più margine.", cost: 400, aimConeBonus: 0.08 },
      { id: "rocket_stock", name: "Calcio", desc: "Cadenza di fuoco più rapida.", cost: 450, cooldownMult: 0.85 },
      { id: "rocket_barrel", name: "Canna lunga", desc: "Più danno d'esplosione.", cost: 500, damage: 30 },
      { id: "rocket_mag", name: "Caricatore esteso", desc: "Più razzi massimi.", cost: 350, maxAmmo: 2 },
    ],
  },
];

// Consumable throwables, bought in stacks (not sequential tiers) and thrown
// along the current aim. Expensive on purpose — a panic button, not a main weapon.
const THROWABLES = [
  { id: "grenade", name: "Granata", desc: "Esplosione che infligge danno pesante in un'area.", cost: 1200, kind: "damage", radius: 70, damage: 70, fuse: 1.1, maxCarry: 5 },
  { id: "molotov", name: "Molotov", desc: "Crea una pozza di fuoco che brucia i nemici per qualche secondo.", cost: 1300, kind: "fire", radius: 60, damagePerSecond: 22, duration: 3.5, fuse: 0.6, maxCarry: 5 },
  { id: "sticky", name: "Bomba adesiva", desc: "Si attacca al primo nemico colpito ed esplode con danno enorme.", cost: 1500, kind: "damage", radius: 55, damage: 130, fuse: 1.4, maxCarry: 4, sticky: true },
  { id: "smoke", name: "Granata fumogena", desc: "Acceca i nemici nella zona: smettono di inseguirti per qualche secondo.", cost: 1250, kind: "cc", ccType: "smoke", radius: 100, duration: 4, fuse: 0.5, maxCarry: 4 },
  { id: "flashbang", name: "Granata stordente", desc: "Stordisce i nemici vicini, bloccandoli sul posto per qualche secondo.", cost: 1350, kind: "cc", ccType: "stun", radius: 110, duration: 2.5, fuse: 0.4, maxCarry: 4 },
  { id: "throwknife", name: "Coltello da lancio", desc: "Lama leggera, colpisce quasi all'istante ma fa meno danno di una granata.", cost: 1000, kind: "damage", radius: 30, damage: 45, fuse: 0.12, maxCarry: 8 },
  { id: "shuriken", name: "Shuriken", desc: "Lama piccola e velocissima, perfetta per liberarti in fretta di un nemico isolato.", cost: 1050, kind: "damage", radius: 26, damage: 40, fuse: 0.08, maxCarry: 10 },
];
const THROW_RANGE = 260;
const THROW_CONE = Math.PI / 6;

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
  {
    id: "bruto",
    label: "Bruto",
    color: "#5c2626",
    radiusMult: 1.5,
    speedMult: 0.42,
    hpMult: 1.6,
    damageMult: 2.3,
    cooldownMult: 1.3, // heavy wind-up between hits, to offset how hard they land
    behavior: "steady", // direct pursuit, same as Balordo, just much slower and scarier
    minZone: 4,
    weight: (zone) => (zone < 4 ? 0 : 0.18 + (zone - 4) * 0.05),
  },
  {
    id: "tiratore",
    label: "Tiratore",
    color: "#4a6b7a",
    radiusMult: 0.85,
    speedMult: 0.85,
    hpMult: 0.55, // fragile — the threat is the gun, not a melee trade
    damageMult: 0.8, // low melee fallback damage if it gets cornered
    cooldownMult: 1.0,
    behavior: "ranged",
    minZone: 5,
    preferredRange: 260,
    projectileSpeed: 420,
    projectileDamageMult: 1.0,
    attackRangeOverride: 260, // used as the firing range for this type, not melee reach
    detectRangeOverride: 420,
    weight: (zone) => (zone < 5 ? 0 : 0.15 + (zone - 5) * 0.07),
  },
  {
    id: "driveby",
    label: "Quelli del drive by",
    color: "#3a3f4a",
    radiusMult: 1.7,
    speedMult: 2.6,
    hpMult: 0.5, // fragile, but it's on screen only a couple of seconds
    damageMult: 1.4, // multiplies the projectile damage it fires while passing through
    cooldownMult: 0.5, // fires roughly twice as often during its transit
    behavior: "driveby", // straight-line pass through the field, no chase/melee at all — see Enemy.updateDriveby
    minZone: 6,
    projectileSpeed: 480,
    moneyMult: 5, // juicy bonus if you manage to shoot the car down before it leaves
    weight: (zone) => (zone < 6 ? 0 : 0.12 + (zone - 6) * 0.04),
  },
];

// Aggregates the purchased per-tier upgrades of a weapon into flat stat deltas.
function sumWeaponUpgrades(weaponEntry, ownedIds) {
  const owned = new Set(ownedIds || []);
  const totals = { damage: 0, range: 0, cooldownMult: 1, maxAmmo: 0, aimConeBonus: 0 };
  for (const upg of weaponEntry.upgrades || []) {
    if (!owned.has(upg.id)) continue;
    if (upg.damage) totals.damage += upg.damage;
    if (upg.range) totals.range += upg.range;
    if (upg.cooldownMult) totals.cooldownMult *= upg.cooldownMult;
    if (upg.maxAmmo) totals.maxAmmo += upg.maxAmmo;
    if (upg.aimConeBonus) totals.aimConeBonus += upg.aimConeBonus;
  }
  return totals;
}

function allWeaponUpgradesOwned(weaponEntry, ownedIds) {
  if (!weaponEntry) return true; // no current weapon (e.g. no ranged weapon owned yet) — nothing to gate on
  const owned = new Set(ownedIds || []);
  return (weaponEntry.upgrades || []).every(u => owned.has(u.id));
}

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
  emptyClick() { this.beep(140, 0.05, "square", 0.03); },
  heal() { this.beep(520, 0.12, "sine", 0.05); },
  ammoPickup() { this.beep(660, 0.06, "square", 0.04); },
  throwBomb() { this.beep(300, 0.08, "sine", 0.04); },
  explosion() { this.beep(70, 0.35, "sawtooth", 0.09); },
  wave() { this.beep(220, 0.3, "triangle", 0.06); },
  gameover() { this.beep(80, 0.5, "sawtooth", 0.08); },
};

/* =========================================================
   RUN STATE
   Nothing here survives a death — money, upgrades and weapons only exist
   for the current playthrough. Dying resets everything to zero.
========================================================= */
function createRunState() {
  const upgrades = {};
  UPGRADES.forEach(u => { upgrades[u.id] = 0; });
  return {
    money: 0,
    upgrades,
    meleeTier: 0,
    rangedTier: -1,
    meleeWeaponUpgrades: [], // ids of purchased per-tier weapon upgrades
    rangedWeaponUpgrades: [],
    bombs: {}, // { [throwableId]: count }
    playerLevel: 0, // grows with power purchases; feeds a slow extra enemy scaling
  };
}

/* =========================================================
   SAVE / RESUME
   The run only survives a death via this snapshot — see createRunState's own
   comment. Saved whenever the game actually pauses (see Game.openUpgradeMenu),
   so closing the tab mid-fight loses that wave but never the shop progress.
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

// Stable per-entity ids (Enemy/Projectile/Pickup/Bomb) so a multiplayer guest
// can match the same entity across two snapshots and interpolate its motion
// instead of teleporting it — see Game.sendSnapshot/drawFromSnapshot.
let _nextEntityId = 1;
function nextEntityId() { return _nextEntityId++; }

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
  constructor(x, y, angle, speed, damage, owner = "player", splashRadius = 0) {
    this.id = nextEntityId();
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.damage = damage;
    this.owner = owner; // "player" | "enemy" — decides who it can hit
    this.splashRadius = splashRadius; // rocket launcher: area damage on impact instead of a single hit
    this.radius = splashRadius ? 9 : 6;
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
    ctx.fillStyle = this.owner === "enemy" ? "#ff6a6a" : this.splashRadius ? "#ff8a3d" : "#ffe27a";
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/* =========================================================
   PICKUP (medikit / ammo, dropped by defeated enemies)
========================================================= */
class Pickup {
  constructor(x, y, kind, amount) {
    this.id = nextEntityId();
    this.x = x;
    this.y = y;
    this.kind = kind; // "health" | "ammo"
    this.amount = amount;
    this.radius = CONFIG.pickup.radius;
    this.life = CONFIG.pickup.lifespan;
    this.dead = false;
  }
  update(dt) {
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }
  draw(ctx) {
    const alpha = this.life < 2 ? clamp(this.life / 2, 0.15, 1) : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (this.kind === "health") {
      ctx.fillStyle = "#3ddc71";
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#0c3d1e";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(this.x - 4, this.y); ctx.lineTo(this.x + 4, this.y);
      ctx.moveTo(this.x, this.y - 4); ctx.lineTo(this.x, this.y + 4);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#ffd24a";
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#5c4108";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#5c4108";
      ctx.font = "bold 10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("A", this.x, this.y + 0.5);
    }
    ctx.restore();
  }
}

/* =========================================================
   BOMB (thrown consumables: grenades, molotov, sticky, smoke, stun)
========================================================= */
class Bomb {
  constructor(type, x, y, stickTarget) {
    this.id = nextEntityId();
    this.type = type;
    this.x = x;
    this.y = y;
    this.stickTarget = stickTarget || null; // Enemy instance the sticky bomb is riding, if any
    this.fuse = type.fuse;
    this.exploded = false;
    this.effectTimer = 0;
    this.tickTimer = 0;
    this.dead = false;
  }

  update(dt, game) {
    if (this.stickTarget && !this.stickTarget.dead) {
      this.x = this.stickTarget.x;
      this.y = this.stickTarget.y;
    }

    if (!this.exploded) {
      this.fuse -= dt;
      if (this.fuse <= 0) this.detonate(game);
      return;
    }

    if (this.type.kind === "fire") {
      this.tickTimer -= dt;
      if (this.tickTimer <= 0) {
        this.tickTimer = 0.5;
        for (const enemy of game.enemies) {
          if (!enemy.dead && dist(enemy.x, enemy.y, this.x, this.y) <= this.type.radius) {
            game.damageEnemy(enemy, this.type.damagePerSecond * 0.5);
          }
        }
      }
    } else if (this.type.kind === "cc") {
      for (const enemy of game.enemies) {
        if (!enemy.dead && dist(enemy.x, enemy.y, this.x, this.y) <= this.type.radius) {
          enemy.ccTimer = this.type.duration;
          enemy.ccType = this.type.ccType;
        }
      }
    }

    this.effectTimer -= dt;
    if (this.effectTimer <= 0) this.dead = true;
  }

  detonate(game) {
    this.exploded = true;
    SoundManager.explosion();
    if (this.type.kind === "damage") {
      for (const enemy of game.enemies) {
        if (!enemy.dead && dist(enemy.x, enemy.y, this.x, this.y) <= this.type.radius) {
          game.damageEnemy(enemy, this.type.damage);
        }
      }
      this.dead = true;
    } else {
      this.effectTimer = this.type.duration;
    }
  }

  draw(ctx) {
    if (!this.exploded) {
      ctx.save();
      ctx.fillStyle = this.type.kind === "fire" ? "#ff8a3d" : this.type.kind === "cc" ? "#9fb0bd" : "#3a3a3a";
      ctx.beginPath();
      ctx.arc(this.x, this.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#000000aa";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (this.dead) return;
    ctx.save();
    const frac = clamp(this.effectTimer / this.type.duration, 0, 1);
    ctx.globalAlpha = 0.25 + frac * 0.35;
    ctx.fillStyle = this.type.kind === "fire" ? "#ff5a2a" : this.type.ccType === "stun" ? "#ffe27a" : "#c7d3da";
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.type.radius, 0, Math.PI * 2);
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
    this.facing = -Math.PI / 2; // up — movement direction, drives melee swing & dash
    this.aimAngle = this.facing; // where the ranged weapon points; right stick overrides, else follows facing
    this.radius = CONFIG.player.radius;

    this.attackCooldownTimer = 0;
    this.attackActiveTimer = 0;
    this.rangedCooldownTimer = 0;
    this.dashTimer = 0;
    this.dashCooldownTimer = 0;
    this.invulnTimer = 0;
    this.hitFlash = 0;
    this.isMoving = false;
    this.walkPhase = 0;

    this.hp = 100;
    this.maxHp = 100;
    this.stats = null; // computed from upgrades
    this.melee = null; // computed from equipped melee weapon
    this.ranged = null; // computed from equipped ranged weapon, or null if unarmed
    this.ammo = 0; // rounds currently carried for the equipped ranged weapon
    this._rangedWeaponId = null; // tracks tier changes so ammo only refills on upgrade, not on every stat refresh
    this._rangedMaxAmmo = null; // tracks capacity changes from magazine sub-upgrades

    this.selectedThrowable = 0; // index into THROWABLES
  }

  refreshLoadout(run) {
    const lvl = id => run.upgrades[id] || 0;
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

    const meleeWeapon = MELEE_WEAPONS[run.meleeTier || 0];
    const meleeBonus = sumWeaponUpgrades(meleeWeapon, run.meleeWeaponUpgrades);
    const meleeCooldown = meleeWeapon.cooldown * meleeBonus.cooldownMult;
    this.melee = {
      id: meleeWeapon.id,
      name: meleeWeapon.name,
      damage: meleeWeapon.damage + gymBonus + meleeBonus.damage,
      range: meleeWeapon.range + meleeBonus.range,
      cooldown: meleeCooldown,
      activeTime: Math.min(0.18, meleeCooldown * 0.4),
    };

    const rangedIdx = run.rangedTier;
    if (rangedIdx != null && rangedIdx >= 0 && RANGED_WEAPONS[rangedIdx]) {
      const rw = RANGED_WEAPONS[rangedIdx];
      const rangedBonus = sumWeaponUpgrades(rw, run.rangedWeaponUpgrades);
      const newMaxAmmo = rw.maxAmmo + rangedBonus.maxAmmo;
      if (this._rangedWeaponId !== rw.id) {
        // Newly acquired or upgraded gun: hand it over freshly loaded.
        this.ammo = newMaxAmmo;
        this._rangedWeaponId = rw.id;
      } else if (this._rangedMaxAmmo != null && newMaxAmmo > this._rangedMaxAmmo) {
        // Same gun, but a magazine sub-upgrade just extended its capacity.
        this.ammo += newMaxAmmo - this._rangedMaxAmmo;
      }
      this._rangedMaxAmmo = newMaxAmmo;
      this.ranged = {
        name: rw.name,
        damage: rw.damage + gymBonus * 0.5 + rangedBonus.damage,
        cooldown: rw.cooldown * rangedBonus.cooldownMult,
        projectileSpeed: rw.projectileSpeed,
        maxAmmo: newMaxAmmo,
        aimConeBonus: rangedBonus.aimConeBonus,
        pellets: rw.pellets || 1,
        spread: rw.spread || 0,
        splashRadius: rw.splashRadius || 0,
      };
    } else {
      this.ranged = null;
      this._rangedWeaponId = null;
      this._rangedMaxAmmo = null;
      this.ammo = 0;
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

  // Touch-only hands-free melee: the touch attack button was replaced by the
  // aim stick (see index.html/bindAimStick), so on touch devices melee fires
  // on its own whenever an enemy is within range, mirroring how ranged
  // auto-fire already works. Keyboard/gamepad melee stays manual (Space/Cross).
  autoMeleeAttack(game) {
    if (this.attackCooldownTimer > 0) return;
    const inRange = game.enemies.some(e => !e.dead && dist(this.x, this.y, e.x, e.y) <= this.melee.range + e.radius);
    if (inRange) this.tryAttack(game);
  }

  // Manual trigger (F key / R2): fires along the current aim even if nothing
  // is lined up, snapping onto a nearby enemy within a narrow cone if there is one.
  tryRangedAttack(game) {
    if (!this.ranged || this.rangedCooldownTimer > 0) return;
    if (this.ammo <= 0) { SoundManager.emptyClick(); return; }
    const angle = game.aimAssist(this.x, this.y, this.aimAngle, this.ranged.aimConeBonus);
    this.fireRanged(game, angle);
  }

  // Hands-free auto-fire, like a mobile shooter: as long as the aim (right
  // stick, or facing when it's centered) is actually resting on an enemy in
  // range, the gun keeps firing on its own — no trigger needed.
  autoFireRanged(game) {
    if (!this.ranged || this.rangedCooldownTimer > 0 || this.ammo <= 0) return;
    const angle = game.findAutoFireAngle(this.x, this.y, this.aimAngle, this.ranged.aimConeBonus);
    if (angle === null) return;
    this.fireRanged(game, angle);
  }

  fireRanged(game, angle) {
    this.rangedCooldownTimer = this.ranged.cooldown;
    this.ammo--;
    const muzzle = this.radius + 8;
    const pellets = this.ranged.pellets;
    for (let i = 0; i < pellets; i++) {
      // Single-pellet weapons fire straight down `angle`; multi-pellet ones
      // (shotgun) fan out evenly across `spread`, centered on it.
      const a = pellets > 1 ? angle + (i / (pellets - 1) - 0.5) * this.ranged.spread : angle;
      game.spawnProjectile(
        this.x + Math.cos(a) * muzzle,
        this.y + Math.sin(a) * muzzle,
        a,
        this.ranged.projectileSpeed,
        this.ranged.damage,
        this.ranged.splashRadius
      );
    }
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

    // True 360° direction when the input device offers one (gamepad stick,
    // touch joystick); keyboard has no analog direction, so it falls back
    // to the old 8-way (up/down/left/right, diagonals normalized) combo.
    let mx = 0, my = 0;
    const analogMove = input.moveVec;
    if (analogMove) {
      const mag = Math.hypot(analogMove.x, analogMove.y) || 1;
      mx = analogMove.x / mag;
      my = analogMove.y / mag;
    } else {
      if (input.isDown("left")) mx -= 1;
      if (input.isDown("right")) mx += 1;
      if (input.isDown("up")) my -= 1;
      if (input.isDown("down")) my += 1;
      const len = Math.hypot(mx, my);
      if (len > 0) { mx /= len; my /= len; }
    }

    const moving = mx !== 0 || my !== 0;
    if (moving) this.facing = Math.atan2(my, mx);
    this.isMoving = moving;
    this.walkPhase = moving ? this.walkPhase + dt * 10 : 0;

    // Right stick (gamepad) or aim stick (touch), if tilted, aims
    // independently of movement; otherwise the aim just follows facing,
    // which keeps keyboard-only play unchanged.
    const stickAim = input.gpAim || input.touchAim;
    this.aimAngle = stickAim ? Math.atan2(stickAim.y, stickAim.x) : this.facing;

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

    // body: bird's-eye top-down head sprite (rotated to facing, with a small
    // walk bob) once loaded, falling back to the original vector circle
    // until then
    const sprite = Sprites.get("player");
    if (sprite) {
      const bob = this.isMoving ? Math.sin(this.walkPhase) * 3 : 0;
      const size = this.radius * 2.3;
      ctx.save();
      ctx.rotate(this.facing + Math.PI / 2); // sprite art faces "up" by default
      const { w, h } = drawSpriteFit(ctx, sprite, size, bob);
      if (this.hitFlash > 0) {
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = `rgba(255, 90, 90, ${Math.min(0.6, this.hitFlash * 2)})`;
        ctx.fillRect(-w / 2, -h / 2 + bob, w, h);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();
    } else {
      ctx.fillStyle = this.hitFlash > 0 ? "#ff8080" : "#4fa1e8";
      ctx.beginPath();
      ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#1c2b3d";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Weapon overlay: a single hand+weapon icon (authored pointing "up",
    // hand at the bottom), offset forward of the head so it reads as an arm
    // reaching out in the aim/facing direction. Every weapon but the fists
    // is also offset to the side (held out beside the body); the fists stay
    // centered, like a guard stance in front of the face rather than off to
    // one side. Shows the ranged weapon (rotated to aim, independent of body
    // facing) when one is equipped, otherwise the current melee weapon
    // (rotated with facing, like the body).
    const weaponId = this.ranged ? this._rangedWeaponId : (this.melee && this.melee.id);
    const weaponSprite = weaponId && Sprites.get(weaponId);
    if (weaponSprite) {
      const weaponAngle = this.ranged ? this.aimAngle : this.facing;
      const size = this.radius * 2.6;
      const sideOffset = weaponId === "fists" ? 0 : this.radius * 0.5;
      ctx.save();
      ctx.rotate(weaponAngle + Math.PI / 2 - (WEAPON_SPRITE_ANGLE_CORRECTION[weaponId] || 0));
      ctx.translate(sideOffset, -this.radius * 0.6);
      drawSpriteFit(ctx, weaponSprite, size);
      ctx.restore();
    }

    // aim indicator: only meaningful with a ranged weapon, and only worth
    // drawing separately from facing when it actually points elsewhere
    if (this.ranged && Math.abs(this.aimAngle - this.facing) > 0.05) {
      const aimLen = this.radius * 1.2 + this.melee.range * 0.25 + 14;
      ctx.strokeStyle = "#ffd24a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(this.aimAngle) * aimLen, Math.sin(this.aimAngle) * aimLen);
      ctx.stroke();
    }

    ctx.restore();
  }
}

/* =========================================================
   ENEMY
========================================================= */
class Enemy {
  constructor(x, y, stats, type) {
    this.id = nextEntityId();
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
    this.facing = -Math.PI / 2; // default facing until movement/AI takes over
    this.isMoving = false;
    this.walkPhase = 0;

    // "steady" / "aggressive" behavior
    this.jitterAngle = rand(0, Math.PI * 2);
    this.jitterTimer = rand(0, 1);

    // "erratic" behavior
    this.moveDir = { x: 0, y: 0 };
    this.moveSpeedMult = 1;
    this.erraticTimer = rand(0, 0.3);

    // "ranged" behavior
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;

    // "driveby" behavior — set by Game.spawnDriveby right after construction
    this.drivebyDir = 1;

    // crowd control from smoke/stun bombs
    this.ccTimer = 0;
    this.ccType = null; // "smoke" | "stun"
  }

  update(dt, player, game) {
    if (this.dead) return;
    if (this.attackCooldownTimer > 0) this.attackCooldownTimer -= dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;

    if (this.type.behavior === "driveby") {
      this.updateDriveby(dt, player, game);
      return; // ignores CC, separation and the normal field-boundary clamp entirely
    }

    if (this.ccTimer > 0) {
      this.ccTimer -= dt;
      this.isMoving = false;
      return; // stunned/blinded by a bomb: frozen in place for the duration
    }

    const d = dist(this.x, this.y, player.x, player.y);
    this.isMoving = false;

    if (this.type.behavior === "ranged") {
      this.updateRanged(dt, player, game, d);
    } else if (d <= this.stats.attackRange + this.radius) {
      this.facing = Math.atan2(player.y - this.y, player.x - this.x);
      if (this.attackCooldownTimer <= 0) {
        this.attackCooldownTimer = this.stats.attackCooldown;
        const hit = player.takeDamage(this.stats.damage);
        if (hit) game.onPlayerHit(player);
      }
    } else {
      this.moveTowardBehavior(dt, player, d);
    }

    this.walkPhase = this.isMoving ? this.walkPhase + dt * 10 : 0;

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

  // Straight-line pass across the field: never turns, never melees, just
  // fires at the player on a timer until it drives off the far edge. Cooldown
  // and hit-flash timers are already ticked down by the caller (update()).
  updateDriveby(dt, player, game) {
    this.x += this.drivebyDir * this.stats.speed * dt;
    this.isMoving = true;

    if (this.attackCooldownTimer <= 0) {
      this.attackCooldownTimer = this.stats.attackCooldown;
      const angle = Math.atan2(player.y - this.y, player.x - this.x);
      game.spawnEnemyProjectile(this.x, this.y, angle, this.type.projectileSpeed, this.stats.damage);
    }

    if (this.x < -60 || this.x > CONFIG.width + 60) {
      this.dead = true;
      game.onDrivebyExit();
    }
  }

  // Slow, aimless wandering used by any behavior below once the player is
  // beyond its detectRange, so an "undetected" enemy looks alive instead of
  // frozen in place, without revealing where the player actually is. The
  // driveby car ignores detectRange entirely (see updateDriveby) and the
  // erratic behavior already has its own near-identical far-away wander
  // built in (see moveTowardBehavior), so neither calls this.
  wanderRandomly(dt) {
    this.erraticTimer -= dt;
    if (this.erraticTimer <= 0) {
      this.erraticTimer = rand(0.6, 1.4);
      const a = rand(0, Math.PI * 2);
      this.moveDir = { x: Math.cos(a), y: Math.sin(a) };
    }
    this.x += this.moveDir.x * this.stats.speed * 0.4 * dt;
    this.y += this.moveDir.y * this.stats.speed * 0.4 * dt;
    this.isMoving = true;
    this.facing = Math.atan2(this.moveDir.y, this.moveDir.x);
  }

  // Kites to stay near its preferred range instead of closing to melee, and
  // fires a projectile at the player whenever it's within firing range.
  updateRanged(dt, player, game, d) {
    if (d > this.stats.detectRange) { this.wanderRandomly(dt); return; } // hasn't noticed the player yet

    const pref = this.type.preferredRange;
    let dx = player.x - this.x, dy = player.y - this.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;

    let dir = 0; // -1 retreat, 1 approach, 0 hold position
    if (d < pref * 0.75) dir = -1;
    else if (d > pref * 1.25) dir = 1;

    if (dir !== 0) {
      this.x += dx * dir * this.stats.speed * dt;
      this.y += dy * dir * this.stats.speed * dt;
      this.facing = Math.atan2(dy * dir, dx * dir);
    } else {
      // small sideways strafe so it doesn't just stand still at range
      this.x += -dy * this.strafeDir * this.stats.speed * 0.3 * dt;
      this.y += dx * this.strafeDir * this.stats.speed * 0.3 * dt;
      this.facing = Math.atan2(dy, dx); // keeps facing the player while strafing
    }
    this.isMoving = true;

    if (d <= this.stats.attackRange && this.attackCooldownTimer <= 0) {
      this.attackCooldownTimer = this.stats.attackCooldown;
      const angle = Math.atan2(player.y - this.y, player.x - this.x);
      this.facing = angle;
      game.spawnEnemyProjectile(this.x, this.y, angle, this.type.projectileSpeed, this.stats.damage);
    }
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
      this.isMoving = true;
      this.facing = Math.atan2(this.moveDir.y, this.moveDir.x);
      return;
    }

    if (d > this.stats.detectRange) { this.wanderRandomly(dt); return; }

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
    this.isMoving = true;
    this.facing = Math.atan2(jdy, jdx);
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

    // Top-down sprite per enemy type (rotated to facing) once loaded,
    // falling back to the original vector shapes until then. Each enemy's
    // sprite already bakes in its head, arms and held item as one image
    // (enemies don't swap weapons like the player), so unlike Player.draw()
    // there's no separate weapon overlay here.
    const sprite = Sprites.get(this.type.id);
    if (sprite) {
      const bob = this.isMoving ? Math.sin(this.walkPhase) * 2 : 0;
      const size = this.radius * 3.6;
      ctx.save();
      // Sprite convention is "faces up" EXCEPT the humanoid reference
      // portraits, whose arms/held item hang toward the BOTTOM of their own
      // frame (their actual forward/attack direction) — so those need an
      // extra 180deg on top of the usual facing rotation, or they render
      // walking/attacking backwards. The driveby car's front is already at
      // the top of its frame, so it's excluded (see ENEMY_SPRITE_ANGLE_CORRECTION).
      ctx.rotate(this.facing + Math.PI / 2 + (ENEMY_SPRITE_ANGLE_CORRECTION[this.type.id] || 0));
      const { w, h } = drawSpriteFit(ctx, sprite, size, bob);
      if (this.hitFlash > 0) {
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
        ctx.fillRect(-w / 2, -h / 2 + bob, w, h);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();
    } else if (this.type.behavior === "driveby") {
      this.drawCar(ctx);
    } else {
      ctx.fillStyle = this.hitFlash > 0 ? "#ffffff" : this.type.color;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#00000055";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
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

    if (this.ccTimer > 0) {
      ctx.save();
      ctx.fillStyle = this.ccType === "stun" ? "#ffe27a" : "#c7d3da";
      ctx.font = "bold 12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(this.ccType === "stun" ? "☆" : "?", this.x, this.y - this.radius - 14);
      ctx.restore();
    }
  }

  // Simple vector car (matches the rest of the game's shape-only art): a body
  // rectangle oriented along its travel direction, with two riders inside.
  drawCar(ctx) {
    const w = this.radius * 2.6, h = this.radius * 1.4;
    if (this.drivebyDir < 0) ctx.rotate(Math.PI);
    ctx.fillStyle = this.hitFlash > 0 ? "#ffffff" : this.type.color;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = "#00000066";
    ctx.lineWidth = 2;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = "#c7cad1";
    ctx.beginPath(); ctx.arc(-w * 0.18, 0, this.radius * 0.26, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(w * 0.18, 0, this.radius * 0.26, 0, Math.PI * 2); ctx.fill();
  }
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

// Input-shaped adapter fed by messages from the remote peer, so
// Player.update(dt, input) can drive the second player exactly like it
// drives the local one — see Game.applyRemoteState.
class RemoteInputState {
  constructor() {
    this.moveState = { up: false, down: false, left: false, right: false };
    this.moveVec = null; // { x, y } continuous direction, or null (keyboard-only guest)
    this.aim = null; // { x, y } unit vector, or null when centered
  }
  isDown(dir) { return !!this.moveState[dir]; }
  get gpAim() { return this.aim; }
  get touchAim() { return null; }
}

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
        const wasGuest = this.role === "guest";
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
          this.game.onNetworkClosed(wasGuest);
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
        this.hostId = msg.hostId; // lets us tell "the host left" apart from "some other guest left"
        this.notify();
        // Tell the host what kind of input device we are, so it can decide
        // whether to run auto-melee for our character (see Player.autoMeleeAttack).
        this.send({ type: "hello", isTouchDevice: this.game.isTouchDevice });
        break;
      case "join-error":
        this.game.onRoomJoinError(msg.reason);
        break;
      case "hello":
        this.game.onRemoteHello(msg);
        break;
      case "peer-joined":
        // Order matters: onPeerJoined() actually adds the entry to
        // this.game.remotePlayers, which the status UI reads the size of —
        // notifying first would show a stale, one-behind player count.
        this.game.onPeerJoined(msg.id);
        this.notify();
        break;
      case "peer-left":
        this.game.onPeerLeft(msg.id);
        this.notify();
        break;
      case "state":
        this.game.applyRemoteState(msg);
        break;
      case "action":
        this.game.applyRemoteAction(msg);
        break;
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

    this.network = new NetworkManager(this);
    // Host-side only: one entry per connected peer (up to 3, for up to 4
    // players total), keyed by that peer's server-assigned id — see
    // onPeerJoined/onPeerLeft and applyRemoteState/applyRemoteAction.
    this.remotePlayers = new Map(); // id -> { player: Player, input: RemoteInputState, isTouchDevice: bool }
    this._pendingTouchFlags = new Map(); // id -> bool, for a "hello" that arrives just before its "peer-joined"
    this._snapshotTimer = 0;
    this._stateSendTimer = 0;
    // Guest-only: raw snapshots (see applySnapshot) used to interpolate
    // positions smoothly in drawFromSnapshot() instead of teleporting.
    this._snapPrev = null;
    this._snapCurr = null;
    this._snapReceivedAt = 0;
    this._snapInterpDuration = 1 / 100;

    this.input = new InputHandler();
    // In multiplayer these callbacks fork on role: the host (or a solo
    // player) executes the action directly exactly as before; a guest has
    // no local simulation to act on, so it ships the action to the host
    // over the network instead (see NetworkManager / applyRemoteAction).
    this.input.onAttack = () => {
      if (this.network.isGuest) { this.network.send({ type: "action", action: "attack" }); return; }
      if (this.state === "playing") this.player.tryAttack(this);
    };
    this.input.onRangedAttack = () => {
      if (this.network.isGuest) { this.network.send({ type: "action", action: "rangedAttack" }); return; }
      if (this.state === "playing") this.player.tryRangedAttack(this);
    };
    this.input.onDash = () => {
      if (this.network.isGuest) { this.network.send({ type: "action", action: "dash" }); return; }
      if (this.state === "playing") this.player.tryDash();
    };
    // Pause/shop stays host-only in this version — the guest is a thin
    // client and doesn't manage the shared shop UI, see README.
    this.input.onToggleMenu = () => { if (!this.network.isGuest) this.toggleUpgradeMenu(); };
    this.input.onThrowBomb = () => {
      if (this.network.isGuest) { this.network.send({ type: "action", action: "throwBomb" }); return; }
      if (this.state === "playing") this.throwBomb(this.player);
    };
    this.input.onSelectBomb = (value, absolute) => {
      if (this.network.isGuest) { this.network.send({ type: "action", action: "selectBomb", value, absolute }); return; }
      if (this.state === "playing") this.selectBomb(value, absolute, this.player);
    };

    this.run = createRunState();
    this.player = new Player(CONFIG.width / 2, CONFIG.height / 2);
    this.player.refreshLoadout(this.run);
    this.player.resetForRun();

    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.bombs = [];
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
    this.detectTouchDevice();
    this.bindTouchControls();
    this.bindMultiplayerUI();
    this.setupResponsiveScaling();
    this.updateHUDStatic();
    this.refreshSaveSummary();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  bindUI() {
    document.getElementById("start-btn").addEventListener("click", () => {
      SoundManager.ensure();
      clearRunState(); // starting fresh deliberately abandons any saved run
      this.startRun();
    });
    document.getElementById("continue-btn").addEventListener("click", () => {
      SoundManager.ensure();
      this.resumeRun();
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
  normalizeRun(run) {
    UPGRADES.forEach(u => { if (run.upgrades[u.id] == null) run.upgrades[u.id] = 0; });
    if (run.meleeTier == null) run.meleeTier = 0;
    if (run.rangedTier == null) run.rangedTier = -1;
    if (!run.meleeWeaponUpgrades) run.meleeWeaponUpgrades = [];
    if (!run.rangedWeaponUpgrades) run.rangedWeaponUpgrades = [];
    if (!run.bombs) run.bombs = {};
    if (run.playerLevel == null) run.playerLevel = 0;
    if (run.money == null) run.money = 0;
    return run;
  }

  // Restores the shop progress (money, upgrades, weapons, zone reached) from
  // the last save; the wave in progress when it was saved is not replayed,
  // the zone simply restarts fresh — see the SAVE / RESUME header comment.
  resumeRun() {
    const saved = loadRunState();
    if (!saved) { this.startRun(); return; }
    this.run = this.normalizeRun(saved.run);
    this.zone = saved.zone || 1;
    this.moneyThisRun = 0;
    this.player.refreshLoadout(this.run);
    this.player.resetForRun();
    if (saved.playerHp != null) this.player.hp = clamp(saved.playerHp, 1, this.player.maxHp);
    this.player.x = CONFIG.width / 2;
    this.player.y = CONFIG.height / 2;
    this.repositionRemotePlayers();
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.bombs = [];
    this.player.selectedThrowable = 0;
    this.floatingTexts = [];
    this.setState("playing");
    this.startZone();
  }

  // See the SAVE / RESUME header comment: called every time the game
  // actually pauses (openUpgradeMenu), not continuously.
  saveGame() {
    saveRunState({ zone: this.zone, run: this.run, playerHp: this.player.hp });
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
  // On a phone/tablet, the canvas is NEVER rotated and the game field must
  // stay clean: HUD text and touch controls both live outside of it, in
  // strips above/below (portrait) or panels left/right (landscape) — see the
  // .portrait-controls / .landscape-controls CSS, which also owns the fixed
  // pixel size of #game-container for each case (this function just has to
  // know those same totals to compute a matching scale). A narrow desktop
  // *browser window* (no touch) keeps the old 90deg-rotate trick instead,
  // since there's no touch UI to place outside the field there.
  setupResponsiveScaling() {
    const container = document.getElementById("game-container");
    // Must match the #game-container width/height in the corresponding CSS class.
    const PORTRAIT_TOTAL = { w: 960, h: 1210 };
    const LANDSCAPE_TOTAL = { w: 1740, h: 700 };
    const fit = () => {
      const isTouch = document.documentElement.classList.contains("touch-device");
      const portrait = window.innerHeight > window.innerWidth;
      document.documentElement.classList.toggle("portrait-controls", isTouch && portrait);
      document.documentElement.classList.toggle("landscape-controls", isTouch && !portrait);
      if (isTouch) {
        this.portraitRotated = false;
        const total = portrait ? PORTRAIT_TOTAL : LANDSCAPE_TOTAL;
        const scale = Math.min(window.innerWidth / total.w, window.innerHeight / total.h);
        container.style.transform = `scale(${scale})`;
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

    document.getElementById("touch-bomb-throw").addEventListener("touchstart", e => {
      e.preventDefault();
      if (this.state === "playing") this.throwBomb();
    }, { passive: false });
    document.getElementById("touch-bomb-select").addEventListener("touchstart", e => {
      e.preventDefault();
      if (this.state === "playing") this.selectBomb(1, false);
    }, { passive: false });
    document.getElementById("touch-pause").addEventListener("touchstart", e => {
      e.preventDefault();
      this.toggleUpgradeMenu();
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
      let dx = clientX - cx, dy = clientY - cy;
      if (this.portraitRotated) {
        // undo the container's 90deg CSS rotation: a real on-screen drag has
        // to be mapped back onto the game's own (unrotated) up/down/left/right
        [dx, dy] = [dy, -dx];
      }
      const mag = Math.hypot(dx, dy) || 1;
      const clampedFrac = Math.min(mag, realMaxRadius) / realMaxRadius; // 0..1, scale-independent
      const fx = (dx / mag) * clampedFrac;
      const fy = (dy / mag) * clampedFrac;
      knob.style.transform = `translate(${fx * knobTravel}px, ${fy * knobTravel}px)`;

      const knobMag = Math.hypot(fx, fy);
      if (knobMag < 0.2) {
        this.input.touchMove = { up: false, down: false, left: false, right: false };
        this.input.touchMoveVec = null;
      } else {
        this.input.touchMove = { left: fx < -0.3, right: fx > 0.3, up: fy < -0.3, down: fy > 0.3 };
        // True 360° direction (unit vector) — see Player.update(), preferred
        // over the 8-way touchMove booleans above whenever it's available.
        this.input.touchMoveVec = { x: fx / knobMag, y: fy / knobMag };
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
      let dx = clientX - cx, dy = clientY - cy;
      if (this.portraitRotated) {
        [dx, dy] = [dy, -dx];
      }
      const mag = Math.hypot(dx, dy) || 1;
      const clampedFrac = Math.min(mag, realMaxRadius) / realMaxRadius;
      const fx = (dx / mag) * clampedFrac;
      const fy = (dy / mag) * clampedFrac;
      knob.style.transform = `translate(${fx * knobTravel}px, ${fy * knobTravel}px)`;

      const knobMag = Math.hypot(fx, fy);
      this.input.touchAim = knobMag < 0.2 ? null : { x: fx / knobMag, y: fy / knobMag };
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
        const count = this.remotePlayers.size + 1; // +1 for the host itself
        setStatus(
          count > 1
            ? `Stanza ${net.roomCode} — ${count}/4 giocatori connessi, condividi il codice per farne entrare altri`
            : `Stanza ${net.roomCode} — condividi il codice, in attesa di altri giocatori (fino a 4 in totale)...`,
          count > 1 ? "mp-ok" : null
        );
      } else if (net.isGuest) {
        setStatus(`Connesso alla stanza ${net.roomCode}. In attesa dell'host...`, "mp-ok");
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
      const wasGuest = this.network.isGuest;
      this.network.disconnect();
      this.remotePlayers.clear();
      this._snapPrev = null;
    this._snapCurr = null;
      document.getElementById("mp-wait-overlay").classList.add("hidden");
      this.network.onStatusChange();
      if (wasGuest) this.setState("menu");
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

  // A peer just paired into our room. On the guest side this message just
  // means "some *other* guest joined too" — irrelevant to us, we only ever
  // talk to the host — so this stays a no-op there.
  //
  // Host-side, hot-add a Player for them, spread out around the host's
  // spawn point; this can happen before a run has even started (menu) or
  // mid-run either way. Nothing else needs to change since enemy
  // targeting/collision/game-over already iterate over activePlayers.
  onPeerJoined(id) {
    if (!this.network.isHost || this.remotePlayers.has(id)) return;
    const off = this.spawnOffsetFor(this.remotePlayers.size + 1);
    const player = new Player(CONFIG.width / 2 + off.x, CONFIG.height / 2 + off.y);
    player.refreshLoadout(this.run);
    player.resetForRun();
    const isTouchDevice = this._pendingTouchFlags.get(id) || false;
    this._pendingTouchFlags.delete(id);
    this.remotePlayers.set(id, { player, input: new RemoteInputState(), isTouchDevice });
  }

  // The guest tells us (the host) whether it's a touch device right after
  // joining, so we know whether to run auto-melee for its character too —
  // see Player.autoMeleeAttack and the isTouchDevice-gated call in update().
  // Stashed in _pendingTouchFlags if it beats the matching "peer-joined"
  // there (the server sends peer-joined first, but message arrival order
  // across two different sockets is never strictly guaranteed).
  onRemoteHello(msg) {
    const entry = this.remotePlayers.get(msg.from);
    if (entry) entry.isTouchDevice = !!msg.isTouchDevice;
    else this._pendingTouchFlags.set(msg.from, !!msg.isTouchDevice);
  }

  onPeerLeft(id) {
    if (this.network.isHost) {
      // That one player dropped out — everyone else's game continues uninterrupted.
      this.remotePlayers.delete(id);
      this._pendingTouchFlags.delete(id);
      return;
    }
    // We're a guest. With up to 4 players in a room, a "peer-left" can be
    // about any *other* guest leaving — none of our business, since we only
    // ever talk to the host. Only react if it's specifically the host that
    // disconnected, since that's the one peer we actually depend on: there's
    // no local simulation to fall back on, so head back to the menu.
    if (id !== this.network.hostId) return;
    this.network.disconnect();
    this.remotePlayers.clear();
    this._snapPrev = null;
    this._snapCurr = null;
    document.getElementById("mp-wait-overlay").classList.add("hidden");
    this.setState("menu");
  }

  // Our own socket closed (not a "peer-left" relay message — our actual
  // connection to the relay dropped). For a guest that means the whole
  // session is gone since it never ran its own simulation; a host just
  // loses its networking and can keep playing solo.
  onNetworkClosed(wasGuest) {
    this.remotePlayers.clear();
    this._pendingTouchFlags.clear();
    this._snapPrev = null;
    this._snapCurr = null;
    document.getElementById("mp-wait-overlay").classList.add("hidden");
    if (wasGuest) this.setState("menu");
  }

  // Spawn offset (relative to field center) for the Nth player to join a
  // room, host included — a small cross formation so up to 4 players don't
  // stack on top of each other. Index 0 (the host) is always dead center.
  spawnOffsetFor(index) {
    const offsets = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: -60, y: 0 }, { x: 0, y: 60 }];
    return offsets[index % offsets.length];
  }

  // Applies the current run's upgrades/weapons to every connected player —
  // shared by every shop purchase handler below.
  refreshAllLoadouts() {
    this.player.refreshLoadout(this.run);
    for (const entry of this.remotePlayers.values()) entry.player.refreshLoadout(this.run);
  }

  // Refreshes loadout and re-spawns every currently-connected remote player
  // around the host's spawn point — shared by startRun()/resumeRun().
  repositionRemotePlayers() {
    let i = 1;
    for (const entry of this.remotePlayers.values()) {
      const off = this.spawnOffsetFor(i++);
      entry.player.refreshLoadout(this.run);
      entry.player.resetForRun();
      entry.player.x = CONFIG.width / 2 + off.x;
      entry.player.y = CONFIG.height / 2 + off.y;
    }
  }

  // Every living player (host's own + every connected guest's) — used by
  // enemy targeting, projectile/pickup collision and the game-over check so
  // none of that logic needs to know whether we're actually in multiplayer,
  // let alone how many players are in the room.
  get activePlayers() {
    const list = [this.player];
    for (const entry of this.remotePlayers.values()) list.push(entry.player);
    return list.filter(p => p.hp > 0);
  }

  nearestPlayerTo(x, y) {
    const candidates = this.activePlayers;
    if (candidates.length === 0) return this.player;
    let best = candidates[0];
    let bestD = dist(x, y, best.x, best.y);
    for (let i = 1; i < candidates.length; i++) {
      const d = dist(x, y, candidates[i].x, candidates[i].y);
      if (d < bestD) { bestD = d; best = candidates[i]; }
    }
    return best;
  }

  // Guest -> host: continuous movement/aim state, sent at a throttled rate
  // (see update()). Applied straight into the sender's RemoteInputState,
  // identified by msg.from — see the entry.player.update() call in update().
  applyRemoteState(msg) {
    if (!this.network.isHost) return;
    const entry = this.remotePlayers.get(msg.from);
    if (!entry) return;
    entry.input.moveState = msg.move || { up: false, down: false, left: false, right: false };
    entry.input.moveVec = msg.moveVec || null;
    entry.input.aim = msg.aim || null;
  }

  // Guest -> host: discrete one-shot actions (mirrors the local keyboard's
  // edge-triggered onAttack/onDash/etc. — one message per press, cooldowns
  // inside tryAttack/tryDash/etc. already make repeats harmless).
  applyRemoteAction(msg) {
    if (!this.network.isHost || this.state !== "playing") return;
    const entry = this.remotePlayers.get(msg.from);
    if (!entry) return;
    const rp = entry.player;
    switch (msg.action) {
      case "attack": rp.tryAttack(this); break;
      case "rangedAttack": rp.tryRangedAttack(this); break;
      case "dash": rp.tryDash(); break;
      case "throwBomb": this.throwBomb(rp); break;
      case "selectBomb": this.selectBomb(msg.value, msg.absolute, rp); break;
    }
  }

  // Host -> guest: a compact snapshot of everything the guest needs to
  // render (see applySnapshot). Throttled — see the call site in update().
  sendSnapshot() {
    const serializePlayer = (p, id, isHost) => ({
      id, isHost,
      x: p.x, y: p.y, facing: p.facing, aimAngle: p.aimAngle,
      radius: p.radius, hp: p.hp, maxHp: p.maxHp,
      meleeId: p.melee && p.melee.id, meleeName: p.melee && p.melee.name,
      rangedId: p._rangedWeaponId, rangedName: p.ranged && p.ranged.name,
      ammo: p.ammo, maxAmmo: p.ranged && p.ranged.maxAmmo,
      hitFlash: p.hitFlash, isMoving: p.isMoving, walkPhase: p.walkPhase,
      attackActiveTimer: p.attackActiveTimer, isInvulnerable: p.isInvulnerable,
      meleeRange: p.melee && p.melee.range,
    });
    const players = [serializePlayer(this.player, this.network.myId, true)];
    for (const [id, entry] of this.remotePlayers) players.push(serializePlayer(entry.player, id, false));

    const state = {
      gameState: this.state,
      zone: this.zone,
      zoneName: this.zoneName(this.zone),
      waveTotal: this.waveTotalEnemies,
      waveDefeated: this.waveEnemiesDefeated,
      money: this.run.money,
      finalZone: this.zone,
      finalMoney: Math.max(0, this.moneyThisRun),
      players,
      enemies: this.enemies.filter(e => !e.dead).map(e => ({
        id: e.id, x: e.x, y: e.y, facing: e.facing, hp: e.hp, maxHp: e.maxHp,
        radius: e.radius, typeId: e.type.id, hitFlash: e.hitFlash,
        isMoving: e.isMoving, walkPhase: e.walkPhase,
        ccTimer: e.ccTimer, ccType: e.ccType, drivebyDir: e.drivebyDir,
      })),
      projectiles: this.projectiles.map(p => ({
        id: p.id, x: p.x, y: p.y, radius: p.radius, owner: p.owner, splashRadius: p.splashRadius,
      })),
      pickups: this.pickups.map(p => ({ id: p.id, x: p.x, y: p.y, kind: p.kind, life: p.life })),
      bombs: this.bombs.map(b => ({
        id: b.id, x: b.x, y: b.y, typeId: b.type.id, exploded: b.exploded,
        effectTimer: b.effectTimer, fuseDuration: b.type.fuse,
      })),
      floatingTexts: this.floatingTexts.map(ft => ({
        x: ft.x, y: ft.y, text: ft.text, color: ft.color, life: ft.life, maxLife: ft.maxLife,
      })),
    };
    this.network.send({ type: "snapshot", state });
  }

  // Guest-side: stashes the raw snapshot (prev + newly arrived) with a
  // wall-clock timestamp, so drawFromSnapshot() can interpolate positions
  // between the two rather than teleporting to the new one every ~10ms
  // (see the id-matched lerp in interpolatedList). HUD/UI state itself
  // isn't interpolated — it just tracks the latest snapshot directly.
  applySnapshot(state) {
    if (!this.network.isGuest) return;

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
      document.getElementById("gameover-guest-note").classList.remove("hidden");
      document.getElementById("restart-btn").classList.add("hidden");
    } else {
      this.setState("playing");
      document.getElementById("mp-wait-overlay").classList.toggle("hidden", s.gameState !== "paused" && s.gameState !== "zoneComplete");
      this.updateHUDFromSnapshot(s);
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
    }
    document.getElementById("zone-label").textContent = `Zona ${s.zone} — ${s.zoneName}`;
    document.getElementById("wave-label").textContent = `Nemici rimasti: ${Math.max(0, s.waveTotal - s.waveDefeated)}`;
    document.getElementById("money-label").textContent = `€ ${s.money}`;
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

  zoneName(zone) {
    const names = CONFIG.zoneNames;
    if (zone <= names.length) return names[zone - 1];
    return `${names[names.length - 1]} (Lv. ${zone - names.length + 1})`;
  }

  enemyStatsForZone(zone, type) {
    const s = CONFIG.enemy;
    const z = zone - 1;
    const sc = CONFIG.zoneScaling;
    // Player level grows as upgrades/weapons get bought — a slow extra HP/damage
    // tax so a fully-kitted-out player doesn't make the run trivially easy.
    const lvl = this.run.playerLevel || 0;
    const levelHpMult = 1 + sc.hpPerPlayerLevel * lvl;
    const levelDamageMult = 1 + sc.damagePerPlayerLevel * lvl;
    return {
      speed: s.baseSpeed * (1 + sc.speedPerZone * z) * type.speedMult,
      maxHP: Math.round(s.baseMaxHP * (1 + sc.hpPerZone * z) * type.hpMult * levelHpMult),
      damage: Math.round(s.baseDamage * (1 + sc.damagePerZone * z) * type.damageMult * levelDamageMult),
      attackCooldown: Math.max(
        sc.minCooldown,
        s.attackCooldown * (1 - sc.cooldownFactorPerZone * z) * type.cooldownMult
      ),
      attackRange: type.attackRangeOverride || s.attackRange,
      detectRange: type.detectRangeOverride || s.detectRange,
      moneyRange: [
        Math.round(s.baseMoneyDrop[0] * (1 + sc.moneyPerZone * z) * (type.moneyMult || 1)),
        Math.round(s.baseMoneyDrop[1] * (1 + sc.moneyPerZone * z) * (type.moneyMult || 1)),
      ],
    };
  }

  startRun() {
    this.run = createRunState();
    this.player.refreshLoadout(this.run);
    this.player.resetForRun();
    this.player.x = CONFIG.width / 2;
    this.player.y = CONFIG.height / 2;
    this.repositionRemotePlayers();
    this.zone = 1;
    this.moneyThisRun = 0;
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.bombs = [];
    this.player.selectedThrowable = 0;
    this.floatingTexts = [];
    this.setState("playing");
    this.startZone();
  }

  startZone() {
    this.player.healOnNewZone();
    for (const entry of this.remotePlayers.values()) entry.player.healOnNewZone();
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
    const type = pickEnemyType(this.zone);
    if (type.behavior === "driveby") { this.spawnDriveby(type); return; }

    const edge = randInt(0, 3);
    let x, y;
    const m = 30;
    if (edge === 0) { x = rand(m, CONFIG.width - m); y = 70; }
    else if (edge === 1) { x = rand(m, CONFIG.width - m); y = CONFIG.height - m; }
    else if (edge === 2) { x = m; y = rand(90, CONFIG.height - m); }
    else { x = CONFIG.width - m; y = rand(90, CONFIG.height - m); }

    const zoneStats = this.enemyStatsForZone(this.zone, type);
    this.enemies.push(new Enemy(x, y, zoneStats, type));
  }

  // Enters from the left or right edge near the player's current lane and
  // drives straight across at high speed, firing as it passes — it never
  // chases or melees (see Enemy.updateDriveby). Killing it before it exits
  // pays out a bonus (see moneyMult); otherwise it just leaves the field.
  spawnDriveby(type) {
    const fromLeft = Math.random() < 0.5;
    const x = fromLeft ? -50 : CONFIG.width + 50;
    const players = this.activePlayers;
    const lanePlayer = players[randInt(0, players.length - 1)] || this.player;
    const y = clamp(lanePlayer.y + rand(-80, 80), 90, CONFIG.height - 30);
    const zoneStats = this.enemyStatsForZone(this.zone, type);
    const enemy = new Enemy(x, y, zoneStats, type);
    enemy.drivebyDir = fromLeft ? 1 : -1;
    enemy.facing = fromLeft ? 0 : Math.PI;
    this.enemies.push(enemy);
  }

  spawnProjectile(x, y, angle, speed, damage, splashRadius) {
    this.projectiles.push(new Projectile(x, y, angle, speed, damage, "player", splashRadius));
  }

  spawnEnemyProjectile(x, y, angle, speed, damage) {
    this.projectiles.push(new Projectile(x, y, angle, speed, damage, "enemy"));
  }

  // value/absolute: keyboard digit keys pass (index, true) to jump straight
  // to a slot; the gamepad's L1 passes (1, false) to cycle forward by one.
  // `actor` defaults to the local player but is passed explicitly as one of
  // the entries in this.remotePlayers when applying a guest's action in
  // multiplayer, since the selected slot is tracked per-player, not per-run.
  selectBomb(value, absolute, actor = this.player) {
    const n = THROWABLES.length;
    actor.selectedThrowable = absolute ? value % n : (actor.selectedThrowable + value + n) % n;
  }

  throwBomb(actor = this.player) {
    const type = THROWABLES[actor.selectedThrowable];
    if (!type) return;
    const count = this.run.bombs[type.id] || 0;
    if (count <= 0) { SoundManager.emptyClick(); return; }
    this.run.bombs[type.id] = count - 1;

    const angle = actor.aimAngle;
    let x, y, stickTarget = null;
    if (type.sticky) {
      stickTarget = this.findNearestInCone(actor.x, actor.y, angle, THROW_CONE, THROW_RANGE);
    }
    if (stickTarget) {
      x = stickTarget.x;
      y = stickTarget.y;
    } else {
      const margin = 20;
      x = clamp(actor.x + Math.cos(angle) * THROW_RANGE, margin, CONFIG.width - margin);
      y = clamp(actor.y + Math.sin(angle) * THROW_RANGE, margin, CONFIG.height - margin);
    }
    this.bombs.push(new Bomb(type, x, y, stickTarget));
    SoundManager.throwBomb();
  }

  // Nearest living enemy within a cone around `angle`, or null if none.
  findNearestInCone(x, y, angle, maxAngle, maxDist) {
    let best = null;
    let bestDiff = Infinity;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const dx = enemy.x - x, dy = enemy.y - y;
      const d = Math.hypot(dx, dy);
      if (d > maxDist) continue;
      const enemyAngle = Math.atan2(dy, dx);
      let diff = Math.abs(enemyAngle - angle);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      if (diff <= maxAngle && diff < bestDiff) {
        bestDiff = diff;
        best = enemy;
      }
    }
    return best;
  }

  // Manual fire: snaps onto a nearby enemy if there is one, otherwise still
  // fires straight along the aim (a deliberate button press shouldn't be a no-op).
  aimAssist(x, y, aim, coneBonus = 0) {
    const enemy = this.findNearestInCone(x, y, aim, Math.PI / 5 + coneBonus, 480);
    return enemy ? Math.atan2(enemy.y - y, enemy.x - x) : aim;
  }

  // Auto-fire: only shoots when something is actually sitting in the aim
  // cone — silence otherwise, so the gun doesn't spray at nothing.
  findAutoFireAngle(x, y, aim, coneBonus = 0) {
    const enemy = this.findNearestInCone(x, y, aim, Math.PI / 6 + coneBonus, 480);
    return enemy ? Math.atan2(enemy.y - y, enemy.x - x) : null;
  }

  damageEnemy(enemy, amount) {
    const killed = enemy.takeDamage(amount);
    this.floatingTexts.push(new FloatingText(enemy.x, enemy.y - 20, `-${Math.round(amount)}`, "#ffffff"));
    if (killed) {
      SoundManager.ko();
      const [minM, maxM] = enemy.stats.moneyRange;
      const reward = randInt(minM, maxM);
      this.moneyThisRun += reward;
      this.run.money += reward;
      this.floatingTexts.push(new FloatingText(enemy.x, enemy.y - 34, `+${reward}€`, "#4fd07a"));
      this.waveEnemiesDefeated++;
      SoundManager.coin();
      this.rollPickupDrop(enemy);
    } else {
      SoundManager.hitEnemy();
    }
  }

  // A drive-by car that reaches the far edge alive just leaves — it still
  // has to count against the wave total (same bookkeeping as a kill) or the
  // wave would never complete, but it pays no money since nobody beat it.
  onDrivebyExit() {
    this.waveEnemiesDefeated++;
  }

  // At most one pickup per kill: a medikit if any active player could use
  // one, otherwise a shot at ammo if any of them carries a gun.
  rollPickupDrop(enemy) {
    const cfg = CONFIG.pickup;
    const players = this.activePlayers;
    const anyNeedsHeal = players.some(p => p.hp < p.maxHp * 0.9);
    if (Math.random() < cfg.medikitChance && anyNeedsHeal) {
      const heal = Math.round(this.player.maxHp * cfg.medikitHealFraction);
      this.pickups.push(new Pickup(enemy.x, enemy.y, "health", heal));
      return;
    }
    if (players.some(p => p.ranged) && Math.random() < cfg.ammoChance) {
      const amount = randInt(cfg.ammoAmountRange[0], cfg.ammoAmountRange[1]);
      this.pickups.push(new Pickup(enemy.x, enemy.y, "ammo", amount));
    }
  }

  // `actor` is whichever active player is closest to the pickup — see the
  // call site in update(), which already picked that out.
  collectPickup(pickup, actor = this.player) {
    if (pickup.kind === "health") {
      const before = actor.hp;
      actor.hp = clamp(actor.hp + pickup.amount, 0, actor.maxHp);
      const healed = Math.round(actor.hp - before);
      if (healed > 0) {
        this.floatingTexts.push(new FloatingText(actor.x, actor.y - 26, `+${healed} HP`, "#3ddc71"));
        SoundManager.heal();
      }
    } else if (pickup.kind === "ammo" && actor.ranged) {
      const add = Math.min(pickup.amount, actor.ranged.maxAmmo - actor.ammo);
      if (add > 0) {
        actor.ammo += add;
        this.floatingTexts.push(new FloatingText(actor.x, actor.y - 26, `+${add} munizioni`, "#ffd24a"));
        SoundManager.ammoPickup();
      }
    }
  }

  // `actor` is whichever player actually took the hit — see the call site
  // in update(). The stolen money still comes out of the shared run purse.
  onPlayerHit(actor = this.player) {
    if (this.run.money <= 0) return;
    const stealFrac = 0.05;
    const reduction = actor.stats.stealReduction;
    let stolen = Math.round(this.run.money * stealFrac * (1 - reduction));
    stolen = Math.min(stolen, this.run.money);
    if (stolen > 0) {
      this.run.money -= stolen;
      this.moneyThisRun -= Math.min(stolen, Math.max(0, this.moneyThisRun));
      this.floatingTexts.push(new FloatingText(actor.x, actor.y - 26, `-${stolen}€ rubati!`, "#d9455f"));
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
    this.renderWeaponList("melee-weapon-list", MELEE_WEAPONS, this.run.meleeTier, this.run.meleeWeaponUpgrades, (idx) => this.buyMeleeWeapon(idx));
    this.renderWeaponUpgrades("melee-weapon-upgrades-section", "melee-weapon-upgrades", MELEE_WEAPONS, this.run.meleeTier, this.run.meleeWeaponUpgrades, (id, cost) => this.buyMeleeWeaponUpgrade(id, cost));
    this.renderWeaponList("ranged-weapon-list", RANGED_WEAPONS, this.run.rangedTier, this.run.rangedWeaponUpgrades, (idx) => this.buyRangedWeapon(idx));
    if (this.run.rangedTier >= 0) {
      this.renderWeaponUpgrades("ranged-weapon-upgrades-section", "ranged-weapon-upgrades", RANGED_WEAPONS, this.run.rangedTier, this.run.rangedWeaponUpgrades, (id, cost) => this.buyRangedWeaponUpgrade(id, cost));
    } else {
      document.getElementById("ranged-weapon-upgrades-section").classList.add("hidden");
    }
    this.renderAmmoShop();
    this.renderBombShop();
    document.getElementById("upgrade-screen").classList.remove("hidden");
    this.saveGame();
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
      const level = this.run.upgrades[upg.id] || 0;
      const maxed = level >= upg.maxLevel;
      const cost = maxed ? null : this.costFor(upg, level);

      const card = document.createElement("div");
      card.className = "upgrade-card";
      card.innerHTML = `
        <h3>${upg.name}</h3>
        <p>${upg.desc}</p>
        <div class="row">
          <span class="level">Lv. ${level}/${upg.maxLevel}</span>
          <button ${maxed || cost > this.run.money ? "disabled" : ""}>
            ${maxed ? "MAX" : `Acquista — ${cost}€`}
          </button>
        </div>
      `;
      if (!maxed) {
        card.querySelector("button").addEventListener("click", () => {
          if (this.run.money >= cost) {
            this.run.money -= cost;
            this.run.upgrades[upg.id] = level + 1;
            this.run.playerLevel++;
            this.refreshAllLoadouts();
            if (upg.id === "firstaid") {
              // Buying more max HP also tops every player up to at least 3/4
              // of the new max, instead of just preserving whatever HP was
              // missing before the purchase (refreshLoadout's default) —
              // never reduces current HP if it's already higher than that.
              this.player.hp = Math.max(this.player.hp, Math.round(this.player.maxHp * 0.75));
              for (const entry of this.remotePlayers.values()) {
                entry.player.hp = Math.max(entry.player.hp, Math.round(entry.player.maxHp * 0.75));
              }
            }
            this.renderUpgradeList();
            this.updateHUDStatic();
          }
        });
      }
      list.appendChild(card);
    });
    document.getElementById("upgrade-money").textContent = `€ ${this.run.money}`;
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
        const affordable = weapon.cost <= this.run.money;
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
      const affordable = upg.cost <= this.run.money;
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

  buyMeleeWeapon(idx) {
    const weapon = MELEE_WEAPONS[idx];
    const current = MELEE_WEAPONS[this.run.meleeTier];
    if (idx !== this.run.meleeTier + 1 || this.run.money < weapon.cost) return;
    if (!allWeaponUpgradesOwned(current, this.run.meleeWeaponUpgrades)) return;
    this.run.money -= weapon.cost;
    this.run.meleeTier = idx;
    this.run.playerLevel++;
    this.refreshAllLoadouts();
    this.openUpgradeMenu(this.menuMode);
    this.updateHUDStatic();
  }

  buyRangedWeapon(idx) {
    const weapon = RANGED_WEAPONS[idx];
    if (idx !== this.run.rangedTier + 1 || this.run.money < weapon.cost) return;
    if (weapon.minZone && this.zone < weapon.minZone) return;
    if (this.run.rangedTier >= 0) {
      const current = RANGED_WEAPONS[this.run.rangedTier];
      if (!allWeaponUpgradesOwned(current, this.run.rangedWeaponUpgrades)) return;
    }
    this.run.money -= weapon.cost;
    this.run.rangedTier = idx;
    this.run.playerLevel++;
    this.refreshAllLoadouts();
    this.openUpgradeMenu(this.menuMode);
    this.updateHUDStatic();
  }

  buyMeleeWeaponUpgrade(id, cost) {
    if (this.run.meleeWeaponUpgrades.includes(id) || this.run.money < cost) return;
    this.run.money -= cost;
    this.run.meleeWeaponUpgrades.push(id);
    this.run.playerLevel++;
    this.refreshAllLoadouts();
    this.openUpgradeMenu(this.menuMode);
    this.updateHUDStatic();
  }

  buyRangedWeaponUpgrade(id, cost) {
    if (this.run.rangedWeaponUpgrades.includes(id) || this.run.money < cost) return;
    this.run.money -= cost;
    this.run.rangedWeaponUpgrades.push(id);
    this.run.playerLevel++;
    this.refreshAllLoadouts();
    this.openUpgradeMenu(this.menuMode);
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
    const weapon = RANGED_WEAPONS[this.run.rangedTier];
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
        <button ${chunk <= 0 || cost > this.run.money ? "disabled" : ""}>
          ${chunk <= 0 ? "Scorta piena" : `Rifornisci +${chunk} — ${cost}€`}
        </button>
      </div>
    `;
    if (chunk > 0) {
      card.querySelector("button").addEventListener("click", () => this.buyAmmo());
    }
    container.appendChild(card);
  }

  buyAmmo() {
    if (!this.player.ranged) return;
    const weapon = RANGED_WEAPONS[this.run.rangedTier];
    const chunk = Math.min(10, weapon.maxAmmo - this.player.ammo);
    if (chunk <= 0) return;
    const cost = Math.ceil(chunk * weapon.costPerAmmo);
    if (this.run.money < cost) return;
    this.run.money -= cost;
    this.player.ammo += chunk;
    this.renderAmmoShop();
    this.updateHUDStatic();
  }

  // Consumable throwables: bought one at a time, stacked up to maxCarry.
  renderBombShop() {
    const container = document.getElementById("bomb-shop");
    container.innerHTML = "";
    THROWABLES.forEach(type => {
      const count = this.run.bombs[type.id] || 0;
      const atCap = count >= type.maxCarry;
      const affordable = type.cost <= this.run.money;
      const card = document.createElement("div");
      card.className = "upgrade-card";
      card.innerHTML = `
        <h3>${type.name}</h3>
        <p>${type.desc}</p>
        <div class="row">
          <span class="level">In tasca: ${count}/${type.maxCarry}</span>
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

  buyBomb(id) {
    const type = THROWABLES.find(t => t.id === id);
    if (!type) return;
    const count = this.run.bombs[id] || 0;
    if (count >= type.maxCarry || this.run.money < type.cost) return;
    this.run.money -= type.cost;
    this.run.bombs[id] = count + 1;
    this.renderBombShop();
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
    clearRunState(); // death wipes the run — nothing left worth resuming
    document.getElementById("final-zone").textContent = this.zone;
    document.getElementById("final-money").textContent = Math.max(0, this.moneyThisRun);
  }

  updateHUDStatic() {
    document.getElementById("money-label").textContent = `€ ${this.run.money}`;
  }

  updateHUD() {
    const hpFrac = clamp(this.player.hp / this.player.maxHp, 0, 1);
    document.getElementById("hp-fill").style.width = `${hpFrac * 100}%`;
    document.getElementById("hp-label").textContent = `${Math.round(this.player.hp)} / ${this.player.maxHp}`;
    document.getElementById("zone-label").textContent = `Zona ${this.zone} — ${this.zoneName(this.zone)}`;
    const remaining = this.waveTotalEnemies - this.waveEnemiesDefeated;
    document.getElementById("wave-label").textContent = `Nemici rimasti: ${remaining}`;
    document.getElementById("money-label").textContent = `€ ${this.run.money}`;

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
    const bombCount = this.run.bombs[bombType.id] || 0;
    document.getElementById("bomb-label").textContent = `${bombType.name} x${bombCount}`;
  }

  // Guest: no local simulation at all — just poll our own input and ship it
  // to the host at a throttled rate. Everything on screen instead comes
  // from applySnapshot()/draw()'s drawFromSnapshot() path.
  updateGuest(dt) {
    this._stateSendTimer -= dt;
    if (this._stateSendTimer <= 0) {
      this._stateSendTimer = 1 / 100;
      const move = {
        up: this.input.isDown("up"), down: this.input.isDown("down"),
        left: this.input.isDown("left"), right: this.input.isDown("right"),
      };
      const moveVec = this.input.moveVec; // continuous 360° direction, or null (keyboard-only)
      const stickAim = this.input.gpAim || this.input.touchAim;
      const aim = stickAim ? { x: stickAim.x, y: stickAim.y } : null;
      this.network.send({ type: "state", move, moveVec, aim });
    }
  }

  update(dt) {
    if (this.network.isGuest) { this.updateGuest(dt); return; }

    // Host -> guest snapshot broadcast. Runs regardless of this.state so a
    // connected guest still sees the pause/shop/game-over overlays, not
    // just live combat — see the early return for "playing"-only logic below.
    if (this.network.isHost && this.remotePlayers.size > 0) {
      this._snapshotTimer -= dt;
      if (this._snapshotTimer <= 0) {
        this._snapshotTimer = 1 / 100;
        this.sendSnapshot();
      }
    }

    if (this.state !== "playing") return;

    this.player.update(dt, this.input);
    // Attack/shoot/dash are held down rather than edge-triggered (there's no
    // "keydown" equivalent for a polled gamepad); their own cooldowns already
    // throttle this the same way holding a keyboard key would. Melee and
    // manual ranged fire have no touch equivalent — see the auto-melee call
    // and autoFireRanged below instead.
    if (this.input.gpAttack) this.player.tryAttack(this);
    if (this.input.gpRanged) this.player.tryRangedAttack(this);
    if (this.input.gpDash || this.input.touchDash) this.player.tryDash();
    // Hands-free shooting: fires on its own whenever the aim rests on an
    // enemy, on top of (not instead of) the manual F/R2 trigger above.
    this.player.autoFireRanged(this);
    // Touch has no attack button (see autoMeleeAttack) — melee triggers on
    // its own whenever an enemy is in range, so the freed-up thumb can aim
    // instead. Keyboard/gamepad melee stays the manual gpAttack/Space above.
    if (this.isTouchDevice) this.player.autoMeleeAttack(this);

    // Host-side simulation of every other connected player: each is driven
    // by the last continuous input state it sent (see applyRemoteState),
    // with discrete actions (attack/dash/...) applied immediately as they
    // arrive over the socket — see applyRemoteAction.
    for (const entry of this.remotePlayers.values()) {
      if (entry.player.hp <= 0) continue;
      entry.player.update(dt, entry.input);
      entry.player.autoFireRanged(this);
      if (entry.isTouchDevice) entry.player.autoMeleeAttack(this);
    }

    if (this.enemiesToSpawn > 0) {
      this.spawnTimer -= dt;
      const concurrentCap = Math.min(2 + Math.floor((this.zone - 1) / 2), CONFIG.maxConcurrentEnemies);
      if (this.spawnTimer <= 0 && this.enemies.filter(e => !e.dead).length < concurrentCap) {
        this.spawnEnemy();
        this.enemiesToSpawn--;
        this.spawnTimer = CONFIG.spawnInterval;
      }
    }

    // Each enemy targets whichever active player is nearest to IT — this is
    // the only change needed for co-op AI, since every behavior branch
    // inside Enemy already just uses whatever `player` it's handed.
    for (const enemy of this.enemies) {
      enemy.update(dt, this.nearestPlayerTo(enemy.x, enemy.y), this);
    }
    this.enemies = this.enemies.filter(e => !e.dead);

    for (const proj of this.projectiles) {
      if (proj.dead) continue;
      proj.update(dt);
      if (proj.owner === "enemy") {
        for (const p of this.activePlayers) {
          if (proj.dead) break;
          if (dist(proj.x, proj.y, p.x, p.y) <= proj.radius + p.radius) {
            const hit = p.takeDamage(proj.damage);
            if (hit) this.onPlayerHit(p);
            proj.dead = true;
          }
        }
      } else {
        for (const enemy of this.enemies) {
          if (enemy.dead || proj.dead) continue;
          if (dist(proj.x, proj.y, enemy.x, enemy.y) <= proj.radius + enemy.radius) {
            if (proj.splashRadius) {
              // Rocket: damages every enemy within the blast, not just the one hit.
              SoundManager.explosion();
              for (const e2 of this.enemies) {
                if (!e2.dead && dist(proj.x, proj.y, e2.x, e2.y) <= proj.splashRadius) {
                  this.damageEnemy(e2, proj.damage);
                }
              }
            } else {
              this.damageEnemy(enemy, proj.damage);
            }
            proj.dead = true;
          }
        }
      }
    }
    this.projectiles = this.projectiles.filter(p => !p.dead);

    for (const pickup of this.pickups) {
      if (pickup.dead) continue;
      pickup.update(dt);
      if (pickup.dead) continue;
      for (const p of this.activePlayers) {
        if (dist(p.x, p.y, pickup.x, pickup.y) <= p.radius + pickup.radius) {
          this.collectPickup(pickup, p);
          pickup.dead = true;
          break;
        }
      }
    }
    this.pickups = this.pickups.filter(p => !p.dead);

    for (const bomb of this.bombs) bomb.update(dt, this);
    this.bombs = this.bombs.filter(b => !b.dead);

    for (const ft of this.floatingTexts) ft.update(dt);
    this.floatingTexts = this.floatingTexts.filter(ft => !ft.dead);

    if (this.activePlayers.length === 0) {
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
    if (this.network.isGuest) { this.drawFromSnapshot(); return; }
    this.drawBackground();
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

    // Bombs/pickups/floating texts don't move (or barely do), so they're
    // drawn straight from the latest snapshot with no interpolation.
    for (const bomb of curr.bombs) this.mkBomb(bomb).draw(this.ctx);
    for (const pickup of curr.pickups) this.mkPickup(pickup).draw(this.ctx);
    for (const enemy of enemies) this.mkEnemy(enemy).draw(this.ctx);
    for (const proj of projectiles) this.mkProjectile(proj).draw(this.ctx);
    for (const other of others) this.mkPlayer(other).draw(this.ctx);
    if (me) this.mkPlayer(me).draw(this.ctx);
    for (const ft of curr.floatingTexts) this.mkText(ft).draw(this.ctx);
  }

  loop(now) {
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.input.pollGamepad();
    this.update(dt);
    this.draw();
    requestAnimationFrame(this.loop);
  }
}

window.addEventListener("load", () => {
  window.__game = new Game();
});
