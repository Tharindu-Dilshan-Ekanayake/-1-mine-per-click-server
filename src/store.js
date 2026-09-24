import fs from 'node:fs'
import path from 'node:path'

/**
 * Player progress persistence, shared by every room in this process.
 *
 * Two backends behind one API:
 *  - MongoDB when MONGODB_URI is set. Bloxity Legion injects it: an isolated
 *    database for this game + channel, shared by every pod, so progress and the
 *    leaderboards survive restarts, deploys and scaling.
 *  - A JSON file (data/players.json) otherwise, for local development.
 *
 * Writes are buffered and flushed every few seconds (and on shutdown), so a busy
 * lobby costs one batched write, not one per click.
 */

const FLUSH_MS = 10_000
/** How often the global leaderboards are re-read from Mongo (other pods write too). */
const TOP_REFRESH_MS = 15_000
const BOARD_SIZE = 8
const BOARD_KEYS = ['strength', 'totalEarned', 'rebirths']

let backend = null

/* ------------------------------------------------------------------------ */
/* JSON file backend                                                         */
/* ------------------------------------------------------------------------ */

function jsonBackend() {
  const dir = path.resolve(process.env.DATA_DIR || 'data')
  const file = path.join(dir, 'players.json')
  let records = {}
  let dirty = false
  try {
    records = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    records = {}
  }
  return {
    name: `json file (${file})`,
    async load(uid) {
      return records[uid] ? structuredClone(records[uid]) : null
    },
    save(uid, record) {
      records[uid] = record
      dirty = true
    },
    async flush() {
      if (!dirty) return
      dirty = false
      try {
        fs.mkdirSync(dir, { recursive: true })
        const tmp = `${file}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(records))
        fs.renameSync(tmp, file)
      } catch (err) {
        dirty = true
        console.error('[store] failed to write players.json', err)
      }
    },
    /** Records the leaderboards are ranked from: here, every saved player. */
    candidates() {
      return Object.values(records)
    },
    async close() {},
  }
}

/* ------------------------------------------------------------------------ */
/* MongoDB backend                                                           */
/* ------------------------------------------------------------------------ */

async function mongoBackend(uri) {
  const { MongoClient } = await import('mongodb')
  const client = new MongoClient(uri, { maxPoolSize: 5 })
  await client.connect()
  // The URI names the database (Legion scopes it to this game + channel).
  const players = client.db().collection('players')
  await Promise.all(BOARD_KEYS.map((key) => players.createIndex({ [key]: -1 })))

  /** uid -> record waiting to be written */
  const pending = new Map()
  /** The current top players of each board, re-read from the database. */
  let top = []

  const refreshTop = async () => {
    try {
      const lists = await Promise.all(
        BOARD_KEYS.map((key) =>
          players
            .find({ [key]: { $gt: 0 } }, { projection: { discovered: 0, bag: 0, quests: 0 } })
            .sort({ [key]: -1 })
            .limit(BOARD_SIZE)
            .toArray(),
        ),
      )
      const byUid = new Map()
      lists.flat().forEach((r) => byUid.set(r._id, { ...r, uid: r._id }))
      top = [...byUid.values()]
    } catch (err) {
      console.error('[store] leaderboard refresh failed:', err.message)
    }
  }
  await refreshTop()
  const topTimer = setInterval(refreshTop, TOP_REFRESH_MS)
  topTimer.unref()

  return {
    name: 'mongodb',
    async load(uid) {
      // A write still waiting to go out is newer than what the database has.
      if (pending.has(uid)) return structuredClone(pending.get(uid))
      const doc = await players.findOne({ _id: uid })
      if (!doc) return null
      delete doc._id
      return doc
    },
    save(uid, record) {
      pending.set(uid, record)
    },
    async flush() {
      if (pending.size === 0) return
      const batch = [...pending.entries()]
      pending.clear()
      try {
        await players.bulkWrite(
          batch.map(([uid, record]) => ({
            replaceOne: { filter: { _id: uid }, replacement: { ...record, _id: uid }, upsert: true },
          })),
          { ordered: false },
        )
      } catch (err) {
        // Put them back (unless a newer save arrived meanwhile) and retry next flush.
        batch.forEach(([uid, record]) => {
          if (!pending.has(uid)) pending.set(uid, record)
        })
        console.error('[store] mongo flush failed:', err.message)
      }
    },
    /** Records the leaderboards are ranked from: the cached top of each board. */
    candidates() {
      return top
    },
    async close() {
      clearInterval(topTimer)
      await client.close()
    },
  }
}

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

/** Connects the store. Call once, before the server starts accepting players. */
export async function initStore() {
  const uri = process.env.MONGODB_URI
  backend = uri ? await mongoBackend(uri) : jsonBackend()
  console.log(`[store] saving players to ${backend.name}`)
  setInterval(() => backend.flush(), FLUSH_MS).unref()
}

/** A player's saved record, or null for a new player. */
export const loadRecord = (uid) => backend.load(uid)
export const saveRecord = (uid, record) => backend.save(uid, record)
export const flush = () => backend?.flush()

/** Final flush and disconnect, on shutdown. */
export async function closeStore() {
  if (!backend) return
  await backend.flush()
  await backend.close()
}

/**
 * Global top-N boards across every saved player, so a new lobby still shows the
 * all-time champions. `live` overrides saved records with in-room values.
 */
export function leaderboards(live = [], limit = BOARD_SIZE) {
  const merged = new Map()
  for (const r of backend?.candidates() || []) if (r?.uid) merged.set(r.uid, r)
  for (const r of live) merged.set(r.uid, r)
  const all = [...merged.values()].filter((r) => r && r.name)

  const sorted = (key) =>
    all.filter((r) => (r[key] || 0) > 0).sort((a, b) => (b[key] || 0) - (a[key] || 0))
  const top = (key) =>
    sorted(key)
      .slice(0, limit)
      .map((r) => [r.name, r[key] || 0])
  // The #1 of each board dances on the Champions stage, so send their look too.
  const champ = (key) => {
    const best = sorted(key)[0]
    return best ? { name: best.name, avatar: best.avatar || '' } : null
  }

  return {
    strength: top('strength'),
    cash: top('totalEarned'),
    rebirths: top('rebirths'),
    champs: { strength: champ('strength'), cash: champ('totalEarned'), rebirths: champ('rebirths') },
  }
}
