# AGENTS.md — werewolf

Repo-specific guidance for coding agents. Global always-on rules (security, English code, Traditional Chinese user-facing replies) still apply from the user SSOT.

## Purpose and scope

Monorepo for the online werewolf game:

- **Authority** (rules, seats, night/day, win): Cloudflare Workers + Room Durable Object in this repo (`src/`).
- **Web client**: `src/client/` + `public/` (no framework).
- **Godot 4.7 2.5D client**: `godot/` — HTTP create/join + WSS intents only.
- Do **not** reimplement server authority in Godot unless the user explicitly scopes a backend rewrite.

Production Worker URL (`name` in `wrangler.jsonc` is `werewolf`):

`https://werewolf.leafxc0903.workers.dev`

GitHub: `leaf76/werewolf`.  
Former Worker name / hostname: `werewolf-demo`. Former repos: `werewolf-demo` (this tree) and `werewolf-godot` (now `godot/`).

## Repo snapshot

| Area | Path / notes |
|------|----------------|
| Worker + DO | `src/worker.ts`, `src/room.ts`, `src/protocol.ts` |
| Web client | `src/client/client.ts`, `public/` |
| Tests | `test/`, `scripts/e2e.mjs`, `scripts/bots.mjs` |
| Godot | `godot/project.godot` — open **that folder** in Godot, not repo root |
| Godot autoloads | `godot/scripts/autoload/` |
| Assets policy | `godot/assets/ASSETS.md` — runtime files only; Kenney CC0 |

## Workflow policy

1. Read root `README.md` before changing net/game logic.
2. Protocol field names are **camelCase** and must match `src/protocol.ts` and Godot `protocol.gd` together.
3. Mirror public state on clients; never invent hidden roles, votes, or winners locally.
4. UI copy: Traditional Chinese; code identifiers/comments English where already established.
5. Scene/resource edits: prefer Godot editor for complex `.tscn`; keep `.gd` surgical.

## Change safety

- **Do not commit**: `node_modules/`, `.wrangler/`, `.godot/`, `export_presets.cfg`, `*.zip`, `godot/assets/kenney/`, debug artifacts — see `.gitignore`.
- **Do not** weaken client/server trust: secret roles and private night info only via unicast (`role_assigned`, `seer_result`, `witch_wake`, `wolf_pick`, …).
- Seat credentials: web `sessionStorage`; Godot `user://seat_<CODE>.cfg` — do not log secrets.
- Do not rename the Wrangler worker (`werewolf`) unless the user wants to change the live hostname.

## Verified commands

```sh
npm install
npm run check
npm test
npm run dev          # http://localhost:8787
# bots: node scripts/bots.mjs <roomCode> 5 ws://localhost:8787

# Godot smoke (if `godot` is on PATH)
godot --path godot -s res://tools/auto_test_create.gd
```

## Domain guardrails

- Clients send intents only: `join`, `start_game`, `night_action`, `vote`, `hunt`, `restart`, `chat`.
- Server is source of truth. Godot `GameState` is a **mirror**.
- Align limits in `src/protocol.ts` and `godot/scripts/autoload/protocol.gd`
  (`MAX_PLAYERS`, `MAX_CHAT_LEN`, `MAX_SOCKETS`, `MAX_WS_BYTES`).
- Close codes: `4000` replaced, `4001` join denied.

## Validation

- Backend: `npm run check` + `npm test` (and `npm run e2e` with wrangler running).
- Godot: headless script above if binary exists; otherwise document that Godot was not on PATH.
