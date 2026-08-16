/**
 * RoomDO — one Durable Object instance per room, the single source of truth.
 *
 * Clients connect over WebSockets (Hibernation API) and send intents; every
 * intent is validated here against the current game state. Private
 * information (roles, wolf picks, seer results, the witch's wake-up call) is
 * only ever unicast to the entitled player's sockets — broadcasts carry
 * public state exclusively.
 *
 * The DO also owns all clocks: phase deadlines and idle cleanup share the
 * single Durable Object alarm; rule consequences of a timeout live in
 * game.ts (timeout* functions).
 */

import { DurableObject } from "cloudflare:workers";
import * as g from "./game";
import {
  MAX_CHAT_LEN,
  MAX_NAME_LEN,
  MAX_SOCKETS,
  MAX_WS_BYTES,
  type ClientMessage,
  type PublicRoomState,
  type RoleReveal,
  type ServerMessage,
} from "./protocol";

interface Attachment {
  playerId: string;
  spectator?: boolean;
  /** Survives hibernation (WeakMap buckets do not). */
  chatTokens?: number;
  chatLast?: number;
}

export interface TimerConfig {
  nightMs: number;
  witchMs: number;
  dayMs: number;
  runoffMs: number;
  huntMs: number;
  idleMs: number;
  endedMs: number;
}

const DEFAULT_TIMERS: TimerConfig = {
  nightMs: 45_000,
  witchMs: 30_000,
  dayMs: 120_000,
  runoffMs: 45_000,
  huntMs: 30_000,
  idleMs: 24 * 3_600_000,
  endedMs: 2 * 3_600_000,
};

interface Deadlines {
  phaseAt: number | null;
  cleanupAt: number;
}

const PLAYER_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Chat flood control: bucket of 5, refills one message every 2 seconds. */
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 2_000;

export class RoomDO extends DurableObject<Env> {
  private game: g.GameState | null = null;
  private timers: TimerConfig = DEFAULT_TIMERS;
  private deadlines: Deadlines = { phaseAt: null, cleanupAt: 0 };
  /**
   * Per-seat session secrets (playerId -> secret). Kept out of GameState so
   * they can never ride along accidental public snapshots. Survives rematch;
   * wiped with the room on teardown.
   */
  private secrets: Record<string, string> = {};

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Reload state on every wake-up (hibernation resets memory).
    ctx.blockConcurrencyWhile(async () => {
      this.game = (await ctx.storage.get<g.GameState>("game")) ?? null;
      this.timers = (await ctx.storage.get<TimerConfig>("timer-config")) ?? DEFAULT_TIMERS;
      this.deadlines =
        (await ctx.storage.get<Deadlines>("deadlines")) ?? { phaseAt: null, cleanupAt: 0 };
      this.secrets = (await ctx.storage.get<Record<string, string>>("secrets")) ?? {};
    });
  }

  // ---------- RPC (called by the Worker and by tests) ----------

  /** Atomically claim a fresh room code. False if the room already exists. */
  async claim(code: string, opts?: { timers?: Partial<TimerConfig> }): Promise<boolean> {
    if (this.game) return false;
    this.game = g.newGame(code);
    this.timers = { ...DEFAULT_TIMERS, ...opts?.timers };
    await this.ctx.storage.put("timer-config", this.timers);
    await this.env.ROOM_INDEX.put(code.toUpperCase(), "1");
    await this.persist();
    await this.afterTransition();
    return true;
  }

  async exists(): Promise<boolean> {
    return this.game !== null;
  }

  // ---------- WebSocket lifecycle ----------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (!this.game) {
      return new Response("room not found", { status: 404 });
    }
    const open = this.ctx.getWebSockets().filter((s) => s.readyState === WebSocket.READY_STATE_OPEN).length;
    if (open >= MAX_SOCKETS) {
      return new Response("too many connections", { status: 503 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.game) {
      this.sendError(ws, "room_gone", "room no longer exists");
      ws.close(1011, "room gone");
      return;
    }

    let msg: ClientMessage;
    try {
      if (typeof raw !== "string") throw new Error("binary frame");
      if (raw.length > MAX_WS_BYTES) {
        this.sendError(ws, "bad_message", "message too large");
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
        throw new Error("bad shape");
      }
      msg = parsed as ClientMessage;
    } catch {
      this.sendError(ws, "bad_message", "malformed message");
      return;
    }

    switch (msg.type) {
      case "join":
        return this.onJoin(ws, msg);
      case "start_game":
        return this.onStart(ws, msg);
      case "night_action":
        return this.onNightAction(ws, msg);
      case "vote":
        return this.onVote(ws, msg);
      case "hunt":
        return this.onHunt(ws, msg);
      case "restart":
        return this.onRestart(ws);
      case "chat":
        return this.onChat(ws, msg);
      default:
        // Deny by default: anything unrecognised is rejected, never ignored.
        this.sendError(ws, "unknown_message", "unsupported message type");
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason); // complete the close handshake
    } catch {
      // already closed
    }
    if (this.game) this.broadcastRoomState(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    if (this.game) this.broadcastRoomState(ws);
  }

  // ---------- alarm: phase deadlines + idle cleanup ----------

  async alarm(): Promise<void> {
    if (!this.game) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const now = Date.now();

    if (this.deadlines.phaseAt !== null && now >= this.deadlines.phaseAt) {
      this.deadlines.phaseAt = null;
      await this.firePhaseTimeout();
      return; // afterTransition already re-armed everything
    }

    if (now >= this.deadlines.cleanupAt) {
      await this.teardown();
      return;
    }

    await this.armAlarm();
  }

  private async firePhaseTimeout(): Promise<void> {
    const game = this.game!;
    if (game.phase === "night" && game.nightStage === "actions") {
      await this.applyNightOutcome(g.timeoutNightActions(game));
    } else if (game.phase === "night" && game.nightStage === "witch") {
      await this.applyNightOutcome(g.timeoutWitch(game));
    } else if (game.phase === "day") {
      await this.applyDayOutcome(g.timeoutDay(game));
    } else if (game.phase === "hunt") {
      await this.applyHuntOutcome(g.timeoutHunt(game));
    } else {
      await this.afterTransition();
    }
  }

  /** Everything is over or idle: tell everyone, drop the room, free the code. */
  private async teardown(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      this.sendError(ws, "room_closed", "room expired");
      try {
        ws.close(1001, "room expired");
      } catch {
        // already closed
      }
    }
    const code = this.game?.code;
    this.game = null;
    this.secrets = {};
    if (code) await this.env.ROOM_INDEX.delete(code.toUpperCase());
    await this.ctx.storage.deleteAll(); // also clears the alarm
  }

  // ---------- message handlers ----------

  private async onJoin(
    ws: WebSocket,
    msg: { playerId?: unknown; name?: unknown; secret?: unknown },
  ): Promise<void> {
    const game = this.game!;
    const playerId = typeof msg.playerId === "string" ? msg.playerId : "";
    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    const secret = typeof msg.secret === "string" ? msg.secret : "";
    if (!PLAYER_ID_RE.test(playerId) || name.length === 0 || name.length > MAX_NAME_LEN) {
      this.sendError(ws, "bad_message", "invalid playerId or name");
      return;
    }

    // Rebind of an existing seat: the public playerId alone is not enough —
    // the server-issued secret must match. Wrong/missing secret never kicks
    // the legitimate connection (no replaceSockets on failure).
    const existing = game.players.find((p) => p.id === playerId);
    if (existing) {
      if (!secret || !secretsEqual(this.secrets[playerId], secret)) {
        this.sendError(ws, "bad_session", "invalid or missing seat secret");
        return;
      }
      this.replaceSockets(ws, playerId);
      ws.serializeAttachment({ playerId } satisfies Attachment);
      await this.touchCleanup();
      this.send(ws, { type: "session", playerId, secret: this.secrets[playerId]! });
      this.broadcastRoomState();
      this.sendPrivateSnapshot(ws, existing);
      return;
    }

    const res = g.joinPlayer(game, playerId, name);
    if (!res.ok) {
      if (res.code === "room_full" || res.code === "game_started") {
        // Spectator: server-minted id so a client cannot kick a seated player
        // by reusing their public playerId on the spectator path.
        const specId = crypto.randomUUID();
        ws.serializeAttachment({ playerId: specId, spectator: true } satisfies Attachment);
        this.send(ws, { type: "spectate" });
        this.send(ws, { type: "room_state", state: this.publicState() });
        if (game.phase === "ended" && game.winner) {
          this.send(ws, { type: "game_over", winner: game.winner, roles: this.roleReveal() });
        }
        return;
      }
      this.sendError(ws, res.code, "cannot join this room");
      ws.close(4001, res.code);
      return;
    }

    const granted = crypto.randomUUID();
    this.secrets[playerId] = granted;
    await this.ctx.storage.put("secrets", this.secrets);

    this.replaceSockets(ws, playerId);
    ws.serializeAttachment({ playerId } satisfies Attachment);
    await this.persist();
    await this.touchCleanup();
    this.send(ws, { type: "session", playerId, secret: granted });
    this.broadcastRoomState();
    this.sendPrivateSnapshot(ws, res.value);
  }

  private async onStart(ws: WebSocket, msg: { revealOnDeath?: unknown }): Promise<void> {
    const game = this.game!;
    const player = this.requireJoined(ws);
    if (!player) return;

    const res = g.startGame(game, player.id, cryptoUnitRandom, {
      revealOnDeath: msg.revealOnDeath === true,
    });
    if (!res.ok) {
      this.sendError(ws, res.code, "cannot start the game");
      return;
    }

    await this.persist();
    for (const p of game.players) {
      this.unicast(p.id, this.roleMessage(p));
    }
    this.broadcast({ type: "phase_changed", phase: game.phase, round: game.round });
    await this.afterTransition();
    this.broadcastRoomState();
  }

  private async onNightAction(
    ws: WebSocket,
    msg: { action?: unknown; targetId?: unknown },
  ): Promise<void> {
    const player = this.requireJoined(ws);
    if (!player) return;

    const action = msg.action;
    const needsTarget = action === "kill" || action === "inspect" || action === "poison";
    const bareAction = action === "save" || action === "skip";
    if ((!needsTarget && !bareAction) || (needsTarget && typeof msg.targetId !== "string")) {
      this.sendError(ws, "bad_message", "invalid night action");
      return;
    }

    const targetId = needsTarget ? (msg.targetId as string) : undefined;
    const res = g.nightAction(this.game!, player.id, action as never, targetId);
    if (!res.ok) {
      this.sendError(ws, res.code, "night action rejected");
      return;
    }

    this.send(ws, { type: "action_ack", action: action as never, targetId });
    if (action === "kill") {
      // Wolves coordinate: every wolf sees every pick as it changes.
      this.unicastRole("werewolf", { type: "wolf_pick", wolfId: player.id, targetId: targetId! });
    }
    await this.persist();
    await this.applyNightOutcome(res.value);
  }

  private async onVote(ws: WebSocket, msg: { targetId?: unknown }): Promise<void> {
    const player = this.requireJoined(ws);
    if (!player) return;
    if (typeof msg.targetId !== "string") {
      this.sendError(ws, "bad_message", "invalid vote");
      return;
    }

    const res = g.castVote(this.game!, player.id, msg.targetId);
    if (!res.ok) {
      this.sendError(ws, res.code, "vote rejected");
      return;
    }

    this.send(ws, { type: "action_ack", action: "vote", targetId: msg.targetId });
    await this.persist();
    await this.applyDayOutcome(res.value);
  }

  private async onHunt(ws: WebSocket, msg: { targetId?: unknown }): Promise<void> {
    const player = this.requireJoined(ws);
    if (!player) return;
    const targetId = typeof msg.targetId === "string" ? msg.targetId : null;

    const res = g.huntShot(this.game!, player.id, targetId);
    if (!res.ok) {
      this.sendError(ws, res.code, "shot rejected");
      return;
    }

    this.send(ws, { type: "action_ack", action: "shoot", targetId: targetId ?? undefined });
    await this.persist();
    await this.applyHuntOutcome(res.value);
  }

  private async onRestart(ws: WebSocket): Promise<void> {
    const game = this.game!;
    const player = this.requireJoined(ws);
    if (!player) return;

    const res = g.restartGame(game, player.id);
    if (!res.ok) {
      this.sendError(ws, res.code, "cannot restart");
      return;
    }

    await this.persist();
    this.broadcast({ type: "phase_changed", phase: "lobby", round: 0 });
    await this.afterTransition();
    this.broadcastRoomState();
  }

  private onChat(ws: WebSocket, msg: { text?: unknown }): void {
    const game = this.game!;
    const player = this.requireJoined(ws);
    if (!player) return;

    if (!this.allowChat(ws)) {
      this.sendError(ws, "rate_limited", "too many messages, slow down");
      return;
    }
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    if (text.length === 0 || text.length > MAX_CHAT_LEN) {
      this.sendError(ws, "bad_message", "invalid chat text");
      return;
    }

    if (!player.alive) {
      // One final line, then silence.
      if (!g.spendLastWords(game, player.id)) {
        this.sendError(ws, "not_alive", "dead players cannot chat");
        return;
      }
      void this.persist();
      this.broadcast({ type: "chat", from: player.name, text, channel: "last_words" });
      return;
    }

    if (game.phase === "night") {
      if (player.role !== "werewolf") {
        this.sendError(ws, "wrong_phase", "chat is closed at night");
        return;
      }
      this.unicastRole("werewolf", { type: "chat", from: player.name, text, channel: "wolf" });
      return;
    }

    // lobby / day / hunt / ended are open floors.
    this.broadcast({ type: "chat", from: player.name, text, channel: "public" });
  }

  // ---------- outcome application (shared by intents and timeouts) ----------

  private async applyNightOutcome(out: g.NightOutcome): Promise<void> {
    const game = this.game!;
    if (out.kind === "pending") {
      this.broadcastRoomState();
      return;
    }

    if (out.kind === "witch") {
      const witch = game.players.find((p) => p.role === "witch");
      if (witch) {
        this.unicast(witch.id, {
          type: "witch_wake",
          victimId: out.victimId,
          canSave: out.canSave,
          canPoison: out.canPoison,
        });
      }
      await this.afterTransition();
      this.broadcastRoomState();
      return;
    }

    // resolved
    if (out.seer) {
      const seer = game.players.find((p) => p.role === "seer");
      if (seer) {
        this.unicast(seer.id, {
          type: "seer_result",
          round: out.seer.round,
          targetId: out.seer.targetId,
          faction: out.seer.faction,
        });
      }
    }
    this.broadcast({
      type: "phase_changed",
      phase: game.phase,
      round: game.round,
      deaths: out.deaths,
      ...(out.hunterId ? { hunterId: out.hunterId } : {}),
    });
    await this.afterTransition();
    this.broadcastRoomState();
    if (game.winner) this.broadcastGameOver();
  }

  private async applyDayOutcome(out: g.DayOutcome): Promise<void> {
    const game = this.game!;
    if (out.kind === "pending") {
      this.broadcastRoomState();
      return;
    }

    if (out.kind === "runoff") {
      this.broadcast({
        type: "phase_changed",
        phase: "day",
        round: game.round,
        runoffIds: out.runoffIds,
        voteReveal: out.voteReveal,
      });
      await this.afterTransition();
      this.broadcastRoomState();
      return;
    }

    this.broadcast({
      type: "phase_changed",
      phase: game.phase,
      round: game.round,
      eliminatedId: out.eliminatedId,
      voteReveal: out.voteReveal,
      ...(out.hunterId ? { hunterId: out.hunterId } : {}),
    });
    await this.afterTransition();
    this.broadcastRoomState();
    if (game.winner) this.broadcastGameOver();
  }

  private async applyHuntOutcome(out: g.HuntOutcome): Promise<void> {
    const game = this.game!;
    this.broadcast({
      type: "phase_changed",
      phase: game.phase,
      round: game.round,
      shotId: out.shotId,
    });
    await this.afterTransition();
    this.broadcastRoomState();
    if (game.winner) this.broadcastGameOver();
  }

  // ---------- timers ----------

  /** Re-derive the phase deadline and cleanup horizon, persist, re-arm. */
  private async afterTransition(): Promise<void> {
    const game = this.game!;
    const t = this.timers;
    let duration: number | null = null;
    if (game.phase === "night") duration = game.nightStage === "witch" ? t.witchMs : t.nightMs;
    else if (game.phase === "day") duration = game.runoffIds ? t.runoffMs : t.dayMs;
    else if (game.phase === "hunt") duration = t.huntMs;

    const now = Date.now();
    this.deadlines.phaseAt = duration === null ? null : now + duration;
    this.deadlines.cleanupAt = now + (game.phase === "ended" ? t.endedMs : t.idleMs);
    await this.ctx.storage.put("deadlines", this.deadlines);
    await this.armAlarm();
  }

  private async touchCleanup(): Promise<void> {
    const game = this.game!;
    this.deadlines.cleanupAt =
      Date.now() + (game.phase === "ended" ? this.timers.endedMs : this.timers.idleMs);
    await this.ctx.storage.put("deadlines", this.deadlines);
    await this.armAlarm();
  }

  private async armAlarm(): Promise<void> {
    const next = Math.min(this.deadlines.phaseAt ?? Infinity, this.deadlines.cleanupAt);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }

  // ---------- private helpers ----------

  private persist(): Promise<void> {
    return this.ctx.storage.put("game", this.game);
  }

  private attachment(ws: WebSocket): Attachment | null {
    try {
      return (ws.deserializeAttachment() as Attachment | null) ?? null;
    } catch {
      return null;
    }
  }

  /** A reconnect replaces any previous socket of the same player/spectator. */
  private replaceSockets(current: WebSocket, playerId: string): void {
    for (const other of this.ctx.getWebSockets()) {
      if (other !== current && this.attachment(other)?.playerId === playerId) {
        try {
          other.close(4000, "replaced by a newer connection");
        } catch {
          // already closing
        }
      }
    }
  }

  private requireJoined(ws: WebSocket): g.GamePlayer | null {
    const att = this.attachment(ws);
    const player =
      att && !att.spectator ? this.game!.players.find((p) => p.id === att.playerId) : undefined;
    if (!player) {
      this.sendError(ws, "not_joined", "join the room first");
      return null;
    }
    return player;
  }

  private allowChat(ws: WebSocket): boolean {
    const now = Date.now();
    const att = this.attachment(ws);
    if (!att) return false;
    let tokens = att.chatTokens ?? CHAT_BURST;
    const last = att.chatLast ?? now;
    tokens = Math.min(CHAT_BURST, tokens + (now - last) / CHAT_REFILL_MS);
    if (tokens < 1) {
      ws.serializeAttachment({ ...att, chatTokens: tokens, chatLast: now } satisfies Attachment);
      return false;
    }
    tokens -= 1;
    ws.serializeAttachment({ ...att, chatTokens: tokens, chatLast: now } satisfies Attachment);
    return true;
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket is closing; presence is derived from live sockets anyway.
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.send(ws, { type: "error", code, message });
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // skip closing sockets
      }
    }
  }

  private unicast(playerId: string, msg: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (att && !att.spectator && att.playerId === playerId) this.send(ws, msg);
    }
  }

  /** Deliver to every seated player holding the given role. */
  private unicastRole(role: g.GamePlayer["role"], msg: ServerMessage): void {
    const ids = new Set(this.game!.players.filter((p) => p.role === role).map((p) => p.id));
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (att && !att.spectator && ids.has(att.playerId)) this.send(ws, msg);
    }
  }

  /** Everything a (re)joining player is entitled to know, and nothing more. */
  private sendPrivateSnapshot(ws: WebSocket, player: g.GamePlayer): void {
    const game = this.game!;
    if (player.role) this.send(ws, this.roleMessage(player));
    if (player.role === "seer") {
      for (const r of game.seerHistory) {
        this.send(ws, { type: "seer_result", round: r.round, targetId: r.targetId, faction: r.faction });
      }
    }
    if (game.phase === "night") {
      if (player.role === "werewolf") {
        for (const [wolfId, targetId] of Object.entries(game.killVotes)) {
          this.send(ws, { type: "wolf_pick", wolfId, targetId });
        }
        const kill = game.killVotes[player.id];
        if (kill) this.send(ws, { type: "action_ack", action: "kill", targetId: kill });
      }
      if (player.role === "seer" && game.inspectTarget) {
        this.send(ws, { type: "action_ack", action: "inspect", targetId: game.inspectTarget });
      }
      if (player.role === "witch" && game.nightStage === "witch" && !game.witch.action) {
        this.send(ws, {
          type: "witch_wake",
          victimId: game.pendingVictimId,
          canSave: !game.witch.saveUsed && game.pendingVictimId !== null,
          canPoison: !game.witch.poisonUsed,
        });
      }
    }
    if (game.phase === "day") {
      const vote = game.dayVotes[player.id];
      if (vote) this.send(ws, { type: "action_ack", action: "vote", targetId: vote });
    }
    if (game.phase === "ended" && game.winner) {
      this.send(ws, { type: "game_over", winner: game.winner, roles: this.roleReveal() });
    }
  }

  private roleMessage(player: g.GamePlayer): ServerMessage {
    const game = this.game!;
    const teammates =
      player.role === "werewolf"
        ? game.players
            .filter((p) => p.role === "werewolf" && p.id !== player.id)
            .map((p) => ({ id: p.id, name: p.name }))
        : [];
    return {
      type: "role_assigned",
      role: player.role ?? "villager",
      teammates,
      ...(player.role === "witch"
        ? { potions: { save: !game.witch.saveUsed, poison: !game.witch.poisonUsed } }
        : {}),
    };
  }

  private roleReveal(): RoleReveal[] {
    return this.game!.players.map((p) => ({ id: p.id, name: p.name, role: p.role ?? "villager" }));
  }

  private broadcastGameOver(): void {
    const game = this.game!;
    if (!game.winner) return;
    this.broadcast({ type: "game_over", winner: game.winner, roles: this.roleReveal() });
  }

  /** Public snapshot — identical for everyone; carries no hidden information. */
  private publicState(): PublicRoomState {
    const game = this.game!;
    const connected = new Set<string>();
    const spectators = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const att = this.attachment(ws);
      if (!att) continue;
      if (att.spectator) spectators.add(att.playerId);
      else connected.add(att.playerId);
    }

    let nightPending = false;
    if (game.phase === "night") {
      if (game.nightStage === "witch") {
        nightPending = true;
      } else {
        for (const p of game.players) {
          if (!p.alive) continue;
          if (p.role === "werewolf" && !game.killVotes[p.id]) {
            nightPending = true;
            break;
          }
          if (p.role === "seer" && !game.inspectTarget) {
            nightPending = true;
            break;
          }
        }
      }
    }

    return {
      code: game.code,
      phase: game.phase,
      round: game.round,
      hostId: game.hostId,
      players: game.players.map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        alive: p.alive,
        connected: connected.has(p.id),
        ...(game.config.revealOnDeath && !p.alive && p.role ? { role: p.role } : {}),
      })),
      votedIds: game.phase === "day" ? Object.keys(game.dayVotes) : [],
      nightPending,
      nightStage: game.phase === "night" ? game.nightStage : null,
      runoffIds: game.phase === "day" ? game.runoffIds : null,
      deadlineAt: this.deadlines.phaseAt,
      spectators: spectators.size,
      revealOnDeath: game.config.revealOnDeath,
      winner: game.winner,
    };
  }

  /** Broadcast the public state, optionally treating one socket as gone. */
  private broadcastRoomState(closing?: WebSocket): void {
    const msg: ServerMessage = { type: "room_state", state: this.publicState() };
    if (closing) {
      const att = this.attachment(closing);
      if (att && !att.spectator) {
        const player = msg.state.players.find((p) => p.id === att.playerId);
        const stillOpen = this.ctx
          .getWebSockets()
          .some(
            (ws) =>
              ws !== closing &&
              ws.readyState === WebSocket.READY_STATE_OPEN &&
              this.attachment(ws)?.playerId === att.playerId,
          );
        if (player && !stillOpen) player.connected = false;
      }
    }
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      try {
        ws.send(data);
      } catch {
        // skip closing sockets
      }
    }
  }
}

function cryptoUnitRandom(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! / 4294967296;
}

function secretsEqual(stored: string | undefined, offered: string): boolean {
  if (!stored) return false;
  const enc = new TextEncoder();
  const a = enc.encode(stored);
  const b = enc.encode(offered);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}
