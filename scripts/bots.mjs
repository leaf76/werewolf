#!/usr/bin/env node
/**
 * Seat-filler bots for local testing (the rules require 6-12 players, but a
 * demo usually has two humans in two tabs). Each bot joins the given room and
 * plays a deterministic, legal strategy:
 *   - werewolf: kill the highest-seated living non-wolf
 *   - seer:     inspect the highest-seated living player other than itself
 *   - witch:    hoards her potions (skips her beat)
 *   - hunter:   shoots the highest-seated living player when dying
 *   - everyone: vote the highest-seated living eligible player
 * Targeting high seats first means bots eat each other before the humans.
 *
 * Usage: node scripts/bots.mjs <ROOM_CODE> [count=4] [base=ws://localhost:8787]
 */

const code = (process.argv[2] ?? "").toUpperCase();
const count = Number(process.argv[3] ?? 4);
const base = process.argv[4] ?? "ws://localhost:8787";

if (!/^[A-Z0-9]{6}$/.test(code)) {
  console.error("Usage: node scripts/bots.mjs <ROOM_CODE> [count] [ws-base]");
  process.exit(1);
}

const ACT_DELAY_MS = 900; // let humans watch things happen

function log(name, text) {
  console.log(`[${name}] ${text}`);
}

function runBot(index) {
  const name = `Bot-${index}`;
  const playerId = crypto.randomUUID();
  const ws = new WebSocket(`${base}/api/rooms/${code}/ws`);

  let role = null;
  let teammates = new Set();
  let state = null;
  let actedNight = false;
  let votedDay = false;
  let witchAwake = false;

  const send = (msg) => ws.send(JSON.stringify(msg));

  function livingTargets() {
    if (!state) return [];
    return state.players
      .filter((p) => p.alive && p.id !== playerId)
      .sort((a, b) => b.seat - a.seat); // highest seat first
  }

  function act() {
    if (!state) return;
    const self = state.players.find((p) => p.id === playerId);
    if (!self) return;

    // Hunter's dying shot works while dead, so check before the alive gate.
    if (state.phase === "hunt" && role === "hunter" && !self.alive) {
      const target = livingTargets()[0];
      send({ type: "hunt", targetId: target ? target.id : null });
      log(name, `hunter shot -> ${target ? target.name : "(holster)"}`);
      return;
    }
    if (!self.alive) return;

    if (state.phase === "night") {
      if (state.nightStage === "witch") {
        if (role === "witch" && witchAwake) {
          witchAwake = false;
          send({ type: "night_action", action: "skip" });
          log(name, "witch skips");
        }
        return;
      }
      if (actedNight) return;
      if (role === "werewolf") {
        const target = livingTargets().find((p) => !teammates.has(p.id));
        if (target) {
          actedNight = true;
          send({ type: "night_action", action: "kill", targetId: target.id });
          log(name, `wolf kill -> ${target.name}`);
        }
      } else if (role === "seer") {
        const target = livingTargets()[0];
        if (target) {
          actedNight = true;
          send({ type: "night_action", action: "inspect", targetId: target.id });
          log(name, `seer inspect -> ${target.name}`);
        }
      }
      return;
    }

    if (state.phase === "day" && !votedDay) {
      if (state.runoffIds && state.runoffIds.includes(playerId)) return; // candidates sit out
      const pool = state.runoffIds
        ? livingTargets().filter((p) => state.runoffIds.includes(p.id))
        : livingTargets();
      const target = pool[0];
      if (target) {
        votedDay = true;
        send({ type: "vote", targetId: target.id });
        log(name, `vote -> ${target.name}`);
      }
    }
  }

  ws.addEventListener("open", () => {
    send({ type: "join", playerId, name });
    log(name, `joined room ${code}`);
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case "room_state":
        state = msg.state;
        // Acting on state (not just phase_changed) also covers reconnects.
        setTimeout(act, ACT_DELAY_MS);
        break;
      case "role_assigned":
        role = msg.role;
        teammates = new Set(msg.teammates.map((t) => t.id));
        log(name, `role = ${role}`);
        break;
      case "witch_wake":
        witchAwake = true;
        setTimeout(act, ACT_DELAY_MS);
        break;
      case "phase_changed":
        actedNight = false;
        votedDay = false;
        break;
      case "seer_result":
        log(name, `seer result: ${msg.targetId} is ${msg.faction}`);
        break;
      case "game_over":
        log(name, `game over, winner: ${msg.winner}`);
        break;
      case "error":
        log(name, `error: ${msg.code}`);
        break;
    }
  });

  ws.addEventListener("close", (event) => log(name, `disconnected (${event.code})`));
  ws.addEventListener("error", () => log(name, "socket error"));
}

for (let i = 1; i <= count; i++) runBot(i);
