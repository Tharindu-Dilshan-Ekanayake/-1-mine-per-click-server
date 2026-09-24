import { ArraySchema, MapSchema, schema, t } from '@colyseus/schema'

/** One piece of loot sitting in a player's backpack. */
export const BagItem = schema(
  {
    kind: t.string(),
    value: t.float64(),
  },
  'BagItem',
)

/** One active quest. Claimable once progress >= target. */
export const Quest = schema(
  {
    type: t.string(),
    target: t.float64(),
    progress: t.float64(),
    cash: t.float64(),
    tokens: t.uint16(),
  },
  'Quest',
)

export const Player = schema(
  {
    name: t.string(),
    /** Bloxity equipped-cosmetics JSON, so other clients can build this avatar. */
    avatar: t.string(),

    // Transform, reported by the owning client.
    x: t.float32(),
    y: t.float32(),
    z: t.float32(),
    ry: t.float32(),
    spd: t.float32(),
    air: t.boolean(),

    // Progress (server-authoritative).
    strength: t.float64(),
    cash: t.float64(),
    tokens: t.float64(),
    /** Premium currency: bought through the hosting platform, never earned in-game. */
    bux: t.float64(),
    rebirths: t.uint32(),
    /** Floors broken on the current trip. Resets to 0 whenever you surface. */
    mined: t.uint16(),
    /** Deepest stage room ever reached. */
    best: t.uint16(),
    /** Remaining HP of the barrier at index `mined`. */
    barrierHp: t.float64(),
    /** First-time guide step (0 = just started, TUTORIAL_DONE = finished/skipped). */
    tut: t.uint8(),

    pickaxe: t.string(),
    aura: t.string(),
    ownedPickaxes: t.array('string'),
    ownedAuras: t.array('string'),
    /** Training pads bought (free pads are always usable). */
    pads: t.array('string'),
    /** Equipped backpack and every backpack owned. */
    bagType: t.string(),
    ownedBags: t.array('string'),
    quests: t.array(Quest),

    bagLvl: t.uint8(),
    speedLvl: t.uint8(),
    sellLvl: t.uint8(),
    powerLvl: t.uint8(),
    bag: t.array(BagItem),

    /** Unix ms when the free gift can next be claimed. */
    giftAt: t.float64(),
  },
  'Player',
)

/** A loot item lying on a stage floor. */
export const WorldItem = schema(
  {
    kind: t.string(),
    stage: t.uint8(),
    x: t.float32(),
    z: t.float32(),
    value: t.float64(),
  },
  'WorldItem',
)

export const MineState = schema(
  {
    players: t.map(Player),
    items: t.map(WorldItem),
    /** Seconds until the next timed rare spawn. */
    legendaryIn: t.uint16(),
    mythicIn: t.uint16(),
    secretIn: t.uint16(),
    /** JSON: { strength: [[name, value]], cash: [...], rebirths: [...] } */
    leaderboard: t.string(),
  },
  'MineState',
)

export { ArraySchema, MapSchema }
