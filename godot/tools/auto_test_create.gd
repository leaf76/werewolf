extends SceneTree
## Headless-ish automated create-room test (offline + online).
## Run: godot --path . -s res://tools/auto_test_create.gd

func _initialize() -> void:
	await process_frame
	await process_frame
	print("AUTO: start")
	var net := root.get_node_or_null("Net")
	var gs := root.get_node_or_null("GameState")
	if net == null or gs == null:
		push_error("AUTO: missing autoloads")
		quit(1)
		return

	# --- offline create ---
	net.offline_mode = true
	var got_code := [""]
	var err_msg := [""]
	net.room_created.connect(func(c: String): got_code[0] = c, CONNECT_ONE_SHOT)
	net.http_error.connect(func(m: String): err_msg[0] = m, CONNECT_ONE_SHOT)
	net.create_room()
	var t := 0.0
	while got_code[0] == "" and err_msg[0] == "" and t < 3.0:
		await process_frame
		t += 0.016
	print("AUTO offline code=", got_code[0], " err=", err_msg[0])
	if got_code[0] == "":
		push_error("AUTO: offline create failed")
		quit(2)
		return

	# enter room offline
	gs.enter_room(got_code[0], "自動測試")
	t = 0.0
	while gs.room.is_empty() and t < 3.0:
		await process_frame
		t += 0.016
	print("AUTO offline room keys=", gs.room.keys(), " players=", gs.room.get("players", []).size() if gs.room.has("players") else -1)
	if gs.room.is_empty():
		push_error("AUTO: offline room_state missing")
		quit(3)
		return

	# --- online create ---
	net.offline_mode = false
	net.set_base_url("https://werewolf.leafxc0903.workers.dev")
	got_code[0] = ""
	err_msg[0] = ""
	net.room_created.connect(func(c: String): got_code[0] = c, CONNECT_ONE_SHOT)
	net.http_error.connect(func(m: String): err_msg[0] = m, CONNECT_ONE_SHOT)
	net.create_room()
	t = 0.0
	while got_code[0] == "" and err_msg[0] == "" and t < 25.0:
		await process_frame
		t += 0.05
	print("AUTO online code=", got_code[0], " err=", err_msg[0])
	if got_code[0] == "":
		push_error("AUTO: online create failed: " + err_msg[0])
		quit(4)
		return

	print("AUTO: PASS offline+online create")
	quit(0)
