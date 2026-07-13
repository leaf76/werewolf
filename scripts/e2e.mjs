#!/usr/bin/env node
/**
 * Protocol-level end-to-end smoke test against a running server
 * (`wrangler dev` locally or the deployed Worker). It drives six scripted
 * players through a real game with a god's-eye view: exercises the witch's
 * save and poison, wolf coordination, public vote reveals, last words,
 * spectators, and the same-room rematch, then asserts a clean verdict.
 *
 * Usage: node scripts/e2e.mjs [base=http://localhost:8787]
 * Exits 0 on success, 1 on any protocol error or timeout.
 */

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");

const fail = (msg) => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`✓ ${msg}`);

function connect(code, name) {
  const playerId = crypto.randomUUID();
  const ws = new WebSocket(`${wsBase}/api/rooms/${code}/ws`);
  const queue = [];
  let waiter = null;
  const client = {
    id: playerId,
    name,
    role: null,
    sawPrivate: false,
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    /** Consume messages in order, discarding non-matching, until one fits. */
    until(type, pred = () => true, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`[${name}] timed out waiting for ${type}`)),
          timeoutMs,
        );
        const pump = () => {
          while (queue.length > 0) {
            const msg = queue.shift();
            if (msg.type === type && pred(msg)) {
              clearTimeout(timer);
              waiter = null;
              resolve(msg);
              return;
            }
          }
          waiter = pump;
        };
        pump();
      });
    },
  };
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "error" && msg.code !== "not_alive") {
      fail(`[${name}] unexpected server error: ${msg.code}`);
    }
    if (msg.type === "role_assigned" || msg.type === "seer_result" || msg.type === "witch_wake") {
      client.sawPrivate = true;
    }
    queue.push(msg);
    if (waiter) waiter();
  });
  ws.addEventListener("open", () => client.send({ type: "join", playerId, name }));
  return client;
}

const startedAt = Date.now();

// --- Create a room.
const res = await fetch(`${base}/api/rooms`, { method: "POST" });
if (res.status !== 201) fail(`POST /api/rooms -> ${res.status}`);
const { code } = await res.json();
ok(`room created: ${code}`);

// --- Six players join one at a time: over a real network, concurrent
// sockets race and the host would be whoever handshakes first.
const players = [];
for (let i = 1; i <= 6; i++) {
  const p = connect(code, `E2E-${i}`);
  await p.until("room_state"); // seat confirmed before the next player knocks
  players.push(p);
}
ok("six players seated (E2E-1 is host)");

// --- Start; discover the cast.
players[0].send({ type: "start_game", revealOnDeath: true });
for (const p of players) {
  const assigned = await p.until("role_assigned");
  p.role = assigned.role;
}
const wolves = players.filter((p) => p.role === "werewolf");
const seer = players.find((p) => p.role === "seer");
const witch = players.find((p) => p.role === "witch");
const villagers = players.filter((p) => p.role === "villager");
if (wolves.length !== 2 || !seer || !witch || villagers.length !== 2) {
  fail(`unexpected cast: ${players.map((p) => p.role).join(",")}`);
}
ok("cast dealt: 2 wolves, seer, witch, 2 villagers");

// --- A late joiner becomes a spectator and must stay blind.
const watcher = connect(code, "圍觀");
await watcher.until("spectate");
ok("late joiner became a spectator");

// --- Night 1: wolves hit a villager; the witch saves; the seer checks a wolf.
const prey = villagers[0];
for (const w of wolves) w.send({ type: "night_action", action: "kill", targetId: prey.id });
seer.send({ type: "night_action", action: "inspect", targetId: wolves[0].id });
const wake1 = await witch.until("witch_wake");
if (wake1.victimId !== prey.id || !wake1.canSave) fail("witch wake mismatch");
witch.send({ type: "night_action", action: "save" });

const seen = await seer.until("seer_result");
if (seen.faction !== "werewolf") fail("seer misread a wolf");
const dawn1 = await players[3].until("phase_changed", (m) => m.phase === "day");
if (dawn1.deaths.length !== 0) fail("the save did not hold");
ok("night 1: the witch's antidote held; the seer confirmed a wolf");

// --- Day 1: the village piles on wolf #1; ballots go public.
for (const p of players.filter((q) => q !== wolves[0])) {
  p.send({ type: "vote", targetId: wolves[0].id });
}
wolves[0].send({ type: "vote", targetId: prey.id });
const dusk1 = await players[3].until("phase_changed", (m) => m.eliminatedId !== undefined);
if (dusk1.eliminatedId !== wolves[0].id) fail("vote did not eliminate the wolf");
if (!Array.isArray(dusk1.voteReveal) || dusk1.voteReveal.length !== 6) fail("missing vote reveal");
ok("day 1: wolf lynched, tally revealed");

// --- The dead wolf leaves one last line.
wolves[0].send({ type: "chat", text: "GG" });
const lastLine = await players[4].until("chat", (m) => m.channel === "last_words");
if (lastLine.from !== wolves[0].name) fail("last words attribution wrong");
ok("last words delivered");

// --- Night 2: the last wolf kills; the witch poisons it (god's-eye view).
wolves[1].send({ type: "night_action", action: "kill", targetId: prey.id });
seer.send({ type: "night_action", action: "inspect", targetId: villagers[1].id });
const wake2 = await witch.until("witch_wake");
if (wake2.canSave) fail("antidote should be spent");
witch.send({ type: "night_action", action: "poison", targetId: wolves[1].id });

const over = await Promise.all(players.map((p) => p.until("game_over")));
for (const o of over) {
  if (o.winner !== "villagers") fail("expected a villager win");
  if (o.roles.length !== 6) fail("final reveal incomplete");
}
await watcher.until("game_over");
if (watcher.sawPrivate) fail("spectator received private information");
ok("night 2: poison ended it — villagers win; spectator stayed blind");

// --- Same-room rematch.
players[0].send({ type: "restart" });
await players[5].until("phase_changed", (m) => m.phase === "lobby");
const lobby = await players[5].until("room_state", (m) => m.state.phase === "lobby");
if (lobby.state.players.length !== 6 || !lobby.state.players.every((p) => p.alive)) {
  fail("rematch roster mismatch");
}
ok("rematch: same room back to the lobby, all six seats alive");

console.log(`\nAll green in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — E2E smoke passed.`);
for (const p of [...players, watcher]) p.ws.close(1000, "e2e done");
process.exit(0);
