import { Server } from '@colyseus/core'
import { WebSocketTransport } from '@colyseus/ws-transport'

import { MineRoom } from './rooms/MineRoom.js'
import { ROOM_NAME } from './shared/gameConfig.js'
import { closeStore, initStore } from './store.js'

// Bloxity Legion injects PORT (HTTP and WebSocket share it); 2567 locally.
const PORT = Number(process.env.PORT || 2567)

// Load saves / connect to Mongo before accepting anyone.
await initStore()

const server = new Server({
  transport: new WebSocketTransport(),
  express: (app) => {
    // Legion's readiness/liveness probe: must answer fast.
    app.get('/health', (_req, res) => res.json({ ok: true }))
  },
})

// maxClients = 8 on the room: joinOrCreate() fills a lobby, and the 9th player
// automatically gets a fresh one.
server.define(ROOM_NAME, MineRoom)

// On SIGTERM (a deploy or scale-down) Colyseus drains by itself: every room is
// disposed, which saves its players, and clients reconnect to the new pod. We
// just write the last saves out before the process exits.
server.onShutdown(async () => {
  await closeStore()
  console.log('[server] shut down cleanly')
})

await server.listen(PORT)
console.log(`⛏  Mine server listening on port ${PORT} (${process.env.BLOXITY_CHANNEL || 'local'})`)
