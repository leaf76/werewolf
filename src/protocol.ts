/**
 * WebSocket protocol shared by server (Durable Object) and client.
 * The server is authoritative: clients only send intents; every intent is
 * validated inside the room DO. Nothing here may carry another player's
 * hidden role — private data flows only through unicast messages
 * (role_assigned / seer_result / witch_wake / wolf_pick).
 */

export type Role = "werewolf" | "seer" | "witch" | "hunter" | "villager";
export type Faction = "werewolf" | "good";
export type Phase = "lobby" | "night" | "day" | "hunt" | "ended";
export type NightStage = "actions" | "witch";
export type Winner = "werewolves" | "villagers";

/** Public view of a player — safe to broadcast to everyone. */
export interface PublicPlayer {
  id: string;
  name: string;
  seat: number;
  alive: boolean;
  connected: boolean;
  /** Present only when the room plays with reveal-on-death and the player is dead. */
  role?: Role;
}

/** Public room snapshot — identical for every recipient. */
export interface PublicRoomState {
  code: string;
  phase: Phase;
  round: number;
  hostId: string | null;
  players: PublicPlayer[];
  /** Day only: who has already voted (targets stay secret until the reveal). */
  votedIds: string[];
  /** Night only: number of pending secret actions (never who). */
  nightPending: number;
  /** Night only: which script beat the room is on (composition is public). */
  nightStage: NightStage | null;
  /** Day only: candidates of a runoff (PK) revote, if one is in progress. */
  runoffIds: string[] | null;
  /** Epoch ms when the current phase auto-resolves; null = no timer. */
  deadlineAt: number | null;
  spectators: number;
  revealOnDeath: boolean;
  winner: Winner | null;
}

export interface VoteReveal {
  voterId: string;
  targetId: string;
}

// ---------- client -> server ----------

export type ClientMessage =
  | { type: "join"; playerId: string; name: string }
  | { type: "start_game"; revealOnDeath?: boolean }
  | { type: "night_action"; action: "kill" | "inspect" | "poison"; targetId: string }
  | { type: "night_action"; action: "save" | "skip" }
  | { type: "vote"; targetId: string }
  /** Hunter's dying shot; null target = holster (不開槍). */
  | { type: "hunt"; targetId: string | null }
  /** Host only, ended phase: reset the same room back to the lobby. */
  | { type: "restart" }
  | { type: "chat"; text: string };

// ---------- server -> client ----------

export interface RoleReveal {
  id: string;
  name: string;
  role: Role;
}

export type ServerMessage =
  | { type: "room_state"; state: PublicRoomState }
  /**
   * Unicast to the player only; wolves also get their teammate list and the
   * witch gets her remaining potions.
   */
  | {
      type: "role_assigned";
      role: Role;
      teammates: { id: string; name: string }[];
      potions?: { save: boolean; poison: boolean };
    }
  /** Unicast to every wolf whenever a wolf picks or changes a kill target. */
  | { type: "wolf_pick"; wolfId: string; targetId: string }
  /** Unicast to the witch when her night step begins. */
  | { type: "witch_wake"; victimId: string | null; canSave: boolean; canPoison: boolean }
  | {
      type: "phase_changed";
      phase: Phase;
      round: number;
      /** Entering day/hunt from night: everyone who died at dawn. */
      deaths?: string[];
      /** Leaving day: who was voted out (null = nobody). */
      eliminatedId?: string | null;
      /** Leaving day (or entering a runoff): the full vote tally, made public. */
      voteReveal?: VoteReveal[];
      /** Entering a runoff revote: the tied candidates. */
      runoffIds?: string[];
      /** Entering hunt: the dead hunter who may now shoot. */
      hunterId?: string;
      /** Leaving hunt: who was shot (null = holstered). */
      shotId?: string | null;
    }
  /** Unicast to the seer only. */
  | { type: "seer_result"; round: number; targetId: string; faction: Faction }
  /** Unicast confirmation that the sender's secret intent was accepted. */
  | {
      type: "action_ack";
      action: "kill" | "inspect" | "vote" | "save" | "poison" | "skip" | "shoot";
      targetId?: string;
    }
  /** channel wolf = night wolf chat; last_words = a dead player's final line. */
  | { type: "chat"; from: string; text: string; channel: "public" | "wolf" | "last_words" }
  /** Unicast: this socket watches but has no seat. */
  | { type: "spectate" }
  | { type: "game_over"; winner: Winner; roles: RoleReveal[] }
  | { type: "error"; code: string; message: string };

export const MAX_PLAYERS = 12;
export const MIN_PLAYERS = 6;
export const MAX_CHAT_LEN = 200;
export const MAX_NAME_LEN = 12;
