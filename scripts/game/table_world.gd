## 2D table + seats in a circle. Parent should reposition this Node2D to screen center.
extends Node2D

signal seat_clicked(action: String, player: Dictionary)

const SEAT_SCENE := preload("res://scenes/game/seat_token.tscn")
const TABLE_TEX := preload("res://assets/generated/table.png")

@onready var table_sprite: Sprite2D = $Table
@onready var seats_root: Node2D = $Seats

var seat_radius: float = 250.0


func _ready() -> void:
	table_sprite.texture = TABLE_TEX
	table_sprite.scale = Vector2(0.72, 0.72)


func clear_seats() -> void:
	for c in seats_root.get_children():
		c.queue_free()


func rebuild_seats(players: Array, ctx: Dictionary) -> void:
	clear_seats()
	var n := players.size()
	if n == 0:
		return
	# Fit radius to count
	seat_radius = clampf(160.0 + float(n) * 12.0, 180.0, 300.0)
	for i in n:
		var p: Dictionary = players[i]
		var token: Node2D = SEAT_SCENE.instantiate()
		seats_root.add_child(token)
		var angle := -PI * 0.5 + TAU * float(i) / float(n)
		token.position = Vector2(cos(angle), sin(angle)) * seat_radius

		var pid := str(p.get("id", ""))
		var is_me: bool = pid == str(ctx.get("player_id", ""))
		var is_dead: bool = not bool(p.get("alive", true))
		var teammate_ids: Dictionary = ctx.get("teammate_ids", {})
		var is_teammate: bool = teammate_ids.has(pid)
		var actions: Dictionary = ctx.get("actions", {})
		var metas: Dictionary = ctx.get("metas", {})
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
		token.setup(p, display, meta, action, is_me, is_teammate, is_dead)
		if token.has_signal("seat_clicked"):
			token.seat_clicked.connect(func(a, pl): seat_clicked.emit(a, pl))


func set_phase_tint(phase: String) -> void:
	match phase:
		"night":
			table_sprite.modulate = Color(0.65, 0.7, 1.0)
		"day":
			table_sprite.modulate = Color(1.1, 1.0, 0.85)
		"hunt":
			table_sprite.modulate = Color(1.15, 0.7, 0.65)
		"ended":
			table_sprite.modulate = Color(0.9, 0.85, 0.7)
		_:
			table_sprite.modulate = Color.WHITE
