## 2.5D seat: Kenney Shape Character with idle bob, walk tween, speech bubble.
class_name SeatToken3D
extends Node3D

signal seat_clicked(action: String, player: Dictionary)

@onready var sprite: Sprite3D = $Sprite3D
@onready var ring: MeshInstance3D = $Ring
@onready var name_label: Label3D = $NameLabel
@onready var meta_label: Label3D = $MetaLabel
@onready var area: Area3D = $Area3D
@onready var bubble_root: Node3D = $Bubble
@onready var bubble_label: Label3D = $Bubble/BubbleLabel
@onready var bubble_bg: MeshInstance3D = $Bubble/BubbleBg

var player: Dictionary = {}
var player_id: String = ""
var action: String = ""
var _targetable: bool = false
var _base_scale: float = 1.0
var _dead: bool = false
var _home_pos: Vector3 = Vector3.ZERO
var _bob_t: float = 0.0
var _bob_phase: float = 0.0
var _move_tween: Tween
var _bubble_tween: Tween
var _bubble_timer: float = 0.0

const TEX_ME := preload("res://assets/characters/shape/me.png")
const TEX_DEAD := preload("res://assets/characters/shape/dead.png")
const TEX_WOLF := preload("res://assets/characters/shape/wolf_ally.png")

const POOL: Array[Texture2D] = [
	preload("res://assets/characters/shape/player_blue_a.png"),
	preload("res://assets/characters/shape/player_green_b.png"),
	preload("res://assets/characters/shape/player_pink_c.png"),
	preload("res://assets/characters/shape/player_purple_d.png"),
	preload("res://assets/characters/shape/player_red_e.png"),
	preload("res://assets/characters/shape/player_yellow_f.png"),
	preload("res://assets/characters/shape/player_blue_c.png"),
	preload("res://assets/characters/shape/player_green_d.png"),
	preload("res://assets/characters/shape/player_pink_a.png"),
	preload("res://assets/characters/shape/player_purple_b.png"),
	preload("res://assets/characters/shape/player_red_f.png"),
	preload("res://assets/characters/shape/player_yellow_a.png"),
]


func _ready() -> void:
	_bob_phase = randf() * TAU
	area.input_event.connect(_on_input_event)
	area.mouse_entered.connect(_on_hover.bind(true))
	area.mouse_exited.connect(_on_hover.bind(false))
	sprite.billboard = BaseMaterial3D.BILLBOARD_FIXED_Y
	sprite.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR
	sprite.pixel_size = 0.012
	sprite.shaded = true
	sprite.alpha_cut = SpriteBase3D.ALPHA_CUT_OPAQUE_PREPASS
	ring.visible = false
	if bubble_root:
		bubble_root.visible = false
	_setup_bubble_material()


func _setup_bubble_material() -> void:
	if bubble_bg == null:
		return
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(1, 1, 1, 0.92)
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.billboard_mode = BaseMaterial3D.BILLBOARD_ENABLED
	bubble_bg.material_override = mat


func _process(delta: float) -> void:
	_bob_t += delta
	# Idle bob (dead characters stay still)
	if not _dead and _move_tween == null:
		var bob := sin(_bob_t * 2.2 + _bob_phase) * 0.035
		position.y = _home_pos.y + bob
	if _bubble_timer > 0.0:
		_bubble_timer -= delta
		if _bubble_timer <= 0.0:
			hide_bubble()


func setup(
	p: Dictionary,
	display_name: String,
	meta: String,
	act: String,
	is_me: bool,
	is_teammate: bool,
	is_dead: bool
) -> void:
	player = p
	player_id = str(p.get("id", ""))
	action = act
	_targetable = not act.is_empty()
	_dead = is_dead
	name_label.text = display_name
	meta_label.text = meta

	var seat := int(p.get("seat", 1))
	var pool_tex: Texture2D = POOL[(seat - 1) % POOL.size()]

	if is_dead:
		sprite.texture = TEX_DEAD
		sprite.modulate = Color(0.8, 0.8, 0.8, 0.95)
	elif is_me:
		sprite.texture = TEX_ME
		sprite.modulate = Color.WHITE
	elif is_teammate:
		sprite.texture = TEX_WOLF
		sprite.modulate = Color(1.0, 0.9, 0.9)
	else:
		sprite.texture = pool_tex
		sprite.modulate = Color.WHITE

	ring.visible = _targetable
	_base_scale = 1.1 if _targetable else 1.0
	if _move_tween == null:
		scale = Vector3.ONE * _base_scale


## Walk / slide to a seat position on the table ring.
func move_to(target: Vector3, rot_y: float, animate: bool = true, from_spawn: bool = false) -> void:
	_home_pos = target
	if _move_tween:
		_move_tween.kill()
		_move_tween = null
	if not animate:
		position = target
		rotation.y = rot_y
		return
	var start := position
	if from_spawn:
		# Enter from outside the circle
		var outward := Vector3(target.x, 0, target.z).normalized()
		if outward.length_squared() < 0.01:
			outward = Vector3.FORWARD
		start = target + outward * 2.2 + Vector3(0, 0.4, 0)
		position = start
		scale = Vector3.ONE * 0.2
	_move_tween = create_tween()
	_move_tween.set_parallel(true)
	_move_tween.tween_property(self, "position", target, 0.55).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	_move_tween.tween_property(self, "rotation:y", rot_y, 0.45).set_trans(Tween.TRANS_SINE)
	_move_tween.tween_property(self, "scale", Vector3.ONE * _base_scale, 0.4).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	_move_tween.chain().tween_callback(func():
		_move_tween = null
		_home_pos = target
	)


func leave_animated() -> void:
	if _move_tween:
		_move_tween.kill()
	_move_tween = create_tween()
	var outward := Vector3(position.x, 0, position.z).normalized()
	if outward.length_squared() < 0.01:
		outward = Vector3.BACK
	var dest := position + outward * 2.5 + Vector3(0, 0.5, 0)
	_move_tween.set_parallel(true)
	_move_tween.tween_property(self, "position", dest, 0.4).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN)
	_move_tween.tween_property(self, "scale", Vector3.ONE * 0.1, 0.4)
	_move_tween.chain().tween_callback(queue_free)


## Show a speech bubble above the character.
func show_bubble(text: String, channel: String = "public", duration: float = 4.0) -> void:
	if bubble_root == null or bubble_label == null:
		return
	var shown := text.strip_edges()
	if shown.length() > 36:
		shown = shown.substr(0, 34) + "…"
	if channel == "wolf":
		shown = "🐺 " + shown
		bubble_label.modulate = Color(1.0, 0.75, 0.75)
	elif channel == "last_words":
		shown = "💀 " + shown
		bubble_label.modulate = Color(0.85, 0.75, 1.0)
	else:
		bubble_label.modulate = Color(0.15, 0.12, 0.1)
	bubble_label.text = shown
	bubble_root.visible = true
	bubble_root.scale = Vector3.ONE * 0.01
	_bubble_timer = duration
	if _bubble_tween:
		_bubble_tween.kill()
	_bubble_tween = create_tween()
	_bubble_tween.tween_property(bubble_root, "scale", Vector3.ONE, 0.2).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	# slight hop when talking
	if not _dead:
		var hop := create_tween()
		hop.tween_property(self, "position:y", _home_pos.y + 0.12, 0.12)
		hop.tween_property(self, "position:y", _home_pos.y, 0.18)


func hide_bubble() -> void:
	if bubble_root == null:
		return
	if _bubble_tween:
		_bubble_tween.kill()
	_bubble_tween = create_tween()
	_bubble_tween.tween_property(bubble_root, "scale", Vector3.ONE * 0.01, 0.15)
	_bubble_tween.tween_callback(func():
		bubble_root.visible = false
		_bubble_tween = null
	)


func _on_hover(on: bool) -> void:
	if not _targetable:
		return
	var s := 1.25 if on else _base_scale
	if _move_tween == null:
		scale = Vector3.ONE * s


func _on_input_event(_camera: Node, event: InputEvent, _pos: Vector3, _normal: Vector3, _shape_idx: int) -> void:
	if not _targetable:
		return
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		Sfx.play("confirm")
		seat_clicked.emit(action, player)
