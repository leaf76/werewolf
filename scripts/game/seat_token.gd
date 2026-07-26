## 2D pixel seat token around the table — clickable when action is available.
class_name SeatToken
extends Node2D

signal seat_clicked(action: String, player: Dictionary)

@onready var sprite: Sprite2D = $Sprite
@onready var ring: Sprite2D = $Ring
@onready var name_label: Label = $NameLabel
@onready var meta_label: Label = $MetaLabel
@onready var area: Area2D = $Area2D

var player: Dictionary = {}
var action: String = ""
var _targetable: bool = false

const TEX_ALIVE := preload("res://assets/characters/char_alive.png")
const TEX_DEAD := preload("res://assets/characters/char_dead.png")
const TEX_ME := preload("res://assets/characters/char_me.png")
const TEX_WOLF := preload("res://assets/characters/char_wolf_ally.png")
const TEX_RING := preload("res://assets/generated/seat_alive.png")


func _ready() -> void:
	area.input_event.connect(_on_input_event)
	area.mouse_entered.connect(_on_hover.bind(true))
	area.mouse_exited.connect(_on_hover.bind(false))
	ring.texture = TEX_RING
	ring.visible = false
	# Pixel-crisp
	sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	ring.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST


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
	action = act
	_targetable = not act.is_empty()
	name_label.text = display_name
	meta_label.text = meta

	if is_dead:
		sprite.texture = TEX_DEAD
		modulate = Color(0.85, 0.85, 0.85, 0.95)
	elif is_me:
		sprite.texture = TEX_ME
		modulate = Color.WHITE
	elif is_teammate:
		sprite.texture = TEX_WOLF
		modulate = Color(1.0, 0.9, 0.9)
	else:
		sprite.texture = TEX_ALIVE
		modulate = Color.WHITE

	ring.visible = _targetable
	if _targetable:
		ring.modulate = Color(1.0, 0.92, 0.25, 0.85)
		scale = Vector2(1.08, 1.08)
	else:
		scale = Vector2.ONE


func _on_hover(on: bool) -> void:
	if not _targetable:
		return
	scale = Vector2(1.2, 1.2) if on else Vector2(1.08, 1.08)


func _on_input_event(_viewport: Node, event: InputEvent, _shape_idx: int) -> void:
	if not _targetable:
		return
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		Sfx.play("confirm")
		seat_clicked.emit(action, player)
