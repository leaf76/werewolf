import { describe, expect, it } from "vitest";
import {
  alivePlayers,
  assignRoles,
  castVote,
  checkWin,
  huntShot,
  joinPlayer,
  newGame,
  nightAction,
  restartGame,
  rolesFor,
  spendLastWords,
  startGame,
  tally,
  timeoutDay,
  timeoutHunt,
  timeoutNightActions,
  timeoutWitch,
  werewolfCountFor,
  type GameState,
} from "../src/game";
import type { Role } from "../src/protocol";

/** Deterministic PRNG so shuffles are reproducible in tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lobbyWith(n: number): GameState {
  const state = newGame("TEST42");
  for (let i = 1; i <= n; i++) {
    const res = joinPlayer(state, `p${i}`, `玩家${i}`);
    expect(res.ok).toBe(true);
  }
  return state;
}

/** Hand-built started game, bypassing the shuffle. */
function startedGame(roles: Role[]): GameState {
  const state = lobbyWith(roles.length);
  state.players.forEach((p, i) => (p.role = roles[i]!));
  state.phase = "night";
  state.round = 1;
  state.nightStage = "actions";
  return state;
}

/** p1 p2 wolves · p3 seer · p4-p6 villagers (no witch in play). */
const noWitchSix: Role[] = ["werewolf", "werewolf", "seer", "villager", "villager", "villager"];
/** p1 p2 wolves · p3 seer · p4 witch · p5 p6 villagers. */
const witchSix: Role[] = ["werewolf", "werewolf", "seer", "witch", "villager", "villager"];
/** p1 p2 wolves · p3 seer · p4 witch · p5 hunter · p6-p8 villagers. */
const hunterEight: Role[] = [
  "werewolf",
  "werewolf",
  "seer",
  "witch",
  "hunter",
  "villager",
  "villager",
  "villager",
];

describe("role sheet", () => {
  it("werewolfCountFor follows the size table", () => {
    expect(werewolfCountFor(6)).toBe(2);
    expect(werewolfCountFor(8)).toBe(2);
    expect(werewolfCountFor(9)).toBe(3);
    expect(werewolfCountFor(11)).toBe(3);
    expect(werewolfCountFor(12)).toBe(4);
  });

  it("rolesFor always seats a seer and a witch, hunter from 8 up", () => {
    expect(rolesFor(6).filter((r) => r === "witch")).toHaveLength(1);
    expect(rolesFor(6)).not.toContain("hunter");
    expect(rolesFor(7)).not.toContain("hunter");
    expect(rolesFor(8).filter((r) => r === "hunter")).toHaveLength(1);
    expect(rolesFor(12)).toEqual(
      expect.arrayContaining(["werewolf", "seer", "witch", "hunter", "villager"]),
    );
    expect(rolesFor(9)).toHaveLength(9);
  });
});

describe("joinPlayer", () => {
  it("seats players in order and makes the first player host", () => {
    const state = lobbyWith(3);
    expect(state.hostId).toBe("p1");
    expect(state.players.map((p) => p.seat)).toEqual([1, 2, 3]);
  });

  it("rejects a 13th player", () => {
    const state = lobbyWith(12);
    expect(joinPlayer(state, "p13", "太多人")).toEqual({ ok: false, code: "room_full" });
  });

  it("rejects new players after the game started, but rebinds known ones", () => {
    const state = startedGame(noWitchSix);
    expect(joinPlayer(state, "latecomer", "遲到")).toEqual({ ok: false, code: "game_started" });
    const back = joinPlayer(state, "p2", "玩家2");
    expect(back.ok && back.value.seat === 2).toBe(true);
    expect(state.players).toHaveLength(6);
  });
});

describe("assignRoles / startGame", () => {
  it("deals the full sheet for 8 players", () => {
    const state = lobbyWith(8);
    assignRoles(state, mulberry32(7));
    const roles = state.players.map((p) => p.role);
    expect(roles.filter((r) => r === "werewolf")).toHaveLength(2);
    expect(roles.filter((r) => r === "seer")).toHaveLength(1);
    expect(roles.filter((r) => r === "witch")).toHaveLength(1);
    expect(roles.filter((r) => r === "hunter")).toHaveLength(1);
    expect(roles.filter((r) => r === "villager")).toHaveLength(3);
  });

  it("is deterministic for a fixed seed", () => {
    const a = lobbyWith(9);
    const b = lobbyWith(9);
    assignRoles(a, mulberry32(42));
    assignRoles(b, mulberry32(42));
    expect(a.players.map((p) => p.role)).toEqual(b.players.map((p) => p.role));
  });

  it("only the host starts, with 6-12 players, and options stick", () => {
    const five = lobbyWith(5);
    expect(startGame(five, "p1", mulberry32(1))).toEqual({ ok: false, code: "bad_player_count" });

    const six = lobbyWith(6);
    expect(startGame(six, "p2", mulberry32(1))).toEqual({ ok: false, code: "not_host" });

    const ok = startGame(six, "p1", mulberry32(1), { revealOnDeath: true });
    expect(ok.ok).toBe(true);
    expect(six.phase).toBe("night");
    expect(six.nightStage).toBe("actions");
    expect(six.round).toBe(1);
    expect(six.config.revealOnDeath).toBe(true);
    expect(six.players.every((p) => p.role !== null)).toBe(true);

    expect(startGame(six, "p1", mulberry32(1))).toEqual({ ok: false, code: "wrong_phase" });
  });
});

describe("tally", () => {
  it("finds the unique plurality target", () => {
    expect(tally({ a: "x", b: "x", c: "y" })).toEqual({ top: "x", tied: [] });
  });
  it("reports ties and empty votes", () => {
    expect(tally({ a: "x", b: "y" })).toEqual({ top: null, tied: expect.arrayContaining(["x", "y"]) });
    expect(tally({})).toEqual({ top: null, tied: [] });
  });
});

describe("night · wolves and seer", () => {
  it("validates phase, actor, role, and target", () => {
    const state = startedGame(noWitchSix);
    expect(nightAction(state, "p4", "kill", "p5")).toEqual({ ok: false, code: "wrong_role" });
    expect(nightAction(state, "p1", "inspect", "p5")).toEqual({ ok: false, code: "wrong_role" });
    expect(nightAction(state, "ghost", "kill", "p5")).toEqual({ ok: false, code: "not_in_room" });
    expect(nightAction(state, "p1", "kill", "ghost")).toEqual({ ok: false, code: "bad_target" });
    expect(nightAction(state, "p3", "inspect", "p3")).toEqual({ ok: false, code: "bad_target" });

    state.players[4]!.alive = false;
    expect(nightAction(state, "p1", "kill", "p5")).toEqual({ ok: false, code: "bad_target" });
    state.players[0]!.alive = false;
    expect(nightAction(state, "p1", "kill", "p6")).toEqual({ ok: false, code: "not_alive" });
    state.players[0]!.alive = true;

    state.phase = "day";
    expect(nightAction(state, "p1", "kill", "p4")).toEqual({ ok: false, code: "wrong_phase" });
  });

  it("resolves straight to day when no witch is in play", () => {
    const state = startedGame(noWitchSix);
    expect(nightAction(state, "p1", "kill", "p4")).toMatchObject({ ok: true, value: { kind: "pending" } });
    nightAction(state, "p2", "kill", "p4");
    const last = nightAction(state, "p3", "inspect", "p1");
    expect(last.ok).toBe(true);
    if (!last.ok) return;
    expect(last.value).toMatchObject({
      kind: "resolved",
      deaths: ["p4"],
      seer: { round: 1, targetId: "p1", faction: "werewolf" },
      hunterId: null,
      winner: null,
    });
    expect(state.phase).toBe("day");
    expect(state.players[3]!.alive).toBe(false);
  });

  it("kills nobody when the wolves tie, and wolves may re-pick before the stage ends", () => {
    const state = startedGame(noWitchSix);
    nightAction(state, "p1", "kill", "p4");
    nightAction(state, "p1", "kill", "p5"); // overwrite own pick
    nightAction(state, "p2", "kill", "p4");
    const last = nightAction(state, "p3", "inspect", "p4");
    expect(last.ok && last.value.kind === "resolved" && last.value.deaths).toEqual([]);
    expect(alivePlayers(state)).toHaveLength(6);
  });

  it("resolves without the seer once the seer is dead", () => {
    const state = startedGame(noWitchSix);
    state.players[2]!.alive = false;
    nightAction(state, "p1", "kill", "p4");
    const last = nightAction(state, "p2", "kill", "p4");
    expect(last.ok && last.value.kind === "resolved" && last.value.seer === null).toBe(true);
  });
});

describe("night · witch", () => {
  function witchStage(state: GameState, killTarget = "p5"): void {
    nightAction(state, "p1", "kill", killTarget);
    nightAction(state, "p2", "kill", killTarget);
    const out = nightAction(state, "p3", "inspect", "p1");
    expect(out.ok && out.value.kind === "witch").toBe(true);
  }

  it("wakes the witch with the victim and her potion options", () => {
    const state = startedGame(witchSix);
    nightAction(state, "p1", "kill", "p5");
    nightAction(state, "p2", "kill", "p5");
    const out = nightAction(state, "p3", "inspect", "p1");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toEqual({ kind: "witch", victimId: "p5", canSave: true, canPoison: true });
    expect(state.nightStage).toBe("witch");
    // Wolves and seer cannot act during the witch's beat.
    expect(nightAction(state, "p1", "kill", "p6")).toEqual({ ok: false, code: "wrong_phase" });
  });

  it("the antidote cancels the kill and is single-use", () => {
    const state = startedGame(witchSix);
    witchStage(state);
    const saved = nightAction(state, "p4", "save");
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value).toMatchObject({ kind: "resolved", deaths: [], winner: null });
    expect(state.players[4]!.alive).toBe(true);
    expect(state.witch.saveUsed).toBe(true);
    expect(state.phase).toBe("day");

    // Next night: save is spent, so only poison remains on the wake call.
    for (const voter of ["p1", "p2", "p3", "p4", "p5", "p6"]) castVote(state, voter, "p6");
    expect(state.phase).toBe("night");
    nightAction(state, "p1", "kill", "p5");
    nightAction(state, "p2", "kill", "p5");
    const out = nightAction(state, "p3", "inspect", "p2");
    expect(out.ok && out.value.kind === "witch" && !out.value.canSave && out.value.canPoison).toBe(true);
    expect(nightAction(state, "p4", "save")).toEqual({ ok: false, code: "no_potion" });
  });

  it("poison stacks a second death and only one potion fits a night", () => {
    const state = startedGame(witchSix);
    witchStage(state);
    const poisoned = nightAction(state, "p4", "poison", "p1");
    expect(poisoned.ok).toBe(true);
    if (!poisoned.ok) return;
    expect(poisoned.value).toMatchObject({ kind: "resolved" });
    if (poisoned.value.kind !== "resolved") return;
    expect(poisoned.value.deaths.sort()).toEqual(["p1", "p5"]);
    expect(state.witch.poisonUsed).toBe(true);
    // Her single action resolved the night on the spot, so a second potion
    // finds no witch beat left to act in.
    expect(nightAction(state, "p4", "save")).toEqual({ ok: false, code: "wrong_phase" });
  });

  it("guards the witch beat: role, stage, and dead witches", () => {
    const state = startedGame(witchSix);
    expect(nightAction(state, "p4", "save")).toEqual({ ok: false, code: "wrong_phase" });
    expect(nightAction(state, "p5", "save")).toEqual({ ok: false, code: "wrong_role" });

    // A dead witch never wakes: the night resolves directly.
    const state2 = startedGame(witchSix);
    state2.players[3]!.alive = false;
    nightAction(state2, "p1", "kill", "p5");
    nightAction(state2, "p2", "kill", "p5");
    const out = nightAction(state2, "p3", "inspect", "p1");
    expect(out.ok && out.value.kind === "resolved" && out.value.deaths).toEqual(["p5"]);
  });

  it("a tied kill still wakes the witch, but with no one to save", () => {
    const state = startedGame(witchSix);
    nightAction(state, "p1", "kill", "p5");
    nightAction(state, "p2", "kill", "p6");
    const out = nightAction(state, "p3", "inspect", "p1");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toEqual({ kind: "witch", victimId: null, canSave: false, canPoison: true });
    expect(nightAction(state, "p4", "save")).toEqual({ ok: false, code: "no_potion" });
    const skip = nightAction(state, "p4", "skip");
    expect(skip.ok && skip.value.kind === "resolved" && skip.value.deaths).toEqual([]);
  });
});

describe("hunt", () => {
  it("a wolf-killed hunter shoots at dawn, then the day begins", () => {
    const state = startedGame(hunterEight);
    nightAction(state, "p1", "kill", "p5");
    nightAction(state, "p2", "kill", "p5");
    nightAction(state, "p3", "inspect", "p1");
    const out = nightAction(state, "p4", "skip");
    expect(out.ok).toBe(true);
    if (!out.ok || out.value.kind !== "resolved") return;
    expect(out.value.hunterId).toBe("p5");
    expect(state.phase).toBe("hunt");

    expect(huntShot(state, "p6", "p1")).toEqual({ ok: false, code: "wrong_role" });
    expect(huntShot(state, "p5", "p5")).toEqual({ ok: false, code: "bad_target" });

    const shot = huntShot(state, "p5", "p1");
    expect(shot.ok && shot.value.shotId === "p1").toBe(true);
    expect(state.players[0]!.alive).toBe(false);
    expect(state.phase).toBe("day");
    expect(state.round).toBe(1);
  });

  it("a poisoned hunter cannot shoot", () => {
    const state = startedGame(hunterEight);
    nightAction(state, "p1", "kill", "p6");
    nightAction(state, "p2", "kill", "p6");
    nightAction(state, "p3", "inspect", "p1");
    const out = nightAction(state, "p4", "poison", "p5");
    expect(out.ok).toBe(true);
    if (!out.ok || out.value.kind !== "resolved") return;
    expect(out.value.deaths.sort()).toEqual(["p5", "p6"]);
    expect(out.value.hunterId).toBeNull();
    expect(state.phase).toBe("day");
  });

  it("a voted-out hunter shoots, then night falls", () => {
    const state = startedGame(hunterEight);
    state.phase = "day";
    state.nightStage = null;
    for (const voter of ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]) {
      castVote(state, voter, "p5");
    }
    expect(state.phase).toBe("hunt");
    const shot = huntShot(state, "p5", null); // holster
    expect(shot.ok && shot.value.shotId === null).toBe(true);
    expect(state.phase).toBe("night");
    expect(state.round).toBe(2);
    expect(state.nightStage).toBe("actions");
  });

  it("the dying shot can decide the game", () => {
    const state = startedGame(hunterEight);
    // Only one wolf left; wolves killed the hunter overnight.
    state.players[1]!.alive = false; // p2 wolf dead
    nightAction(state, "p1", "kill", "p5");
    nightAction(state, "p3", "inspect", "p1");
    nightAction(state, "p4", "skip");
    expect(state.phase).toBe("hunt");
    const shot = huntShot(state, "p5", "p1");
    expect(shot.ok && shot.value.winner === "villagers").toBe(true);
    expect(state.phase).toBe("ended");
  });
});

describe("day · vote and runoff", () => {
  function atDay(): GameState {
    const state = startedGame(noWitchSix);
    nightAction(state, "p1", "kill", "p4");
    nightAction(state, "p2", "kill", "p4");
    nightAction(state, "p3", "inspect", "p1");
    expect(state.phase).toBe("day");
    return state; // alive: p1 p2 p3 p5 p6
  }

  it("validates voter and target", () => {
    const state = atDay();
    expect(castVote(state, "p4", "p1")).toEqual({ ok: false, code: "not_alive" });
    expect(castVote(state, "p1", "p4")).toEqual({ ok: false, code: "bad_target" });
    expect(castVote(state, "p1", "p5").ok).toBe(true);
    expect(castVote(state, "p1", "p6")).toEqual({ ok: false, code: "already_voted" });
  });

  it("eliminates the unique plurality target and reveals the ballots", () => {
    const state = atDay();
    castVote(state, "p3", "p1");
    castVote(state, "p5", "p1");
    castVote(state, "p1", "p3");
    castVote(state, "p2", "p3");
    const last = castVote(state, "p6", "p1");
    expect(last.ok).toBe(true);
    if (!last.ok || last.value.kind !== "resolved") return;
    expect(last.value.eliminatedId).toBe("p1");
    expect(last.value.voteReveal).toHaveLength(5);
    expect(last.value.voteReveal).toContainEqual({ voterId: "p6", targetId: "p1" });
    expect(state.phase).toBe("night");
    expect(state.round).toBe(2);
  });

  it("a tie opens a runoff: candidates defend and cannot vote", () => {
    const state = atDay();
    // 2-2-1 across p1 / p5 / p6 -> runoff between p1 and p5.
    castVote(state, "p3", "p1");
    castVote(state, "p5", "p1");
    castVote(state, "p1", "p5");
    castVote(state, "p2", "p5");
    const tied = castVote(state, "p6", "p6"); // self-vote is legal
    expect(tied.ok).toBe(true);
    if (!tied.ok) return;
    expect(tied.value.kind).toBe("runoff");
    if (tied.value.kind !== "runoff") return;
    expect(tied.value.runoffIds.sort()).toEqual(["p1", "p5"]);
    expect(tied.value.voteReveal).toHaveLength(5);
    expect(state.phase).toBe("day");

    // Candidates cannot vote; ballots must name a candidate.
    expect(castVote(state, "p1", "p5")).toEqual({ ok: false, code: "runoff_candidate" });
    expect(castVote(state, "p2", "p6")).toEqual({ ok: false, code: "bad_target" });

    // Revote: the wolf p1 goes down 2-1, so the game continues.
    castVote(state, "p2", "p5");
    castVote(state, "p3", "p1");
    const final = castVote(state, "p6", "p1");
    expect(final.ok && final.value.kind === "resolved" && final.value.eliminatedId === "p1").toBe(true);
    expect(state.runoffIds).toBeNull();
    expect(state.phase).toBe("night");
  });

  it("a tied runoff eliminates nobody", () => {
    const state = atDay();
    castVote(state, "p1", "p3");
    castVote(state, "p2", "p3");
    castVote(state, "p3", "p5");
    castVote(state, "p5", "p6");
    castVote(state, "p6", "p5"); // runoff between p3 and p5
    castVote(state, "p1", "p3");
    castVote(state, "p2", "p5");
    const final = castVote(state, "p6", "p3"); // 2-1... wait: p3=2 (p1,p6), p5=1 (p2)
    expect(final.ok && final.value.kind === "resolved" && final.value.eliminatedId === "p3").toBe(true);

    // Build an actual tied runoff on a fresh day.
    const s2 = atDay();
    castVote(s2, "p1", "p3");
    castVote(s2, "p2", "p3");
    castVote(s2, "p3", "p5");
    castVote(s2, "p5", "p6");
    castVote(s2, "p6", "p5"); // runoff p3 vs p5; voters p1 p2 p6
    castVote(s2, "p1", "p3");
    castVote(s2, "p2", "p5");
    // p6 abstains -> timeout closes the vote 1-1.
    const out = timeoutDay(s2);
    expect(out.kind === "resolved" && out.eliminatedId === null).toBe(true);
    expect(alivePlayers(s2)).toHaveLength(5);
    expect(s2.phase).toBe("night");
  });
});

describe("timeouts", () => {
  it("closes the actions stage with the ballots that were cast", () => {
    const state = startedGame(noWitchSix);
    nightAction(state, "p1", "kill", "p4"); // p2 and the seer sleep on
    const out = timeoutNightActions(state);
    expect(out.kind === "resolved" && out.deaths).toEqual(["p4"]);
    expect(state.phase).toBe("day");
  });

  it("a fully silent night kills nobody", () => {
    const state = startedGame(noWitchSix);
    const out = timeoutNightActions(state);
    expect(out.kind === "resolved" && out.deaths).toEqual([]);
    expect(state.phase).toBe("day");
  });

  it("still wakes the witch after a wolf timeout, then her timeout skips", () => {
    const state = startedGame(witchSix);
    nightAction(state, "p1", "kill", "p5");
    nightAction(state, "p2", "kill", "p5");
    const out = timeoutNightActions(state); // seer overslept
    expect(out.kind).toBe("witch");
    const resolved = timeoutWitch(state);
    expect(resolved.kind === "resolved" && resolved.deaths).toEqual(["p5"]);
    expect(resolved.kind === "resolved" && resolved.seer).toBeNull();
  });

  it("closes the day vote and the hunt on deadline", () => {
    const state = startedGame(noWitchSix);
    state.phase = "day";
    state.nightStage = null;
    castVote(state, "p1", "p3");
    const out = timeoutDay(state);
    expect(out.kind === "resolved" && out.eliminatedId === "p3").toBe(true);

    const h = startedGame(hunterEight);
    h.phase = "hunt";
    h.nightStage = null;
    h.players[4]!.alive = false;
    h.hunter = { pendingId: "p5", next: "day" };
    const hunted = timeoutHunt(h);
    expect(hunted.shotId).toBeNull();
    expect(h.phase).toBe("day");
  });
});

describe("win conditions and endgame", () => {
  it("villagers win when the last wolf is voted out", () => {
    const state = startedGame(noWitchSix);
    state.players[1]!.alive = false;
    state.phase = "day";
    state.nightStage = null;
    for (const voter of ["p1", "p3", "p4", "p5", "p6"]) castVote(state, voter, "p1");
    expect(state.winner).toBe("villagers");
    expect(state.phase).toBe("ended");
  });

  it("wolves win on parity through a night kill", () => {
    const state = startedGame(noWitchSix);
    state.players[5]!.alive = false;
    nightAction(state, "p1", "kill", "p4");
    nightAction(state, "p2", "kill", "p4");
    const last = nightAction(state, "p3", "inspect", "p1");
    expect(last.ok && last.value.kind === "resolved" && last.value.winner === "werewolves").toBe(true);
  });

  it("checkWin is null while both sides live", () => {
    expect(checkWin(startedGame(noWitchSix))).toBeNull();
  });

  it("rejects actions after the game ended, then restart re-opens the lobby", () => {
    const state = startedGame(noWitchSix);
    state.players[0]!.alive = false;
    state.phase = "ended";
    state.winner = "villagers";
    state.lastWords = { p1: 1 };
    expect(nightAction(state, "p1", "kill", "p4")).toEqual({ ok: false, code: "wrong_phase" });
    expect(castVote(state, "p1", "p4")).toEqual({ ok: false, code: "wrong_phase" });

    expect(restartGame(state, "p2")).toEqual({ ok: false, code: "not_host" });
    const restarted = restartGame(state, "p1");
    expect(restarted.ok).toBe(true);
    expect(state.phase).toBe("lobby");
    expect(state.round).toBe(0);
    expect(state.winner).toBeNull();
    expect(state.players.every((p) => p.alive && p.role === null)).toBe(true);
    expect(state.players.map((p) => p.seat)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.witch).toEqual({ saveUsed: false, poisonUsed: false, action: null });
    expect(state.lastWords).toEqual({});

    expect(restartGame(state, "p1")).toEqual({ ok: false, code: "wrong_phase" });
  });
});

describe("last words", () => {
  it("grants one credit per death and spends it once", () => {
    const state = startedGame(noWitchSix);
    nightAction(state, "p1", "kill", "p4");
    nightAction(state, "p2", "kill", "p4");
    nightAction(state, "p3", "inspect", "p1");
    expect(state.lastWords["p4"]).toBe(1);
    expect(spendLastWords(state, "p4")).toBe(true);
    expect(spendLastWords(state, "p4")).toBe(false);
    expect(spendLastWords(state, "p5")).toBe(false); // alive players have no credit
  });
});
