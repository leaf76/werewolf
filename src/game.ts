/**
 * Pure game rules for the werewolf room. No I/O, no Durable Object types,
 * no clocks — timers live in the DO, which calls the timeout* functions
 * below when a deadline fires. Randomness is injected so every rule is
 * deterministic under test.
 *
 * State is mutated in place: a DO is single-threaded per instance and
 * persists the whole state object after each successful transition.
 */

import type { Faction, Phase, NightStage, Role, VoteReveal, Winner } from "./protocol";
import { MAX_PLAYERS, MIN_PLAYERS } from "./protocol";

export interface GamePlayer {
  id: string;
  name: string;
  seat: number;
  alive: boolean;
  role: Role | null;
}

export interface SeerRecord {
  round: number;
  targetId: string;
  faction: Faction;
}

export type WitchAction = { kind: "save" } | { kind: "poison"; targetId: string } | { kind: "skip" };

export interface GameState {
  code: string;
  phase: Phase;
  round: number;
  hostId: string | null;
  players: GamePlayer[];
  config: { revealOnDeath: boolean };
  /** Which beat of the night script is running (null outside night). */
  nightStage: NightStage | null;
  /** Current night: werewolfId -> targetId (overwritable until the stage ends). */
  killVotes: Record<string, string>;
  /** Current night: the seer's chosen target, if submitted. */
  inspectTarget: string | null;
  /** Every inspection ever made, so a reconnecting seer can be replayed. */
  seerHistory: SeerRecord[];
  /** The wolves' decided victim, held while the witch considers her potions. */
  pendingVictimId: string | null;
  witch: { saveUsed: boolean; poisonUsed: boolean; action: WitchAction | null };
  /** Current day: voterId -> targetId (immutable once cast). */
  dayVotes: Record<string, string>;
  /** Tied candidates of the current runoff revote, if any. */
  runoffIds: string[] | null;
  /** Set while a dead hunter decides; next = where the game resumes after. */
  hunter: { pendingId: string | null; next: "day" | "night" | null };
  /** playerId -> remaining last-words chat credits (granted on death). */
  lastWords: Record<string, number>;
  winner: Winner | null;
}

export type ErrorCode =
  | "room_full"
  | "game_started"
  | "not_host"
  | "wrong_phase"
  | "bad_player_count"
  | "not_in_room"
  | "not_alive"
  | "wrong_role"
  | "bad_target"
  | "already_voted"
  | "already_acted"
  | "no_potion"
  | "runoff_candidate";

export type Result<T> = { ok: true; value: T } | { ok: false; code: ErrorCode };

export type NightOutcome =
  | { kind: "pending" }
  | { kind: "witch"; victimId: string | null; canSave: boolean; canPoison: boolean }
  | {
      kind: "resolved";
      deaths: string[];
      seer: SeerRecord | null;
      /** Set when the game pauses for the dead hunter's shot. */
      hunterId: string | null;
      winner: Winner | null;
    };

export type DayOutcome =
  | { kind: "pending" }
  | { kind: "runoff"; runoffIds: string[]; voteReveal: VoteReveal[] }
  | {
      kind: "resolved";
      eliminatedId: string | null;
      voteReveal: VoteReveal[];
      hunterId: string | null;
      winner: Winner | null;
    };

export interface HuntOutcome {
  shotId: string | null;
  winner: Winner | null;
}

export function newGame(code: string): GameState {
  return {
    code,
    phase: "lobby",
    round: 0,
    hostId: null,
    players: [],
    config: { revealOnDeath: false },
    nightStage: null,
    killVotes: {},
    inspectTarget: null,
    seerHistory: [],
    pendingVictimId: null,
    witch: { saveUsed: false, poisonUsed: false, action: null },
    dayVotes: {},
    runoffIds: null,
    hunter: { pendingId: null, next: null },
    lastWords: {},
    winner: null,
  };
}

/** 6-8 players -> 2 wolves, 9-11 -> 3, 12 -> 4. */
export function werewolfCountFor(playerCount: number): number {
  if (playerCount >= 12) return 4;
  if (playerCount >= 9) return 3;
  return 2;
}

/** Role sheet: wolves by table, 1 seer, 1 witch, hunter from 8 players up. */
export function rolesFor(playerCount: number): Role[] {
  const wolves = werewolfCountFor(playerCount);
  const roles: Role[] = [];
  for (let i = 0; i < wolves; i++) roles.push("werewolf");
  roles.push("seer");
  roles.push("witch");
  if (playerCount >= 8) roles.push("hunter");
  while (roles.length < playerCount) roles.push("villager");
  return roles;
}

/**
 * Lobby join, or rebind of a known player in any phase.
 * New players get the next seat; the first player becomes host.
 */
export function joinPlayer(state: GameState, id: string, name: string): Result<GamePlayer> {
  const existing = state.players.find((p) => p.id === id);
  if (existing) return { ok: true, value: existing };
  if (state.phase !== "lobby") return { ok: false, code: "game_started" };
  if (state.players.length >= MAX_PLAYERS) return { ok: false, code: "room_full" };

  const player: GamePlayer = {
    id,
    name,
    seat: state.players.length + 1,
    alive: true,
    role: null,
  };
  state.players.push(player);
  if (state.hostId === null) state.hostId = id;
  return { ok: true, value: player };
}

/** Shuffle the role sheet onto players using the injected random source. */
export function assignRoles(state: GameState, random: () => number): void {
  const roles = rolesFor(state.players.length);
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = roles[i]!;
    roles[i] = roles[j]!;
    roles[j] = tmp;
  }
  state.players.forEach((p, i) => {
    p.role = roles[i]!;
  });
}

export function startGame(
  state: GameState,
  byPlayerId: string,
  random: () => number,
  options?: { revealOnDeath?: boolean },
): Result<null> {
  if (state.phase !== "lobby") return { ok: false, code: "wrong_phase" };
  if (state.hostId !== byPlayerId) return { ok: false, code: "not_host" };
  const n = state.players.length;
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) return { ok: false, code: "bad_player_count" };

  assignRoles(state, random);
  state.config.revealOnDeath = options?.revealOnDeath ?? false;
  state.phase = "night";
  state.round = 1;
  state.nightStage = "actions";
  return { ok: true, value: null };
}

/** Host resets the finished room back to the lobby with the same seats. */
export function restartGame(state: GameState, byPlayerId: string): Result<null> {
  if (state.phase !== "ended") return { ok: false, code: "wrong_phase" };
  if (state.hostId !== byPlayerId) return { ok: false, code: "not_host" };

  state.phase = "lobby";
  state.round = 0;
  state.winner = null;
  state.nightStage = null;
  state.killVotes = {};
  state.inspectTarget = null;
  state.seerHistory = [];
  state.pendingVictimId = null;
  state.witch = { saveUsed: false, poisonUsed: false, action: null };
  state.dayVotes = {};
  state.runoffIds = null;
  state.hunter = { pendingId: null, next: null };
  state.lastWords = {};
  for (const p of state.players) {
    p.alive = true;
    p.role = null;
  }
  return { ok: true, value: null };
}

// ---------- night ----------

export function nightAction(
  state: GameState,
  byPlayerId: string,
  action: "kill" | "inspect" | "save" | "poison" | "skip",
  targetId?: string,
): Result<NightOutcome> {
  if (state.phase !== "night") return { ok: false, code: "wrong_phase" };
  const actor = state.players.find((p) => p.id === byPlayerId);
  if (!actor) return { ok: false, code: "not_in_room" };
  if (!actor.alive) return { ok: false, code: "not_alive" };

  if (action === "kill" || action === "inspect") {
    if (state.nightStage !== "actions") return { ok: false, code: "wrong_phase" };
    const requiredRole: Role = action === "kill" ? "werewolf" : "seer";
    if (actor.role !== requiredRole) return { ok: false, code: "wrong_role" };
    const target = state.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return { ok: false, code: "bad_target" };
    // A self-check is always wasted; block it so misclicks don't burn the night.
    if (action === "inspect" && target.id === actor.id) return { ok: false, code: "bad_target" };

    if (action === "kill") state.killVotes[byPlayerId] = target.id;
    else state.inspectTarget = target.id;
    return { ok: true, value: maybeFinishActionsStage(state) };
  }

  // save / poison / skip — the witch's beat.
  if (actor.role !== "witch") return { ok: false, code: "wrong_role" };
  if (state.nightStage !== "witch") return { ok: false, code: "wrong_phase" };
  if (state.witch.action) return { ok: false, code: "already_acted" };

  if (action === "save") {
    if (state.witch.saveUsed || state.pendingVictimId === null) return { ok: false, code: "no_potion" };
    state.witch.action = { kind: "save" };
  } else if (action === "poison") {
    if (state.witch.poisonUsed) return { ok: false, code: "no_potion" };
    const target = state.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return { ok: false, code: "bad_target" };
    state.witch.action = { kind: "poison", targetId: target.id };
  } else {
    state.witch.action = { kind: "skip" };
  }
  return { ok: true, value: resolveNight(state) };
}

/** DO deadline: force the actions stage closed with whatever was submitted. */
export function timeoutNightActions(state: GameState): NightOutcome {
  return finishActionsStage(state);
}

/** DO deadline: the witch sleeps through her window. */
export function timeoutWitch(state: GameState): NightOutcome {
  state.witch.action = { kind: "skip" };
  return resolveNight(state);
}

function maybeFinishActionsStage(state: GameState): NightOutcome {
  const pendingWolf = state.players.some(
    (p) => p.alive && p.role === "werewolf" && !state.killVotes[p.id],
  );
  const seerAlive = state.players.some((p) => p.alive && p.role === "seer");
  const pendingSeer = seerAlive && state.inspectTarget === null;
  if (pendingWolf || pendingSeer) return { kind: "pending" };
  return finishActionsStage(state);
}

function finishActionsStage(state: GameState): NightOutcome {
  state.pendingVictimId = tally(state.killVotes).top;

  const witch = state.players.find((p) => p.role === "witch");
  const canSave = !!witch?.alive && !state.witch.saveUsed && state.pendingVictimId !== null;
  const canPoison = !!witch?.alive && !state.witch.poisonUsed;
  if (witch?.alive && (canSave || canPoison)) {
    state.nightStage = "witch";
    return { kind: "witch", victimId: state.pendingVictimId, canSave, canPoison };
  }
  state.witch.action = { kind: "skip" };
  return resolveNight(state);
}

function resolveNight(state: GameState): NightOutcome {
  // Record the inspection (delivered at dawn, replayable on reconnect).
  let seer: SeerRecord | null = null;
  if (state.inspectTarget !== null) {
    const target = state.players.find((p) => p.id === state.inspectTarget);
    if (target) {
      seer = {
        round: state.round,
        targetId: target.id,
        faction: target.role === "werewolf" ? "werewolf" : "good",
      };
      state.seerHistory.push(seer);
    }
  }

  const deaths: string[] = [];
  const action = state.witch.action;
  let victimId = state.pendingVictimId;
  if (action?.kind === "save") {
    state.witch.saveUsed = true;
    victimId = null;
  }
  if (victimId) deaths.push(victimId);

  let poisonedId: string | null = null;
  if (action?.kind === "poison") {
    state.witch.poisonUsed = true;
    poisonedId = action.targetId;
    if (!deaths.includes(poisonedId)) deaths.push(poisonedId);
  }

  for (const id of deaths) killPlayer(state, id);

  // Reset the night workspace.
  state.killVotes = {};
  state.inspectTarget = null;
  state.pendingVictimId = null;
  state.witch.action = null;
  state.nightStage = null;

  // A wolf-killed hunter shoots at dawn; a poisoned hunter cannot.
  const hunter = deaths
    .map((id) => state.players.find((p) => p.id === id))
    .find((p) => p?.role === "hunter" && p.id !== poisonedId);
  if (hunter) {
    state.phase = "hunt";
    state.hunter = { pendingId: hunter.id, next: "day" };
    return { kind: "resolved", deaths, seer, hunterId: hunter.id, winner: null };
  }

  const winner = checkWin(state);
  if (winner) {
    state.winner = winner;
    state.phase = "ended";
  } else {
    state.phase = "day";
    state.dayVotes = {};
    state.runoffIds = null;
  }
  return { kind: "resolved", deaths, seer, hunterId: null, winner };
}

// ---------- day ----------

export function castVote(state: GameState, byPlayerId: string, targetId: string): Result<DayOutcome> {
  if (state.phase !== "day") return { ok: false, code: "wrong_phase" };
  const voter = state.players.find((p) => p.id === byPlayerId);
  if (!voter) return { ok: false, code: "not_in_room" };
  if (!voter.alive) return { ok: false, code: "not_alive" };
  if (state.runoffIds?.includes(byPlayerId)) return { ok: false, code: "runoff_candidate" };
  if (state.dayVotes[byPlayerId]) return { ok: false, code: "already_voted" };
  const target = state.players.find((p) => p.id === targetId);
  if (!target || !target.alive) return { ok: false, code: "bad_target" };
  if (state.runoffIds && !state.runoffIds.includes(targetId)) return { ok: false, code: "bad_target" };

  state.dayVotes[byPlayerId] = targetId;

  const pending = state.players.some((p) => p.alive && eligibleVoter(state, p.id) && !state.dayVotes[p.id]);
  if (pending) return { ok: true, value: { kind: "pending" } };
  return { ok: true, value: resolveDay(state) };
}

/** DO deadline: close the vote with whatever ballots were cast. */
export function timeoutDay(state: GameState): DayOutcome {
  return resolveDay(state);
}

function eligibleVoter(state: GameState, playerId: string): boolean {
  return !state.runoffIds || !state.runoffIds.includes(playerId);
}

function resolveDay(state: GameState): DayOutcome {
  const voteReveal: VoteReveal[] = Object.entries(state.dayVotes).map(([voterId, targetId]) => ({
    voterId,
    targetId,
  }));
  const { top, tied } = tally(state.dayVotes);
  const wasRunoff = state.runoffIds !== null;
  state.dayVotes = {};

  if (top === null && tied.length > 1 && !wasRunoff) {
    // First tie of the day: the tied candidates defend, everyone else revotes.
    const everyoneTied = !state.players.some((p) => p.alive && !tied.includes(p.id));
    if (!everyoneTied) {
      state.runoffIds = tied;
      return { kind: "runoff", runoffIds: tied, voteReveal };
    }
  }

  state.runoffIds = null;
  const eliminatedId = top;
  if (eliminatedId) killPlayer(state, eliminatedId);

  const eliminated = eliminatedId ? state.players.find((p) => p.id === eliminatedId) : undefined;
  if (eliminated?.role === "hunter") {
    state.phase = "hunt";
    state.hunter = { pendingId: eliminated.id, next: "night" };
    return { kind: "resolved", eliminatedId, voteReveal, hunterId: eliminated.id, winner: null };
  }

  const winner = checkWin(state);
  if (winner) {
    state.winner = winner;
    state.phase = "ended";
  } else {
    beginNight(state);
  }
  return { kind: "resolved", eliminatedId, voteReveal, hunterId: null, winner };
}

// ---------- hunt ----------

export function huntShot(state: GameState, byPlayerId: string, targetId: string | null): Result<HuntOutcome> {
  if (state.phase !== "hunt") return { ok: false, code: "wrong_phase" };
  if (state.hunter.pendingId !== byPlayerId) return { ok: false, code: "wrong_role" };

  let shotId: string | null = null;
  if (targetId !== null) {
    const target = state.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return { ok: false, code: "bad_target" };
    shotId = target.id;
    killPlayer(state, target.id);
  }
  return { ok: true, value: finishHunt(state, shotId) };
}

/** DO deadline: the hunter holsters. */
export function timeoutHunt(state: GameState): HuntOutcome {
  return finishHunt(state, null);
}

function finishHunt(state: GameState, shotId: string | null): HuntOutcome {
  const resumeAt = state.hunter.next;
  state.hunter = { pendingId: null, next: null };

  const winner = checkWin(state);
  if (winner) {
    state.winner = winner;
    state.phase = "ended";
  } else if (resumeAt === "night") {
    beginNight(state);
  } else {
    state.phase = "day";
    state.dayVotes = {};
    state.runoffIds = null;
  }
  return { shotId, winner };
}

// ---------- shared helpers ----------

function beginNight(state: GameState): void {
  state.phase = "night";
  state.round += 1;
  state.nightStage = "actions";
  state.killVotes = {};
  state.inspectTarget = null;
  state.pendingVictimId = null;
  state.witch.action = null;
}

function killPlayer(state: GameState, id: string): void {
  const player = state.players.find((p) => p.id === id);
  if (player && player.alive) {
    player.alive = false;
    state.lastWords[id] = 1;
  }
}

/** Spends one last-words credit; false if the player has none left. */
export function spendLastWords(state: GameState, playerId: string): boolean {
  const left = state.lastWords[playerId] ?? 0;
  if (left <= 0) return false;
  state.lastWords[playerId] = left - 1;
  return true;
}

/**
 * Plurality count. `top` is the unique winner or null; on a tie the tied
 * target ids are listed in `tied` (empty when there were no votes at all).
 */
export function tally(votes: Record<string, string>): { top: string | null; tied: string[] } {
  const counts = new Map<string, number>();
  for (const target of Object.values(votes)) {
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  let best = 0;
  for (const count of counts.values()) best = Math.max(best, count);
  if (best === 0) return { top: null, tied: [] };
  const leaders = [...counts.entries()].filter(([, c]) => c === best).map(([t]) => t);
  return leaders.length === 1 ? { top: leaders[0]!, tied: [] } : { top: null, tied: leaders };
}

/** Wolves all dead -> villagers win; wolves >= everyone else -> wolves win. */
export function checkWin(state: GameState): Winner | null {
  const alive = state.players.filter((p) => p.alive);
  const wolves = alive.filter((p) => p.role === "werewolf").length;
  if (wolves === 0) return "villagers";
  if (wolves >= alive.length - wolves) return "werewolves";
  return null;
}

export function alivePlayers(state: GameState): GamePlayer[] {
  return state.players.filter((p) => p.alive);
}
