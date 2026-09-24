import { Room } from '@colyseus/core'

import {
  AURA_BY_ID,
  BAG_BY_ID,
  BARRIERS_PER_STAGE,
  EVENT_ITEMS,
  FREE_PADS,
  GIFT_CASH,
  GIFT_COOLDOWN_S,
  ITEMS_BY_ID,
  ITEM_STAGE,
  ITEMS_PER_STAGE,
  MAX_CLICKS_PER_SECOND,
  MAX_PLAYERS,
  PICKAXE_BY_ID,
  PICKUP_RANGE,
  PIT,
  QUEST_SLOTS,
  QUEST_TYPES,
  RARITY_ORDER,
  ROOM,
  SPAWN,
  STAGES,
  STALL_RANGE,
  STALLS,
  TRAINING_BY_ID,
  TUTORIAL_DONE,
  UPGRADES,
  bagCapacity,
  barrierHp,
  barrierInfo,
  hitDamage,
  indexBonus,
  insideObstacle,
  makeQuest,
  pickaxeIndex,
  rarityWeight,
  rebirthCost,
  rebirthTokens,
  roomFloorY,
  sellMult,
  stagePitZ,
  stageValueMult,
  strengthPerClick,
  trainingZoneAt,
  upgradeCost,
} from '../shared/gameConfig.js'
import { leaderboards, loadRecord, saveRecord } from '../store.js'
import { ArraySchema, BagItem, MineState, Player, Quest, WorldItem } from './schema.js'

const TOTAL_BARRIERS = STAGES.length * BARRIERS_PER_STAGE
const RESPAWN_EVERY_S = 3
const LEADERBOARD_EVERY_S = 5
const AUTOSAVE_EVERY_S = 30
const QUEST_KINDS = Object.keys(QUEST_TYPES)
const RARE_INDEX = RARITY_ORDER.indexOf('Rare')

const rand = (min, max) => min + Math.random() * (max - min)
const finite = (n, fallback = 0) => (Number.isFinite(n) ? n : fallback)
const cleanName = (s) =>
  String(s || '')
    .replace(/[^\w .\-]/g, '')
    .trim()
    .slice(0, 20) || 'Player'

/** Deepest stage room a player can legitimately stand in on this trip. */
/** Bump when loot values change enough that old saves need fixing up on load. */
const ECONOMY_VERSION = 4

const reachableStage = (p) => Math.floor(p.mined / BARRIERS_PER_STAGE)
/** True while standing on the surface (not inside the pit shaft). */
const onSurface = (p) =>
  p.y > 0.5 &&
  !(Math.abs(p.x - PIT.x) <= PIT.size / 2 + 1 && Math.abs(p.z - PIT.z) <= PIT.size / 2 + 1)

function pickLoot(stage) {
  const items = STAGES[stage - 1].items
  const weights = items.map((i) => rarityWeight(i.rarity, stage))
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return items[i]
  }
  return items[0]
}

export class MineRoom extends Room {
  maxClients = MAX_PLAYERS

  onCreate() {
    this.setState(new MineState())
    this.state.legendaryIn = EVENT_ITEMS.Legendary.every
    this.state.mythicIn = EVENT_ITEMS.Mythic.every
    this.state.secretIn = EVENT_ITEMS.Secret.every

    /** sessionId -> server-only data (uid, click budget, discovered items...) */
    this.meta = new Map()
    this.itemSeq = 0

    for (let stage = 1; stage <= STAGES.length; stage++) {
      for (let i = 0; i < ITEMS_PER_STAGE; i++) this.spawnItem(stage)
    }
    this.updateLeaderboard()

    let tick = 0
    this.clock.setInterval(() => {
      tick++
      this.tickEvents()
      if (tick % RESPAWN_EVERY_S === 0) this.refillItems()
      if (tick % LEADERBOARD_EVERY_S === 0) this.updateLeaderboard()
      if (tick % AUTOSAVE_EVERY_S === 0) this.saveAll()
    }, 1000)

    this.onMessage('move', (client, m) => this.onMove(client, m))
    this.onMessage('click', (client) => this.onClick(client))
    this.onMessage('pickup', (client, m) => this.onPickup(client, m))
    this.onMessage('sell', (client) => this.onSell(client))
    this.onMessage('buyPickaxe', (client, m) => this.onBuyPickaxe(client, m))
    this.onMessage('equipPickaxe', (client, m) => this.onEquipPickaxe(client, m))
    this.onMessage('buyAura', (client, m) => this.onBuyAura(client, m))
    this.onMessage('equipAura', (client, m) => this.onEquipAura(client, m))
    this.onMessage('upgrade', (client, m) => this.onUpgrade(client, m))
    this.onMessage('unlockPad', (client, m) => this.onUnlockPad(client, m))
    this.onMessage('buyBag', (client, m) => this.onBuyBag(client, m))
    this.onMessage('equipBag', (client, m) => this.onEquipBag(client, m))
    this.onMessage('claimQuest', (client, m) => this.onClaimQuest(client, m))
    this.onMessage('rebirth', (client) => this.onRebirth(client))
    this.onMessage('gift', (client) => this.onGift(client))
    this.onMessage('surface', (client) => this.onSurface(client))
    // The client drives the first-time guide; the server just remembers the step.
    this.onMessage('tut', (client, m) => {
      const p = this.state.players.get(client.sessionId)
      const step = Math.floor(Number(m?.step))
      if (p && Number.isFinite(step)) p.tut = Math.max(p.tut, Math.min(TUTORIAL_DONE, step))
    })
    this.onMessage('jump', (client) => {
      const meta = this.meta.get(client.sessionId)
      const now = Date.now()
      if (!meta || now - (meta.lastJump || 0) < 200) return
      meta.lastJump = now
      this.act(client, { k: 'jump' })
    })
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  async onJoin(client, options = {}) {
    const uid = String(options.uid || client.sessionId).slice(0, 80)
    const saved = (await loadRecord(uid)) || {}
    const p = new Player()

    p.name = cleanName(options.name || saved.name)
    p.avatar = typeof options.avatar === 'string' ? options.avatar.slice(0, 2000) : ''
    p.x = SPAWN.x + rand(-3, 3)
    p.y = SPAWN.y
    p.z = SPAWN.z + rand(-2, 2)
    // Set every transform field: clients read them before this player first moves.
    p.ry = 0
    p.spd = 0
    p.air = false

    p.strength = finite(saved.strength)
    p.cash = finite(saved.cash)
    p.tokens = finite(saved.tokens)
    p.bux = finite(saved.bux)
    p.rebirths = finite(saved.rebirths)
    // Every session starts on the surface with the mine sealed.
    p.mined = 0
    p.barrierHp = barrierHp(0)
    p.best = Math.min(STAGES.length, finite(saved.best))
    p.ownedPickaxes = new ArraySchema(...(saved.ownedPickaxes || ['wood']).filter((id) => PICKAXE_BY_ID[id]))
    if (!p.ownedPickaxes.includes('wood')) p.ownedPickaxes.push('wood')
    p.ownedAuras = new ArraySchema(...(saved.ownedAuras || ['none']).filter((id) => AURA_BY_ID[id]))
    if (!p.ownedAuras.includes('none')) p.ownedAuras.push('none')
    p.pickaxe = p.ownedPickaxes.includes(saved.pickaxe) ? saved.pickaxe : 'wood'
    p.aura = p.ownedAuras.includes(saved.aura) ? saved.aura : 'none'
    p.pads = new ArraySchema(...(saved.pads || []).filter((id) => TRAINING_BY_ID[id]))
    p.ownedBags = new ArraySchema(...(saved.ownedBags || ['starter']).filter((id) => BAG_BY_ID[id]))
    if (!p.ownedBags.includes('starter')) p.ownedBags.push('starter')
    p.bagType = p.ownedBags.includes(saved.bagType) ? saved.bagType : 'starter'
    p.bagLvl = Math.min(UPGRADES.bag.max, finite(saved.bagLvl))
    p.speedLvl = Math.min(UPGRADES.speed.max, finite(saved.speedLvl))
    p.sellLvl = Math.min(UPGRADES.sell.max, finite(saved.sellLvl))
    p.powerLvl = Math.min(UPGRADES.power.max, finite(saved.powerLvl))
    // Saves from before the economy rebalance carry inflated loot and quest
    // rewards: cap loot at today's price and re-roll the quests.
    const oldEconomy = saved.econ !== ECONOMY_VERSION
    for (const b of saved.bag || []) {
      if (ITEMS_BY_ID[b.kind] && p.bag.length < bagCapacity(p)) {
        const stage = ITEM_STAGE[b.kind] || 1
        const max = Math.round(ITEMS_BY_ID[b.kind].base * stageValueMult(stage) * 1.15)
        p.bag.push(new BagItem({ kind: b.kind, value: Math.min(max, finite(b.value)) }))
      }
    }
    for (const q of oldEconomy ? [] : saved.quests || []) {
      if (QUEST_TYPES[q.type] && p.quests.length < QUEST_SLOTS) {
        p.quests.push(
          new Quest({
            type: q.type,
            target: finite(q.target, 1),
            progress: finite(q.progress),
            cash: finite(q.cash),
            tokens: finite(q.tokens),
          }),
        )
      }
    }
    // A brand-new player can open their first daily gift straight away.
    p.giftAt = finite(saved.giftAt, 0)
    // Brand-new players get the guide; anyone who has already played skips it.
    const veteran = p.best > 0 || finite(saved.totalEarned) > 0 || p.ownedPickaxes.length > 1
    p.tut = Math.min(TUTORIAL_DONE, finite(saved.tut, veteran ? TUTORIAL_DONE : 0))

    this.state.players.set(client.sessionId, p)
    this.meta.set(client.sessionId, {
      uid,
      totalEarned: finite(saved.totalEarned),
      discovered: new Set(saved.discovered || []),
      clicks: [],
      lastNeedPick: 0,
    })
    this.fillQuests(p)

    client.send('discovered', [...this.meta.get(client.sessionId).discovered])
    console.log(`[mine ${this.roomId}] ${p.name} joined (${this.clients.length}/${MAX_PLAYERS})`)
  }

  onLeave(client, code) {
    const p = this.state.players.get(client.sessionId)
    console.log(`[mine ${this.roomId}] ${p?.name} left (code ${code})`)
    this.save(client.sessionId)
    this.state.players.delete(client.sessionId)
    this.meta.delete(client.sessionId)
  }

  onDispose() {
    this.saveAll()
  }

  /* ---------------------------------------------------------------------- */
  /* Persistence                                                             */
  /* ---------------------------------------------------------------------- */

  toRecord(sessionId) {
    const p = this.state.players.get(sessionId)
    const meta = this.meta.get(sessionId)
    if (!p || !meta) return null
    return {
      uid: meta.uid,
      econ: ECONOMY_VERSION,
      name: p.name,
      avatar: p.avatar,
      strength: p.strength,
      cash: p.cash,
      tokens: p.tokens,
      bux: p.bux,
      rebirths: p.rebirths,
      best: p.best,
      pickaxe: p.pickaxe,
      aura: p.aura,
      ownedPickaxes: [...p.ownedPickaxes],
      ownedAuras: [...p.ownedAuras],
      pads: [...p.pads],
      bagType: p.bagType,
      ownedBags: [...p.ownedBags],
      bagLvl: p.bagLvl,
      speedLvl: p.speedLvl,
      sellLvl: p.sellLvl,
      powerLvl: p.powerLvl,
      bag: p.bag.map((b) => ({ kind: b.kind, value: b.value })),
      quests: p.quests.map((q) => ({
        type: q.type,
        target: q.target,
        progress: q.progress,
        cash: q.cash,
        tokens: q.tokens,
      })),
      giftAt: p.giftAt,
      tut: p.tut,
      totalEarned: meta.totalEarned,
      discovered: [...meta.discovered],
    }
  }

  save(sessionId) {
    const record = this.toRecord(sessionId)
    if (record) saveRecord(record.uid, record)
  }

  saveAll() {
    for (const sessionId of this.state.players.keys()) this.save(sessionId)
  }

  updateLeaderboard() {
    const live = [...this.state.players.keys()].map((id) => this.toRecord(id)).filter(Boolean)
    this.state.leaderboard = JSON.stringify(leaderboards(live))
  }

  /* ---------------------------------------------------------------------- */
  /* Quests                                                                  */
  /* ---------------------------------------------------------------------- */

  fillQuests(p) {
    while (p.quests.length < QUEST_SLOTS) {
      // Avoid two quests of the same kind at once.
      const taken = new Set(p.quests.map((q) => q.type))
      const pool = QUEST_KINDS.filter((k) => !taken.has(k))
      const type = pool[Math.floor(Math.random() * pool.length)]
      const q = makeQuest(type, p.best)
      p.quests.push(new Quest({ ...q, progress: 0 }))
    }
  }

  /** Adds to every active quest of `type`. `set` = progress is a max, not a sum. */
  questProgress(p, type, amount, set = false) {
    p.quests.forEach((q) => {
      if (q.type !== type || q.progress >= q.target) return
      q.progress = Math.min(q.target, set ? Math.max(q.progress, amount) : q.progress + amount)
    })
  }

  onClaimQuest(client, m) {
    const p = this.state.players.get(client.sessionId)
    const meta = this.meta.get(client.sessionId)
    const i = Number(m?.i)
    const q = p?.quests?.[i]
    if (!p || !meta || !q || q.progress < q.target) return
    p.cash += q.cash
    meta.totalEarned += q.cash
    p.tokens += q.tokens
    p.quests.splice(i, 1)
    this.fillQuests(p)
    client.send('questDone', { cash: q.cash, tokens: q.tokens })
  }

  /* ---------------------------------------------------------------------- */
  /* World items                                                             */
  /* ---------------------------------------------------------------------- */

  spawnItem(stage, def = pickLoot(stage)) {
    const zc = stagePitZ(stage)
    const id = String(++this.itemSeq)
    const isEvent = !STAGES[stage - 1].items.includes(def)
    const value = Math.round(
      def.base * stageValueMult(stage) * (isEvent ? 1 : rand(0.85, 1.15)),
    )
    // Keep loot out of pillars and partition walls.
    let x = 0
    let z = zc
    for (let i = 0; i < 12; i++) {
      x = rand(-ROOM.halfWidth + 2, ROOM.halfWidth - 2)
      z = rand(zc - 22, zc + 6)
      if (!insideObstacle(stage, x, z)) break
    }
    this.state.items.set(id, new WorldItem({ kind: def.id, stage, x, z, value }))
    return id
  }

  refillItems() {
    const counts = new Array(STAGES.length + 1).fill(0)
    this.state.items.forEach((it) => counts[it.stage]++)
    for (let stage = 1; stage <= STAGES.length; stage++) {
      if (counts[stage] < ITEMS_PER_STAGE) this.spawnItem(stage)
    }
  }

  tickEvents() {
    for (const [rarity, key] of [
      ['Legendary', 'legendaryIn'],
      ['Mythic', 'mythicIn'],
      ['Secret', 'secretIn'],
    ]) {
      if (this.state[key] > 1) {
        this.state[key]--
        continue
      }
      this.state[key] = EVENT_ITEMS[rarity].every

      // Drop it somewhere the lobby can actually reach, but never shallower than
      // the event's minimum stage: a jackpot up top would skip the early game.
      const { minStage } = EVENT_ITEMS[rarity]
      let deepest = 0
      this.state.players.forEach((p) => (deepest = Math.max(deepest, p.best)))
      deepest = Math.min(STAGES.length, deepest)
      if (deepest < minStage) continue
      const stage = minStage + Math.floor(Math.random() * (deepest - minStage + 1))
      const pool = EVENT_ITEMS[rarity].items
      const def = pool[Math.floor(Math.random() * pool.length)]
      this.spawnItem(stage, def)
      this.broadcast('announce', {
        text: `${def.rarity} ${def.name} spawned in Stage ${stage}!`,
        rarity: def.rarity,
      })
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Messages                                                                */
  /* ---------------------------------------------------------------------- */

  onMove(client, m) {
    const p = this.state.players.get(client.sessionId)
    if (!p || !m) return
    const x = Number(m.x)
    const y = Number(m.y)
    const z = Number(m.z)
    if (![x, y, z].every(Number.isFinite)) return
    p.x = x
    p.y = y
    p.z = z
    p.ry = finite(Number(m.ry))
    p.spd = Math.min(40, Math.max(0, finite(Number(m.spd))))
    p.air = Boolean(m.air)
    // Back on the surface: the mine seals up again.
    if (p.mined > 0 && onSurface(p)) this.resetTrip(p)
  }

  resetTrip(p) {
    p.mined = 0
    p.barrierHp = barrierHp(0)
  }

  onClick(client) {
    const p = this.state.players.get(client.sessionId)
    const meta = this.meta.get(client.sessionId)
    if (!p || !meta) return

    // Rate limit: autoclickers get the cap, not infinity.
    const now = Date.now()
    meta.clicks = meta.clicks.filter((t) => now - t < 1000)
    if (meta.clicks.length >= MAX_CLICKS_PER_SECOND) return
    meta.clicks.push(now)

    let zone = trainingZoneAt(p.x, p.y, p.z)
    if (zone && !this.ownsPad(p, zone.id)) zone = null

    const gain = strengthPerClick(p, zone)
    p.strength += gain
    // What everyone else sees for this click: a plain swing unless it trained or dug.
    let act = { k: 'swing' }
    if (zone) {
      this.questProgress(p, 'train', 1)
      act = { k: 'train', v: gain, c: zone.crystal }
    }

    const result = { gain, zone: zone ? zone.mult : 0 }

    if (p.mined < TOTAL_BARRIERS) {
      const b = barrierInfo(p.mined)
      const half = PIT.size / 2 + 0.6
      const onBarrier =
        Math.abs(p.x - b.x) <= half &&
        Math.abs(p.z - b.z) <= half &&
        p.y >= b.topY - 0.5 &&
        p.y <= b.topY + 4
      if (onBarrier) {
        if (pickaxeIndex(p.pickaxe) < pickaxeIndex(b.pickaxe.id)) {
          // Too weak to scratch it. Tell them what they need (not every click).
          result.needPick = b.pickaxe.name
          if (now - meta.lastNeedPick > 2500) {
            meta.lastNeedPick = now
            client.send('toast', {
              text: `Stage ${b.stage} needs a ${b.pickaxe.name} Pickaxe or better!`,
              kind: 'error',
            })
          }
        } else {
          const dmg = hitDamage(p, b.hp)
          p.barrierHp -= dmg
          result.dmg = dmg
          act = { k: 'hit', b: p.mined }
          if (p.barrierHp <= 0) {
            p.mined++
            p.barrierHp = p.mined < TOTAL_BARRIERS ? barrierHp(p.mined) : 0
            result.broke = p.mined - 1
            act = { k: 'break', b: p.mined - 1 }
            this.questProgress(p, 'mine', 1)
            if (p.mined % BARRIERS_PER_STAGE === 0) {
              const reached = p.mined / BARRIERS_PER_STAGE
              this.questProgress(p, 'reach', reached, true)
              if (reached > p.best) {
                p.best = reached
                result.newBest = reached
              }
            }
          }
        }
      }
    }

    client.send('clicked', result)
    this.act(client, act)
  }

  /** Relays one player's action to everyone else in the lobby, for effects. */
  act(client, m) {
    this.broadcast('act', { id: client.sessionId, ...m }, { except: client })
  }

  onPickup(client, m) {
    const p = this.state.players.get(client.sessionId)
    const meta = this.meta.get(client.sessionId)
    const id = String(m?.id ?? '')
    const it = this.state.items.get(id)
    if (!p || !meta || !it) return

    const cap = bagCapacity(p)
    if (p.bag.length >= cap) {
      client.send('bagFull', {})
      return
    }
    if (reachableStage(p) < it.stage) return
    const floorY = roomFloorY(it.stage)
    if (Math.hypot(p.x - it.x, p.z - it.z) > PICKUP_RANGE) return
    if (Math.abs(p.y - floorY) > 5) return

    this.state.items.delete(id)
    p.bag.push(new BagItem({ kind: it.kind, value: it.value }))
    const def = ITEMS_BY_ID[it.kind]
    const isNew = !meta.discovered.has(it.kind)
    meta.discovered.add(it.kind)
    this.questProgress(p, 'collect', 1)
    if (RARITY_ORDER.indexOf(def?.rarity) >= RARE_INDEX) this.questProgress(p, 'rare', 1)
    client.send('picked', { id, kind: it.kind, value: it.value, isNew })
    this.act(client, { k: 'pick', kind: it.kind, x: it.x, z: it.z, y: floorY })
    if (p.bag.length >= cap) client.send('bagFull', {})
  }

  onSell(client) {
    const p = this.state.players.get(client.sessionId)
    const meta = this.meta.get(client.sessionId)
    if (!p || !meta) return
    const stall = STALLS.find((s) => s.id === 'sell')
    if (p.y < -3 || Math.hypot(p.x - stall.x, p.z - stall.z) > STALL_RANGE + 3) return
    if (p.bag.length === 0) {
      client.send('toast', { text: 'Your backpack is empty.', kind: 'error' })
      return
    }
    let total = 0
    p.bag.forEach((b) => (total += b.value))
    total = Math.round(total * sellMult(p.sellLvl) * indexBonus(meta.discovered))
    p.cash += total
    meta.totalEarned += total
    p.bag.clear()
    this.questProgress(p, 'sell', total)
    client.send('sold', { total })
  }

  /**
   * Shopping only happens in person: standing at the stall on the surface. From
   * down in the mine you can browse the menus but not buy.
   */
  atStall(client, p, stallId) {
    const stall = STALLS.find((s) => s.id === stallId)
    if (stall && p.y > -3 && Math.hypot(p.x - stall.x, p.z - stall.z) <= STALL_RANGE + 3) return true
    client.send('toast', { text: `Go to the ${stall?.label || 'shop'} stall in the lobby to buy that!`, kind: 'error' })
    return false
  }

  spend(client, p, field, cost) {
    if (p[field] < cost) {
      client.send('toast', {
        text: field === 'cash' ? 'Not enough cash!' : 'Not enough rebirth tokens!',
        kind: 'error',
      })
      return false
    }
    p[field] -= cost
    return true
  }

  ownsPad(p, id) {
    return FREE_PADS.includes(id) || p.pads.includes(id)
  }

  onUnlockPad(client, m) {
    const p = this.state.players.get(client.sessionId)
    const pad = TRAINING_BY_ID[m?.id]
    if (!p || !pad || this.ownsPad(p, pad.id)) return
    if (p.rebirths < pad.rebirths) {
      client.send('toast', { text: `Needs ${pad.rebirths} rebirths to unlock.`, kind: 'error' })
      return
    }
    if (!this.spend(client, p, 'cash', pad.cost)) return
    p.pads.push(pad.id)
    client.send('bought', { text: `Unlocked x${pad.mult} training pad! 💪` })
  }

  onBuyBag(client, m) {
    const p = this.state.players.get(client.sessionId)
    const bag = BAG_BY_ID[m?.id]
    if (!p || !bag || p.ownedBags.includes(bag.id)) return
    if (!this.atStall(client, p, 'pickaxes')) return
    if (bag.bux) {
      if (p.bux < bag.bux) {
        client.send('toast', { text: 'Not enough Bux!', kind: 'error' })
        return
      }
      p.bux -= bag.bux
    } else if (!this.spend(client, p, 'cash', bag.cost)) {
      return
    }
    p.ownedBags.push(bag.id)
    p.bagType = bag.id
    client.send('bought', { text: `New backpack: ${bag.name} (${bag.cap} slots)!` })
  }

  onEquipBag(client, m) {
    const p = this.state.players.get(client.sessionId)
    if (!p || !p.ownedBags.includes(m?.id)) return
    // Swapping to a smaller bag can't delete loot: refuse if it wouldn't fit.
    if (p.bag.length > bagCapacity({ bagType: m.id, bagLvl: p.bagLvl })) {
      client.send('toast', { text: 'Sell your loot first — it won’t fit in that bag.', kind: 'error' })
      return
    }
    p.bagType = m.id
  }

  onBuyPickaxe(client, m) {
    const p = this.state.players.get(client.sessionId)
    const pick = PICKAXE_BY_ID[m?.id]
    if (!p || !pick || p.ownedPickaxes.includes(pick.id)) return
    if (!this.atStall(client, p, 'pickaxes')) return
    if (!this.spend(client, p, 'cash', pick.cost)) return
    p.ownedPickaxes.push(pick.id)
    p.pickaxe = pick.id
    client.send('bought', { text: `Bought ${pick.name} Pickaxe!` })
  }

  onEquipPickaxe(client, m) {
    const p = this.state.players.get(client.sessionId)
    if (p && p.ownedPickaxes.includes(m?.id)) p.pickaxe = m.id
  }

  onBuyAura(client, m) {
    const p = this.state.players.get(client.sessionId)
    const aura = AURA_BY_ID[m?.id]
    if (!p || !aura || p.ownedAuras.includes(aura.id)) return
    if (!this.atStall(client, p, 'auras')) return
    if (!this.spend(client, p, 'tokens', aura.cost)) return
    p.ownedAuras.push(aura.id)
    p.aura = aura.id
    client.send('bought', { text: `Unlocked the ${aura.name} aura!` })
  }

  onEquipAura(client, m) {
    const p = this.state.players.get(client.sessionId)
    if (p && p.ownedAuras.includes(m?.id)) p.aura = m.id
  }

  onUpgrade(client, m) {
    const p = this.state.players.get(client.sessionId)
    const key = m?.key
    if (!p || !UPGRADES[key]) return
    const field = `${key}Lvl`
    const level = p[field]
    if (level >= UPGRADES[key].max) return
    if (!this.atStall(client, p, 'upgrades')) return
    if (!this.spend(client, p, 'cash', upgradeCost(key, level))) return
    p[field] = level + 1
  }

  onRebirth(client) {
    const p = this.state.players.get(client.sessionId)
    if (!p) return
    const cost = rebirthCost(p.rebirths)
    if (p.cash < cost) {
      client.send('toast', { text: 'Not enough cash to rebirth!', kind: 'error' })
      return
    }
    p.tokens += rebirthTokens(p.rebirths)
    p.rebirths++
    p.cash = 0
    p.strength = 0
    this.resetTrip(p)
    p.bag.clear()
    client.send('rebirthed', { rebirths: p.rebirths })
  }

  onGift(client) {
    const p = this.state.players.get(client.sessionId)
    const meta = this.meta.get(client.sessionId)
    if (!p || !meta) return
    const now = Date.now()
    if (now < p.giftAt) return
    p.cash += GIFT_CASH
    meta.totalEarned += GIFT_CASH
    p.giftAt = now + GIFT_COOLDOWN_S * 1000
    client.send('gift', { cash: GIFT_CASH })
  }

  onSurface(client) {
    // Teleport home (button, full backpack, rebirth). The floors seal behind you.
    const p = this.state.players.get(client.sessionId)
    if (!p) return
    p.x = SPAWN.x
    p.y = SPAWN.y
    p.z = SPAWN.z
    this.resetTrip(p)
  }
}
