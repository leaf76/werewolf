## 2.5D table world: seats walk to positions; chat bubbles over speakers.
extends Node3D

signal seat_clicked(action: String, player: Dictionary)

const SEAT_SCENE := preload("res://scenes/game/seat_token_3d.tscn")
const TABLE_TEX := preload("res://assets/generated/table.png")

@onready var seats_root: Node3D = $Seats
@onready var table_mesh: MeshInstance3D = $Table
@onready var table_top: MeshInstance3D = $TableTop
@onready var floor_mesh: MeshInstance3D = $Floor
@onready var sun: DirectionalLight3D = $Sun
@onready var lamp: OmniLight3D = $Lamp
@onready var camera: Camera3D = $Camera3D
@onready var world_env: WorldEnvironment = $WorldEnvironment

var seat_radius: float = 2.35
var _tokens: Dictionary = {}  # player_id -> SeatToken3D


func _ready() -> void:
	_setup_materials()
	_setup_environment("lobby")


func _setup_materials() -> void:
	var wood := StandardMaterial3D.new()
	wood.albedo_color = Color(0.42, 0.26, 0.14)
	wood.roughness = 0.75
	table_mesh.material_override = wood

	var felt := StandardMaterial3D.new()
	felt.albedo_texture = TABLE_TEX
	felt.albedo_color = Color(1, 1, 1)
	felt.roughness = 0.9
	table_top.material_override = felt

	var floor_mat := StandardMaterial3D.new()
	floor_mat.albedo_color = Color(0.08, 0.07, 0.1)
	floor_mat.roughness = 1.0
	floor_mesh.material_override = floor_mat


func clear_seats() -> void:
	for id in _tokens.keys():
		var t: Node = _tokens[id]
		if is_instance_valid(t):
			t.queue_free()
	_tokens.clear()


func rebuild_seats(players: Array, ctx: Dictionary) -> void:
	var n := players.size()
	if n == 0:
		# everyone left
		for id in _tokens.keys():
			var t = _tokens[id]
			if is_instance_valid(t) and t.has_method("leave_animated"):
				t.leave_animated()
			elif is_instance_valid(t):
				t.queue_free()
		_tokens.clear()
		return

	seat_radius = clampf(1.9 + float(n) * 0.06, 1.9, 2.7)
	var seen: Dictionary = {}
	var teammate_ids: Dictionary = ctx.get("teammate_ids", {})
	var actions: Dictionary = ctx.get("actions", {})
	var metas: Dictionary = ctx.get("metas", {})

	for i in n:
		var p: Dictionary = players[i]
		var pid := str(p.get("id", ""))
		if pid.is_empty():
			continue
		seen[pid] = true

		var angle := -PI * 0.5 + TAU * float(i) / float(n)
		var target := Vector3(cos(angle) * seat_radius, 0.02, sin(angle) * seat_radius)
		var rot_y := -angle + PI

		var is_me: bool = pid == str(ctx.get("player_id", ""))
		var is_dead: bool = not bool(p.get("alive", true))
		var is_teammate: bool = teammate_ids.has(pid)
		var action: String = ""
		if actions.has(pid):
			action = str(actions[pid])
		var meta: String = ""
		if metas.has(pid):
			meta = str(metas[pid])
		var display := str(p.get("name", "?"))
		if is_me:
			display += "（你）"
		var seat_n := int(p.get("seat", i + 1))
		display = "%d. %s" % [seat_n, display]

		var token: Node3D
		var is_new := false
		if _tokens.has(pid) and is_instance_valid(_tokens[pid]):
			token = _tokens[pid]
		else:
			token = SEAT_SCENE.instantiate()
			seats_root.add_child(token)
			_tokens[pid] = token
			is_new = true
			if token.has_signal("seat_clicked"):
				token.seat_clicked.connect(func(a, pl): seat_clicked.emit(a, pl))

		token.setup(p, display, meta, action, is_me, is_teammate, is_dead)
		if token.has_method("move_to"):
			token.move_to(target, rot_y, true, is_new)
		else:
			token.position = target
			token.rotation.y = rot_y

	# Remove players who left
	var to_remove: Array = []
	for id in _tokens.keys():
		if not seen.has(id):
			to_remove.append(id)
	for id in to_remove:
		var t = _tokens[id]
		_tokens.erase(id)
		if is_instance_valid(t) and t.has_method("leave_animated"):
			t.leave_animated()
		elif is_instance_valid(t):
			t.queue_free()


## Show chat bubble on the seat matching player display name.
func show_chat_bubble(from_name: String, text: String, channel: String = "public") -> void:
	var target: Node3D = null
	for id in _tokens.keys():
		var t = _tokens[id]
		if not is_instance_valid(t):
			continue
		var pname := str(t.player.get("name", ""))
		if pname == from_name:
			target = t
			break
	# fallback: name label contains name
	if target == null:
		for id in _tokens.keys():
			var t = _tokens[id]
			if not is_instance_valid(t):
				continue
			if t.name_label and from_name in str(t.name_label.text):
				target = t
				break
	if target and target.has_method("show_bubble"):
		target.show_bubble(text, channel)


func set_phase_tint(phase: String) -> void:
	_setup_environment(phase)


func _setup_environment(phase: String) -> void:
	var env: Environment
	if world_env.environment:
		env = world_env.environment
	else:
		env = Environment.new()
		world_env.environment = env

	env.background_mode = Environment.BG_COLOR
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.tonemap_mode = Environment.TONE_MAPPER_FILMIC

	match phase:
		"night":
			env.background_color = Color(0.04, 0.05, 0.12)
			env.ambient_light_color = Color(0.25, 0.3, 0.55)
			env.ambient_light_energy = 0.35
			sun.light_color = Color(0.45, 0.55, 0.95)
			sun.light_energy = 0.35
			lamp.light_color = Color(1.0, 0.75, 0.4)
			lamp.light_energy = 2.2
			lamp.omni_range = 8.0
		"day":
			env.background_color = Color(0.55, 0.7, 0.9)
			env.ambient_light_color = Color(0.95, 0.92, 0.85)
			env.ambient_light_energy = 0.55
			sun.light_color = Color(1.0, 0.96, 0.88)
			sun.light_energy = 1.15
			lamp.light_energy = 0.35
		"hunt":
			env.background_color = Color(0.18, 0.04, 0.04)
			env.ambient_light_color = Color(0.6, 0.2, 0.15)
			env.ambient_light_energy = 0.4
			sun.light_color = Color(1.0, 0.35, 0.25)
			sun.light_energy = 0.55
			lamp.light_color = Color(1.0, 0.3, 0.2)
			lamp.light_energy = 2.8
		"ended":
			env.background_color = Color(0.12, 0.1, 0.08)
			env.ambient_light_color = Color(0.85, 0.75, 0.5)
			env.ambient_light_energy = 0.5
			sun.light_color = Color(1.0, 0.9, 0.7)
			sun.light_energy = 0.7
			lamp.light_energy = 1.2
		_:
			env.background_color = Color(0.08, 0.06, 0.12)
			env.ambient_light_color = Color(0.45, 0.4, 0.6)
			env.ambient_light_energy = 0.4
			sun.light_color = Color(0.7, 0.65, 0.9)
			sun.light_energy = 0.55
			lamp.light_color = Color(1.0, 0.85, 0.65)
			lamp.light_energy = 1.6
