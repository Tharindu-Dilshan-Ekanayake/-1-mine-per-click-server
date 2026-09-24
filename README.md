# 1 Mine Per Click — game server

Colyseus 0.18 backend for the mining game.

```bash
npm install
npm start        # ws://localhost:2567   (npm run dev = auto-restart on save)
```

Then in `../1-mine-per-click-client`: `npm run dev` and open http://localhost:5173.

## Lobbies

One room type, `mine`, capped at **8 players** (`MAX_PLAYERS`). Clients call
`joinOrCreate('mine')`, so the 9th player automatically gets a fresh lobby.

## What the server owns

Movement is client-side, but everything worth cheating on is decided here:
strength per click (rate-limited to 12/s), barrier HP and breaking, loot
pickup (range + reached-stage checks), selling, shops and upgrades (you must
stand at the matching stall in the lobby; menus opened in the mine are
browse-only), rebirth and the free gift. Players' hits, floor breaks, training
reps, jumps and pickups are relayed to the rest of the lobby as `act`
messages so everyone sees each other's activity.

Progress is saved per player id (every 10 s, on leave and on shutdown): to
MongoDB when `MONGODB_URI` is set (Bloxity Legion provides it), otherwise to
`data/players.json`. The Champions leaderboards read from the same store.

## Progression loop

- Every trip starts at the surface with the mine sealed. Surfacing (button, or
  automatically when the backpack fills) closes every floor you dug.
- 20 stages, 3 floors each. Floor HP grows ~5x per stage, and every stage needs
  a minimum pickaxe (`stagePickaxe`), so you need both strength and cash to go
  deeper.
- Strength: click anywhere, or stand on a training pad you own (buy with E) to
  auto-train at x1.5 → x1000.
- Cash: loot is worth ~2.9x more per stage and deeper stages roll rarer items.
  Early stages only hold cheap loot ($4-12 in stage 1), so nothing up top can
  pay for a late pickaxe; each pickaxe costs roughly 5 trips early on, rising
  to 30+ trips late. World-event drops only land deep (Legendary from stage 4,
  Mythic from 8, Secret from 12) and scale with their stage.
- Extras: 3 rotating quests, Index collection bonus (+10% sell per completed
  stage), rebirths (tokens → auras), a free $30 gift once a day.

## Controls (client)

WASD walk (A/D turn the camera), Space jump, Shift sprint, mouse look (the
first click in the game captures the mouse; Esc frees it), click to swing, E to
interact. Menu shortcuts: P pickaxes, B bags, T auras, U upgrades, R rebirth,
I index, Q quests, G gift, F surface, M sound.

## Game config

`src/shared/gameConfig.js` holds the world layout and every balance number:
stages, loot tables, pickaxes, auras, upgrades, barrier HP, training rocks.
The client needs an identical copy; after editing, run:

```bash
npm run sync-config
```

## Deploying to Bloxity Legion

`.github/workflows/deploy.yml` builds the `Dockerfile`, pushes the image to this
repo's GitHub Container Registry and asks Legion to roll it out:
`dev` branch → dev channel, `main` → prod.

One-time setup (repo → Settings → Secrets and variables → Actions):

| Kind     | Name                  | Value                                            |
| -------- | --------------------- | ------------------------------------------------ |
| Secret   | `LEGION_DEPLOY_TOKEN` | deploy token from My Games                       |
| Variable | `BLOXITY_GAME_ID`     | your lowercase game id, e.g. `mine-per-click`    |
| Variable | `SEAT_CAP` (optional) | players per pod, default `8` (one lobby per pod) |
| Variable | `MAX_REPLICAS` (opt.) | most pods at once, default `10`                  |

After the first run, make the `ghcr.io/<owner>/<gameId>-server` package public
(repo → Packages → Package settings → Change visibility) so Legion can pull it.

What the server does for Legion: listens on `PORT`, answers `GET /health`,
runs as the non-root `node` user, saves to the injected `MONGODB_URI`, and on
SIGTERM lets Colyseus close every room (saving its players) before exiting;
clients reconnect to the new pod automatically.
