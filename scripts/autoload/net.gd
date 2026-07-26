## HTTP room API + WebSocket transport for the werewolf-demo backend.
extends Node

signal connected
signal disconnected(code: int, reason: String)
signal server_message(msg: Dictionary)
signal http_error(message: String)
signal room_created(code: String)
signal room_exists_result(code: String, exists: bool)

## Default: production demo. Override in main UI or set before connect.
var base_url: String = "https://werewolf-demo.leafxc0903.workers.dev"

## When true, create/join skip network (UI-only testing).
var offline_mode: bool = false

var _ws := WebSocketPeer.new()
var _ws_active: bool = false
var _http: HTTPRequest
var _pending_http: String = ""  # "create" | "exists"
var _exists_code: String = ""
var _opening: bool = false

const CLOSE_REPLACED := 4000
const CLOSE_JOIN_DENIED := 4001

const HTTP_RESULT_TEXT := {
	0: "成功",
	1: "分塊大小不符",
	2: "無法連線伺服器",
	3: "無法解析網域（DNS）",
	4: "連線錯誤",
	5: "TLS/憑證握手失敗",
	6: "伺服器無回應",
	7: "回應過大",
	8: "解壓失敗",
	9: "請求失敗",
	13: "逾時（15 秒）",
}


func _ready() -> void:
	_http = HTTPRequest.new()
	_http.timeout = 20.0
	_http.use_threads = true
	add_child(_http)
	_http.request_completed.connect(_on_http_completed)


func _process(_delta: float) -> void:
	if not _ws_active:
		return
	_ws.poll()
	var state := _ws.get_ready_state()
	match state:
		WebSocketPeer.STATE_OPEN:
			while _ws.get_available_packet_count() > 0:
				var packet := _ws.get_packet()
				var text := packet.get_string_from_utf8()
				var data = JSON.parse_string(text)
				if typeof(data) == TYPE_DICTIONARY:
					server_message.emit(data)
				else:
					push_warning("Net: non-object JSON: %s" % text)
		WebSocketPeer.STATE_CLOSING:
			pass
		WebSocketPeer.STATE_CLOSED:
			var code := _ws.get_close_code()
			var reason := _ws.get_close_reason()
			_ws_active = false
			disconnected.emit(code, reason)


func set_base_url(url: String) -> void:
	base_url = url.strip_edges().rstrip("/")


func is_ws_open() -> bool:
	return _ws_active and _ws.get_ready_state() == WebSocketPeer.STATE_OPEN


func _cancel_http() -> void:
	if _http.get_http_client_status() != HTTPClient.STATUS_DISCONNECTED:
		_http.cancel_request()
	_pending_http = ""


## POST /api/rooms → { code, url }
func create_room() -> void:
	if offline_mode:
		var code := _offline_code()
		call_deferred("_emit_offline_created", code)
		return

	if base_url.is_empty() or not (base_url.begins_with("http://") or base_url.begins_with("https://")):
		http_error.emit("伺服器 URL 無效，需以 http:// 或 https:// 開頭")
		return

	_cancel_http()
	_pending_http = "create"
	var url := "%s/api/rooms" % base_url
	print("[Net] POST ", url)
	var err := _http.request(
		url,
		PackedStringArray(["Content-Type: application/json", "Accept: application/json"]),
		HTTPClient.METHOD_POST,
		"{}"
	)
	if err != OK:
		_pending_http = ""
		http_error.emit("無法送出建房請求：%s" % _request_err_text(err))


func _emit_offline_created(code: String) -> void:
	room_created.emit(code)


## GET /api/rooms/:code → { exists }
func probe_room(code: String) -> void:
	if offline_mode:
		_exists_code = code.to_upper()
		call_deferred("_emit_offline_exists", true)
		return

	_cancel_http()
	_pending_http = "exists"
	_exists_code = code.to_upper()
	var url := "%s/api/rooms/%s" % [base_url, _exists_code]
	print("[Net] GET ", url)
	var err := _http.request(url, PackedStringArray(["Accept: application/json"]))
	if err != OK:
		_pending_http = ""
		http_error.emit("無法查詢房間：%s" % _request_err_text(err))


func _emit_offline_exists(exists: bool) -> void:
	room_exists_result.emit(_exists_code, exists)


func connect_room(code: String) -> Error:
	if offline_mode:
		# Fake an open connection; GameState will send join (ignored) and we inject lobby state.
		call_deferred("_offline_connected", code.to_upper())
		return OK

	disconnect_ws()
	var room := code.to_upper()
	var ws_url := _to_ws_url("%s/api/rooms/%s/ws" % [base_url, room])
	print("[Net] WS connect ", ws_url)
	var err := _ws.connect_to_url(ws_url)
	if err != OK:
		return err
	_ws_active = true
	_opening = true
	_wait_open()
	return OK


func _offline_connected(code: String) -> void:
	_ws_active = false  # no real socket
	connected.emit()
	# After GameState sends join on connected, push a fake session + room_state
	await get_tree().create_timer(0.05).timeout
	var pid := GameState.player_id
	var pname := GameState.player_name
	if pname.is_empty():
		pname = "玩家"
	server_message.emit({"type": "session", "playerId": pid, "secret": "offline-secret"})
	server_message.emit({
		"type": "room_state",
		"state": {
			"code": code,
			"phase": "lobby",
			"round": 0,
			"hostId": pid,
			"players": [
				{
					"id": pid,
					"name": pname,
					"seat": 1,
					"alive": true,
					"connected": true,
				},
				{
					"id": "bot-2",
					"name": "小紅",
					"seat": 2,
					"alive": true,
					"connected": true,
				},
				{
					"id": "bot-3",
					"name": "小藍",
					"seat": 3,
					"alive": true,
					"connected": true,
				},
			],
			"votedIds": [],
			"nightPending": 0,
			"nightStage": null,
			"runoffIds": null,
			"deadlineAt": null,
			"spectators": 0,
			"revealOnDeath": false,
			"winner": null,
		}
	})


func _offline_code() -> String:
	const alphabet := "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	var code := ""
	for i in 6:
		code += alphabet[randi() % alphabet.length()]
	return code


func _wait_open() -> void:
	if not is_inside_tree():
		return
	var tries := 0
	while tries < 400:
		await get_tree().process_frame
		if not _ws_active:
			_opening = false
			return
		_ws.poll()
		var st := _ws.get_ready_state()
		if st == WebSocketPeer.STATE_OPEN:
			if _opening:
				_opening = false
				connected.emit()
			return
		if st == WebSocketPeer.STATE_CLOSED:
			_opening = false
			_ws_active = false
			disconnected.emit(_ws.get_close_code(), _ws.get_close_reason())
			return
		tries += 1
	_opening = false
	http_error.emit("WebSocket 連線逾時，請檢查網路或伺服器 URL")
	disconnect_ws()


func send_message(msg: Dictionary) -> void:
	if offline_mode:
		_handle_offline_client_msg(msg)
		return
	if not is_ws_open():
		push_warning("Net.send_message: socket not open")
		return
	_ws.send_text(JSON.stringify(msg))


func _handle_offline_client_msg(msg: Dictionary) -> void:
	var t := str(msg.get("type", ""))
	# Minimal offline: chat echoes as bubble/log
	if t == "chat":
		server_message.emit({
			"type": "chat",
			"from": GameState.player_name if not GameState.player_name.is_empty() else "玩家",
			"text": str(msg.get("text", "")),
			"channel": "public",
		})
	elif t == "start_game":
		server_message.emit({
			"type": "error",
			"code": "offline",
			"message": "離線模式僅能看大廳與聊天，無法開局（需連線正式伺服器）",
		})


func disconnect_ws() -> void:
	_opening = false
	_ws_active = false
	if _ws.get_ready_state() != WebSocketPeer.STATE_CLOSED:
		_ws.close()
	_ws = WebSocketPeer.new()


func _to_ws_url(http_url: String) -> String:
	if http_url.begins_with("https://"):
		return "wss://" + http_url.substr(8)
	if http_url.begins_with("http://"):
		return "ws://" + http_url.substr(7)
	return http_url


func _request_err_text(err: int) -> String:
	match err:
		ERR_BUSY:
			return "上一個請求還在進行（BUSY）"
		ERR_INVALID_PARAMETER:
			return "參數無效（URL？）"
		ERR_CANT_CONNECT:
			return "無法建立連線"
		_:
			return "錯誤碼 %s" % err


func _on_http_completed(
	result: int,
	response_code: int,
	_headers: PackedStringArray,
	body: PackedByteArray
) -> void:
	var pending := _pending_http
	_pending_http = ""
	var body_text := body.get_string_from_utf8()
	print("[Net] HTTP done pending=%s result=%s code=%s body=%s" % [pending, result, response_code, body_text.left(200)])

	if result != HTTPRequest.RESULT_SUCCESS:
		var hint: String = str(HTTP_RESULT_TEXT.get(result, "未知錯誤 %s" % result))
		http_error.emit("HTTP 失敗：%s（result=%s）\n請確認網路，或勾選「離線試玩」" % [hint, result])
		return

	var data = JSON.parse_string(body_text)
	if typeof(data) != TYPE_DICTIONARY:
		http_error.emit("HTTP 回應不是 JSON：%s" % body_text.left(80))
		return

	match pending:
		"create":
			if response_code == 201 and data.has("code"):
				room_created.emit(str(data["code"]))
			else:
				http_error.emit("建房失敗 HTTP %s：%s" % [response_code, body_text.left(100)])
		"exists":
			room_exists_result.emit(_exists_code, bool(data.get("exists", false)))
		_:
			# Late/cancelled response
			pass
