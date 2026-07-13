import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "../src/protocol";

/**
 * Integration tests against the real Worker + RoomDO over WebSockets.
 * They mirror the acceptance criteria: invite flow, role secrecy, wolf
 * coordination, the witch's and hunter's beats, runoffs, timeouts,
 * spectators, rematch, rate limiting, and room expiry.
 */

type MsgType = ServerMessage["type"];
type MsgOf<T extends MsgType> = Extract<ServerMessage, { type: T }>;

/** Sockets opened by the current test; leftovers break test teardown. */
const openSockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    try {
      ws.close(1000, "test cleanup");
    } catch {
      // already closed
    }
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Client {
  id: string;
  send(msg: ClientMessage): void;
  until<T extends MsgType>(type: T, timeoutMs?: number): Promise<MsgOf<T>>;
  seen: ServerMessage[];
  close(): void;
}

async function connect(code: string, id: string): Promise<Client> {
  const res = await SELF.fetch(`https://example.com/api/rooms/${code}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  openSockets.push(ws);

  const seen: ServerMessage[] = [];
  const queue: ServerMessage[] = [];
  const waiters: ((m: ServerMessage) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as ServerMessage;
    seen.push(msg);
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });

  function nextMessage(timeoutMs: number): Promise<ServerMessage> {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${id}] timed out waiting for a message`)), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  return {
    id,
    seen,
    send: (msg) => ws.send(JSON.stringify(msg)),
    until: async <T extends MsgType>(type: T, timeoutMs = 3000): Promise<MsgOf<T>> => {
      for (;;) {
        const msg = await nextMessage(timeoutMs);
        if (msg.type === type) return msg as MsgOf<T>;
      }
    },
    close: () => ws.close(1000, "test done"),
  };
}

async function createRoom(): Promise<string> {
  const res = await SELF.fetch("https://example.com/api/rooms", { method: "POST" });
  expect(res.status).toBe(201);
  const body = await res.json<{ code: string; url: string }>();
  expect(body.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  expect(body.url).toContain(`/r/${body.code}`);
  return body.code;
}

async function join(code: string, playerId: string, name: string): Promise<Client> {
  const client = await connect(code, playerId);
  client.send({ type: "join", playerId, name });
  await client.until("room_state");
  return client;
}

async function sixPlayerRoom(code?: string): Promise<{ code: string; clients: Client[] }> {
  const room = code ?? (await createRoom());
  const clients: Client[] = [];
  for (let i = 1; i <= 6; i++) {
    clients.push(await join(room, `player-${i}00000`, `玩家${i}`));
  }
  return { code: room, clients };
}

interface Cast {
  wolves: Client[];
  seer: Client;
  witch: Client;
  villagers: Client[];
}

/** Starts the game and sorts clients by the role each one privately received. */
async function startAndDiscoverRoles(clients: Client[], revealOnDeath = false): Promise<Cast> {
  clients[0]!.send({ type: "start_game", revealOnDeath });
  const wolves: Client[] = [];
  const villagers: Client[] = [];
  let seer: Client | null = null;
  let witch: Client | null = null;
  for (const client of clients) {
    const assigned = await client.until("role_assigned");
    if (assigned.role === "werewolf") wolves.push(client);
    else if (assigned.role === "seer") seer = client;
    else if (assigned.role === "witch") {
      witch = client;
      expect(assigned.potions).toEqual({ save: true, poison: true });
    } else villagers.push(client);
    await client.until("phase_changed");
  }
  expect(wolves).toHaveLength(2);
  expect(seer).not.toBeNull();
  expect(witch).not.toBeNull();
  expect(villagers).toHaveLength(2);
  return { wolves, seer: seer!, witch: witch!, villagers };
}

async function allUntilPhase(clients: Client[]): Promise<MsgOf<"phase_changed">[]> {
  return Promise.all(clients.map((c) => c.until("phase_changed")));
}

describe("HTTP routes", () => {
  it("allocates a room and reports its existence", async () => {
    const code = await createRoom();
    const yes = await SELF.fetch(`https://example.com/api/rooms/${code}`);
    expect(await yes.json()).toEqual({ exists: true });
    const no = await SELF.fetch("https://example.com/api/rooms/ZZZZZ2");
    expect(await no.json()).toEqual({ exists: false });
  });

  it("claim is atomic per room code", async () => {
    const stub = env.ROOM.getByName("ROOM42");
    expect(await stub.claim("ROOM42")).toBe(true);
    expect(await stub.claim("ROOM42")).toBe(false);
  });

  it("rejects websockets to rooms that were never created", async () => {
    const res = await SELF.fetch("https://example.com/api/rooms/XXXXX2/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(404);
  });
});

describe("lobby", () => {
  it("seats players, elects the first as host, and tracks presence", async () => {
    const code = await createRoom();
    const alice = await join(code, "alice-000000", "小明");
    const bobJoinsState = alice.until("room_state");
    const bob = await join(code, "bob-00000000", "小美");
    const seenByAlice = await bobJoinsState;
    expect(seenByAlice.state.players.map((p) => p.name)).toEqual(["小明", "小美"]);
    expect(seenByAlice.state.hostId).toBe("alice-000000");
    for (const p of seenByAlice.state.players) {
      expect("role" in p).toBe(false);
      expect(p.connected).toBe(true);
    }

    bob.close();
    const afterLeave = await alice.until("room_state");
    expect(afterLeave.state.players.find((p) => p.id === "bob-00000000")!.connected).toBe(false);
  });

  it("rejects a start with fewer than six players", async () => {
    const code = await createRoom();
    const host = await join(code, "host-0000000", "房主");
    host.send({ type: "start_game" });
    expect((await host.until("error")).code).toBe("bad_player_count");
  });
});

describe("deny by default", () => {
  it("rejects gameplay from sockets that never joined and unknown messages", async () => {
    const code = await createRoom();
    const lurker = await connect(code, "lurker");
    lurker.send({ type: "vote", targetId: "whoever" });
    expect((await lurker.until("error")).code).toBe("not_joined");

    const solo = await join(code, "solo-0000000", "獨行俠");
    solo.send({ type: "nonsense" } as never);
    expect((await solo.until("error")).code).toBe("unknown_message");
  });

  it("rejects night actions from the wrong role", async () => {
    const { clients } = await sixPlayerRoom();
    const { seer, villagers } = await startAndDiscoverRoles(clients);
    villagers[0]!.send({ type: "night_action", action: "kill", targetId: seer.id });
    expect((await villagers[0]!.until("error")).code).toBe("wrong_role");
    seer.send({ type: "night_action", action: "kill", targetId: villagers[0]!.id });
    expect((await seer.until("error")).code).toBe("wrong_role");
  });

  it("rate limits chat floods", async () => {
    const code = await createRoom();
    const talker = await join(code, "talker-00000", "話癆");
    for (let i = 0; i < 6; i++) talker.send({ type: "chat", text: `msg ${i}` });
    expect((await talker.until("error")).code).toBe("rate_limited");
  });
});

describe("role secrecy and wolf coordination", () => {
  it("unicasts roles; wolves share picks; nobody else sees a thing", async () => {
    const { clients } = await sixPlayerRoom();
    const cast = await startAndDiscoverRoles(clients);
    const [w1, w2] = cast.wolves as [Client, Client];

    const w1Assigned = w1.seen.find((m) => m.type === "role_assigned") as MsgOf<"role_assigned">;
    expect(w1Assigned.teammates.map((t) => t.id)).toEqual([w2.id]);

    // A wolf's pick is echoed to the pack only.
    w1.send({ type: "night_action", action: "kill", targetId: cast.villagers[0]!.id });
    const pick = await w2.until("wolf_pick");
    expect(pick).toMatchObject({ wolfId: w1.id, targetId: cast.villagers[0]!.id });

    for (const client of clients) {
      expect(client.seen.filter((m) => m.type === "role_assigned")).toHaveLength(1);
      for (const msg of client.seen) {
        if (msg.type === "room_state") {
          for (const p of msg.state.players) expect("role" in p).toBe(false);
        }
      }
      if (client !== w1 && client !== w2) {
        expect(client.seen.some((m) => m.type === "wolf_pick")).toBe(false);
      }
    }
  });
});

describe("full game", () => {
  it("plays save, poison, runoff-free days, last words, and rematch", async () => {
    const { clients } = await sixPlayerRoom();
    const cast = await startAndDiscoverRoles(clients);
    const [w1, w2] = cast.wolves as [Client, Client];
    const [v1, v2] = cast.villagers as [Client, Client];
    const { seer, witch } = cast;

    // --- Night 1: wolves take v1; the witch saves them.
    w1.send({ type: "night_action", action: "kill", targetId: v1.id });
    await w1.until("action_ack");
    w2.send({ type: "night_action", action: "kill", targetId: v1.id });
    seer.send({ type: "night_action", action: "inspect", targetId: w1.id });

    const wake1 = await witch.until("witch_wake");
    expect(wake1).toEqual({ type: "witch_wake", victimId: v1.id, canSave: true, canPoison: true });
    witch.send({ type: "night_action", action: "save" });

    expect(await seer.until("seer_result")).toMatchObject({
      round: 1,
      targetId: w1.id,
      faction: "werewolf",
    });
    for (const msg of await allUntilPhase(clients)) {
      expect(msg).toMatchObject({ phase: "day", round: 1, deaths: [] });
    }

    // --- Day 1: the seer leads the village onto w1; ballots go public.
    for (const voter of [v1, v2, seer, witch]) voter.send({ type: "vote", targetId: w1.id });
    w1.send({ type: "vote", targetId: v1.id });
    w2.send({ type: "vote", targetId: v1.id });
    const dusk = await allUntilPhase(clients);
    for (const msg of dusk) {
      expect(msg).toMatchObject({ phase: "night", round: 2, eliminatedId: w1.id });
      expect(msg.voteReveal).toHaveLength(6);
      expect(msg.voteReveal).toContainEqual({ voterId: seer.id, targetId: w1.id });
    }

    // --- The freshly dead wolf gets one last line, then silence.
    w1.send({ type: "chat", text: "我死了，但我不服" });
    const lastWords = await v2.until("chat");
    expect(lastWords).toMatchObject({ channel: "last_words" });
    w1.send({ type: "chat", text: "再說一句" });
    expect((await w1.until("error")).code).toBe("not_alive");

    // --- Night 2: last wolf takes v1 for real; the witch poisons the wolf.
    w2.send({ type: "night_action", action: "kill", targetId: v1.id });
    seer.send({ type: "night_action", action: "inspect", targetId: v2.id });
    const wake2 = await witch.until("witch_wake");
    expect(wake2).toMatchObject({ victimId: v1.id, canSave: false, canPoison: true });
    witch.send({ type: "night_action", action: "poison", targetId: w2.id });

    expect(await seer.until("seer_result")).toMatchObject({ round: 2, faction: "good" });
    for (const msg of await allUntilPhase(clients)) {
      expect(msg.phase).toBe("ended");
      expect(msg.deaths?.sort()).toEqual([v1.id, w2.id].sort());
    }

    const over = await Promise.all(clients.map((c) => c.until("game_over")));
    for (const msg of over) {
      expect(msg.winner).toBe("villagers");
      expect(msg.roles).toHaveLength(6);
      expect(msg.roles.filter((r) => r.role === "werewolf").map((r) => r.id).sort()).toEqual(
        [w1.id, w2.id].sort(),
      );
    }

    // Secrecy held: only the witch woke, only the seer saw results.
    for (const client of clients) {
      if (client !== witch) expect(client.seen.some((m) => m.type === "witch_wake")).toBe(false);
      if (client !== seer) expect(client.seen.some((m) => m.type === "seer_result")).toBe(false);
    }

    // --- Rematch in the same room: host resets, seats survive, roles redeal.
    clients[0]!.send({ type: "restart" });
    for (const msg of await allUntilPhase(clients)) {
      expect(msg).toMatchObject({ phase: "lobby", round: 0 });
    }
    const lobbyState = await clients[1]!.until("room_state");
    expect(lobbyState.state.players).toHaveLength(6);
    expect(lobbyState.state.players.every((p) => p.alive)).toBe(true);
    expect(lobbyState.state.winner).toBeNull();

    clients[0]!.send({ type: "start_game" });
    const redeal = await clients[2]!.until("role_assigned");
    expect(["werewolf", "seer", "witch", "villager"]).toContain(redeal.role);
  });
});

describe("reveal on death", () => {
  it("shows dead players' roles only when the host enabled it", async () => {
    const { clients } = await sixPlayerRoom();
    const cast = await startAndDiscoverRoles(clients, true);
    const [w1, w2] = cast.wolves as [Client, Client];
    const target = cast.villagers[0]!;

    w1.send({ type: "night_action", action: "kill", targetId: target.id });
    w2.send({ type: "night_action", action: "kill", targetId: target.id });
    cast.seer.send({ type: "night_action", action: "inspect", targetId: w1.id });
    (await cast.witch.until("witch_wake")) satisfies unknown;
    cast.witch.send({ type: "night_action", action: "skip" });

    await allUntilPhase(clients);
    const state = await clients[0]!.until("room_state");
    const dead = state.state.players.find((p) => p.id === target.id)!;
    expect(dead.alive).toBe(false);
    expect(dead.role).toBe("villager");
    // The living stay hidden even with the reveal option on.
    for (const p of state.state.players.filter((q) => q.alive)) {
      expect("role" in p).toBe(false);
    }
  });
});

describe("spectators", () => {
  it("late joiners watch: public state only, no seat, no actions", async () => {
    const { code, clients } = await sixPlayerRoom();
    await startAndDiscoverRoles(clients);

    const late = await connect(code, "late-0000000");
    late.send({ type: "join", playerId: "late-0000000", name: "圍觀群眾" });
    await late.until("spectate");
    const state = await late.until("room_state");
    expect(state.state.players).toHaveLength(6);
    expect(state.state.players.some((p) => p.id === "late-0000000")).toBe(false);

    late.send({ type: "vote", targetId: clients[0]!.id });
    expect((await late.until("error")).code).toBe("not_joined");
    expect(late.seen.some((m) => m.type === "role_assigned")).toBe(false);
  });
});

describe("reconnection", () => {
  it("rebinds the same playerId with its private snapshot and pack picks", async () => {
    const { code, clients } = await sixPlayerRoom();
    const cast = await startAndDiscoverRoles(clients);
    const [w1, w2] = cast.wolves as [Client, Client];

    w1.send({ type: "night_action", action: "kill", targetId: cast.villagers[0]!.id });
    await w1.until("action_ack");
    w1.close();

    const back = await join(code, w1.id, "回歸的狼");
    const assigned = await back.until("role_assigned");
    expect(assigned.role).toBe("werewolf");
    expect(assigned.teammates.map((t) => t.id)).toEqual([w2.id]);
    expect(await back.until("wolf_pick")).toMatchObject({
      wolfId: w1.id,
      targetId: cast.villagers[0]!.id,
    });
    expect(await back.until("action_ack")).toMatchObject({
      action: "kill",
      targetId: cast.villagers[0]!.id,
    });

    const state = back.seen.find((m) => m.type === "room_state") as MsgOf<"room_state">;
    const me = state.state.players.find((p) => p.id === w1.id)!;
    expect(me.alive).toBe(true);
    expect(me.name).toBe(`玩家${1 + clients.indexOf(w1)}`);
  });
});

describe("phase timers", () => {
  it("a silent night resolves itself: actions time out, then the witch's beat", async () => {
    const code = "TIMER1";
    const stub = env.ROOM.getByName(code);
    expect(
      await stub.claim(code, {
        timers: { nightMs: 80, witchMs: 80, dayMs: 60_000, runoffMs: 60_000, huntMs: 60_000 },
      }),
    ).toBe(true);

    const { clients } = await sixPlayerRoom(code);
    await startAndDiscoverRoles(clients);
    const first = await clients[0]!.until("room_state");
    expect(first.state.deadlineAt).not.toBeNull();

    // Nobody acts. Force the two deadlines (actions stage, then witch stage).
    await sleep(120);
    await runDurableObjectAlarm(stub);
    await sleep(120);
    await runDurableObjectAlarm(stub);

    for (const msg of await allUntilPhase(clients)) {
      expect(msg).toMatchObject({ phase: "day", round: 1, deaths: [] });
    }
  });

  it("an idle room expires, kicks its sockets, and frees the code", async () => {
    const code = "CLEAN1";
    const stub = env.ROOM.getByName(code);
    expect(await stub.claim(code, { timers: { idleMs: 60 } })).toBe(true);
    const watcher = await join(code, "cleanup-user-0", "掃地僧");

    await sleep(120);
    await runDurableObjectAlarm(stub);

    expect((await watcher.until("error")).code).toBe("room_closed");
    expect(await stub.exists()).toBe(false);
  });
});
