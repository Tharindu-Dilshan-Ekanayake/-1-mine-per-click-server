/**
 * Shared game configuration — the single source of truth for world layout and
 * balance. The server imports it to validate every action; the client keeps an
 * identical copy at `client/src/shared/gameConfig.js` to build the world.
 *
 * KEEP BOTH COPIES IN SYNC (run `npm run sync-config` in the server folder).
 *
 * Progression in one paragraph: every trip starts at the surface with all floors
 * sealed. Each floor takes ~15-35 hits with the weakest pickaxe that can dig it
 * (damage = pickaxe dmg x (1 + sqrt(strength)), never more than 1/3 of a floor),
 * so going deeper needs both strength (train on pads) and money (sell loot, buy
 * better pickaxes). Deeper stages pay ~2.9x more per item and roll rarer loot, so each
 * new stage is worth the grind to reach it. Early stages deliberately hold only
 * cheap loot: nothing up top can pay for a late-game pickaxe.
 */

/* ------------------------------------------------------------------------ */
/* Lobby                                                                     */
/* ------------------------------------------------------------------------ */

export const MAX_PLAYERS = 8
export const ROOM_NAME = 'mine'

/* ------------------------------------------------------------------------ */
/* World layout (world units, player is ~1.8 tall)                           */
/* ------------------------------------------------------------------------ */

export const WORLD_HALF = 48
export const SPAWN = { x: 0, y: 1, z: 8 }

/** The mining pit on the surface. Its floor IS the first barrier. */
export const PIT = { x: 0, z: -26, size: 12 }
/** Shaft wall thickness; holes in floors/ceilings are cut this much wider. */
export const SHAFT_WALL = 1

/** Each stage is this much deeper than the previous one. */
export const STAGE_DEPTH = 20
/** Barriers per stage (the three "floors" you dig through). */
export const BARRIERS_PER_STAGE = 3
/** Vertical distance between the tops of consecutive barriers in one shaft. */
export const BARRIER_GAP = 5
export const BARRIER_THICK = 1
/** Every stage room sits this far further along -Z than the previous one. */
export const STAGE_STEP_Z = 30
/** Stage room footprint relative to where you land in it. */
export const ROOM = { halfWidth: 11, back: 9, front: 37, height: 9 }

export const stageTopY = (stage) => -(stage - 1) * STAGE_DEPTH
export const stagePitZ = (stage) => PIT.z - (stage - 1) * STAGE_STEP_Z
/** Floor of the room you land in after clearing a stage's three barriers. */
export const roomFloorY = (stage) => stageTopY(stage) - STAGE_DEPTH
export const roomCeilingY = (stage) =>
  stageTopY(stage) - (BARRIERS_PER_STAGE - 1) * BARRIER_GAP - BARRIER_THICK

/** Global barrier index k (0-based) -> where it lives. */
export function barrierInfo(k) {
  const stage = Math.floor(k / BARRIERS_PER_STAGE) + 1
  const layer = k % BARRIERS_PER_STAGE
  return {
    stage,
    layer,
    topY: stageTopY(stage) - layer * BARRIER_GAP,
    x: PIT.x,
    z: stagePitZ(stage),
    hp: barrierHp(k),
    pickaxe: stagePickaxe(stage),
  }
}

/**
 * Strength a player is expected to have when they first reach `stage`. Only
 * used to size floor HP; real players can be above or below it.
 */
export const typicalStrength = (stage) => 30 * Math.pow(6, stage - 1)

/** Hits a floor should take with the stage's minimum pickaxe at typical strength. */
export const targetHits = (stage) => 15 + stage

/**
 * Floor HP. Stage 1 is a short warm-up; after that each floor is sized to take
 * `targetHits` swings with the weakest pickaxe that can dig it, so reaching a new
 * stage always means a real dig, and a better pickaxe is what makes it faster.
 */
export function barrierHp(k) {
  const stage = Math.floor(k / BARRIERS_PER_STAGE) + 1
  const layer = k % BARRIERS_PER_STAGE
  const layerMult = 1 + 0.5 * layer
  if (stage === 1) return Math.round(30 * layerMult)
  const perHit = stagePickaxe(stage).dmg * (1 + Math.sqrt(typicalStrength(stage)))
  return Math.round(targetHits(stage) * perHit * layerMult)
}

/** A single hit never takes more than this share of a floor: 3+ hits minimum. */
export const MAX_HIT_SHARE = 1 / 3

/**
 * Damage of one swing: pickaxe damage scaled by the square root of strength, so
 * training helps but with diminishing returns — the pickaxe is the big upgrade.
 * Pass `floorHp` (the floor's full HP) to apply the minimum-hits cap.
 */
export function hitDamage(p, floorHp = Infinity) {
  const pick = PICKAXE_BY_ID[p.pickaxe] || PICKAXES[0]
  const raw = pick.dmg * (1 + Math.sqrt(Math.max(0, p.strength || 0)))
  return Math.min(raw, floorHp * MAX_HIT_SHARE)
}

/** The stage a player is standing in, from their Y (0 = surface). */
export function stageAtY(y) {
  if (y > -2) return 0
  return Math.min(STAGES.length, Math.max(1, Math.ceil((-y - 0.5) / STAGE_DEPTH)))
}

/** Tiny deterministic RNG so server and client derive the same layouts. */
function seeded(seed) {
  let s = seed % 2147483647
  if (s <= 0) s += 2147483646
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}

/**
 * Obstacles inside a stage room, relative to the room (x, z world coords; the
 * room floor is y = 0). Deeper rooms get more pillars, then partition walls with
 * a single gap you have to find.
 */
export function roomObstacles(stage) {
  const rnd = seeded(stage * 9301 + 49297)
  const zc = stagePitZ(stage)
  const list = []

  const walls = stage >= 7 ? Math.min(3, Math.floor((stage - 3) / 4)) : 0
  const wallZs = []
  for (let i = 0; i < walls; i++) {
    const z = zc - 11 - i * 5.5
    wallZs.push(z)
    const gapX = -6 + rnd() * 12
    const gap = 4.2
    const left = [-ROOM.halfWidth, gapX - gap / 2]
    const right = [gapX + gap / 2, ROOM.halfWidth]
    for (const [x0, x1] of [left, right]) {
      if (x1 - x0 > 0.5) list.push({ x: (x0 + x1) / 2, z, w: x1 - x0, d: 1, h: ROOM.height, kind: 'wall' })
    }
  }

  const pillars = stage >= 2 ? Math.min(8, 1 + Math.floor(stage / 2)) : 0
  let tries = 0
  while (list.filter((o) => o.kind === 'pillar').length < pillars && tries++ < 80) {
    const x = -8 + rnd() * 16
    const z = zc + 5 - rnd() * 27
    const s = 1.6 + rnd() * 1.2
    const nearLanding = Math.abs(x) < 7.5 && Math.abs(z - zc) < 7.5
    const nearWall = wallZs.some((wz) => Math.abs(z - wz) < s / 2 + 1.6)
    const nearOther = list.some((o) => Math.hypot(o.x - x, o.z - z) < 4 && o.kind === 'pillar')
    if (nearLanding || nearWall || nearOther) continue
    list.push({ x, z, w: s, d: s, h: ROOM.height, kind: 'pillar' })
  }
  return list
}

/** True when (x, z) is inside (or within `margin` of) a room obstacle. */
export function insideObstacle(stage, x, z, margin = 0.8) {
  return roomObstacles(stage).some(
    (o) => Math.abs(x - o.x) < o.w / 2 + margin && Math.abs(z - o.z) < o.d / 2 + margin,
  )
}

/* ------------------------------------------------------------------------ */
/* Rarities                                                                  */
/* ------------------------------------------------------------------------ */

export const RARITIES = {
  Common: { color: '#ffffff' },
  Uncommon: { color: '#3dff5a' },
  Rare: { color: '#3fa9ff' },
  Epic: { color: '#c054ff' },
  Legendary: { color: '#ffb400' },
  Mythic: { color: 'rainbow' },
  Secret: { color: '#111111' },
  Divine: { color: '#ff6a00' },
}
export const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic', 'Secret', 'Divine']

/** Spawn weight of a rarity in a given stage: deeper stages roll rarer loot. */
export function rarityWeight(rarity, stage) {
  switch (rarity) {
    case 'Common':
      return Math.max(18, 62 - 2.2 * stage)
    case 'Uncommon':
      return 26
    case 'Rare':
      return stage < 2 ? 0 : 9 + stage * 1.1
    case 'Epic':
      return stage < 4 ? 1 : 2 + stage * 0.6
    case 'Legendary':
      return stage >= 11 ? (stage - 10) * 0.9 : 0
    default:
      return 0
  }
}

/* ------------------------------------------------------------------------ */
/* Stages and their loot                                                     */
/* ------------------------------------------------------------------------ */

// shape: ore | gem | bar | duck | orb | crate | skull | gear
const item = (id, name, rarity, base, color, shape = 'ore') => ({
  id,
  name,
  rarity,
  base,
  color,
  shape,
})

export const STAGES = [
  {
    name: 'Dirt Cavern',
    wall: '#e8742a',
    floor: '#f08a3c',
    accent: '#b9b9d6',
    items: [
      item('rock', 'Rock', 'Common', 4, '#8e8e99'),
      item('coal', 'Coal', 'Common', 5.5, '#2b2b33'),
      item('duck', 'Rubber Duck', 'Common', 7, '#ffd92e', 'duck'),
      item('copper', 'Copper Chunk', 'Uncommon', 12, '#d9793b'),
    ],
  },
  {
    name: 'Stone Depths',
    wall: '#8c8fa3',
    floor: '#a3a6b8',
    accent: '#5b5e70',
    items: [
      item('iron', 'Iron Ore', 'Common', 4, '#c9b8a8'),
      item('flint', 'Flint', 'Common', 5.5, '#56575e'),
      item('fossil', 'Fossil', 'Uncommon', 12, '#e9dcc0', 'skull'),
      item('silver', 'Silver Bar', 'Rare', 28, '#dfe6ee', 'bar'),
      item('geode', 'Geode', 'Epic', 65, '#9a5cff', 'orb'),
    ],
  },
  {
    name: 'Frozen Caves',
    wall: '#8fd3ff',
    floor: '#c9ecff',
    accent: '#4aa6e8',
    items: [
      item('ice', 'Ice Chunk', 'Common', 4, '#bdf0ff', 'gem'),
      item('snowball', 'Snowball', 'Common', 5.5, '#ffffff', 'orb'),
      item('frostore', 'Frost Ore', 'Uncommon', 12, '#5ec8ff'),
      item('sapphire', 'Sapphire', 'Rare', 28, '#1f5bff', 'gem'),
      item('icecrown', 'Ice Crown', 'Epic', 65, '#a8f6ff', 'crate'),
    ],
  },
  {
    name: 'Crystal Grotto',
    wall: '#8f55d6',
    floor: '#a877e6',
    accent: '#ff7cf2',
    items: [
      item('amethyst', 'Amethyst', 'Common', 4, '#b273ff', 'gem'),
      item('quartz', 'Quartz', 'Common', 5.5, '#f2e6ff', 'gem'),
      item('prism', 'Prism Shard', 'Uncommon', 12, '#ff9df5', 'gem'),
      item('crystalorb', 'Crystal Orb', 'Rare', 28, '#e0a3ff', 'orb'),
      item('starcore', 'Star Core', 'Epic', 65, '#fff27a', 'orb'),
    ],
  },
  {
    name: 'Jungle Ruins',
    wall: '#3f9c45',
    floor: '#63b85a',
    accent: '#9a6b3c',
    items: [
      item('vine', 'Vine Bundle', 'Common', 4, '#2e8b3a', 'crate'),
      item('idol', 'Clay Idol', 'Common', 5.5, '#b0703e', 'skull'),
      item('jade', 'Jade', 'Uncommon', 12, '#27d67a', 'gem'),
      item('goldidol', 'Golden Idol', 'Rare', 28, '#ffcf30', 'skull'),
      item('emerald', 'Emerald', 'Epic', 65, '#00e05a', 'gem'),
    ],
  },
  {
    name: 'Magma Core',
    wall: '#b8341f',
    floor: '#d94a2a',
    accent: '#ffb02e',
    items: [
      item('basalt', 'Basalt', 'Common', 4, '#3a2a2a'),
      item('obsidian', 'Obsidian', 'Common', 5.5, '#1b1030', 'gem'),
      item('magmarock', 'Magma Rock', 'Uncommon', 12, '#ff5a1f'),
      item('ruby', 'Ruby', 'Rare', 28, '#ff1f48', 'gem'),
      item('phoenix', 'Phoenix Egg', 'Epic', 65, '#ff8a00', 'orb'),
    ],
  },
  {
    name: 'Gold Vault',
    wall: '#d9a21e',
    floor: '#f2c23a',
    accent: '#8a5a12',
    items: [
      item('goldnug', 'Gold Nugget', 'Common', 4, '#ffd23a'),
      item('coinpile', 'Coin Pile', 'Common', 5.5, '#ffbf1f', 'crate'),
      item('goldbar', 'Gold Bar', 'Uncommon', 12, '#ffc400', 'bar'),
      item('crown', 'Royal Crown', 'Rare', 28, '#ffe066', 'crate'),
      item('chalice', 'Golden Chalice', 'Epic', 65, '#fff09a', 'orb'),
    ],
  },
  {
    name: 'Toxic Mines',
    wall: '#5a9e1a',
    floor: '#7cc427',
    accent: '#d5ff2e',
    items: [
      item('sludge', 'Sludge', 'Common', 4, '#7fbf1f', 'orb'),
      item('barrel', 'Toxic Barrel', 'Common', 5.5, '#e6e020', 'crate'),
      item('acid', 'Acid Ore', 'Uncommon', 12, '#9dff1f'),
      item('uranium', 'Uranium', 'Rare', 28, '#6bff3a', 'bar'),
      item('mutant', 'Mutant Skull', 'Epic', 65, '#bfff5a', 'skull'),
    ],
  },
  {
    name: 'Void Abyss',
    wall: '#2a1f45',
    floor: '#3a2d5c',
    accent: '#8a5cff',
    items: [
      item('voidstone', 'Void Stone', 'Common', 4, '#2d1b4d'),
      item('shadow', 'Shadow Shard', 'Common', 5.5, '#4b2d80', 'gem'),
      item('darkmatter', 'Dark Matter', 'Uncommon', 12, '#1a0d33', 'orb'),
      item('nebula', 'Nebula Gem', 'Rare', 28, '#ff4dd2', 'gem'),
      item('blackhole', 'Black Hole', 'Epic', 65, '#0a0014', 'orb'),
    ],
  },
  {
    name: 'Candy Land',
    wall: '#ff8ac8',
    floor: '#ffb3dc',
    accent: '#7ee8ff',
    items: [
      item('gummy', 'Gummy Rock', 'Common', 4, '#ff5aa5'),
      item('lolli', 'Lollipop', 'Common', 5.5, '#ff3d7a', 'orb'),
      item('choco', 'Chocolate Bar', 'Uncommon', 12, '#7a3f1d', 'bar'),
      item('candygem', 'Candy Gem', 'Rare', 28, '#7ee8ff', 'gem'),
      item('cake', 'Mega Cake', 'Epic', 65, '#fff0f6', 'crate'),
    ],
  },
  {
    name: 'Heaven Rift',
    wall: '#e6ecff',
    floor: '#ffffff',
    accent: '#ffe27a',
    items: [
      item('cloud', 'Cloud Puff', 'Common', 4, '#f5f8ff', 'orb'),
      item('feather', 'Angel Feather', 'Common', 5.5, '#fffbe6', 'bar'),
      item('halo', 'Halo', 'Uncommon', 12, '#ffe27a', 'crate'),
      item('seraph', 'Seraph Gem', 'Rare', 28, '#fff6b0', 'gem'),
      item('holygrail', 'Holy Grail', 'Epic', 65, '#ffd54a', 'orb'),
      item('angelwing', 'Archangel Wing', 'Legendary', 150, '#fffbe6', 'bar'),
    ],
  },
  {
    name: 'Chaos Realm',
    wall: '#1a0a0a',
    floor: '#2e0f0f',
    accent: '#ff2020',
    items: [
      item('chaosrock', 'Chaos Rock', 'Common', 4, '#3a0d0d'),
      item('bloodgem', 'Blood Gem', 'Common', 5.5, '#b3001b', 'gem'),
      item('chaoscore', 'Chaos Core', 'Uncommon', 12, '#ff2a2a', 'orb'),
      item('demonskull', 'Demon Skull', 'Rare', 28, '#5c0000', 'skull'),
      item('chaosruin', 'Chaos Ruin', 'Epic', 65, '#ff0033', 'gem'),
      item('chaoscrown', 'Chaos Crown', 'Legendary', 150, '#ff0033', 'crate'),
    ],
  },
  {
    name: 'Mushroom Grove',
    wall: '#5b3d8f',
    floor: '#7a5bb5',
    accent: '#ff6fb5',
    items: [
      item('sporerock', 'Spore Rock', 'Common', 4, '#8a6fc7'),
      item('glowcap', 'Glow Cap', 'Common', 5.5, '#ff6fb5', 'orb'),
      item('truffle', 'Golden Truffle', 'Uncommon', 12, '#c9a24a', 'orb'),
      item('moonshroom', 'Moonshroom Gem', 'Rare', 28, '#b0fff0', 'gem'),
      item('fungalcrown', 'Fungal Crown', 'Epic', 65, '#ff6fb5', 'crate'),
      item('spiritshroom', 'Spirit Mushroom', 'Legendary', 150, '#ffe0ff', 'gem'),
    ],
  },
  {
    name: 'Coral Reef',
    wall: '#1f7fae',
    floor: '#2fa9d6',
    accent: '#ff8a6b',
    items: [
      item('seaglass', 'Sea Glass', 'Common', 4, '#9ff5e0', 'gem'),
      item('shell', 'Conch Shell', 'Common', 5.5, '#ffd6c9', 'orb'),
      item('pearl', 'Giant Pearl', 'Uncommon', 12, '#fff5f0', 'orb'),
      item('coralcrown', 'Coral Crown', 'Rare', 28, '#ff6b6b', 'crate'),
      item('trident', 'Trident Shard', 'Epic', 65, '#4de0ff', 'bar'),
      item('krakeneye', 'Kraken Eye', 'Legendary', 150, '#00ffcc', 'orb'),
    ],
  },
  {
    name: 'Clockwork Factory',
    wall: '#8a5a2b',
    floor: '#b07a3c',
    accent: '#ffd166',
    items: [
      item('brassgear', 'Brass Gear', 'Common', 4, '#d9a441', 'gear'),
      item('coil', 'Copper Coil', 'Common', 5.5, '#c56a33', 'bar'),
      item('steamcore', 'Steam Core', 'Uncommon', 12, '#ffb347', 'orb'),
      item('clockheart', 'Clockwork Heart', 'Rare', 28, '#ff4d4d', 'gem'),
      item('goldcog', 'Golden Cog', 'Epic', 65, '#ffd23a', 'gear'),
      item('chrono', 'Chrono Engine', 'Legendary', 150, '#7df9ff', 'orb'),
    ],
  },
  {
    name: 'Neon City',
    wall: '#1b1035',
    floor: '#2b1a55',
    accent: '#00f0ff',
    items: [
      item('neontube', 'Neon Tube', 'Common', 4, '#ff2ea6', 'bar'),
      item('chip', 'Circuit Chip', 'Common', 5.5, '#2ecc71', 'crate'),
      item('holocube', 'Holo Cube', 'Uncommon', 12, '#00f0ff', 'gem'),
      item('plasma', 'Plasma Cell', 'Rare', 28, '#ff00ff', 'orb'),
      item('cyberskull', 'Cyber Skull', 'Epic', 65, '#00f0ff', 'skull'),
      item('quantum', 'Quantum Core', 'Legendary', 150, '#ffffff', 'orb'),
    ],
  },
  {
    name: 'Frost Giant Tomb',
    wall: '#274b73',
    floor: '#3a6fa3',
    accent: '#bff6ff',
    items: [
      item('permafrost', 'Permafrost', 'Common', 4, '#bfe9ff'),
      item('frozenbone', 'Frozen Bone', 'Common', 5.5, '#e8f7ff', 'skull'),
      item('runestone', 'Rune Stone', 'Uncommon', 12, '#7fb8ff'),
      item('gianttooth', "Giant's Tooth", 'Rare', 28, '#f0ffff', 'gem'),
      item('frostcrown', 'Frost Giant Crown', 'Epic', 65, '#9ff0ff', 'crate'),
      item('eternalice', 'Eternal Ice', 'Legendary', 150, '#66e0ff', 'gem'),
    ],
  },
  {
    name: 'Dragon Lair',
    wall: '#5c0f0f',
    floor: '#7a1a1a',
    accent: '#ffb400',
    items: [
      item('dragonscale', 'Dragon Scale', 'Common', 4, '#ff4d1a', 'gem'),
      item('embercoin', 'Ember Coins', 'Common', 5.5, '#ffb400', 'crate'),
      item('dragonbone', 'Dragon Bone', 'Uncommon', 12, '#f4e4c1', 'skull'),
      item('dragonheart', 'Dragon Heart', 'Rare', 28, '#ff0033', 'gem'),
      item('hoardchest', 'Hoard Chest', 'Epic', 65, '#b8860b', 'crate'),
      item('dragoneggprime', 'Prime Dragon Egg', 'Legendary', 150, '#ff7b00', 'orb'),
    ],
  },
  {
    name: 'Starfield',
    wall: '#0b0b24',
    floor: '#15153a',
    accent: '#b3a1ff',
    items: [
      item('moonrock', 'Moon Rock', 'Common', 4, '#c9c9d9'),
      item('stardust', 'Stardust', 'Common', 5.5, '#fff6a8', 'orb'),
      item('comet', 'Comet Shard', 'Uncommon', 12, '#8fd3ff', 'gem'),
      item('nebulaorb', 'Nebula Orb', 'Rare', 28, '#c86bff', 'orb'),
      item('starfrag', 'Star Fragment', 'Epic', 65, '#fff27a', 'gem'),
      item('supernova', 'Supernova', 'Legendary', 150, '#ffffff', 'orb'),
    ],
  },
  {
    name: 'The Core',
    wall: '#ffe7a8',
    floor: '#ffd36b',
    accent: '#ff8c00',
    items: [
      item('coremagma', 'Core Magma', 'Common', 4, '#ff6a00'),
      item('puregold', 'Pure Gold', 'Common', 5.5, '#ffd700', 'bar'),
      item('corecrystal', 'Core Crystal', 'Uncommon', 12, '#fff7d6', 'gem'),
      item('worldheart', 'Heart of the World', 'Rare', 28, '#ff3b3b', 'orb'),
      item('genesis', 'Genesis Stone', 'Epic', 65, '#ffffff', 'gem'),
      item('worldseed', 'World Seed', 'Legendary', 150, '#7dff7d', 'orb'),
    ],
  },
]

/**
 * Timed world events: a special item drops into a random stage the lobby can
 * reach. They only land deep (minStage and below), and their value scales with
 * that stage like any other loot - a jackpot, but never one that skips the early
 * game. If nobody has reached minStage yet, the drop is skipped.
 */
export const EVENT_ITEMS = {
  Legendary: {
    every: 180,
    minStage: 4,
    items: [
      item('dragonegg', 'Dragon Egg', 'Legendary', 180, '#ffb400', 'orb'),
      item('kingsword', "King's Sword", 'Legendary', 200, '#ffd76a', 'bar'),
    ],
  },
  Mythic: {
    every: 360,
    minStage: 8,
    items: [
      item('rainbowore', 'Rainbow Ore', 'Mythic', 420, '#ff4dd2'),
      item('unicorn', 'Unicorn Horn', 'Mythic', 480, '#bdf3ff', 'gem'),
    ],
  },
  Secret: {
    every: 1200,
    minStage: 12,
    items: [
      item('acidore', 'Acid Ore', 'Secret', 1000, '#39ff14'),
      item('chaosruin_s', 'Chaos Ruin', 'Divine', 1400, '#ff3300', 'gem'),
    ],
  },
}

/** Item value multiplier by depth. */
export const stageValueMult = (stage) => Math.pow(2.9, stage - 1)

/** Every item definition by id, for lookups on both sides. */
export const ITEMS_BY_ID = (() => {
  const map = {}
  STAGES.forEach((s) => s.items.forEach((i) => (map[i.id] = i)))
  Object.values(EVENT_ITEMS).forEach((e) => e.items.forEach((i) => (map[i.id] = i)))
  return map
})()

/** Which stage an item belongs to (0 for world-event items). */
export const ITEM_STAGE = (() => {
  const map = {}
  STAGES.forEach((s, i) => s.items.forEach((it) => (map[it.id] = i + 1)))
  return map
})()

export const ITEMS_PER_STAGE = 7
export const PICKUP_RANGE = 6

/**
 * Collection bonus: every stage whose items are all in your Index adds +10% to
 * everything you sell.
 */
export function completedStages(discovered) {
  const found = discovered instanceof Set ? discovered : new Set(discovered)
  return STAGES.filter((s) => s.items.every((i) => found.has(i.id))).length
}
export const indexBonus = (discovered) => 1 + 0.1 * completedStages(discovered)

/**
 * Roughly what one full trip to `stage` is worth. Used to scale quest and gift
 * rewards so they stay meaningful at every depth.
 */
export function tripValue(stage) {
  const s = Math.min(STAGES.length, Math.max(1, stage))
  const items = STAGES[s - 1].items
  const weights = items.map((i) => rarityWeight(i.rarity, s))
  const total = weights.reduce((x, y) => x + y, 0)
  const perItem = items.reduce((sum, i, j) => sum + i.base * weights[j], 0) / total
  return Math.round(perItem * stageValueMult(s) * (3 + s))
}

/* ------------------------------------------------------------------------ */
/* Pickaxes: dmg = mining damage per hit, power = strength gained per click.   */
/* Each stage needs a minimum pickaxe to dig at all.                          */
/* ------------------------------------------------------------------------ */

export const PICKAXES = [
  { id: 'wood', name: 'Wood', rarity: 'Common', dmg: 1, power: 1, cost: 0, head: '#c0672b', handle: '#7a4520' },
  { id: 'stone', name: 'Stone', rarity: 'Common', dmg: 3, power: 2, cost: 400, head: '#a7b0bf', handle: '#7a4520' },
  { id: 'copper', name: 'Copper', rarity: 'Common', dmg: 8, power: 4, cost: 3000, head: '#d9793b', handle: '#7a4520' },
  { id: 'iron', name: 'Iron', rarity: 'Uncommon', dmg: 20, power: 8, cost: 26000, head: '#dcd6cf', handle: '#5a3a1a' },
  { id: 'gold', name: 'Gold', rarity: 'Uncommon', dmg: 50, power: 16, cost: 150000, head: '#ffcc2e', handle: '#5a3a1a' },
  { id: 'diamond', name: 'Diamond', rarity: 'Rare', dmg: 130, power: 35, cost: 2.3e6, head: '#5ef0ff', handle: '#5a3a1a' },
  { id: 'emerald', name: 'Emerald', rarity: 'Rare', dmg: 350, power: 75, cost: 1.1e7, head: '#22e36b', handle: '#4a2f14' },
  { id: 'ruby', name: 'Ruby', rarity: 'Epic', dmg: 900, power: 160, cost: 4.4e7, head: '#ff2d55', handle: '#3a2410' },
  { id: 'sapphire', name: 'Sapphire', rarity: 'Epic', dmg: 2400, power: 350, cost: 1.7e8, head: '#2d6bff', handle: '#3a2410' },
  { id: 'obsidian', name: 'Obsidian', rarity: 'Epic', dmg: 6500, power: 750, cost: 2.9e9, head: '#3b1e6e', handle: '#1e1e1e' },
  { id: 'magma', name: 'Magma', rarity: 'Legendary', dmg: 18000, power: 1600, cost: 1.1e10, head: '#ff5a1f', handle: '#2a0f05' },
  { id: 'crystal', name: 'Crystal', rarity: 'Legendary', dmg: 50000, power: 3500, cost: 4.2e10, head: '#e0a3ff', handle: '#3a2a5a' },
  { id: 'void', name: 'Void', rarity: 'Legendary', dmg: 140000, power: 7500, cost: 1.9e11, head: '#8a5cff', handle: '#0a0014' },
  { id: 'cosmic', name: 'Cosmic', rarity: 'Mythic', dmg: 400000, power: 16000, cost: 2.2e12, head: '#ff4dd2', handle: '#2a0a4a' },
  { id: 'chaos', name: 'Chaos', rarity: 'Mythic', dmg: 1200000, power: 35000, cost: 9.5e12, head: '#ff1a1a', handle: '#111111' },
  { id: 'divine', name: 'Divine', rarity: 'Divine', dmg: 3500000, power: 80000, cost: 3.5e13, head: '#fff2a8', handle: '#ffb400' },
]
export const PICKAXE_BY_ID = Object.fromEntries(PICKAXES.map((p) => [p.id, p]))
export const pickaxeIndex = (id) => Math.max(0, PICKAXES.findIndex((p) => p.id === id))

/** The weakest pickaxe that can dig a stage's floors. */
export function stagePickaxe(stage) {
  return PICKAXES[Math.min(PICKAXES.length - 1, Math.floor((stage - 1) * 0.8))]
}

/** First stage that needs this pickaxe (null if none does). */
export function pickaxeOpensStage(id) {
  for (let s = 1; s <= STAGES.length; s++) if (stagePickaxe(s).id === id) return s
  return null
}

/* ------------------------------------------------------------------------ */
/* Auras (strength multiplier, bought with rebirth tokens)                   */
/* ------------------------------------------------------------------------ */

export const AURAS = [
  { id: 'none', name: 'None', mult: 1, cost: 0, color: '#ffffff' },
  { id: 'spark', name: 'Spark', mult: 1.5, cost: 1, color: '#fff27a' },
  { id: 'flame', name: 'Flame', mult: 2, cost: 3, color: '#ff4a1f' },
  { id: 'frost', name: 'Frost', mult: 3, cost: 8, color: '#5ec8ff' },
  { id: 'toxic', name: 'Toxic', mult: 5, cost: 20, color: '#6bff3a' },
  { id: 'void', name: 'Void', mult: 8, cost: 50, color: '#8a5cff' },
  { id: 'rainbow', name: 'Rainbow', mult: 15, cost: 120, color: '#ff4dd2' },
  { id: 'celestial', name: 'Celestial', mult: 30, cost: 300, color: '#fff6c2' },
]
export const AURA_BY_ID = Object.fromEntries(AURAS.map((a) => [a.id, a]))

/* ------------------------------------------------------------------------ */
/* Backpacks (worn on your back; bigger = more loot per trip)                */
/* ------------------------------------------------------------------------ */

// price: cash, or bux when `bux` is set. Bux is the premium currency: never
// earned in-game, only bought through the hosting platform (not wired up yet).
// style: body / trim / accent colours for the 3D model; glow for premium bags.
export const BAGS = [
  { id: 'starter', name: 'Starter Sack', cap: 3, cost: 0, body: '#9a6b3c', trim: '#6b4423', accent: '#c9a36b' },
  { id: 'leather', name: 'Leather Pack', cap: 5, cost: 800, body: '#8a4a1f', trim: '#4a2410', accent: '#d9a441' },
  { id: 'miner', name: "Miner's Pack", cap: 8, cost: 40000, body: '#e0782c', trim: '#3a3a44', accent: '#ffd23a' },
  { id: 'steel', name: 'Steel Case', cap: 12, cost: 3e6, body: '#9aa3b5', trim: '#4a5060', accent: '#dfe6ee' },
  { id: 'crystal', name: 'Crystal Pack', cap: 18, cost: 2e8, body: '#b273ff', trim: '#5a2d99', accent: '#f2e6ff' },
  { id: 'dragon', name: 'Dragon Hoard', cap: 26, cost: 3e10, body: '#b8201a', trim: '#3a0a08', accent: '#ffb400' },
  { id: 'void', name: 'Void Pouch', cap: 36, cost: 5e12, body: '#2a1f45', trim: '#0a0014', accent: '#8a5cff' },
  { id: 'rainbow', name: 'Rainbow Pack', cap: 10, bux: 60, body: '#ff4dd2', trim: '#3fa9ff', accent: '#fff27a', glow: 0.5 },
  { id: 'golden', name: 'Golden Chest Pack', cap: 20, bux: 200, body: '#ffc21f', trim: '#8a5a12', accent: '#fff09a', glow: 0.4 },
  { id: 'galaxy', name: 'Galaxy Bag', cap: 32, bux: 600, body: '#15153a', trim: '#b3a1ff', accent: '#7ee8ff', glow: 0.8 },
]
export const BAG_BY_ID = Object.fromEntries(BAGS.map((b) => [b.id, b]))

/* ------------------------------------------------------------------------ */
/* Upgrades (bought with cash)                                               */
/* ------------------------------------------------------------------------ */

export const UPGRADES = {
  bag: { name: 'Extra Pockets', desc: '+1 slot on any backpack', max: 15, base: 150, growth: 2.4, icon: '🎒' },
  speed: { name: 'Walk Speed', desc: '+6% move speed', max: 10, base: 100, growth: 2.2, icon: '👟' },
  sell: { name: 'Sell Price', desc: '+15% loot value', max: 15, base: 300, growth: 2.6, icon: '💰' },
  power: { name: 'Strength Gain', desc: '+20% strength per click', max: 20, base: 250, growth: 2.5, icon: '💪' },
}
export const upgradeCost = (key, level) =>
  Math.round(UPGRADES[key].base * Math.pow(UPGRADES[key].growth, level))

/** Loot slots: the equipped backpack's size plus the Backpack upgrade's extra slots. */
export const bagCapacity = (p) => (BAG_BY_ID[p?.bagType] || BAGS[0]).cap + (p?.bagLvl || 0)
export const speedMult = (speedLvl) => 1 + 0.06 * speedLvl
export const sellMult = (sellLvl) => 1 + 0.15 * sellLvl
export const powerMult = (powerLvl) => 1 + 0.2 * powerLvl

/* ------------------------------------------------------------------------ */
/* Rebirth                                                                   */
/* ------------------------------------------------------------------------ */

export const rebirthCost = (rebirths) => Math.round(20000 * Math.pow(6, rebirths))
export const rebirthMult = (rebirths) => 1 + 0.5 * rebirths
/** Tokens granted for performing rebirth number `rebirths + 1`. */
export const rebirthTokens = (rebirths) => 1 + rebirths

/* ------------------------------------------------------------------------ */
/* Training pads: buy once (press E), then stand on them to auto-train        */
/* ------------------------------------------------------------------------ */

export const TRAINING_ZONES = [
  { id: 't1', mult: 1.5, cost: 0, rebirths: 0, crystal: '#9aa3ff' },
  { id: 't2', mult: 4, cost: 300, rebirths: 0, crystal: '#ff4dd2' },
  { id: 't3', mult: 10, cost: 12000, rebirths: 0, crystal: '#ffcc2e' },
  { id: 't4', mult: 25, cost: 300000, rebirths: 1, crystal: '#ff2d2d' },
  { id: 't5', mult: 75, cost: 8e6, rebirths: 2, crystal: '#39ff14' },
  { id: 't6', mult: 250, cost: 1.5e9, rebirths: 4, crystal: '#2d6bff' },
  { id: 't7', mult: 1000, cost: 5e11, rebirths: 8, crystal: '#ff8c00' },
].map((z, i) => ({ ...z, x: -38, z: -30 + i * 10, radius: 4.4 }))

export const TRAINING_BY_ID = Object.fromEntries(TRAINING_ZONES.map((t) => [t.id, t]))
/** Swings per second while standing on a pad you own. */
export const AUTO_TRAIN_RATE = 3

export function trainingZoneAt(x, y, z) {
  if (Math.abs(y) > 4) return null
  return TRAINING_ZONES.find((t) => Math.hypot(x - t.x, z - t.z) <= t.radius) || null
}

/** Pads everyone owns without buying. */
export const FREE_PADS = TRAINING_ZONES.filter((t) => t.cost === 0 && t.rebirths === 0).map((t) => t.id)

/* ------------------------------------------------------------------------ */
/* Quests                                                                    */
/* ------------------------------------------------------------------------ */

export const QUEST_TYPES = {
  mine: { label: (t) => `Break ${t} floors`, icon: '⛏️' },
  collect: { label: (t) => `Pick up ${t} items`, icon: '🎒' },
  rare: { label: (t) => `Find ${t} Rare+ items`, icon: '💎' },
  sell: { label: (t) => `Sell $${fmt(t)} of loot`, icon: '💵' },
  train: { label: (t) => `Train ${t} times on a pad`, icon: '💪' },
  reach: { label: (t) => `Reach Stage ${t}`, icon: '🏁' },
}

/**
 * A fresh quest of `type`, sized for a player whose deepest stage is `best`.
 * Quests are a side bonus, not an income: each pays a small slice of one trip,
 * so the money for pickaxes still has to come from digging deeper.
 */
export function makeQuest(type, best, rnd = Math.random) {
  const b = Math.max(1, best)
  const reward = Math.max(1, Math.round(tripValue(b) * (0.12 + rnd() * 0.08)))
  switch (type) {
    case 'mine':
      return { type, target: 6 + b * 2, cash: reward, tokens: 0 }
    case 'collect':
      return { type, target: 5 + b, cash: reward, tokens: 0 }
    case 'rare':
      return { type, target: 1 + Math.floor(b / 4), cash: Math.round(reward * 1.3), tokens: 0 }
    case 'sell':
      return { type, target: Math.round(tripValue(b) * 2), cash: reward, tokens: 0 }
    case 'train':
      return { type, target: 100 + b * 30, cash: reward, tokens: 0 }
    case 'reach':
      return { type, target: Math.min(STAGES.length, b + 1), cash: Math.round(reward * 1.5), tokens: 1 }
    default:
      return { type: 'collect', target: 3, cash: reward, tokens: 0 }
  }
}
export const QUEST_SLOTS = 3

/* ------------------------------------------------------------------------ */
/* Surface stalls                                                            */
/* ------------------------------------------------------------------------ */

export const STALLS = [
  { id: 'sell', label: 'Sell Loot', icon: '💵', x: -10, z: -6, rotY: 0, awning: '#2fc24a' },
  { id: 'upgrades', label: 'Upgrades', icon: '⬆️', x: 10, z: -6, rotY: 0, awning: '#2f8fff' },
  { id: 'pickaxes', label: 'Pickaxes', icon: '⛏️', x: -22, z: 8, rotY: Math.PI / 2, awning: '#8fd3ff' },
  { id: 'auras', label: 'Auras', icon: '🔥', x: -22, z: -10, rotY: Math.PI / 2, awning: '#ff3b3b' },
]
export const STALL_RANGE = 6

export const CHAMPIONS = { x: 34, z: -4 }

/* ------------------------------------------------------------------------ */
/* Misc                                                                      */
/* ------------------------------------------------------------------------ */

/** The free gift: a small cash present, once a day. */
export const GIFT_COOLDOWN_S = 24 * 60 * 60
export const GIFT_CASH = 30

/** First-time guide: the step value meaning "finished or skipped". */
export const TUTORIAL_DONE = 99
export const MAX_CLICKS_PER_SECOND = 12
/** Seconds of warning before a full backpack sends you back to the lobby. */
export const BAG_FULL_RETURN_S = 3

/** Strength gained by one click, with every multiplier applied. */
export function strengthPerClick(p, zone) {
  const pick = PICKAXE_BY_ID[p.pickaxe] || PICKAXES[0]
  const aura = AURA_BY_ID[p.aura] || AURAS[0]
  return (
    pick.power *
    aura.mult *
    rebirthMult(p.rebirths) *
    powerMult(p.powerLvl) *
    (zone ? zone.mult : 1)
  )
}

/* ------------------------------------------------------------------------ */
/* Levels (derived from strength, shown on the HUD and name tags)           */
/* ------------------------------------------------------------------------ */

/** Total strength needed to reach `level` (level 1 starts at 0). */
export const levelThreshold = (level) => (level <= 1 ? 0 : Math.floor(20 * Math.pow(level - 1, 2.5)))

/** { level, into, span }: current level and progress toward the next one. */
export function levelInfo(strength) {
  const s = Math.max(0, strength || 0)
  let level = Math.floor(Math.pow(s / 20, 1 / 2.5)) + 1
  // Float error can land one off either way; nudge onto the exact threshold.
  while (levelThreshold(level + 1) <= s) level++
  while (level > 1 && levelThreshold(level) > s) level--
  const base = levelThreshold(level)
  return { level, into: s - base, span: levelThreshold(level + 1) - base }
}

/** 1234 -> "1.23K", 12000000 -> "12.0M". */
export function fmt(n) {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  const units = [
    [1e18, 'Qi'],
    [1e15, 'Qa'],
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [v, s] of units) {
    if (abs >= v) {
      const x = n / v
      return (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) + s
    }
  }
  return Math.floor(n).toString()
}
