## Client-side game mirror of public + private unicast state.
## Never invents hidden info; only stores what the server sends.
extends Node

signal state_changed
signal log_line(text: String, kind: String)  # kind: "" | "important" | "private"
signal chat_line(from: String, text: String, channel: String)
signal toast(text: String)
signal session_ready
signal game_over_show(winner: String, roles: Array)
signal fatal_error(title: String, text: String)
signal connection_status(text: String, open: bool)

var room_code: String = ""
var player_id: String = ""
var secret: String = ""
var player_name: String = ""

var room: Dictionary = {}  # PublicRoomState
var my_role: String = ""  # empty = unknown
var teammates: Array = []  # [{id, name}]
var spectator: bool = false
var picked: Dictionary = {}  # {action, targetId?}
var wolf_picks: Dictionary = {}  # wolfId -> targetId
var witch_wake: Dictionary = {}  # empty or {victimId, canSave, canPoison}
var poison_mode: bool = false
var hunter_pending_id: String = ""
var fatal: bool = false
var last_error_code: String = ""

var _reconnect_attempts: int = 0
var _want_reconnect: bool = false


func _ready() -> void:
	Net.connected.connect(_on_ws_connected)
	Net.disconnected.connect(_on_ws_disconnected)
	Net.server_message.connect(handle_server_message)
	Net.http_error.connect(func(m: String): toast.emit(m))


# ---------- identity / persistence (per room, user://) ----------

func _seat_path(code: String) -> String:
	return "user://seat_%s.cfg" % code.to_upper()


func load_or_create_seat(code: String, display_name: String) -> void:
	room_code = code.to_upper()
	player_name = display_name.strip_edges()
	var path := _seat_path(room_code)
	var cfg := ConfigFile.new()
	if cfg.load(path) == OK:
		player_id = str(cfg.get_value("seat", "player_id", ""))
		secret = str(cfg.get_value("seat", "secret", ""))
		if player_name.is_empty():
			player_name = str(cfg.get_value("seat", "name", ""))
	if player_id.is_empty():
		player_id = _new_uuid()
	_save_seat()


func _save_seat() -> void:
	if room_code.is_empty():
		return
	var cfg := ConfigFile.new()
	cfg.set_value("seat", "player_id", player_id)
	cfg.set_value("seat", "secret", secret)
	cfg.set_value("seat", "name", player_name)
	cfg.save(_seat_path(room_code))


func _new_uuid() -> String:
	# Good enough client id; server issues secret for authority.
	var b := PackedByteArray()
	b.resize(16)
	for i in 16:
		b[i] = randi() % 256
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	var hex := b.hex_encode()
	return "%s-%s-%s-%s-%s" % [
		hex.substr(0, 8), hex.substr(8, 4), hex.substr(12, 4),
		hex.substr(16, 4), hex.substr(20, 12)
	]


# ---------- connect / join ----------

func enter_room(code: String, display_name: String) -> void:
	fatal = false
	_want_reconnect = true
	_reconnect_attempts = 0
	reset_round_private()
	my_role = ""
	teammates = []
	spectator = false
	room = {}
	load_or_create_seat(code, display_name)
	connection_status.emit("連線中…", false)
	var err := Net.connect_room(room_code)
	if err != OK:
		connection_status.emit("連線失敗", false)
		toast.emit("無法建立 WebSocket（錯誤碼 %s）。請檢查 URL 或改用離線試玩。" % err)
		print("[GameState] connect_room failed: ", err)
		return
	# Offline: ensure lobby state even if scene change races the deferred Net inject
	if Net.offline_mode:
		call_deferred("_ensure_offline_lobby")


func leave_room() -> void:
	_want_reconnect = false
	Net.disconnect_ws()
	room_code = ""
	room = {}
	connection_status.emit("未連線", false)


func _ensure_offline_lobby() -> void:
	if not Net.offline_mode:
		return
	if not room.is_empty():
		connection_status.emit("已連線（離線）", true)
		state_changed.emit()
		return
	# Fallback lobby if Net inject lost the race
	if secret.is_empty():
		secret = "offline-secret"
		_save_seat()
	var pname := player_name if not player_name.is_empty() else "玩家"
	room = {
		"code": room_code,
		"phase": "lobby",
		"round": 0,
		"hostId": player_id,
		"players": [
			{"id": player_id, "name": pname, "seat": 1, "alive": true, "connected": true},
			{"id": "bot-2", "name": "小紅", "seat": 2, "alive": true, "connected": true},
			{"id": "bot-3", "name": "小藍", "seat": 3, "alive": true, "connected": true},
		],
		"votedIds": [],
		"nightPending": false,
		"nightStage": null,
		"runoffIds": null,
		"deadlineAt": null,
		"spectators": 0,
		"revealOnDeath": false,
		"winner": null,
	}
	connection_status.emit("已連線（離線）", true)
	state_changed.emit()
	print("[GameState] offline lobby injected fallback")


func reset_round_private() -> void:
	picked = {}
	poison_mode = false
	witch_wake = {}
	wolf_picks.clear()
	hunter_pending_id = ""


func _on_ws_connected() -> void:
	connection_status.emit("已連線", true)
	_reconnect_attempts = 0
	var join := {
		"type": "join",
		"playerId": player_id,
		"name": player_name,
	}
	if not secret.is_empty():
		join["secret"] = secret
	Net.send_message(join)


func _on_ws_disconnected(code: int, _reason: String) -> void:
	connection_status.emit("已斷線", false)
	if fatal:
		return
	if code == Net.CLOSE_REPLACED:
		fatal = true
		_want_reconnect = false
		fatal_error.emit("這個座位已在別處連線", "同一玩家開了新視窗，這裡被取代。")
		return
	if code == Net.CLOSE_JOIN_DENIED:
		fatal = true
		_want_reconnect = false
		fatal_error.emit("無法加入這間房", Protocol.error_message(last_error_code))
		return
	if last_error_code == "room_closed":
		fatal = true
		_want_reconnect = false
		fatal_error.emit("房間已關閉", Protocol.error_message("room_closed"))
		return
	if not _want_reconnect:
		return
	_reconnect_attempts += 1
	var delay := minf(1.0 * float(_reconnect_attempts), 5.0)
	connection_status.emit("已斷線，%.0f 秒後重連…" % delay, false)
	await get_tree().create_timer(delay).timeout
	if not _want_reconnect or fatal:
		return
	Net.probe_room(room_code)
	var exists: bool = await _wait_exists()
	if not exists:
		fatal = true
		_want_reconnect = false
		fatal_error.emit("房間已關閉", "這間房已經到期或被清除了。")
		return
	Net.connect_room(room_code)


func _wait_exists() -> bool:
	var result := [null]
	var cb := func(code: String, exists: bool):
		if code == room_code:
			result[0] = exists
	Net.room_exists_result.connect(cb, CONNECT_ONE_SHOT)
	# timeout
	var t := 0.0
	while result[0] == null and t < 8.0:
		await get_tree().process_frame
		t += get_process_delta_time()
	if result[0] == null:
		return true  # probe failed — try socket anyway
	return bool(result[0])


# ---------- outbound intents ----------

func send_start_game(reveal_on_death: bool) -> void:
	Net.send_message({"type": "start_game", "revealOnDeath": reveal_on_death})


func send_restart() -> void:
	Net.send_message({"type": "restart"})


func send_night_action(action: String, target_id: String = "") -> void:
	var msg := {"type": "night_action", "action": action}
	if action in ["kill", "inspect", "poison"]:
		msg["targetId"] = target_id
	Net.send_message(msg)


func send_vote(target_id: String) -> void:
	Net.send_message({"type": "vote", "targetId": target_id})


func send_hunt(target_id) -> void:
	# null = holster
	Net.send_message({"type": "hunt", "targetId": target_id})


func send_chat(text: String) -> void:
	var t := text.strip_edges()
	if t.is_empty():
		return
	if t.length() > Protocol.MAX_CHAT_LEN:
		t = t.substr(0, Protocol.MAX_CHAT_LEN)
	Net.send_message({"type": "chat", "text": t})


# ---------- helpers for UI ----------

func me() -> Dictionary:
	if spectator or room.is_empty():
		return {}
	for p in room.get("players", []):
		if str(p.get("id", "")) == player_id:
			return p
	return {}


func name_of(id: String) -> String:
	if id.is_empty():
		return "？"
	for p in room.get("players", []):
		if str(p.get("id", "")) == id:
			return str(p.get("name", "？"))
	return "？"


func is_host() -> bool:
	return not room.is_empty() and str(room.get("hostId", "")) == player_id


func phase() -> String:
	return str(room.get("phase", ""))


## What target action is allowed on public player p, or "".
func can_target(p: Dictionary) -> String:
	if room.is_empty() or spectator:
		return ""
	var self_p := me()
	if self_p.is_empty() or not bool(p.get("alive", false)):
		return ""
	var pid := str(p.get("id", ""))
	var ph := phase()

	if ph == "hunt":
		if hunter_pending_id == player_id and pid != player_id:
			return "shoot"
		return ""

	if not bool(self_p.get("alive", false)):
		return ""

	if ph == "night":
		var stage = room.get("nightStage")
		if stage == "witch":
			if my_role == "witch" and not witch_wake.is_empty() and poison_mode and bool(witch_wake.get("canPoison", false)):
				return "poison"
			return ""
		if my_role == "werewolf":
			return "kill"
		if my_role == "seer":
			return "" if pid == player_id else "inspect"
		return ""

	if ph == "day":
		var voted: Array = room.get("votedIds", [])
		if player_id in voted:
			return ""
		var runoff = room.get("runoffIds")
		if runoff is Array and runoff.size() > 0:
			if player_id in runoff:
				return ""
			return "vote" if pid in runoff else ""
		return "vote"
	return ""


# ---------- inbound ----------

func handle_server_message(msg: Dictionary) -> void:
	var t := str(msg.get("type", ""))
	match t:
		"session":
			secret = str(msg.get("secret", ""))
			player_id = str(msg.get("playerId", player_id))
			_save_seat()
			session_ready.emit()
		"room_state":
			room = msg.get("state", {})
			state_changed.emit()
		"spectate":
			spectator = true
			log_line.emit("你以旁觀者身分進入：看得到公開進程，看不到任何身分。", "")
			state_changed.emit()
		"role_assigned":
			my_role = str(msg.get("role", ""))
			teammates = msg.get("teammates", [])
			log_line.emit("你的身分是「%s」。" % Protocol.role_name(my_role), "private")
			if my_role == "werewolf":
				if teammates.size() > 0:
					var names: PackedStringArray = []
					for tm in teammates:
						names.append(str(tm.get("name", "?")))
					log_line.emit("你的狼同伴：%s。" % "、".join(names), "private")
				else:
					log_line.emit("這一局只有你一匹狼。", "private")
			state_changed.emit()
		"wolf_pick":
			var wid := str(msg.get("wolfId", ""))
			var tid := str(msg.get("targetId", ""))
			wolf_picks[wid] = tid
			if wid != player_id:
				log_line.emit("狼同伴 %s 想刀 %s。" % [name_of(wid), name_of(tid)], "private")
			state_changed.emit()
		"witch_wake":
			witch_wake = {
				"victimId": msg.get("victimId"),  # may be null
				"canSave": bool(msg.get("canSave", false)),
				"canPoison": bool(msg.get("canPoison", false)),
			}
			poison_mode = false
			var victim = witch_wake.get("victimId")
			if victim != null and str(victim) != "":
				log_line.emit("女巫睜眼：今晚 %s 倒牌。" % name_of(str(victim)), "private")
			else:
				log_line.emit("女巫睜眼：今晚無人倒牌。", "private")
			state_changed.emit()
		"phase_changed":
			_on_phase_changed(msg)
			state_changed.emit()
		"seer_result":
			var fac := str(msg.get("faction", ""))
			var label := "狼人" if fac == "werewolf" else "好人"
			log_line.emit(
				"查驗結果（第 %s 夜）：%s 是「%s」。" % [
					str(msg.get("round", "")), name_of(str(msg.get("targetId", ""))), label
				],
				"private"
			)
		"action_ack":
			picked = {"action": str(msg.get("action", "")), "targetId": str(msg.get("targetId", ""))}
			var act := str(picked.get("action", ""))
			if act in ["save", "poison", "skip"]:
				witch_wake = {}
				poison_mode = false
			state_changed.emit()
		"chat":
			chat_line.emit(str(msg.get("from", "")), str(msg.get("text", "")), str(msg.get("channel", "public")))
		"game_over":
			log_line.emit("遊戲結束：%s。" % Protocol.winner_name(str(msg.get("winner", ""))), "important")
			game_over_show.emit(str(msg.get("winner", "")), msg.get("roles", []))
			state_changed.emit()
		"error":
			last_error_code = str(msg.get("code", ""))
			var err_text := Protocol.error_message(last_error_code)
			if msg.has("message") and str(msg.get("message", "")) != "":
				var server_msg := str(msg.get("message", ""))
				if err_text.begins_with("發生錯誤"):
					err_text = server_msg
			toast.emit(err_text)
			print("[GameState] error: ", last_error_code, " ", err_text)
		_:
			push_warning("Unknown server message: %s" % t)


func _on_phase_changed(msg: Dictionary) -> void:
	reset_round_private()
	if str(msg.get("phase", "")) != "hunt":
		hunter_pending_id = ""

	if msg.has("voteReveal") and msg["voteReveal"] is Array:
		_log_vote_reveal(msg["voteReveal"])

	var ph := str(msg.get("phase", ""))
	var round_n = msg.get("round", 0)

	if ph == "lobby":
		my_role = ""
		teammates = []
		log_line.emit("房主重開了一局：同一批座位，重新發牌。", "important")
		return

	if msg.has("runoffIds") and msg["runoffIds"] is Array and msg["runoffIds"].size() > 0:
		var names: PackedStringArray = []
		for id in msg["runoffIds"]:
			names.append(name_of(str(id)))
		log_line.emit("投票平手：%s 進入決選，其餘玩家重新投票。" % "、".join(names), "important")

	if msg.has("deaths") and msg["deaths"] is Array:
		var deaths: Array = msg["deaths"]
		if deaths.size() > 0:
			var names: PackedStringArray = []
			for id in deaths:
				names.append(name_of(str(id)))
			log_line.emit("天亮了：%s 昨夜死亡。" % "、".join(names), "important")
		else:
			log_line.emit("天亮了：昨夜平安，無人死亡。", "important")

	if msg.has("eliminatedId"):
		var eid = msg.get("eliminatedId")
		if eid == null:
			log_line.emit("投票平手（或無人投票），本輪無人出局。", "important")
		else:
			log_line.emit("投票結果：%s 被放逐。" % name_of(str(eid)), "important")

	if msg.has("shotId"):
		var sid = msg.get("shotId")
		if sid == null:
			log_line.emit("獵人收槍，沒有開火。", "important")
		else:
			log_line.emit("獵人開槍帶走了 %s。" % name_of(str(sid)), "important")

	if msg.has("hunterId"):
		hunter_pending_id = str(msg.get("hunterId", ""))
		log_line.emit("%s 是獵人！倒下前可以帶走一個人…" % name_of(hunter_pending_id), "important")

	if ph == "night" and int(round_n) == 1 and not msg.has("eliminatedId") and not msg.has("shotId"):
		log_line.emit("遊戲開始，天黑請閉眼 —— 第 1 夜。", "important")
	elif ph == "night" and msg.has("eliminatedId"):
		log_line.emit("天黑請閉眼 —— 第 %s 夜。" % str(round_n), "important")


func _log_vote_reveal(reveal: Array) -> void:
	if reveal.is_empty():
		log_line.emit("開票：這一輪沒有任何選票。", "")
		return
	var by_target: Dictionary = {}
	for v in reveal:
		var tid := str(v.get("targetId", ""))
		if not by_target.has(tid):
			by_target[tid] = []
		(by_target[tid] as Array).append(name_of(str(v.get("voterId", ""))))
	var parts: PackedStringArray = []
	var keys: Array = by_target.keys()
	keys.sort_custom(func(a, b): return (by_target[a] as Array).size() > (by_target[b] as Array).size())
	for tid in keys:
		var voters: Array = by_target[tid]
		parts.append("%s %d 票（%s）" % [name_of(str(tid)), voters.size(), "、".join(PackedStringArray(voters))])
	log_line.emit("開票：%s" % "；".join(parts), "")
