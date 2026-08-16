/**
 * Room client. The server is authoritative: this file only renders public
 * room state plus the private messages addressed to this player, and sends
 * intents. It never derives hidden information locally.
 */

import type {
  ClientMessage,
  PublicPlayer,
  PublicRoomState,
  Role,
  ServerMessage,
  VoteReveal,
  Winner,
} from "../protocol";
import { MIN_PLAYERS } from "../protocol";

// ---------- static tables ----------

const ROLE_NAMES: Record<Role, string> = {
  werewolf: "狼人",
  seer: "預言家",
  witch: "女巫",
  hunter: "獵人",
  villager: "平民",
};

const WINNER_NAMES: Record<Winner, string> = {
  werewolves: "狼人陣營獲勝",
  villagers: "好人陣營獲勝",
};

const ERROR_TEXT: Record<string, string> = {
  room_full: "房間已滿（12 人上限）。",
  game_started: "遊戲已經開始，無法入座。",
  not_host: "只有房主可以做這件事。",
  wrong_phase: "現在的階段不能做這個動作。",
  bad_player_count: "需要 6–12 人才能開局。",
  not_in_room: "你不在這間房裡。",
  not_joined: "尚未加入房間。",
  not_alive: "你已出局，遺言也說完了。",
  wrong_role: "你的身分不能做這個動作。",
  bad_target: "這個目標無效。",
  already_voted: "你已經投過票了，本輪不能改票。",
  already_acted: "你今晚已經行動過了。",
  no_potion: "這瓶藥已經用掉了（或無人可救）。",
  runoff_candidate: "你是決選候選人，本輪不能投票。",
  rate_limited: "說話太快了，稍等一下再送。",
  bad_message: "訊息格式錯誤。",
  bad_session: "這個座位的憑證無效（無法用公開的 playerId 冒充他人）。",
  unknown_message: "不支援的訊息。",
  room_gone: "房間不存在或已關閉。",
  room_closed: "房間已因閒置太久而關閉。",
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

// ---------- page state ----------

const code = (location.pathname.split("/").pop() ?? "").toUpperCase();
const PID_KEY = `ww-pid:${code}`;
const SECRET_KEY = `ww-secret:${code}`;
const NAME_KEY = `ww-name:${code}`;

// sessionStorage (not localStorage) on purpose: a refresh keeps the seat,
// while separate tabs in the same browser can play as different players.
// playerId is public (appears in room_state); secret is the server-issued
// token required to rebind this seat — never share it, never put it in URLs.
function myPlayerId(): string {
  let id = sessionStorage.getItem(PID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(PID_KEY, id);
  }
  return id;
}

const playerId = myPlayerId();
let mySecret = sessionStorage.getItem(SECRET_KEY) ?? "";
let myName = sessionStorage.getItem(NAME_KEY) ?? "";

let ws: WebSocket | null = null;
let state: PublicRoomState | null = null;
let myRole: Role | null = null;
let teammates: { id: string; name: string }[] = [];
let spectator = false;
let picked: { action: string; targetId?: string } | null = null;
/** Latest kill picks of the pack (wolves only ever receive these). */
const wolfPicks = new Map<string, string>();
let witchWake: { victimId: string | null; canSave: boolean; canPoison: boolean } | null = null;
let poisonMode = false;
let hunterPendingId: string | null = null;
let reconnectAttempts = 0;
let fatal = false;
let lastErrorCode = "";

// ---------- dom refs ----------

const gate = el<HTMLElement>("gate");
const gateErr = el<HTMLElement>("gate-err");
const deadEnd = el<HTMLElement>("dead-end");
const stage = el<HTMLElement>("stage");
const conn = el<HTMLElement>("conn");
const specBadge = el<HTMLElement>("spec-badge");
const phaseBanner = el<HTMLElement>("phase-banner");
const countdown = el<HTMLElement>("countdown");
const statusLine = el<HTMLElement>("status-line");
const roleCard = el<HTMLElement>("role-card");
const witchPanel = el<HTMLElement>("witch-panel");
const witchText = el<HTMLElement>("witch-text");
const witchSave = el<HTMLButtonElement>("witch-save");
const witchPoison = el<HTMLButtonElement>("witch-poison");
const witchSkip = el<HTMLButtonElement>("witch-skip");
const playersBox = el<HTMLElement>("players");
const huntActions = el<HTMLElement>("hunt-actions");
const lobbyActions = el<HTMLElement>("lobby-actions");
const startBtn = el<HTMLButtonElement>("start");
const startHint = el<HTMLElement>("start-hint");
const revealWrap = el<HTMLElement>("reveal-wrap");
const revealOpt = el<HTMLInputElement>("reveal-opt");
const restartBtn = el<HTMLButtonElement>("restart");
const logList = el<HTMLElement>("log");
const chatList = el<HTMLElement>("chat");
const chatText = el<HTMLInputElement>("chat-text");
const toast = el<HTMLElement>("toast");

el<HTMLElement>("room-code").textContent = code;

// ---------- tiny ui helpers ----------

let toastTimer = 0;
function showToast(text: string): void {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 2600);
}

function addLog(text: string, cls?: "important" | "private"): void {
  const li = document.createElement("li");
  li.textContent = text;
  if (cls) li.classList.add(cls);
  logList.append(li);
  logList.scrollTop = logList.scrollHeight;
}

function addChat(from: string, text: string, channel: "public" | "wolf" | "last_words"): void {
  const li = document.createElement("li");
  if (channel !== "public") {
    const tag = document.createElement("span");
    tag.className = channel === "wolf" ? "chan-wolf" : "chan-last";
    tag.textContent = channel === "wolf" ? "【狼頻】" : "【遺言】";
    li.append(tag);
  }
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = from;
  li.append(who, `：${text}`);
  chatList.append(li);
  chatList.scrollTop = chatList.scrollHeight;
}

function nameOf(id: string | null | undefined): string {
  if (!id) return "？";
  return state?.players.find((p) => p.id === id)?.name ?? "？";
}

function me(): PublicPlayer | null {
  if (spectator) return null;
  return state?.players.find((p) => p.id === playerId) ?? null;
}

function showDeadEnd(title: string, text: string): void {
  gate.hidden = true;
  stage.hidden = true;
  deadEnd.hidden = false;
  el<HTMLElement>("dead-end-title").textContent = title;
  el<HTMLElement>("dead-end-text").textContent = text;
}

function logVoteReveal(reveal: VoteReveal[]): void {
  if (reveal.length === 0) {
    addLog("開票：這一輪沒有任何選票。");
    return;
  }
  const byTarget = new Map<string, string[]>();
  for (const v of reveal) {
    const list = byTarget.get(v.targetId) ?? [];
    list.push(nameOf(v.voterId));
    byTarget.set(v.targetId, list);
  }
  const parts = [...byTarget.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([targetId, voters]) => `${nameOf(targetId)} ${voters.length} 票（${voters.join("、")}）`);
  addLog(`開票：${parts.join("；")}`);
}

// ---------- countdown ----------

setInterval(() => {
  const at = state?.deadlineAt ?? null;
  if (at === null || state?.phase === "lobby" || state?.phase === "ended") {
    countdown.hidden = true;
    return;
  }
  const left = Math.max(0, Math.ceil((at - Date.now()) / 1000));
  countdown.textContent = `⏱ ${left}s`;
  countdown.hidden = false;
  countdown.classList.toggle("urgent", left <= 10);
}, 400);

// ---------- websocket ----------

function connect(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  conn.dataset.state = "connecting";
  conn.textContent = "連線中…";
  ws = new WebSocket(`${proto}//${location.host}/api/rooms/${code}/ws`);

  ws.addEventListener("open", () => {
    conn.dataset.state = "open";
    conn.textContent = "已連線";
    reconnectAttempts = 0;
    send({
      type: "join",
      playerId,
      name: myName,
      ...(mySecret ? { secret: mySecret } : {}),
    });
  });

  ws.addEventListener("message", (event) => {
    handle(JSON.parse(event.data as string) as ServerMessage);
  });

  ws.addEventListener("close", (event) => {
    conn.dataset.state = "closed";
    conn.textContent = "已斷線";
    if (fatal) return;
    if (event.code === 4000) {
      fatal = true;
      showDeadEnd("這個座位已在別處連線", "同一位玩家開了新的分頁或裝置，這裡的連線已被取代。");
      return;
    }
    if (event.code === 4001) {
      fatal = true;
      showDeadEnd("無法加入這間房", ERROR_TEXT[lastErrorCode] ?? "加入被拒絕。");
      return;
    }
    if (lastErrorCode === "room_closed") {
      fatal = true;
      showDeadEnd("房間已關閉", ERROR_TEXT.room_closed!);
      return;
    }
    // Otherwise: probe whether the room still exists, then retry with backoff.
    reconnectAttempts += 1;
    const delay = Math.min(1000 * reconnectAttempts, 5000);
    conn.textContent = `已斷線，${Math.round(delay / 1000)} 秒後重連…`;
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/rooms/${code}`);
        const { exists } = (await res.json()) as { exists: boolean };
        if (!exists) {
          fatal = true;
          showDeadEnd("房間已關閉", "這間房已經到期或被清除了。");
          return;
        }
      } catch {
        // Probe failed (offline?) — let the socket retry anyway.
      }
      connect();
    }, delay);
  });

  ws.addEventListener("error", () => {
    conn.dataset.state = "error";
  });
}

function send(msg: ClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- server message handling ----------

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case "session":
      mySecret = msg.secret;
      sessionStorage.setItem(SECRET_KEY, msg.secret);
      return;

    case "room_state":
      state = msg.state;
      gate.hidden = true;
      stage.hidden = false;
      render();
      return;

    case "spectate":
      spectator = true;
      specBadge.hidden = false;
      addLog("你以旁觀者身分進入：看得到公開進程，看不到任何身分。");
      return;

    case "role_assigned":
      myRole = msg.role;
      teammates = msg.teammates;
      renderRoleCard(msg.potions);
      addLog(`你的身分是「${ROLE_NAMES[msg.role]}」。`, "private");
      if (msg.role === "werewolf") {
        addLog(
          teammates.length > 0
            ? `你的狼同伴：${teammates.map((t) => t.name).join("、")}。`
            : "這一局只有你一匹狼。",
          "private",
        );
      }
      render();
      return;

    case "wolf_pick":
      wolfPicks.set(msg.wolfId, msg.targetId);
      if (msg.wolfId !== playerId) {
        addLog(`狼同伴 ${nameOf(msg.wolfId)} 想刀 ${nameOf(msg.targetId)}。`, "private");
      }
      renderPlayers();
      return;

    case "witch_wake":
      witchWake = { victimId: msg.victimId, canSave: msg.canSave, canPoison: msg.canPoison };
      poisonMode = false;
      addLog(
        msg.victimId ? `女巫睜眼：今晚 ${nameOf(msg.victimId)} 倒牌。` : "女巫睜眼：今晚無人倒牌。",
        "private",
      );
      renderWitchPanel();
      renderPlayers();
      return;

    case "phase_changed": {
      picked = null;
      poisonMode = false;
      witchWake = null;
      wolfPicks.clear();
      if (msg.phase !== "hunt") hunterPendingId = null;

      if (msg.voteReveal) logVoteReveal(msg.voteReveal);

      if (msg.phase === "lobby") {
        // Rematch: same seats, fresh identities.
        myRole = null;
        teammates = [];
        roleCard.hidden = true;
        el<HTMLElement>("gameover").hidden = true;
        addLog("房主重開了一局：同一批座位，重新發牌。", "important");
      } else if (msg.phase === "night" && msg.round === 1 && msg.eliminatedId === undefined && msg.shotId === undefined) {
        addLog("遊戲開始，天黑請閉眼 —— 第 1 夜。", "important");
      } else if (msg.runoffIds) {
        addLog(
          `投票平手：${msg.runoffIds.map(nameOf).join("、")} 進入決選，其餘玩家重新投票。`,
          "important",
        );
      } else if (msg.phase === "day" || (msg.phase === "hunt" && msg.deaths) || (msg.phase === "ended" && msg.deaths)) {
        if (msg.deaths) {
          addLog(
            msg.deaths.length > 0
              ? `天亮了：${msg.deaths.map(nameOf).join("、")} 昨夜死亡。`
              : "天亮了：昨夜平安，無人死亡。",
            "important",
          );
        } else if (msg.shotId !== undefined) {
          addLog(msg.shotId ? `獵人開槍帶走了 ${nameOf(msg.shotId)}。` : "獵人收槍，沒有開火。", "important");
        }
      } else if (msg.phase === "night" || (msg.phase === "ended" && msg.eliminatedId !== undefined)) {
        if (msg.eliminatedId !== undefined) {
          addLog(
            msg.eliminatedId
              ? `投票結果：${nameOf(msg.eliminatedId)} 被放逐。`
              : "投票平手（或無人投票），本輪無人出局。",
            "important",
          );
        }
        if (msg.shotId !== undefined) {
          addLog(msg.shotId ? `獵人開槍帶走了 ${nameOf(msg.shotId)}。` : "獵人收槍，沒有開火。", "important");
        }
        if (msg.phase === "night") addLog(`天黑請閉眼 —— 第 ${msg.round} 夜。`, "important");
      }

      if (msg.hunterId) {
        hunterPendingId = msg.hunterId;
        addLog(`${nameOf(msg.hunterId)} 是獵人！倒下前可以帶走一個人…`, "important");
      }
      renderWitchPanel();
      return;
    }

    case "seer_result":
      addLog(
        `查驗結果（第 ${msg.round} 夜）：${nameOf(msg.targetId)} 是「${
          msg.faction === "werewolf" ? "狼人" : "好人"
        }」。`,
        "private",
      );
      return;

    case "action_ack":
      picked = { action: msg.action, targetId: msg.targetId };
      if (msg.action === "save" || msg.action === "poison" || msg.action === "skip") {
        witchWake = null;
        poisonMode = false;
        renderWitchPanel();
      }
      renderPlayers();
      renderStatus();
      return;

    case "chat":
      addChat(msg.from, msg.text, msg.channel);
      return;

    case "game_over": {
      addLog(`遊戲結束：${WINNER_NAMES[msg.winner]}。`, "important");
      el<HTMLElement>("winner-line").textContent = WINNER_NAMES[msg.winner];
      const reveal = el<HTMLElement>("reveal");
      reveal.replaceChildren();
      for (const r of msg.roles) {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = r.name;
        const role = document.createElement("span");
        role.textContent = ROLE_NAMES[r.role];
        role.className =
          r.role === "werewolf" ? "r-wolf" : r.role === "villager" ? "" : "r-seer";
        li.append(name, role);
        reveal.append(li);
      }
      restartBtn.hidden = spectator || state?.hostId !== playerId;
      el<HTMLElement>("gameover").hidden = false;
      return;
    }

    case "error":
      lastErrorCode = msg.code;
      showToast(ERROR_TEXT[msg.code] ?? `發生錯誤：${msg.code}`);
      return;
  }
}

// ---------- rendering ----------

function render(): void {
  if (!state) return;
  renderPhase();
  renderStatus();
  renderPlayers();
  renderLobbyActions();
  renderHuntActions();
  renderChatAvailability();
}

function renderPhase(): void {
  if (!state) return;
  phaseBanner.dataset.phase = state.phase;
  phaseBanner.textContent =
    state.phase === "lobby"
      ? "大廳"
      : state.phase === "night"
        ? `第 ${state.round} 夜`
        : state.phase === "day"
          ? state.runoffIds
            ? `第 ${state.round} 天 · 決選`
            : `第 ${state.round} 天`
          : state.phase === "hunt"
            ? "獵人時刻"
            : "遊戲結束";
}

function renderStatus(): void {
  if (!state) return;
  const self = me();
  let text = "";
  if (spectator) {
    text = `旁觀中 · ${state.spectators} 位觀眾`;
  } else if (state.phase === "lobby") {
    text = `${state.players.length} / 12 位玩家 · 滿 ${MIN_PLAYERS} 人可開局`;
  } else if (self && !self.alive) {
    text = "你已出局：可在聊天留一句遺言，之後安靜看完這一局。";
  } else if (state.phase === "night") {
    if (state.nightStage === "witch") {
      text = myRole === "witch" ? "女巫時間：決定要不要用藥。" : "等待女巫用藥…";
    } else if (myRole === "werewolf") {
      text = picked?.action === "kill"
        ? `你選擇獵殺 ${nameOf(picked.targetId)}（結算前可改選）`
        : "選擇今晚要獵殺的對象（狼隊看得到彼此的刀向）。";
    } else if (myRole === "seer") {
      text = picked?.action === "inspect"
        ? `你查驗了 ${nameOf(picked.targetId)}，等待天亮…`
        : "選擇要查驗身分的玩家。";
    } else {
      text = state.nightPending ? "夜深了，等待夜間行動…" : "夜深了，等待天亮…";
    }
  } else if (state.phase === "day") {
    const votedCount = state.votedIds.length;
    const aliveCount = state.players.filter((p) => p.alive).length;
    const eligible = state.runoffIds ? aliveCount - state.runoffIds.length : aliveCount;
    if (state.runoffIds?.includes(playerId)) {
      text = "你是決選候選人：發表辯詞，等其他人重新投票。";
    } else {
      text = state.votedIds.includes(playerId)
        ? `你已投票，等待其他人（${votedCount} / ${eligible}）。`
        : `${state.runoffIds ? "決選中：" : ""}討論後點選要放逐的玩家（${votedCount} / ${eligible} 已投）。`;
    }
  } else if (state.phase === "hunt") {
    text =
      hunterPendingId === playerId
        ? "你倒下了，但可以開最後一槍。"
        : `等待獵人 ${nameOf(hunterPendingId)} 決定開不開槍…`;
  }
  statusLine.textContent = text;
}

function renderRoleCard(potions?: { save: boolean; poison: boolean }): void {
  if (!myRole) return;
  roleCard.hidden = false;
  el<HTMLElement>("role-name").textContent = ROLE_NAMES[myRole];
  const extra = el<HTMLElement>("role-extra");
  if (myRole === "werewolf") {
    extra.textContent =
      teammates.length > 0 ? `狼同伴：${teammates.map((t) => t.name).join("、")}` : "孤狼";
  } else if (myRole === "seer") {
    extra.textContent = "每晚可查驗一名玩家的陣營";
  } else if (myRole === "witch") {
    extra.textContent = potions
      ? `解藥 ${potions.save ? "✓" : "✗"} · 毒藥 ${potions.poison ? "✓" : "✗"}`
      : "一瓶解藥、一瓶毒藥，各用一次";
  } else if (myRole === "hunter") {
    extra.textContent = "被狼刀或被放逐時，可帶走一人";
  } else {
    extra.textContent = "白天用投票找出狼人";
  }
}

function renderWitchPanel(): void {
  if (!witchWake || myRole !== "witch") {
    witchPanel.hidden = true;
    return;
  }
  witchPanel.hidden = false;
  witchText.textContent = witchWake.victimId
    ? `今晚 ${nameOf(witchWake.victimId)} 倒牌。要救嗎？`
    : "今晚無人倒牌。要用毒藥嗎？";
  witchSave.disabled = !witchWake.canSave;
  witchPoison.disabled = !witchWake.canPoison;
  witchPoison.classList.toggle("armed", poisonMode);
  witchPoison.textContent = poisonMode ? "毒藥已上手：點選目標" : "用毒藥（點選目標）";
}

type TargetAction = "kill" | "inspect" | "vote" | "poison" | "shoot";

function canTarget(p: PublicPlayer): TargetAction | null {
  if (!state || spectator) return null;
  const self = me();
  if (!self || !p.alive) return null;

  if (state.phase === "hunt") {
    return hunterPendingId === playerId && p.id !== playerId ? "shoot" : null;
  }
  if (!self.alive) return null;

  if (state.phase === "night") {
    if (state.nightStage === "witch") {
      return myRole === "witch" && witchWake && poisonMode && witchWake.canPoison ? "poison" : null;
    }
    if (myRole === "werewolf") return "kill";
    if (myRole === "seer") return p.id === playerId ? null : "inspect";
    return null;
  }
  if (state.phase === "day" && !state.votedIds.includes(playerId)) {
    if (state.runoffIds) {
      if (state.runoffIds.includes(playerId)) return null;
      return state.runoffIds.includes(p.id) ? "vote" : null;
    }
    return "vote";
  }
  return null;
}

function sendTarget(action: TargetAction, p: PublicPlayer): void {
  if (action === "vote") {
    if (!confirm(`確定投票放逐 ${p.name}？投出後不能改票。`)) return;
    send({ type: "vote", targetId: p.id });
  } else if (action === "shoot") {
    if (!confirm(`確定開槍帶走 ${p.name}？`)) return;
    send({ type: "hunt", targetId: p.id });
  } else if (action === "poison") {
    if (!confirm(`確定對 ${p.name} 用毒藥？`)) return;
    send({ type: "night_action", action: "poison", targetId: p.id });
  } else {
    send({ type: "night_action", action, targetId: p.id });
  }
}

function renderPlayers(): void {
  if (!state) return;
  playersBox.replaceChildren();
  const teammateIds = new Set(teammates.map((t) => t.id));
  const packTargets = new Set(wolfPicks.values());
  for (const p of [...state.players].sort((a, b) => a.seat - b.seat)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "player";
    btn.setAttribute("aria-label", `座位 ${p.seat} ${p.name}${p.alive ? "" : "（已出局）"}`);
    if (p.id === playerId) btn.classList.add("me");
    if (!p.alive) btn.classList.add("dead");
    if (!p.connected && !spectator) btn.classList.add("offline");
    if (teammateIds.has(p.id)) btn.classList.add("teammate");
    if (picked?.targetId === p.id) btn.classList.add("picked");
    if (state.runoffIds?.includes(p.id)) btn.classList.add("runoff");

    const seat = document.createElement("span");
    seat.className = "seat";
    seat.textContent = `座位 ${p.seat}${p.id === state.hostId ? " · 房主" : ""}`;
    const pname = document.createElement("span");
    pname.className = "pname";
    pname.textContent = p.id === playerId ? `${p.name}（你）` : p.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    if (!p.alive) meta.textContent = p.role ? `已出局 · ${ROLE_NAMES[p.role]}` : "已出局";
    else if (state.phase === "day" && state.votedIds.includes(p.id)) meta.textContent = "已投票 ✓";
    else if (state.phase === "night" && myRole === "werewolf" && packTargets.has(p.id))
      meta.textContent = "狼隊目標 🎯";
    else if (teammateIds.has(p.id)) meta.textContent = "狼同伴";
    else if (state.runoffIds?.includes(p.id)) meta.textContent = "決選候選人";
    else if (!p.connected) meta.textContent = "斷線中";

    btn.append(seat, pname, meta);

    const action = canTarget(p);
    if (action) {
      btn.classList.add("targetable");
      btn.addEventListener("click", () => sendTarget(action, p));
    } else {
      btn.disabled = true;
    }
    playersBox.append(btn);
  }
}

function renderLobbyActions(): void {
  if (!state) return;
  const inLobby = state.phase === "lobby";
  lobbyActions.hidden = !inLobby || spectator;
  if (lobbyActions.hidden) return;
  const isHost = state.hostId === playerId;
  const count = state.players.length;
  startBtn.disabled = !isHost || count < MIN_PLAYERS;
  revealWrap.hidden = !isHost;
  startHint.textContent = !isHost
    ? "等待房主開始遊戲…"
    : count < MIN_PLAYERS
      ? `再等 ${MIN_PLAYERS - count} 位玩家加入就能開始。`
      : "人齊了，可以開始！";
}

function renderHuntActions(): void {
  if (!state) return;
  huntActions.hidden = !(state.phase === "hunt" && hunterPendingId === playerId);
}

function renderChatAvailability(): void {
  if (!state) return;
  if (spectator) {
    chatText.disabled = true;
    chatText.placeholder = "旁觀者不能發言";
    return;
  }
  const self = me();
  if (self && !self.alive) {
    chatText.disabled = false;
    chatText.placeholder = "你已出局：可以留下一句遺言…";
    return;
  }
  if (state.phase === "night") {
    const wolfChat = myRole === "werewolf" && !!self?.alive;
    chatText.disabled = !wolfChat;
    chatText.placeholder = wolfChat ? "狼人頻道（只有狼看得到）…" : "夜晚禁言";
    return;
  }
  chatText.disabled = false;
  chatText.placeholder = "說點什麼…";
}

// ---------- wire up static controls ----------

startBtn.addEventListener("click", () =>
  send({ type: "start_game", revealOnDeath: revealOpt.checked }),
);
restartBtn.addEventListener("click", () => send({ type: "restart" }));
witchSave.addEventListener("click", () => send({ type: "night_action", action: "save" }));
witchSkip.addEventListener("click", () => send({ type: "night_action", action: "skip" }));
witchPoison.addEventListener("click", () => {
  poisonMode = !poisonMode;
  renderWitchPanel();
  renderPlayers();
});
el<HTMLButtonElement>("hunt-pass").addEventListener("click", () => {
  if (confirm("確定收槍不開？")) send({ type: "hunt", targetId: null });
});

el<HTMLFormElement>("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatText.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  chatText.value = "";
});

el<HTMLButtonElement>("copy-link").addEventListener("click", async () => {
  const link = `${location.origin}/r/${code}`;
  try {
    await navigator.clipboard.writeText(link);
    showToast("邀請連結已複製，貼給朋友吧！");
  } catch {
    prompt("複製這個連結邀請朋友：", link);
  }
});

el<HTMLFormElement>("gate-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = el<HTMLInputElement>("gate-name").value.trim();
  if (name.length === 0 || name.length > 12) {
    gateErr.textContent = "暱稱要 1–12 個字。";
    gateErr.hidden = false;
    return;
  }
  myName = name;
  sessionStorage.setItem(NAME_KEY, name);
  gate.hidden = true;
  connect();
});

// ---------- boot ----------

async function boot(): Promise<void> {
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    showDeadEnd("網址不對", "房號應該是 6 碼英數字。");
    return;
  }
  try {
    const res = await fetch(`/api/rooms/${code}`);
    const { exists } = (await res.json()) as { exists: boolean };
    if (!exists) {
      showDeadEnd("找不到這間房", "房號可能打錯了，或房間已到期。");
      return;
    }
  } catch {
    // If the probe fails we still try the socket; it has its own errors.
  }
  if (myName) {
    gate.hidden = true;
    connect();
  } else {
    gate.hidden = false;
  }
}

void boot();
