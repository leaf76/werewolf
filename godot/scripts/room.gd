extends Control

const ICON_WOLF := preload("res://assets/generated/role_werewolf.png")
const ICON_SEER := preload("res://assets/generated/role_seer.png")
const ICON_WITCH := preload("res://assets/generated/role_witch.png")
const ICON_HUNTER := preload("res://assets/generated/role_hunter.png")
const ICON_VILLAGER := preload("res://assets/generated/role_villager.png")

@onready var table_world: Node3D = %TableWorld3D
@onready var conn_label: Label = %Conn
@onready var phase_label: Label = %Phase
@onready var countdown_label: Label = %Countdown
@onready var status_line: Label = %StatusLine
@onready var role_card: PanelContainer = %RoleCard
@onready var role_icon: TextureRect = %RoleIcon
@onready var role_name_label: Label = %RoleName
@onready var role_extra: Label = %RoleExtra
@onready var room_code_label: Label = %RoomCodeLabel
@onready var log_list: RichTextLabel = %LogList
@onready var chat_list: RichTextLabel = %ChatList
@onready var chat_input: LineEdit = %ChatInput
@onready var chat_send: Button = %ChatSend
@onready var start_btn: Button = %StartBtn
@onready var reveal_check: CheckBox = %RevealCheck
@onready var restart_btn: Button = %RestartBtn
@onready var lobby_panel: HBoxContainer = %LobbyActions
@onready var witch_panel: HBoxContainer = %WitchPanel
@onready var witch_text: Label = %WitchText
@onready var witch_save: Button = %WitchSave
@onready var witch_poison: Button = %WitchPoison
@onready var witch_skip: Button = %WitchSkip
@onready var hunt_panel: HBoxContainer = %HuntActions
@onready var hunt_pass: Button = %HuntPass
@onready var copy_btn: Button = %CopyBtn
@onready var leave_btn: Button = %LeaveBtn
@onready var toast_label: Label = %Toast
@onready var gameover_panel: PanelContainer = %GameOver
@onready var winner_label: Label = %WinnerLine
@onready var reveal_list: RichTextLabel = %RevealList
@onready var spec_badge: Label = %SpecBadge
@onready var fatal_panel: PanelContainer = %FatalPanel
@onready var fatal_title: Label = %FatalTitle
@onready var fatal_text: Label = %FatalText

var _toast_timer: float = 0.0
var _last_phase: String = ""


func _ready() -> void:
	room_code_label.text = "房號 %s" % GameState.room_code
	log_list.clear()
	chat_list.clear()
	gameover_panel.visible = false
	fatal_panel.visible = false
	toast_label.visible = false
	spec_badge.visible = false

	GameState.state_changed.connect(_render)
	GameState.log_line.connect(_on_log)
	GameState.chat_line.connect(_on_chat)
	GameState.toast.connect(_show_toast)
	GameState.game_over_show.connect(_on_game_over)
	GameState.fatal_error.connect(_on_fatal)
	GameState.connection_status.connect(_on_conn)

	start_btn.pressed.connect(func():
		Sfx.play("start")
		GameState.send_start_game(reveal_check.button_pressed)
	)
	restart_btn.pressed.connect(func():
		Sfx.play("confirm")
		GameState.send_restart()
	)
	witch_save.pressed.connect(func():
		Sfx.play("confirm")
		GameState.send_night_action("save")
	)
	witch_skip.pressed.connect(func():
		Sfx.play_click()
		GameState.send_night_action("skip")
	)
	witch_poison.pressed.connect(func():
		Sfx.play_click()
		_toggle_poison()
	)
	hunt_pass.pressed.connect(func():
		Sfx.play_click()
		GameState.send_hunt(null)
	)
	chat_send.pressed.connect(_send_chat)
	chat_input.text_submitted.connect(func(_t): _send_chat())
	copy_btn.pressed.connect(func():
		Sfx.play_click()
		_copy_invite()
	)
	leave_btn.pressed.connect(func():
		Sfx.play_click()
		_leave()
	)

	if table_world.has_signal("seat_clicked"):
		table_world.seat_clicked.connect(_on_target)

	# SubViewportContainer.stretch handles sizing automatically
	_set_bg("lobby")
	_render()


func _process(delta: float) -> void:
	_update_countdown()
	if _toast_timer > 0.0:
		_toast_timer -= delta
		if _toast_timer <= 0.0:
			toast_label.visible = false


func _update_countdown() -> void:
	var room := GameState.room
	if room.is_empty():
		countdown_label.visible = false
		return
	var ph := str(room.get("phase", ""))
	var at = room.get("deadlineAt")
	if at == null or ph in ["lobby", "ended"]:
		countdown_label.visible = false
		return
	var left := maxi(0, ceili((float(at) / 1000.0) - Time.get_unix_time_from_system()))
	countdown_label.visible = true
	countdown_label.text = "⏱ %ds" % left
	countdown_label.modulate = Color(1, 0.45, 0.4) if left <= 10 else Color.WHITE


func _on_conn(text: String, open: bool) -> void:
	conn_label.text = text
	conn_label.modulate = Color(0.55, 1, 0.65) if open else Color(1, 0.75, 0.45)


func _on_log(text: String, kind: String) -> void:
	var color := "#dddddd"
	if kind == "important":
		color = "#f0d878"
	elif kind == "private":
		color = "#9ecbff"
	log_list.append_text("[color=%s]%s[/color]\n" % [color, text])


func _on_chat(from: String, text: String, channel: String) -> void:
	var prefix := ""
	if channel == "wolf":
		prefix = "[color=#e07070]【狼頻】[/color]"
	elif channel == "last_words":
		prefix = "[color=#c9a0ff]【遺言】[/color]"
	else:
		prefix = "[color=#a0d0a0]【大廳】[/color]"
	chat_list.append_text("%s[b]%s[/b]：%s\n" % [prefix, from, text])
	# 3D speech bubble over the speaker
	if table_world and table_world.has_method("show_chat_bubble"):
		table_world.show_chat_bubble(from, text, channel)
	Sfx.play_click()


func _show_toast(text: String) -> void:
	toast_label.text = text
	toast_label.visible = true
	_toast_timer = 2.6


func _on_game_over(winner: String, roles: Array) -> void:
	Sfx.play("death")
	winner_label.text = Protocol.winner_name(winner)
	reveal_list.clear()
	for r in roles:
		var rn := Protocol.role_name(str(r.get("role", "")))
		reveal_list.append_text("%s — %s\n" % [str(r.get("name", "")), rn])
	restart_btn.visible = not GameState.spectator and GameState.is_host()
	gameover_panel.visible = true


func _on_fatal(title: String, text: String) -> void:
	fatal_title.text = title
	fatal_text.text = text
	fatal_panel.visible = true


func _toggle_poison() -> void:
	GameState.poison_mode = not GameState.poison_mode
	_render()


func _send_chat() -> void:
	GameState.send_chat(chat_input.text)
	chat_input.text = ""


func _copy_invite() -> void:
	var link := "%s/r/%s" % [Net.base_url, GameState.room_code]
	DisplayServer.clipboard_set(link)
	_show_toast("邀請連結已複製（瀏覽器玩家可用）")


func _leave() -> void:
	GameState.leave_room()
	get_tree().change_scene_to_file("res://scenes/main.tscn")


func _set_bg(ph: String) -> void:
	# 2.5D: day/night is lighting + sky color in the 3D world
	if table_world.has_method("set_phase_tint"):
		table_world.set_phase_tint(ph)


func _render() -> void:
	var room := GameState.room
	if room.is_empty():
		status_line.text = "等待房間狀態…"
		return

	if str(room.get("phase", "")) == "lobby":
		gameover_panel.visible = false

	spec_badge.visible = GameState.spectator
	_render_phase()
	_render_status()
	_render_role_card()
	_render_players()
	_render_lobby()
	_render_witch()
	_render_hunt()
	_render_chat_avail()


func _render_phase() -> void:
	var room := GameState.room
	var ph := str(room.get("phase", ""))
	var round_n = room.get("round", 0)
	if ph != _last_phase:
		_last_phase = ph
		_set_bg(ph)
		Sfx.play_phase(ph)
	match ph:
		"lobby":
			phase_label.text = "🏠 大廳"
			phase_label.modulate = Color(0.85, 0.8, 1.0)
		"night":
			phase_label.text = "🌙 第 %s 夜" % str(round_n)
			phase_label.modulate = Color(0.65, 0.8, 1.0)
		"day":
			var runoff = room.get("runoffIds")
			if runoff is Array and runoff.size() > 0:
				phase_label.text = "☀️ 第 %s 天 · 決選" % str(round_n)
			else:
				phase_label.text = "☀️ 第 %s 天" % str(round_n)
			phase_label.modulate = Color(1.0, 0.88, 0.5)
		"hunt":
			phase_label.text = "🔫 獵人時刻"
			phase_label.modulate = Color(1.0, 0.55, 0.45)
		"ended":
			phase_label.text = "🏁 遊戲結束"
			phase_label.modulate = Color(0.95, 0.85, 0.55)
		_:
			phase_label.text = ph


func _render_status() -> void:
	var room := GameState.room
	var ph := str(room.get("phase", ""))
	var self_p := GameState.me()
	var text := ""

	if GameState.spectator:
		text = "旁觀中 · %s 位觀眾" % str(room.get("spectators", 0))
	elif ph == "lobby":
		var n := (room.get("players", []) as Array).size()
		text = "%d / 12 位玩家 · 滿 %d 人可開局 · 2.5D 圓桌" % [n, Protocol.MIN_PLAYERS]
	elif not self_p.is_empty() and not bool(self_p.get("alive", true)):
		text = "你已出局：可在聊天留一句遺言，之後安靜看完這一局。"
	elif ph == "night":
		var stage = room.get("nightStage")
		if stage == "witch":
			text = "女巫時間：決定要不要用藥。" if GameState.my_role == "witch" else "等待女巫用藥…"
		elif GameState.my_role == "werewolf":
			if str(GameState.picked.get("action", "")) == "kill":
				text = "你選擇獵殺 %s（結算前可改選）" % GameState.name_of(str(GameState.picked.get("targetId", "")))
			else:
				text = "點選圓桌座位：今晚要獵殺的對象"
		elif GameState.my_role == "seer":
			if str(GameState.picked.get("action", "")) == "inspect":
				text = "你查驗了 %s，等待天亮…" % GameState.name_of(str(GameState.picked.get("targetId", "")))
			else:
				text = "點選圓桌座位：查驗身分"
		else:
			text = "夜深了，等待夜間行動…" if bool(room.get("nightPending", false)) else "夜深了，等待天亮…"
	elif ph == "day":
		var voted: Array = room.get("votedIds", [])
		var alive := 0
		for p in room.get("players", []):
			if bool(p.get("alive", false)):
				alive += 1
		var runoff = room.get("runoffIds")
		var eligible := alive
		if runoff is Array and runoff.size() > 0:
			eligible = alive - runoff.size()
		if runoff is Array and GameState.player_id in runoff:
			text = "你是決選候選人：發表辯詞，等其他人重新投票。"
		elif GameState.player_id in voted:
			text = "你已投票，等待其他人（%d / %d）。" % [voted.size(), eligible]
		else:
			var pk := "決選中：" if runoff is Array and runoff.size() > 0 else ""
			text = "%s點選圓桌座位投票放逐（%d / %d 已投）" % [pk, voted.size(), eligible]
	elif ph == "hunt":
		if GameState.hunter_pending_id == GameState.player_id:
			text = "你倒下了：點選座位開槍，或按收槍。"
		else:
			text = "等待獵人 %s 決定開不開槍…" % GameState.name_of(GameState.hunter_pending_id)

	status_line.text = text


func _render_role_card() -> void:
	if GameState.my_role.is_empty():
		role_card.visible = false
		return
	role_card.visible = true
	match GameState.my_role:
		"werewolf":
			role_icon.texture = ICON_WOLF
			role_name_label.text = "狼人"
			if GameState.teammates.size() > 0:
				var names: PackedStringArray = []
				for tm in GameState.teammates:
					names.append(str(tm.get("name", "?")))
				role_extra.text = "狼同伴：%s" % "、".join(names)
			else:
				role_extra.text = "孤狼"
		"seer":
			role_icon.texture = ICON_SEER
			role_name_label.text = "預言家"
			role_extra.text = "每晚可查驗一名玩家的陣營"
		"witch":
			role_icon.texture = ICON_WITCH
			role_name_label.text = "女巫"
			role_extra.text = "一瓶解藥、一瓶毒藥，各用一次"
		"hunter":
			role_icon.texture = ICON_HUNTER
			role_name_label.text = "獵人"
			role_extra.text = "被狼刀或被放逐時，可帶走一人"
		_:
			role_icon.texture = ICON_VILLAGER
			role_name_label.text = "平民"
			role_extra.text = "白天用投票找出狼人"


func _render_players() -> void:
	var room := GameState.room
	var players: Array = room.get("players", []).duplicate()
	players.sort_custom(func(a, b): return int(a.get("seat", 0)) < int(b.get("seat", 0)))

	var teammate_ids: Dictionary = {}
	for tm in GameState.teammates:
		teammate_ids[str(tm.get("id", ""))] = true

	var pack_targets: Dictionary = {}
	for tid in GameState.wolf_picks.values():
		pack_targets[str(tid)] = true

	var runoff = room.get("runoffIds")
	var host_id := str(room.get("hostId", ""))
	var ph := str(room.get("phase", ""))
	var actions: Dictionary = {}
	var metas: Dictionary = {}

	for p in players:
		var pid := str(p.get("id", ""))
		var meta := ""
		if not bool(p.get("alive", true)):
			var r = p.get("role")
			if r != null:
				meta = "出局 · " + Protocol.role_name(str(r))
			else:
				meta = "出局"
		elif ph == "day" and pid in room.get("votedIds", []):
			meta = "已投票"
		elif ph == "night" and GameState.my_role == "werewolf" and pack_targets.has(pid):
			meta = "狼隊目標"
		elif teammate_ids.has(pid):
			meta = "狼同伴"
		elif runoff is Array and pid in runoff:
			meta = "決選"
		elif not bool(p.get("connected", true)):
			meta = "斷線"
		elif pid == host_id:
			meta = "房主"

		metas[pid] = meta
		var act := GameState.can_target(p)
		if not act.is_empty():
			actions[pid] = act

	var ctx: Dictionary = {
		"player_id": GameState.player_id,
		"teammate_ids": teammate_ids,
		"actions": actions,
		"metas": metas,
	}
	if table_world.has_method("rebuild_seats"):
		table_world.rebuild_seats(players, ctx)


func _on_target(action: String, p: Dictionary) -> void:
	var pname := str(p.get("name", ""))
	var pid := str(p.get("id", ""))
	match action:
		"vote":
			if not await _confirm("確定投票放逐 %s？投出後不能改票。" % pname):
				return
			Sfx.play("vote")
			GameState.send_vote(pid)
		"shoot":
			if not await _confirm("確定開槍帶走 %s？" % pname):
				return
			Sfx.play("death")
			GameState.send_hunt(pid)
		"poison":
			if not await _confirm("確定對 %s 用毒藥？" % pname):
				return
			Sfx.play("death")
			GameState.send_night_action("poison", pid)
		"kill", "inspect":
			Sfx.play("vote" if action == "kill" else "confirm")
			GameState.send_night_action(action, pid)


func _confirm(text: String) -> bool:
	var d := ConfirmationDialog.new()
	d.dialog_text = text
	add_child(d)
	d.popup_centered()
	var result := [false]
	var done := [false]
	d.confirmed.connect(func():
		result[0] = true
		done[0] = true
	)
	d.canceled.connect(func(): done[0] = true)
	d.close_requested.connect(func(): done[0] = true)
	while not done[0]:
		await get_tree().process_frame
	d.queue_free()
	return result[0]


func _render_lobby() -> void:
	var room := GameState.room
	var in_lobby := str(room.get("phase", "")) == "lobby"
	lobby_panel.visible = in_lobby and not GameState.spectator
	if not lobby_panel.visible:
		return
	var count := (room.get("players", []) as Array).size()
	var host := GameState.is_host()
	start_btn.disabled = not host or count < Protocol.MIN_PLAYERS
	reveal_check.visible = host


func _render_witch() -> void:
	var show_witch := not GameState.witch_wake.is_empty() and GameState.my_role == "witch"
	witch_panel.visible = show_witch
	if not show_witch:
		return
	var victim = GameState.witch_wake.get("victimId")
	if victim != null and str(victim) != "":
		witch_text.text = "今晚 %s 倒牌。要救嗎？" % GameState.name_of(str(victim))
	else:
		witch_text.text = "今晚無人倒牌。要用毒藥嗎？"
	witch_save.disabled = not bool(GameState.witch_wake.get("canSave", false))
	witch_poison.disabled = not bool(GameState.witch_wake.get("canPoison", false))
	witch_poison.text = "毒藥已上手：點選座位" if GameState.poison_mode else "用毒藥（再點座位）"


func _render_hunt() -> void:
	hunt_panel.visible = (
		str(GameState.room.get("phase", "")) == "hunt"
		and GameState.hunter_pending_id == GameState.player_id
	)


func _render_chat_avail() -> void:
	var room := GameState.room
	if GameState.spectator:
		chat_input.editable = false
		chat_input.placeholder_text = "旁觀者不能發言"
		return
	var self_p := GameState.me()
	if not self_p.is_empty() and not bool(self_p.get("alive", true)):
		chat_input.editable = true
		chat_input.placeholder_text = "你已出局：可以留下一句遺言…"
		return
	if str(room.get("phase", "")) == "night":
		var wolf_chat := GameState.my_role == "werewolf" and bool(self_p.get("alive", false))
		chat_input.editable = wolf_chat
		chat_input.placeholder_text = "狼人頻道…" if wolf_chat else "夜晚禁言"
		return
	chat_input.editable = true
	chat_input.placeholder_text = "說點什麼…"
