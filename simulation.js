"use strict";

// =========================================================
// SIMULATION — shared between the browser (solo/offline play) and the
// Node server (multiplayer authority, see server.js). Contains ONLY game
// logic: no canvas, no DOM, no localStorage, no WebSocket. Loaded as a
// plain classic <script> in index.html BEFORE script.js, so in the browser
// everything declared here (CONFIG, Player, Simulation, ...) is just an
// ordinary global, exactly as if it still lived in one file — script.js
// references it unchanged. In Node it's also require()-able (see the
// module.exports guard at the very bottom).
//
// Rendering (draw()) methods are kept on the moved classes for now (Player,
// Enemy, ...) since splitting them out isn't needed for correctness: they
// reference browser-only globals (Sprites, ctx) but are simply never
// *called* server-side, and JS doesn't evaluate a method body until it's
// invoked — so leaving them in place is harmless dead code in Node.
// =========================================================

/* =========================================================
   CONFIG
========================================================= */
const CONFIG = {
  width: 960,
  height: 600,
  maxConcurrentEnemies: 6,
  spawnInterval: 0.9,
  // Fixed simulation/input-sampling rate (ticks per second), shared by the
  // browser's own loop (see script.js's loop()) and, later, the server's
  // per-room tick loop (see server.js) — deliberately below 60Hz to stay
  // battery/network-friendly on the phones this game is mostly played on.
  // Decoupling simulation from the render framerate is what actually keeps
  // every player's game speed identical regardless of their device/display.
  tickRate: 30,

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

  // Stretched ~4x from the original curve so the difficulty/money that used
  // to land around zone 20-30 now lands around zone 80-100, giving a much
  // longer run to spend the expanded upgrade/weapon content on (see
  // UPGRADES, MELEE_WEAPONS, RANGED_WEAPONS below).
  zoneScaling: {
    speedPerZone: 0.018,
    hpPerZone: 0.033,
    damagePerZone: 0.023,
    cooldownFactorPerZone: 0.011, // reduces cooldown -> faster attacks
    minCooldown: 0.35,
    moneyPerZone: 0.025,
    // Separate, much slower scaling tied to the player's own power (see
    // Simulation.combinedPlayerLevel): the more upgrades/weapons bought,
    // the tougher enemies get too, so fully kitting out doesn't trivialize
    // the run. Lower than before in raw terms because there's now ~1.9x
    // more total purchasable levels (11 house upgrades + 5 sub-upgrades per
    // weapon tier instead of 6 + 1-4) — this keeps the same overall "fully
    // kitted out" tax at the new, higher max level instead of taxing harder.
    hpPerPlayerLevel: 0.011,
    damagePerPlayerLevel: 0.011,
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
    "Oltre i confini conosciuti",
    "Il centro città in fiamme",
    "Le torri abbandonate",
    "L'ultimo isolato",
  ],
};

// Destructible park obstacles (see Simulation.generateParkLayout): block
// movement for player/enemies until destroyed by combat, then disappear and
// open up the path. Each has 5 damage-stage sprites (see SPRITE_SOURCES in
// script.js) — objectDamageStage() picks which one to draw from hp/maxHp.
const OBJECT_TYPES = {
  cestino: { hp: 30, radius: 16 },
  panchina: { hp: 70, radius: 32 },
  cassonetto: { hp: 90, radius: 28 },
  barile: { hp: 45, radius: 18 },
  recinzione: { hp: 55, radius: 26 },
  albero: { hp: 140, radius: 24 },
  lampione: { hp: 50, radius: 14 },
};

// 1 = intact, 5 = nearly destroyed — see ART_STYLE.md's 5 damage stages.
function objectDamageStage(hp, maxHp) {
  const frac = clamp(hp / maxHp, 0, 1);
  return clamp(6 - Math.ceil(frac * 5), 1, 5);
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
  {
    id: "bombCapacity",
    name: "Zaino esplosivi",
    desc: "Aumenta la scorta massima di ogni esplosivo.",
    baseCost: 300,
    growth: 1.5,
    maxLevel: 5,
    perLevel: 1, // + maxCarry, applied uniformly to every throwable type
  },
  {
    id: "dashCooldown",
    name: "Scatto potenziato",
    desc: "Riduce il tempo di recupero dello scatto.",
    baseCost: 200,
    growth: 1.5,
    maxLevel: 8,
    perLevel: 0.08, // fraction of base dashCooldown shaved off — clamped to 0.65 total in refreshLoadout()
  },
  {
    id: "moneyBonus",
    name: "Fortuna del quartiere",
    desc: "Aumenta i soldi guadagnati dai nemici sconfitti.",
    baseCost: 250,
    growth: 1.5,
    maxLevel: 10,
    perLevel: 0.04, // + fraction of money earned per kill
  },
  {
    id: "hitInvuln",
    name: "Riflessi rapidi",
    desc: "Allunga l'invulnerabilità appena dopo essere colpito.",
    baseCost: 220,
    growth: 1.5,
    maxLevel: 8,
    perLevel: 0.05, // + seconds added to CONFIG.player.hitInvuln
  },
  {
    id: "meleeSpeed",
    name: "Adrenalina",
    desc: "Riduce il tempo di recupero degli attacchi in mischia, con qualunque arma bianca.",
    baseCost: 260,
    growth: 1.5,
    maxLevel: 8,
    perLevel: 0.035, // fraction of melee cooldown shaved off — clamped to 0.5 total in refreshLoadout()
  },
];

// Sequential melee tiers: each purchase replaces the previous weapon. Every
// tier (but fists) has 1-2 small sub-upgrades that must ALL be bought before
// the next tier becomes purchasable.
const MELEE_WEAPONS = [
  {
    id: "fists", name: "Pugni", desc: "Le tue mani. Gratis, ma poco convincenti.",
    cost: 0, damage: 18, range: 52, cooldown: 0.42, upgrades: [],
  },
  {
    id: "knife1", name: "Coltello", desc: "Taglia in fretta: più danno e colpi più veloci.",
    cost: 60, damage: 26, range: 50, cooldown: 0.32,
    upgrades: [
      { id: "knife1_grip", name: "Impugnatura migliorata", desc: "Colpi leggermente più veloci.", cost: 20, cooldownMult: 0.94 },
      { id: "knife1_blade", name: "Lama più affilata", desc: "Più danno per colpo.", cost: 25, damage: 4 },
      { id: "knife1_pommel", name: "Pomello bilanciato", desc: "Colpi ancora più veloci.", cost: 20, cooldownMult: 0.94 },
      { id: "knife1_edge", name: "Filo rifinito", desc: "Più danno per colpo.", cost: 25, damage: 4 },
      { id: "knife1_reach", name: "Lama allungata", desc: "Colpisce leggermente più lontano.", cost: 20, range: 6 },
    ],
  },
  {
    id: "knife2", name: "Coltello a serramanico", desc: "Lama migliore: ancora più danno e velocità.",
    cost: 140, damage: 36, range: 50, cooldown: 0.24,
    upgrades: [
      { id: "knife2_grip", name: "Impugnatura rinforzata", desc: "Colpi ancora più veloci.", cost: 45, cooldownMult: 0.94 },
      { id: "knife2_blade", name: "Lama temprata", desc: "Più danno per colpo.", cost: 55, damage: 6 },
      { id: "knife2_pommel", name: "Pomello zavorrato", desc: "Colpi ancora più veloci.", cost: 45, cooldownMult: 0.94 },
      { id: "knife2_edge", name: "Filo damascato", desc: "Più danno per colpo.", cost: 55, damage: 6 },
      { id: "knife2_reach", name: "Lama allungata", desc: "Colpisce leggermente più lontano.", cost: 40, range: 6 },
    ],
  },
  {
    id: "bat", name: "Mazza da baseball", desc: "Più lenta, ma colpisce molto più lontano e più forte.",
    cost: 260, damage: 50, range: 78, cooldown: 0.55,
    upgrades: [
      { id: "bat_grip", name: "Impugnatura fasciata", desc: "Colpi leggermente più veloci.", cost: 70, cooldownMult: 0.95 },
      { id: "bat_spikes", name: "Mazza chiodata", desc: "Chiodi che aumentano il danno.", cost: 90, damage: 10 },
      { id: "bat_counterweight", name: "Contrappeso", desc: "Colpi leggermente più veloci.", cost: 70, cooldownMult: 0.95 },
      { id: "bat_corked", name: "Corpo rinforzato", desc: "Più danno per colpo.", cost: 90, damage: 10 },
      { id: "bat_handle", name: "Manico allungato", desc: "Colpisce leggermente più lontano.", cost: 70, range: 8 },
    ],
  },
  {
    id: "pole", name: "Palo d'acciaio", desc: "Portata e danno massimi tra le lame e i pali. Non fa sconti.",
    cost: 420, damage: 75, range: 94, cooldown: 0.6,
    upgrades: [
      { id: "pole_grip", name: "Impugnatura antiscivolo", desc: "Colpi leggermente più veloci.", cost: 110, cooldownMult: 0.95 },
      { id: "pole_reinforced", name: "Palo rinforzato", desc: "Struttura rinforzata: ancora più danno.", cost: 140, damage: 15 },
      { id: "pole_counterweight", name: "Bilanciamento", desc: "Colpi leggermente più veloci.", cost: 110, cooldownMult: 0.95 },
      { id: "pole_tempered", name: "Acciaio temprato", desc: "Più danno per colpo.", cost: 140, damage: 15 },
      { id: "pole_extended", name: "Palo allungato", desc: "Colpisce leggermente più lontano.", cost: 110, range: 10 },
    ],
  },
  {
    id: "hammer", name: "Martello", desc: "Il colpo più pesante di tutti: lentissimo da rialzare, ma devastante.",
    cost: 650, damage: 105, range: 86, cooldown: 0.78,
    upgrades: [
      { id: "hammer_grip", name: "Manico ammortizzato", desc: "Colpi leggermente più veloci.", cost: 170, cooldownMult: 0.96 },
      { id: "hammer_head", name: "Testa rinforzata", desc: "Testa più pesante: ancora più danno.", cost: 210, damage: 20 },
      { id: "hammer_counterbalance", name: "Bilanciamento", desc: "Colpi leggermente più veloci.", cost: 170, cooldownMult: 0.96 },
      { id: "hammer_forged", name: "Acciaio forgiato", desc: "Più danno per colpo.", cost: 210, damage: 20 },
      { id: "hammer_handle", name: "Manico allungato", desc: "Colpisce leggermente più lontano.", cost: 170, range: 10 },
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
    cost: 220, damage: 22, cooldown: 0.6, projectileSpeed: 560, minZone: 12, maxAmmo: 24, costPerAmmo: 6,
    upgrades: [
      { id: "pistol_sight", name: "Mirino", desc: "Aggancia i bersagli con più margine.", cost: 80, aimConeBonus: 0.06 },
      { id: "pistol_stock", name: "Calcio", desc: "Cadenza di fuoco più rapida.", cost: 90, cooldownMult: 0.9 },
      { id: "pistol_barrel", name: "Canna lunga", desc: "Più danno per colpo.", cost: 100, damage: 5 },
      { id: "pistol_mag", name: "Caricatore esteso", desc: "Più munizioni massime.", cost: 70, maxAmmo: 8 },
      { id: "pistol_rifling", name: "Canna rigata", desc: "Ancora più danno per colpo.", cost: 90, damage: 4 },
    ],
  },
  {
    id: "smg", name: "Mitra", desc: "Raffica rapida, danno per colpo minore.",
    cost: 480, damage: 13, cooldown: 0.14, projectileSpeed: 640, minZone: 20, maxAmmo: 60, costPerAmmo: 4,
    upgrades: [
      { id: "smg_sight", name: "Mirino", desc: "Aggancia i bersagli con più margine.", cost: 150, aimConeBonus: 0.06 },
      { id: "smg_stock", name: "Calcio", desc: "Cadenza di fuoco più rapida.", cost: 170, cooldownMult: 0.9 },
      { id: "smg_barrel", name: "Canna lunga", desc: "Più danno per colpo.", cost: 190, damage: 3 },
      { id: "smg_mag", name: "Caricatore esteso", desc: "Più munizioni massime.", cost: 140, maxAmmo: 15 },
      { id: "smg_rifling", name: "Canna rigata", desc: "Ancora più danno per colpo.", cost: 160, damage: 3 },
    ],
  },
  {
    id: "sniper", name: "Cecchino", desc: "Un colpo lentissimo ma devastante: quasi sempre un one-shot.",
    cost: 850, damage: 90, cooldown: 1.4, projectileSpeed: 900, minZone: 28, maxAmmo: 8, costPerAmmo: 25,
    upgrades: [
      { id: "sniper_sight", name: "Mirino", desc: "Aggancia i bersagli con più margine.", cost: 220, aimConeBonus: 0.05 },
      { id: "sniper_stock", name: "Calcio", desc: "Cadenza di fuoco più rapida.", cost: 260, cooldownMult: 0.88 },
      { id: "sniper_barrel", name: "Canna lunga", desc: "Più danno per colpo.", cost: 300, damage: 20 },
      { id: "sniper_mag", name: "Caricatore esteso", desc: "Più munizioni massime.", cost: 200, maxAmmo: 3 },
      { id: "sniper_rifling", name: "Canna rigata", desc: "Ancora più danno per colpo.", cost: 260, damage: 15 },
    ],
  },
  // Fires several pellets per colpo in un piccolo cono: `damage` è il danno
  // di ogni singolo pallino, non del colpo intero.
  {
    id: "shotgun", name: "Shotgun", desc: "Spara una rosa di pallini: devastante da vicino, un solo colpo per cartuccia.",
    cost: 1300, damage: 14, cooldown: 0.9, projectileSpeed: 520, minZone: 36, maxAmmo: 20, costPerAmmo: 10,
    pellets: 6, spread: Math.PI / 9,
    upgrades: [
      { id: "shotgun_sight", name: "Mirino", desc: "Aggancia i bersagli con più margine.", cost: 200, aimConeBonus: 0.06 },
      { id: "shotgun_stock", name: "Calcio", desc: "Cadenza di fuoco più rapida.", cost: 220, cooldownMult: 0.9 },
      { id: "shotgun_barrel", name: "Canna lunga", desc: "Più danno per pallino.", cost: 240, damage: 4 },
      { id: "shotgun_mag", name: "Caricatore esteso", desc: "Più cartucce massime.", cost: 170, maxAmmo: 6 },
      { id: "shotgun_rifling", name: "Canna rigata", desc: "Ancora più danno per pallino.", cost: 200, damage: 3 },
    ],
  },
  // splashRadius: al contatto esplode danneggiando tutti i nemici nel raggio.
  {
    id: "rocket", name: "Lanciarazzi", desc: "Razzo lento ma con danno ad area enorme: spazza via gruppi interi.",
    cost: 2200, damage: 140, cooldown: 1.8, projectileSpeed: 380, minZone: 44, maxAmmo: 4, costPerAmmo: 60,
    splashRadius: 90,
    upgrades: [
      { id: "rocket_sight", name: "Mirino", desc: "Aggancia i bersagli con più margine.", cost: 400, aimConeBonus: 0.08 },
      { id: "rocket_stock", name: "Calcio", desc: "Cadenza di fuoco più rapida.", cost: 450, cooldownMult: 0.85 },
      { id: "rocket_barrel", name: "Canna lunga", desc: "Più danno d'esplosione.", cost: 500, damage: 30 },
      { id: "rocket_mag", name: "Caricatore esteso", desc: "Più razzi massimi.", cost: 350, maxAmmo: 2 },
      { id: "rocket_rifling", name: "Canna rigata", desc: "Ancora più danno d'esplosione.", cost: 420, damage: 25 },
    ],
  },
];

// Consumable throwables, bought in stacks (not sequential tiers). Most land
// at a fixed point along the aim direction and detonate there (see
// Simulation.throwBomb / class Bomb) — knife and shuriken are the exception,
// flagged `isProjectileThrow`.
const THROWABLES = [
  // damage: a placeholder baseline — the thrown amount is actually computed
  // per-zone at throw time (see Simulation.grenadeDamageForZone).
  { id: "grenade", name: "Granata", desc: "Esplosione che infligge danno pesante in un'area: uccide i nemici base, ma non il Bruto.", cost: 600, kind: "damage", radius: 75, damage: 70, fuse: 1.1, maxCarry: 5 },
  { id: "molotov", name: "Molotov", desc: "Crea una pozza di fuoco che brucia chiunque ci passi sopra per qualche secondo.", cost: 700, kind: "fire", radius: 100, damagePerSecond: 22, duration: 5, fuse: 0.6, maxCarry: 5 },
  { id: "sticky", name: "Bomba adesiva", desc: "Si attacca al primo nemico colpito ed esplode con danno enorme.", cost: 1500, kind: "damage", radius: 55, damage: 130, fuse: 1.4, maxCarry: 4, sticky: true },
  // blindRadius: distanza da un giocatore entro cui un nemico "accecato"
  // continua comunque a comportarsi normalmente.
  { id: "smoke", name: "Granata fumogena", desc: "Acceca i nemici nella nube: chi non è a un passo da un giocatore vaga a caso invece di inseguire.", cost: 650, kind: "cc", ccType: "smoke", radius: 150, blindRadius: 10, duration: 4, fuse: 0.5, maxCarry: 4 },
  { id: "flashbang", name: "Granata stordente", desc: "Stordisce i nemici vicini, bloccando ogni loro movimento per qualche secondo.", cost: 800, kind: "cc", ccType: "stun", radius: 75, duration: 2.5, fuse: 0.4, maxCarry: 4 },
  { id: "throwknife", name: "Coltello da lancio", desc: "Vola dritto e uccide all'istante il primo nemico che colpisce.", cost: 200, kind: "damage", isProjectileThrow: true, instaKill: true, projectileSpeed: 700, maxCarry: 8 },
  { id: "shuriken", name: "Shuriken", desc: "Vola veloce e insegue leggermente il nemico più vicino alla sua traiettoria.", cost: 500, kind: "damage", isProjectileThrow: true, homing: true, projectileSpeed: 560, damage: 40, maxCarry: 10 },
];
const THROW_RANGE = 260;
const THROW_CONE = Math.PI / 6;
const HOMING_TURN_RATE = 2.2; // max radians/second a homing projectile can curve
const SMOKE_BLIND_RADIUS = THROWABLES.find(t => t.id === "smoke").blindRadius;

// Three enemy archetypes with distinct movement/attack behavior, not just
// stat multipliers, so they read as different threats at a glance.
const ENEMY_TYPES = [
  {
    id: "balordo", label: "Balordo", color: "#8a7355",
    radiusMult: 1.12, speedMult: 0.72, hpMult: 1.25, damageMult: 1.0, cooldownMult: 1.0,
    behavior: "steady", minZone: 1,
    weight: (zone) => Math.max(0.15, 1.4 - zone * 0.12),
  },
  {
    id: "nervoso", label: "Nervoso", color: "#e0703d",
    radiusMult: 0.9, speedMult: 1.4, hpMult: 0.8, damageMult: 1.05, cooldownMult: 0.7,
    behavior: "aggressive", minZone: 1,
    weight: (zone) => 0.4 + zone * 0.1,
  },
  {
    id: "imprevedibile", label: "Imprevedibile", color: "#9b59d0",
    radiusMult: 1.0, speedMult: 1.1, hpMult: 0.9, damageMult: 1.0, cooldownMult: 0.85,
    behavior: "erratic", minZone: 3,
    weight: (zone) => (zone < 3 ? 0 : 0.25 + (zone - 3) * 0.15),
  },
  {
    id: "bruto", label: "Bruto", color: "#5c2626",
    radiusMult: 1.5, speedMult: 0.42, hpMult: 1.6, damageMult: 2.3, cooldownMult: 1.3,
    behavior: "steady", minZone: 4,
    weight: (zone) => (zone < 4 ? 0 : 0.18 + (zone - 4) * 0.05),
  },
  {
    id: "tiratore", label: "Tiratore", color: "#4a6b7a",
    radiusMult: 0.85, speedMult: 0.85, hpMult: 0.55, damageMult: 0.8, cooldownMult: 1.0,
    behavior: "ranged", minZone: 5,
    preferredRange: 260, projectileSpeed: 420, projectileDamageMult: 1.0,
    attackRangeOverride: 260, detectRangeOverride: 420,
    weight: (zone) => (zone < 5 ? 0 : 0.15 + (zone - 5) * 0.07),
  },
  {
    id: "driveby", label: "Quelli del drive by", color: "#3a3f4a",
    radiusMult: 1.7, speedMult: 2.6, hpMult: 0.5, damageMult: 1.4, cooldownMult: 0.5,
    behavior: "driveby", minZone: 6,
    projectileSpeed: 480, moneyMult: 5,
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
  if (!weaponEntry) return true;
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

function zoneName(zone) {
  const names = CONFIG.zoneNames;
  if (zone <= names.length) return names[zone - 1];
  return `${names[names.length - 1]} (Lv. ${zone - names.length + 1})`;
}

/* =========================================================
   UTILS
========================================================= */
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

/* =========================================================
   SOUND — presentation concern, not simulation. Defaults to a silent no-op
   (used as-is on the server); script.js points this at the real
   SoundManager singleton once it loads (see setSound() below and its call
   site in script.js, right after SoundManager is defined).
========================================================= */
const NOOP_SOUND = new Proxy({}, { get: () => () => {} });
let sound = NOOP_SOUND;
function setSound(impl) { sound = impl || NOOP_SOUND; }

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
    meleeWeaponUpgrades: [],
    rangedWeaponUpgrades: [],
    bombs: {},
    playerLevel: 0,
  };
}

// Backfills any run fields introduced after a save was written, so an older
// save doesn't crash against newer content (new upgrade ids, etc).
function normalizeRun(run) {
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

// Stable per-entity ids (Enemy/Projectile/Pickup/Bomb) so a multiplayer
// guest can match the same entity across two snapshots and interpolate its
// motion instead of teleporting it.
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
  constructor(x, y, angle, speed, damage, owner = "player", splashRadius = 0, shooter = null, weaponId = null, instaKill = false, homing = false) {
    this.id = nextEntityId();
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.damage = damage;
    this.owner = owner;
    this.splashRadius = splashRadius;
    this.radius = splashRadius ? 9 : 6;
    this.dead = false;
    this.shooter = shooter;
    this.weaponId = weaponId;
    this.instaKill = instaKill;
    this.homing = homing;
  }
  update(dt, enemies) {
    if (this.homing && enemies && enemies.length) {
      const speed = Math.hypot(this.vx, this.vy) || 1;
      const dirX = this.vx / speed, dirY = this.vy / speed;
      let best = null, bestPerp = Infinity;
      for (const e of enemies) {
        if (e.dead) continue;
        const ex = e.x - this.x, ey = e.y - this.y;
        const along = ex * dirX + ey * dirY;
        if (along <= 0) continue;
        const perp = Math.abs(ex * dirY - ey * dirX);
        if (perp < bestPerp) { bestPerp = perp; best = e; }
      }
      if (best) {
        const desired = Math.atan2(best.y - this.y, best.x - this.x);
        const current = Math.atan2(this.vy, this.vx);
        let diff = desired - current;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const maxTurn = HOMING_TURN_RATE * dt;
        const turned = current + clamp(diff, -maxTurn, maxTurn);
        this.vx = Math.cos(turned) * speed;
        this.vy = Math.sin(turned) * speed;
      }
    }
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
    this.kind = kind;
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
  constructor(type, x, y, stickTarget, thrower = null, damageOverride = null) {
    this.id = nextEntityId();
    this.type = type;
    this.x = x;
    this.y = y;
    this.stickTarget = stickTarget || null;
    this.fuse = type.fuse;
    this.exploded = false;
    this.effectTimer = 0;
    this.tickTimer = 0;
    this.dead = false;
    this.thrower = thrower;
    this.damageOverride = damageOverride;
  }

  update(dt, sim) {
    if (this.stickTarget && !this.stickTarget.dead) {
      this.x = this.stickTarget.x;
      this.y = this.stickTarget.y;
    }

    if (!this.exploded) {
      this.fuse -= dt;
      if (this.fuse <= 0) this.detonate(sim);
      return;
    }

    if (this.type.kind === "fire") {
      this.tickTimer -= dt;
      if (this.tickTimer <= 0) {
        this.tickTimer = 0.5;
        for (const enemy of sim.enemies) {
          if (!enemy.dead && dist(enemy.x, enemy.y, this.x, this.y) <= this.type.radius) {
            sim.damageEnemy(enemy, this.type.damagePerSecond * 0.5, this.thrower, this.type.id);
          }
        }
      }
    } else if (this.type.kind === "cc") {
      for (const enemy of sim.enemies) {
        if (!enemy.dead && dist(enemy.x, enemy.y, this.x, this.y) <= this.type.radius) {
          enemy.ccTimer = this.type.duration;
          enemy.ccType = this.type.ccType;
        }
      }
    }

    this.effectTimer -= dt;
    if (this.effectTimer <= 0) this.dead = true;
  }

  detonate(sim) {
    this.exploded = true;
    sound.explosion();
    if (this.type.kind === "damage") {
      const dmg = this.damageOverride != null ? this.damageOverride : this.type.damage;
      for (const enemy of sim.enemies) {
        if (!enemy.dead && dist(enemy.x, enemy.y, this.x, this.y) <= this.type.radius) {
          sim.damageEnemy(enemy, dmg, this.thrower, this.type.id);
        }
      }
      for (const obj of sim.parkObjects) {
        if (obj.hp > 0 && dist(obj.x, obj.y, this.x, this.y) <= this.type.radius) {
          sim.damageParkObject(obj, dmg);
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
    this.facing = -Math.PI / 2;
    this.aimAngle = this.facing;
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
    this.stats = null;
    this.melee = null;
    this.ranged = null;
    this.ammo = 0;
    this._rangedWeaponId = null;
    this._rangedMaxAmmo = null;

    this.selectedThrowable = 0;

    this.runStats = { kills: 0, moneyEarned: 0, killsByWeapon: {} };

    // Each player owns their own money/upgrades/weapons — co-op players
    // customize independently rather than sharing one purse. On a guest
    // tab this.player is a read-only mirror kept in sync from the host's
    // snapshot (see applyGuestShopSync in script.js) rather than simulated
    // locally.
    this.run = createRunState();
    // True while this player's own shop panel is open — freezes only
    // their own movement/actions, everyone else keeps playing.
    this.shopOpen = false;
    // Confirmed ready to leave the zone-complete shop — see
    // Simulation.beginZoneClear/tryAdvanceZone.
    this.readyForNextZone = false;
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
    const bombCapacityBonus = lvl("bombCapacity") * UPGRADES.find(u => u.id === "bombCapacity").perLevel;
    const dashCooldownReduction = clamp(lvl("dashCooldown") * UPGRADES.find(u => u.id === "dashCooldown").perLevel, 0, 0.65);
    const moneyBonusFrac = lvl("moneyBonus") * UPGRADES.find(u => u.id === "moneyBonus").perLevel;
    const hitInvulnBonus = lvl("hitInvuln") * UPGRADES.find(u => u.id === "hitInvuln").perLevel;
    const meleeSpeedReduction = clamp(lvl("meleeSpeed") * UPGRADES.find(u => u.id === "meleeSpeed").perLevel, 0, 0.5);

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
      bombCapacityBonus,
      dashCooldown: cfg.dashCooldown * (1 - dashCooldownReduction),
      moneyBonusFrac,
      hitInvuln: cfg.hitInvuln + hitInvulnBonus,
    };

    const meleeWeapon = MELEE_WEAPONS[run.meleeTier || 0];
    const meleeBonus = sumWeaponUpgrades(meleeWeapon, run.meleeWeaponUpgrades);
    const meleeCooldown = meleeWeapon.cooldown * meleeBonus.cooldownMult * (1 - meleeSpeedReduction);
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
        this.ammo = newMaxAmmo;
        this._rangedWeaponId = rw.id;
      } else if (this._rangedMaxAmmo != null && newMaxAmmo > this._rangedMaxAmmo) {
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
    this.runStats = { kills: 0, moneyEarned: 0, killsByWeapon: {} };
    this.shopOpen = false;
    this.readyForNextZone = false;
  }

  healOnNewZone() {
    if (!this.stats) return;
    const missing = this.maxHp - this.hp;
    this.hp = clamp(this.hp + missing * this.stats.doorHealFraction, 0, this.maxHp);
  }

  get isDashing() { return this.dashTimer > 0; }
  get isInvulnerable() { return this.invulnTimer > 0; }

  tryAttack(sim) {
    if (this.attackCooldownTimer > 0) return;
    this.attackCooldownTimer = this.melee.cooldown;
    this.attackActiveTimer = this.melee.activeTime;
    sound.attack();

    for (const enemy of sim.enemies) {
      if (enemy.dead) continue;
      const d = dist(this.x, this.y, enemy.x, enemy.y);
      if (d > this.melee.range + enemy.radius) continue;
      sim.damageEnemy(enemy, this.melee.damage, this, this.melee.id);
    }
    for (const obj of sim.parkObjects) {
      if (obj.hp <= 0) continue;
      if (dist(this.x, this.y, obj.x, obj.y) > this.melee.range + obj.radius) continue;
      sim.damageParkObject(obj, this.melee.damage);
    }
  }

  autoMeleeAttack(sim) {
    if (this.attackCooldownTimer > 0) return;
    const inRange = sim.enemies.some(e => !e.dead && dist(this.x, this.y, e.x, e.y) <= this.melee.range + e.radius);
    if (inRange) this.tryAttack(sim);
  }

  tryRangedAttack(sim) {
    if (!this.ranged || this.rangedCooldownTimer > 0) return;
    if (this.ammo <= 0) { sound.emptyClick(); return; }
    const angle = sim.aimAssist(this.x, this.y, this.aimAngle, this.ranged.aimConeBonus);
    this.fireRanged(sim, angle);
  }

  autoFireRanged(sim) {
    if (!this.ranged || this.rangedCooldownTimer > 0 || this.ammo <= 0) return;
    const angle = sim.findAutoFireAngle(this.x, this.y, this.aimAngle, this.ranged.aimConeBonus);
    if (angle === null) return;
    this.fireRanged(sim, angle);
  }

  fireRanged(sim, angle) {
    this.rangedCooldownTimer = this.ranged.cooldown;
    this.ammo--;
    const muzzle = this.radius + 8;
    const pellets = this.ranged.pellets;
    for (let i = 0; i < pellets; i++) {
      const a = pellets > 1 ? angle + (i / (pellets - 1) - 0.5) * this.ranged.spread : angle;
      sim.spawnProjectile(
        this.x + Math.cos(a) * muzzle,
        this.y + Math.sin(a) * muzzle,
        a,
        this.ranged.projectileSpeed,
        this.ranged.damage,
        this.ranged.splashRadius,
        this,
        this._rangedWeaponId
      );
    }
    sound.shoot();
  }

  tryDash() {
    if (this.dashCooldownTimer > 0 || this.isDashing) return;
    this.dashTimer = CONFIG.player.dashDuration;
    this.dashCooldownTimer = this.stats.dashCooldown;
    this.invulnTimer = Math.max(this.invulnTimer, CONFIG.player.dashDuration + 0.1);
    sound.dash();
  }

  takeDamage(amount) {
    if (this.isInvulnerable) return false;
    const reduced = amount * (1 - this.stats.defReduction);
    this.hp = clamp(this.hp - reduced, 0, this.maxHp);
    this.invulnTimer = this.stats.hitInvuln;
    this.hitFlash = 0.25;
    sound.hitPlayer();
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

    const sprite = Sprites.get("player");
    if (sprite) {
      const bob = this.isMoving ? Math.sin(this.walkPhase) * 3 : 0;
      const size = this.radius * 2.3;
      ctx.save();
      ctx.rotate(this.facing + Math.PI / 2);
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
    this.facing = -Math.PI / 2;
    this.isMoving = false;
    this.walkPhase = 0;

    this.jitterAngle = rand(0, Math.PI * 2);
    this.jitterTimer = rand(0, 1);

    this.moveDir = { x: 0, y: 0 };
    this.moveSpeedMult = 1;
    this.erraticTimer = rand(0, 0.3);

    this.strafeDir = Math.random() < 0.5 ? -1 : 1;

    this.drivebyDir = 1;

    this.ccTimer = 0;
    this.ccType = null;
  }

  update(dt, player, sim) {
    if (this.dead) return;
    if (this.attackCooldownTimer > 0) this.attackCooldownTimer -= dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;

    if (this.type.behavior === "driveby") {
      this.updateDriveby(dt, player, sim);
      return;
    }

    if (this.ccTimer > 0) {
      this.ccTimer -= dt;
      if (this.ccType === "smoke") {
        if (dist(this.x, this.y, player.x, player.y) > SMOKE_BLIND_RADIUS) {
          this.wanderRandomly(dt);
          return;
        }
      } else {
        this.isMoving = false;
        return;
      }
    }

    const d = dist(this.x, this.y, player.x, player.y);
    this.isMoving = false;

    if (this.type.behavior === "ranged") {
      this.updateRanged(dt, player, sim, d);
    } else if (d <= this.stats.attackRange + this.radius) {
      this.facing = Math.atan2(player.y - this.y, player.x - this.x);
      if (this.attackCooldownTimer <= 0) {
        this.attackCooldownTimer = this.stats.attackCooldown;
        const hit = player.takeDamage(this.stats.damage);
        if (hit) sim.onPlayerHit(player);
      }
    } else {
      this.moveTowardBehavior(dt, player, d);
    }

    this.walkPhase = this.isMoving ? this.walkPhase + dt * 10 : 0;

    for (const other of sim.enemies) {
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

  updateDriveby(dt, player, sim) {
    this.x += this.drivebyDir * this.stats.speed * dt;
    this.isMoving = true;

    if (this.attackCooldownTimer <= 0) {
      this.attackCooldownTimer = this.stats.attackCooldown;
      const angle = Math.atan2(player.y - this.y, player.x - this.x);
      sim.spawnEnemyProjectile(this.x, this.y, angle, this.type.projectileSpeed, this.stats.damage);
    }

    if (this.x < -60 || this.x > CONFIG.width + 60) {
      this.dead = true;
      sim.onDrivebyExit();
    }
  }

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

  updateRanged(dt, player, sim, d) {
    if (d > this.stats.detectRange) { this.wanderRandomly(dt); return; }

    const pref = this.type.preferredRange;
    let dx = player.x - this.x, dy = player.y - this.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;

    let dir = 0;
    if (d < pref * 0.75) dir = -1;
    else if (d > pref * 1.25) dir = 1;

    if (dir !== 0) {
      this.x += dx * dir * this.stats.speed * dt;
      this.y += dy * dir * this.stats.speed * dt;
      this.facing = Math.atan2(dy * dir, dx * dir);
    } else {
      this.x += -dy * this.strafeDir * this.stats.speed * 0.3 * dt;
      this.y += dx * this.strafeDir * this.stats.speed * 0.3 * dt;
      this.facing = Math.atan2(dy, dx);
    }
    this.isMoving = true;

    if (d <= this.stats.attackRange && this.attackCooldownTimer <= 0) {
      this.attackCooldownTimer = this.stats.attackCooldown;
      const angle = Math.atan2(player.y - this.y, player.x - this.x);
      this.facing = angle;
      sim.spawnEnemyProjectile(this.x, this.y, angle, this.type.projectileSpeed, this.stats.damage);
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
          const a = rand(0, Math.PI * 2);
          this.moveDir = { x: Math.cos(a), y: Math.sin(a) };
          this.moveSpeedMult = 0.4;
        } else {
          const roll = Math.random();
          if (roll < 0.45) {
            this.moveDir = { x: dx / len, y: dy / len };
            this.moveSpeedMult = 1.3;
          } else if (roll < 0.8) {
            const baseAngle = Math.atan2(dy, dx);
            const off = rand(0.9, 2.4) * (Math.random() < 0.5 ? -1 : 1);
            const a = baseAngle + off;
            this.moveDir = { x: Math.cos(a), y: Math.sin(a) };
            this.moveSpeedMult = 1.1;
          } else {
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

    const sprite = Sprites.get(this.type.id);
    if (sprite) {
      const bob = this.isMoving ? Math.sin(this.walkPhase) * 2 : 0;
      const size = this.radius * 3.6;
      ctx.save();
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
   REMOTE INPUT STATE
   Adapter "shaped like" the browser's InputHandler (isDown/moveVec/gpAim/
   touchAim) so Player.update(dt, input) can drive a networked player
   exactly like the local one — its fields are written by
   Simulation.applyRemoteState from the "state" messages a client sends.
========================================================= */
class RemoteInputState {
  constructor() {
    this.moveState = { up: false, down: false, left: false, right: false };
    this.moveVec = null;
    this.aim = null;
  }
  isDown(dir) { return !!this.moveState[dir]; }
  get gpAim() { return this.aim; }
  get touchAim() { return null; }
}

/* =========================================================
   SIMULATION
   Owns every piece of live game state and the logic that advances it.
   `player` is this simulation's "primary" participant (the local player in
   solo/browser play; conceptually just "player #1" once this also runs
   server-side); `remotePlayers` holds every other connected participant,
   keyed by their network id.
========================================================= */
class Simulation {
  constructor() {
    this.player = new Player(CONFIG.width / 2, CONFIG.height / 2);
    this.player.refreshLoadout(this.player.run);
    this.player.resetForRun();

    this.remotePlayers = new Map(); // id -> { player: Player, input: RemoteInputState, isTouchDevice: bool }

    // "Primary" participant identity — only meaningful server-side (see
    // server.js), where EVERY participant including this.player arrives
    // over the network: server.js sets this.primaryId to the room
    // creator's network id, and this.player's own input/touch-device flag
    // then live here instead of in a real browser InputHandler. In the
    // browser (solo/local play) this.primaryId stays null and this.player
    // is always driven by tick()'s explicit localInput argument instead —
    // see tick()/_participant() below.
    this.primaryId = null;
    this.primaryInput = new RemoteInputState();
    this.primaryIsTouchDevice = false;

    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.bombs = [];
    this.parkPaths = [];
    this.parkObjects = [];
    this.floatingTexts = [];

    this.zone = 1;
    this.moneyThisRun = 0;
    this.enemiesToSpawn = 0;
    this.spawnTimer = 0;
    this.waveTotalEnemies = 0;
    this.waveEnemiesDefeated = 0;
    // True from the moment a wave is cleared until every active player has
    // confirmed ready in their own shop — see beginZoneClear/tryAdvanceZone.
    this.zoneClearPending = false;
    // Edge-triggered flags a host wrapper (Game.update, browser-only) reads
    // and resets after each tick() — see the call site in script.js.
    this.gameOver = false;
    this.justEnteredZoneClear = false;
  }

  startRun() {
    this.player.run = createRunState();
    this.player.refreshLoadout(this.player.run);
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
    this.parkPaths = [];
    this.parkObjects = [];
    this.player.selectedThrowable = 0;
    this.floatingTexts = [];
    this.gameOver = false;
    this.justEnteredZoneClear = false;
    this.startZone();
  }

  // Restores shop progress (money, upgrades, weapons, zone reached) from a
  // save — see saveRunState/loadRunState in script.js (localStorage,
  // browser-only, so the save/load itself stays there; this just applies
  // the already-loaded data to sim state).
  resumeRun(savedRun, savedZone, savedPlayerHp) {
    this.player.run = normalizeRun(savedRun);
    this.zone = savedZone || 1;
    this.moneyThisRun = 0;
    this.player.refreshLoadout(this.player.run);
    this.player.resetForRun();
    if (savedPlayerHp != null) this.player.hp = clamp(savedPlayerHp, 1, this.player.maxHp);
    this.player.x = CONFIG.width / 2;
    this.player.y = CONFIG.height / 2;
    this.repositionRemotePlayers();
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.bombs = [];
    this.parkPaths = [];
    this.parkObjects = [];
    this.player.selectedThrowable = 0;
    this.floatingTexts = [];
    this.gameOver = false;
    this.justEnteredZoneClear = false;
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
    // Fresh park layout every 10 zones (1, 11, 21, ...) — same cadence as
    // the difficulty curve, so the field looks visibly different again
    // right when the wave composition ramps up too.
    if ((this.zone - 1) % 10 === 0 || this.parkPaths.length === 0) this.generateParkLayout();
    sound.wave();
  }

  // Builds this.parkPaths (the lanes the drive-by car travels — see
  // spawnDriveby) and this.parkObjects (destructible obstacles: benches and
  // lamp posts hug the path edges, everything else scatters through the
  // rest of the field, always clear of the paths themselves).
  generateParkLayout() {
    const pathCount = this.zone >= 80 ? 4 : this.zone >= 50 ? 3 : this.zone >= 20 ? 2 : 1;
    const top = 90, bottom = CONFIG.height - 30;
    const pathHeight = 64;

    const paths = [];
    for (let i = 0; i < pathCount; i++) {
      const frac = (i + 1) / (pathCount + 1);
      paths.push({ y: top + frac * (bottom - top), height: pathHeight });
    }
    const onAnyPath = (y) => paths.some(p => Math.abs(y - p.y) < p.height / 2 + 20);

    const objects = [];
    const margin = 36;
    const minGap = 46;

    const overlapsExisting = (x, y, radius) =>
      objects.some(o => dist(x, y, o.x, o.y) < o.radius + radius + minGap);

    const place = (typeKey, count, alongPath) => {
      const type = OBJECT_TYPES[typeKey];
      let placed = 0, attempts = 0;
      while (placed < count && attempts < 300) {
        attempts++;
        let x, y;
        if (alongPath) {
          if (paths.length === 0) break;
          const path = paths[randInt(0, paths.length - 1)];
          x = rand(margin, CONFIG.width - margin);
          const side = Math.random() < 0.5 ? -1 : 1;
          y = clamp(path.y + side * (path.height / 2 + 22 + rand(0, 18)), top, bottom);
        } else {
          x = rand(margin, CONFIG.width - margin);
          y = rand(top + margin, bottom - margin);
          if (onAnyPath(y)) continue;
        }
        if (overlapsExisting(x, y, type.radius)) continue;
        objects.push({ id: nextEntityId(), x, y, typeKey, radius: type.radius, hp: type.hp, maxHp: type.hp });
        placed++;
      }
    };

    place("panchina", pathCount * 2, true);
    if (Math.floor((this.zone - 1) / 10) % 2 === 0) place("lampione", pathCount * 2, true);
    place("albero", 7, false);
    place("cestino", 4, false);
    place("cassonetto", 3, false);
    place("barile", 3, false);
    place("recinzione", 4, false);

    this.parkPaths = paths;
    this.parkObjects = objects;
  }

  damageParkObject(obj, amount) {
    obj.hp = clamp(obj.hp - amount, 0, obj.maxHp);
    this.floatingTexts.push(new FloatingText(obj.x, obj.y - 16, `-${Math.round(amount)}`, "#c7cad1"));
    if (obj.hp <= 0) sound.hitEnemy();
  }

  resolveObjectCollisions(entity) {
    for (const obj of this.parkObjects) {
      if (obj.hp <= 0) continue;
      const d = dist(entity.x, entity.y, obj.x, obj.y);
      const minD = entity.radius + obj.radius;
      if (d > 0 && d < minD) {
        const push = minD - d;
        entity.x += ((entity.x - obj.x) / d) * push;
        entity.y += ((entity.y - obj.y) / d) * push;
      }
    }
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

  spawnDriveby(type) {
    const fromLeft = Math.random() < 0.5;
    const x = fromLeft ? -50 : CONFIG.width + 50;
    const path = this.parkPaths.length
      ? this.parkPaths[randInt(0, this.parkPaths.length - 1)]
      : null;
    const players = this.activePlayers;
    const lanePlayer = players[randInt(0, players.length - 1)] || this.player;
    const y = path ? path.y : clamp(lanePlayer.y + rand(-80, 80), 90, CONFIG.height - 30);
    const zoneStats = this.enemyStatsForZone(this.zone, type);
    const enemy = new Enemy(x, y, zoneStats, type);
    enemy.drivebyDir = fromLeft ? 1 : -1;
    enemy.facing = fromLeft ? 0 : Math.PI;
    this.enemies.push(enemy);
  }

  spawnProjectile(x, y, angle, speed, damage, splashRadius, shooter, weaponId, instaKill = false, homing = false) {
    this.projectiles.push(new Projectile(x, y, angle, speed, damage, "player", splashRadius, shooter, weaponId, instaKill, homing));
  }

  spawnEnemyProjectile(x, y, angle, speed, damage) {
    this.projectiles.push(new Projectile(x, y, angle, speed, damage, "enemy"));
  }

  selectBomb(value, absolute, actor = this.player) {
    const n = THROWABLES.length;
    actor.selectedThrowable = absolute ? value % n : (actor.selectedThrowable + value + n) % n;
  }

  grenadeDamageForZone() {
    const sc = CONFIG.zoneScaling;
    const z = this.zone - 1;
    const lvl = this.combinedPlayerLevel;
    const levelHpMult = 1 + sc.hpPerPlayerLevel * lvl;
    const balordoHpMult = ENEMY_TYPES.find(t => t.id === "balordo").hpMult;
    const baseHpAtZone = CONFIG.enemy.baseMaxHP * (1 + sc.hpPerZone * z) * balordoHpMult * levelHpMult;
    return Math.round(baseHpAtZone * 1.15);
  }

  throwBomb(actor = this.player) {
    const type = THROWABLES[actor.selectedThrowable];
    if (!type) return;
    const count = actor.run.bombs[type.id] || 0;
    if (count <= 0) { sound.emptyClick(); return; }
    actor.run.bombs[type.id] = count - 1;

    const angle = actor.aimAngle;

    if (type.isProjectileThrow) {
      const muzzle = actor.radius + 8;
      this.spawnProjectile(
        actor.x + Math.cos(angle) * muzzle,
        actor.y + Math.sin(angle) * muzzle,
        angle,
        type.projectileSpeed,
        type.damage || 0,
        0,
        actor,
        type.id,
        !!type.instaKill,
        !!type.homing
      );
      sound.throwBomb();
      return;
    }

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
    const damageOverride = type.id === "grenade" ? this.grenadeDamageForZone() : null;
    this.bombs.push(new Bomb(type, x, y, stickTarget, actor, damageOverride));
    sound.throwBomb();
  }

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

  aimAssist(x, y, aim, coneBonus = 0) {
    const enemy = this.findNearestInCone(x, y, aim, Math.PI / 5 + coneBonus, 480);
    return enemy ? Math.atan2(enemy.y - y, enemy.x - x) : aim;
  }

  findAutoFireAngle(x, y, aim, coneBonus = 0) {
    const enemy = this.findNearestInCone(x, y, aim, Math.PI / 6 + coneBonus, 480);
    return enemy ? Math.atan2(enemy.y - y, enemy.x - x) : null;
  }

  damageEnemy(enemy, amount, source = null, weaponId = null) {
    const killed = enemy.takeDamage(amount);
    this.floatingTexts.push(new FloatingText(enemy.x, enemy.y - 20, `-${Math.round(amount)}`, "#ffffff"));
    if (killed) {
      sound.ko();
      const [minM, maxM] = enemy.stats.moneyRange;
      const moneyBonusFrac = (source || this.player).stats.moneyBonusFrac;
      const reward = Math.round(randInt(minM, maxM) * (1 + moneyBonusFrac));
      this.moneyThisRun += reward;
      (source || this.player).run.money += reward;
      this.floatingTexts.push(new FloatingText(enemy.x, enemy.y - 34, `+${reward}€`, "#4fd07a"));
      this.waveEnemiesDefeated++;
      sound.coin();
      this.rollPickupDrop(enemy);
      if (source) {
        source.runStats.kills++;
        source.runStats.moneyEarned += reward;
        if (weaponId) source.runStats.killsByWeapon[weaponId] = (source.runStats.killsByWeapon[weaponId] || 0) + 1;
      }
    } else {
      sound.hitEnemy();
    }
  }

  onDrivebyExit() {
    this.waveEnemiesDefeated++;
  }

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

  collectPickup(pickup, actor = this.player) {
    if (pickup.kind === "health") {
      const before = actor.hp;
      actor.hp = clamp(actor.hp + pickup.amount, 0, actor.maxHp);
      const healed = Math.round(actor.hp - before);
      if (healed > 0) {
        this.floatingTexts.push(new FloatingText(actor.x, actor.y - 26, `+${healed} HP`, "#3ddc71"));
        sound.heal();
      }
    } else if (pickup.kind === "ammo" && actor.ranged) {
      const add = Math.min(pickup.amount, actor.ranged.maxAmmo - actor.ammo);
      if (add > 0) {
        actor.ammo += add;
        this.floatingTexts.push(new FloatingText(actor.x, actor.y - 26, `+${add} munizioni`, "#ffd24a"));
        sound.ammoPickup();
      }
    }
  }

  onPlayerHit(actor = this.player) {
    if (actor.run.money <= 0) return;
    const stealFrac = 0.05;
    const reduction = actor.stats.stealReduction;
    let stolen = Math.round(actor.run.money * stealFrac * (1 - reduction));
    stolen = Math.min(stolen, actor.run.money);
    if (stolen > 0) {
      actor.run.money -= stolen;
      this.moneyThisRun -= Math.min(stolen, Math.max(0, this.moneyThisRun));
      this.floatingTexts.push(new FloatingText(actor.x, actor.y - 26, `-${stolen}€ rubati!`, "#d9455f"));
    }
  }

  // Wave cleared: every active (alive) player must confirm ready in their
  // own shop before the next zone starts — see tryAdvanceZone. Setting
  // justEnteredZoneClear lets a browser host react (auto-open its own shop
  // UI) without this class knowing anything about DOM.
  beginZoneClear() {
    this.zoneClearPending = true;
    for (const p of this.activePlayers) p.readyForNextZone = false;
    this.justEnteredZoneClear = true;
  }

  // Solo play (one active player) behaves exactly like today: confirming
  // ready immediately advances the zone.
  tryAdvanceZone() {
    if (!this.zoneClearPending) return;
    if (!this.activePlayers.every(p => p.readyForNextZone)) return;
    this.zoneClearPending = false;
    this.zone++;
    this.startZone();
  }

  costFor(upg, level) {
    return Math.round(upg.baseCost * Math.pow(upg.growth, level));
  }

  // Pure mutation of ONE player's own run/gear, no UI/network side effects
  // — shared by the host's own local buyX() handlers (script.js) and
  // applyRemoteAction (guest purchases, applied to that guest's own player).
  applyUpgradePurchase(player, id) {
    const upg = UPGRADES.find(u => u.id === id);
    const run = player.run;
    const level = run.upgrades[id] || 0;
    if (level >= upg.maxLevel) return;
    const cost = this.costFor(upg, level);
    if (run.money < cost) return;
    run.money -= cost;
    run.upgrades[id] = level + 1;
    run.playerLevel++;
    player.refreshLoadout(run);
    if (id === "firstaid") {
      player.hp = Math.max(player.hp, Math.round(player.maxHp * 0.75));
    }
  }

  applyMeleeWeaponPurchase(player, idx) {
    const run = player.run;
    const weapon = MELEE_WEAPONS[idx];
    const current = MELEE_WEAPONS[run.meleeTier];
    if (!weapon || idx !== run.meleeTier + 1 || run.money < weapon.cost) return;
    if (!allWeaponUpgradesOwned(current, run.meleeWeaponUpgrades)) return;
    run.money -= weapon.cost;
    run.meleeTier = idx;
    run.playerLevel++;
    player.refreshLoadout(run);
  }

  applyRangedWeaponPurchase(player, idx) {
    const run = player.run;
    const weapon = RANGED_WEAPONS[idx];
    if (!weapon || idx !== run.rangedTier + 1 || run.money < weapon.cost) return;
    if (weapon.minZone && this.zone < weapon.minZone) return;
    if (run.rangedTier >= 0) {
      const current = RANGED_WEAPONS[run.rangedTier];
      if (!allWeaponUpgradesOwned(current, run.rangedWeaponUpgrades)) return;
    }
    run.money -= weapon.cost;
    run.rangedTier = idx;
    run.playerLevel++;
    player.refreshLoadout(run);
  }

  applyMeleeWeaponUpgradePurchase(player, id, cost) {
    const run = player.run;
    if (run.meleeWeaponUpgrades.includes(id) || run.money < cost) return;
    run.money -= cost;
    run.meleeWeaponUpgrades.push(id);
    run.playerLevel++;
    player.refreshLoadout(run);
  }

  applyRangedWeaponUpgradePurchase(player, id, cost) {
    const run = player.run;
    if (run.rangedWeaponUpgrades.includes(id) || run.money < cost) return;
    run.money -= cost;
    run.rangedWeaponUpgrades.push(id);
    run.playerLevel++;
    player.refreshLoadout(run);
  }

  applyAmmoPurchase(player) {
    if (!player.ranged) return;
    const run = player.run;
    const weapon = RANGED_WEAPONS[run.rangedTier];
    const chunk = Math.min(10, weapon.maxAmmo - player.ammo);
    if (chunk <= 0) return;
    const cost = Math.ceil(chunk * weapon.costPerAmmo);
    if (run.money < cost) return;
    run.money -= cost;
    player.ammo += chunk;
  }

  bombCapacityFor(type, player = this.player) {
    return type.maxCarry + (player.stats.bombCapacityBonus || 0);
  }

  applyBombPurchase(player, id) {
    const type = THROWABLES.find(t => t.id === id);
    if (!type) return;
    const run = player.run;
    const count = run.bombs[id] || 0;
    if (count >= this.bombCapacityFor(type, player) || run.money < type.cost) return;
    run.money -= type.cost;
    run.bombs[id] = count + 1;
  }

  // Spawn offset (relative to field center) for the Nth player to join a
  // room, host included — a small cross formation so up to 4 players don't
  // stack on top of each other. Index 0 (the host) is always dead center.
  spawnOffsetFor(index) {
    const offsets = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: -60, y: 0 }, { x: 0, y: 60 }];
    return offsets[index % offsets.length];
  }

  addRemotePlayer(id, isTouchDevice) {
    const off = this.spawnOffsetFor(this.remotePlayers.size + 1);
    const player = new Player(CONFIG.width / 2 + off.x, CONFIG.height / 2 + off.y);
    player.refreshLoadout(player.run);
    player.resetForRun();
    this.remotePlayers.set(id, { player, input: new RemoteInputState(), isTouchDevice: !!isTouchDevice });
  }

  removeRemotePlayer(id) {
    this.remotePlayers.delete(id);
  }

  // Server-side only: if the primary participant (this.primaryId) drops
  // out while others remain, one of them takes over as this.player so
  // nobody's left simulating a "ghost" — the departed player's old
  // this.player instance is simply discarded along with them, exactly as
  // if they'd been an ordinary remotePlayers entry. Called by server.js.
  promoteRemoteToPrimary(id) {
    const entry = this.remotePlayers.get(id);
    if (!entry) return false;
    this.remotePlayers.delete(id);
    this.player = entry.player;
    this.primaryInput = entry.input;
    this.primaryIsTouchDevice = entry.isTouchDevice;
    this.primaryId = id;
    return true;
  }

  // Re-spawns every currently-connected remote player around the host's
  // spawn point — shared by startRun()/resumeRun(). Each keeps their own
  // run/loadout (individual economies) — this only resets position and
  // per-run state like HP/stats/ready flags.
  repositionRemotePlayers() {
    let i = 1;
    for (const entry of this.remotePlayers.values()) {
      const off = this.spawnOffsetFor(i++);
      entry.player.refreshLoadout(entry.player.run);
      entry.player.resetForRun();
      entry.player.x = CONFIG.width / 2 + off.x;
      entry.player.y = CONFIG.height / 2 + off.y;
    }
  }

  // Every living player (this.player + every connected remote one) — used
  // by enemy targeting, projectile/pickup collision and the game-over check.
  get activePlayers() {
    const list = [this.player];
    for (const entry of this.remotePlayers.values()) list.push(entry.player);
    return list.filter(p => p.hp > 0);
  }

  // Since each player levels up their own run independently, enemy
  // difficulty scaling sums every active player's level rather than reading
  // one shared number — a stronger/bigger group makes for tougher enemies,
  // same as before for solo play where this just equals that one player's
  // own level.
  get combinedPlayerLevel() {
    return this.activePlayers.reduce((sum, p) => sum + (p.run.playerLevel || 0), 0);
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

  // Resolves {player, input} for a network id — either this.player itself
  // (only when server.js has set this.primaryId for the room's first
  // participant) or a this.remotePlayers entry. Lets applyRemoteState/
  // applyRemoteAction/setTouchDevice treat every connected participant
  // uniformly instead of special-casing "the primary one".
  _participant(id) {
    if (this.primaryId != null && id === this.primaryId) {
      return { player: this.player, input: this.primaryInput, setTouch: (v) => { this.primaryIsTouchDevice = v; } };
    }
    const entry = this.remotePlayers.get(id);
    return entry ? { player: entry.player, input: entry.input, setTouch: (v) => { entry.isTouchDevice = v; } } : null;
  }

  // Peer -> host (or, server-side, any connected client -> the room's
  // simulation): continuous movement/aim state, applied straight into the
  // sender's own input state, identified by msg.from. isTouchDevice rides
  // along on every state message rather than a separate one-off "hello",
  // so there's no join-order race to worry about (see server.js).
  applyRemoteState(msg) {
    const p = this._participant(msg.from);
    if (!p) return;
    p.input.moveState = msg.move || { up: false, down: false, left: false, right: false };
    p.input.moveVec = msg.moveVec || null;
    p.input.aim = msg.aim || null;
    p.player.shopOpen = !!msg.shopOpen;
    if (msg.isTouchDevice != null) p.setTouch(!!msg.isTouchDevice);
  }

  // Peer -> host: discrete one-shot actions (attack/dash/purchases/ready).
  applyRemoteAction(msg) {
    const p = this._participant(msg.from);
    if (!p) return;
    const rp = p.player;
    switch (msg.action) {
      case "attack": rp.tryAttack(this); break;
      case "rangedAttack": rp.tryRangedAttack(this); break;
      case "dash": rp.tryDash(); break;
      case "throwBomb": this.throwBomb(rp); break;
      case "selectBomb": this.selectBomb(msg.value, msg.absolute, rp); break;
      case "buyUpgrade": this.applyUpgradePurchase(rp, msg.id); break;
      case "buyMeleeWeapon": this.applyMeleeWeaponPurchase(rp, msg.idx); break;
      case "buyRangedWeapon": this.applyRangedWeaponPurchase(rp, msg.idx); break;
      case "buyMeleeWeaponUpgrade": this.applyMeleeWeaponUpgradePurchase(rp, msg.id, msg.cost); break;
      case "buyRangedWeaponUpgrade": this.applyRangedWeaponUpgradePurchase(rp, msg.id, msg.cost); break;
      case "buyAmmo": this.applyAmmoPurchase(rp); break;
      case "buyBomb": this.applyBombPurchase(rp, msg.id); break;
      case "readyForNextZone":
        rp.readyForNextZone = true;
        this.tryAdvanceZone();
        break;
    }
  }

  enemyStatsForZone(zone, type) {
    const s = CONFIG.enemy;
    const z = zone - 1;
    const sc = CONFIG.zoneScaling;
    const lvl = this.combinedPlayerLevel;
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

  // One fixed step of the whole simulation: player(s), enemies, projectiles,
  // pickups, bombs, floating texts, spawn/zone progression. `localInput` is
  // whatever input-like object (isDown/moveVec/gpAim/touchAim, plus the
  // gpAttack/gpRanged/gpDash/touchDash flags) drives this.player — the
  // browser passes its real InputHandler. Server-side (see server.js),
  // nothing local exists at all: localInput is omitted, so this.player
  // falls back to this.primaryInput/primaryIsTouchDevice instead, fed by
  // network messages exactly like every this.remotePlayers entry (see
  // applyRemoteState/applyRemoteAction/_participant above) — the room
  // creator has no more "local" authority than anyone else once the
  // server is running the simulation.
  tick(dt, localInput, isLocalTouchDevice) {
    const input = localInput || this.primaryInput;
    const touchDevice = localInput ? isLocalTouchDevice : this.primaryIsTouchDevice;
    if (!this.player.shopOpen) {
      this.player.update(dt, input);
      this.resolveObjectCollisions(this.player);
      if (input.gpAttack) this.player.tryAttack(this);
      if (input.gpRanged) this.player.tryRangedAttack(this);
      if (input.gpDash || input.touchDash) this.player.tryDash();
      this.player.autoFireRanged(this);
      if (touchDevice) this.player.autoMeleeAttack(this);
    }

    for (const entry of this.remotePlayers.values()) {
      if (entry.player.hp <= 0 || entry.player.shopOpen) continue;
      entry.player.update(dt, entry.input);
      this.resolveObjectCollisions(entry.player);
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

    for (const enemy of this.enemies) {
      enemy.update(dt, this.nearestPlayerTo(enemy.x, enemy.y), this);
      if (enemy.type.behavior !== "driveby") this.resolveObjectCollisions(enemy);
    }
    this.enemies = this.enemies.filter(e => !e.dead);

    for (const proj of this.projectiles) {
      if (proj.dead) continue;
      proj.update(dt, this.enemies);
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
              sound.explosion();
              for (const e2 of this.enemies) {
                if (!e2.dead && dist(proj.x, proj.y, e2.x, e2.y) <= proj.splashRadius) {
                  this.damageEnemy(e2, proj.damage, proj.shooter, proj.weaponId);
                }
              }
            } else if (proj.instaKill) {
              this.damageEnemy(enemy, enemy.hp, proj.shooter, proj.weaponId);
            } else {
              this.damageEnemy(enemy, proj.damage, proj.shooter, proj.weaponId);
            }
            proj.dead = true;
          }
        }
        if (!proj.dead) {
          for (const obj of this.parkObjects) {
            if (obj.hp <= 0 || proj.dead) continue;
            if (dist(proj.x, proj.y, obj.x, obj.y) <= proj.radius + obj.radius) {
              if (proj.splashRadius) {
                sound.explosion();
                for (const o2 of this.parkObjects) {
                  if (o2.hp > 0 && dist(proj.x, proj.y, o2.x, o2.y) <= proj.splashRadius) {
                    this.damageParkObject(o2, proj.damage);
                  }
                }
              } else {
                this.damageParkObject(obj, proj.instaKill ? obj.hp : proj.damage);
              }
              proj.dead = true;
            }
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

    // Destroyed park objects are already ignored everywhere (collisions,
    // damage, the snapshot) via their own hp<=0 check, but — unlike every
    // other entity array above — were never actually dropped from the
    // array itself, leaving them to accumulate in memory and get iterated
    // for nothing until the next full-layout regen (every 10 zones).
    this.parkObjects = this.parkObjects.filter(o => o.hp > 0);

    if (this.activePlayers.length === 0) {
      this.gameOver = true;
      return;
    }

    if (!this.zoneClearPending && this.enemiesToSpawn === 0 && this.enemies.length === 0 && this.waveEnemiesDefeated >= this.waveTotalEnemies) {
      this.beginZoneClear();
    }
  }

  // Compact wire representation of everything a thin client needs to
  // render — broadcast identically to every connected client (see
  // server.js's per-room tick loop).
  toSnapshot(gameState) {
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
      run: p.run, ready: p.readyForNextZone,
    });
    const players = [serializePlayer(this.player, this.primaryId, true)];
    for (const [id, entry] of this.remotePlayers) players.push(serializePlayer(entry.player, id, false));

    return {
      gameState,
      zone: this.zone,
      zoneName: zoneName(this.zone),
      waveTotal: this.waveTotalEnemies,
      waveDefeated: this.waveEnemiesDefeated,
      zoneClearPending: this.zoneClearPending,
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
      parkPaths: this.parkPaths,
      parkObjects: this.parkObjects.filter(o => o.hp > 0).map(o => ({
        id: o.id, x: o.x, y: o.y, typeKey: o.typeKey, radius: o.radius, hp: o.hp, maxHp: o.maxHp,
      })),
      bombs: this.bombs.map(b => ({
        id: b.id, x: b.x, y: b.y, typeId: b.type.id, exploded: b.exploded,
        effectTimer: b.effectTimer, fuseDuration: b.type.fuse,
      })),
      floatingTexts: this.floatingTexts.map(ft => ({
        x: ft.x, y: ft.y, text: ft.text, color: ft.color, life: ft.life, maxLife: ft.maxLife,
      })),
    };
  }
}

// Node (server.js, added in a later step) requires this file as a CommonJS
// module; a browser classic <script> just leaves every const/class above as
// an ordinary global for script.js (loaded right after this file) to use
// unchanged — see index.html's script order.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CONFIG, OBJECT_TYPES, objectDamageStage, UPGRADES, MELEE_WEAPONS, RANGED_WEAPONS,
    THROWABLES, THROW_RANGE, THROW_CONE, HOMING_TURN_RATE, SMOKE_BLIND_RADIUS, ENEMY_TYPES,
    sumWeaponUpgrades, allWeaponUpgradesOwned, pickEnemyType, zoneName,
    clamp, rand, randInt, dist, nextEntityId, createRunState, normalizeRun,
    setSound, FloatingText, Projectile, Pickup, Bomb, Player, Enemy,
    RemoteInputState, Simulation,
  };
}
