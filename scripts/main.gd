extends Control

@onready var base_url_edit: LineEdit = %BaseUrl
@onready var name_edit: LineEdit = %PlayerName
@onready var code_edit: LineEdit = %RoomCode
@onready var status_label: Label = %Status
@onready var create_btn: Button = %CreateBtn
@onready var join_btn: Button = %JoinBtn
@onready var offline_check: CheckBox = %OfflineCheck


func _ready() -> void:
	base_url_edit.text = Net.base_url
	create_btn.pressed.connect(_on_create)
	join_btn.pressed.connect(_on_join)
	if offline_check:
		offline_check.toggled.connect(_on_offline_toggled)
	Net.room_created.connect(_on_room_created)
	Net.room_exists_result.connect(_on_exists)
	Net.http_error.connect(_on_http_error)

	var cfg := ConfigFile.new()
	if cfg.load("user://prefs.cfg") == OK:
		name_edit.text = str(cfg.get_value("ui", "name", ""))
		var u := str(cfg.get_value("ui", "base_url", ""))
		if not u.is_empty():
			base_url_edit.text = u
		if offline_check:
			offline_check.button_pressed = bool(cfg.get_value("ui", "offline", false))
			Net.offline_mode = offline_check.button_pressed

	if name_edit.text.strip_edges().is_empty():
		name_edit.placeholder_text = "必填：例如 測試A"
	_refresh_status_hint()

	# Automation: WW_AUTO_CREATE=1 [WW_OFFLINE=1] [WW_NAME=TestA]
	if OS.get_environment("WW_AUTO_CREATE") == "1":
		call_deferred("_auto_create_for_test")


func _auto_create_for_test() -> void:
	await get_tree().process_frame
	await get_tree().process_frame
	var n := OS.get_environment("WW_NAME")
	if n.is_empty():
		n = "TestA"
	name_edit.text = n
	if offline_check:
		var off := OS.get_environment("WW_OFFLINE") != "0"
		offline_check.button_pressed = off
		Net.offline_mode = off
	print("[Main] AUTO_CREATE name=", n, " offline=", Net.offline_mode)
	_on_create()


func _on_offline_toggled(on: bool) -> void:
	Net.offline_mode = on
	_save_prefs()
	_refresh_status_hint()


func _refresh_status_hint() -> void:
	if Net.offline_mode:
		status_label.text = "離線試玩：可看圓桌／聊天泡泡，不能真正開局。"
		status_label.modulate = Color(0.7, 0.9, 1.0)
	else:
		status_label.text = "連線模式：需要可連外網。暱稱必填後按建立房間。"
		status_label.modulate = Color(1, 0.9, 0.55)


func _on_http_error(m: String) -> void:
	status_label.text = m
	status_label.modulate = Color(1.0, 0.55, 0.45)
	create_btn.disabled = false
	join_btn.disabled = false
	Sfx.play("error")


func _save_prefs() -> void:
	var cfg := ConfigFile.new()
	cfg.set_value("ui", "name", name_edit.text.strip_edges())
	cfg.set_value("ui", "base_url", base_url_edit.text.strip_edges())
	if offline_check:
		cfg.set_value("ui", "offline", offline_check.button_pressed)
	cfg.save("user://prefs.cfg")


func _valid_name() -> String:
	var n := name_edit.text.strip_edges()
	if n.is_empty() or n.length() > Protocol.MAX_NAME_LEN:
		status_label.text = "請先填暱稱（1–%d 字），再按建立房間。" % Protocol.MAX_NAME_LEN
		status_label.modulate = Color(1.0, 0.55, 0.45)
		name_edit.grab_focus()
		Sfx.play("error")
		return ""
	return n


func _on_create() -> void:
	Sfx.play_click()
	var n := _valid_name()
	if n.is_empty():
		return
	Net.set_base_url(base_url_edit.text.strip_edges())
	if offline_check:
		Net.offline_mode = offline_check.button_pressed
	_save_prefs()
	status_label.text = "建立房間中…（%s）" % ("離線" if Net.offline_mode else Net.base_url)
	status_label.modulate = Color(1, 0.95, 0.7)
	create_btn.disabled = true
	join_btn.disabled = true
	Net.create_room()


func _on_room_created(code: String) -> void:
	create_btn.disabled = false
	join_btn.disabled = false
	status_label.text = "已建房：%s，進入中…" % code
	status_label.modulate = Color(0.6, 1.0, 0.7)
	Sfx.play("start")
	_go_room(code)


func _on_join() -> void:
	Sfx.play_click()
	var n := _valid_name()
	if n.is_empty():
		return
	var code := code_edit.text.strip_edges().to_upper()
	if not _valid_code(code):
		status_label.text = "房號應為 6 碼英數字。"
		status_label.modulate = Color(1.0, 0.55, 0.45)
		Sfx.play("error")
		return
	Net.set_base_url(base_url_edit.text.strip_edges())
	if offline_check:
		Net.offline_mode = offline_check.button_pressed
	_save_prefs()
	status_label.text = "檢查房間…"
	status_label.modulate = Color(1, 0.95, 0.7)
	create_btn.disabled = true
	join_btn.disabled = true
	Net.probe_room(code)


func _on_exists(code: String, exists: bool) -> void:
	create_btn.disabled = false
	join_btn.disabled = false
	if not exists:
		status_label.text = "找不到這間房。"
		status_label.modulate = Color(1.0, 0.55, 0.45)
		Sfx.play("error")
		return
	Sfx.play("confirm")
	_go_room(code)


func _valid_code(code: String) -> bool:
	if code.length() != 6:
		return false
	var re := RegEx.new()
	re.compile("^[A-Z0-9]{6}$")
	return re.search(code) != null


func _go_room(code: String) -> void:
	var n := name_edit.text.strip_edges()
	GameState.enter_room(code, n)
	get_tree().change_scene_to_file("res://scenes/room.tscn")
