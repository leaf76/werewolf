## Draws a round table and lays out seat controls on a circle.
extends Control

signal seat_pressed(action: String, player: Dictionary)

const SEAT_SIZE := Vector2(108, 86)

var _seats: Array = []  # [{control, player, action}]
var _phase: String = "lobby"


func set_phase(phase: String) -> void:
	_phase = phase
	queue_redraw()


func clear_seats() -> void:
	for c in get_children():
		c.queue_free()
	_seats.clear()
	queue_redraw()


func add_seat(
	player: Dictionary,
	label_lines: PackedStringArray,
	action: String,
	modulate_color: Color,
	targetable: bool
) -> void:
	var btn := Button.new()
	btn.custom_minimum_size = SEAT_SIZE
	btn.size = SEAT_SIZE
	btn.clip_text = true
	btn.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	btn.text = "\n".join(label_lines)
	btn.modulate = modulate_color
	btn.focus_mode = Control.FOCUS_NONE
	if targetable and not action.is_empty():
		btn.disabled = false
		btn.add_theme_color_override("font_color", Color(1, 0.95, 0.7))
		btn.pressed.connect(func(): seat_pressed.emit(action, player))
	else:
		btn.disabled = true
	add_child(btn)
	_seats.append({"btn": btn, "player": player, "action": action})
	call_deferred("_layout_seats")


func _notification(what: int) -> void:
	if what == NOTIFICATION_RESIZED:
		_layout_seats()
		queue_redraw()


func _layout_seats() -> void:
	var n := _seats.size()
	if n == 0:
		return
	var center := size * 0.5
	var radius := minf(size.x, size.y) * 0.36
	radius = maxf(radius, 80.0)
	for i in n:
		var angle := -PI * 0.5 + TAU * float(i) / float(n)
		var pos := center + Vector2(cos(angle), sin(angle)) * radius - SEAT_SIZE * 0.5
		var btn: Button = _seats[i]["btn"]
		if is_instance_valid(btn):
			btn.position = pos
			btn.size = SEAT_SIZE


func _draw() -> void:
	var center := size * 0.5
	var outer_r := minf(size.x, size.y) * 0.28
	outer_r = maxf(outer_r, 56.0)
	var table_col: Color
	var rim_col: Color
	match _phase:
		"night":
			table_col = Color(0.12, 0.14, 0.22, 0.95)
			rim_col = Color(0.35, 0.4, 0.65, 0.9)
		"day":
			table_col = Color(0.28, 0.22, 0.14, 0.95)
			rim_col = Color(0.75, 0.55, 0.28, 0.95)
		"hunt":
			table_col = Color(0.22, 0.12, 0.1, 0.95)
			rim_col = Color(0.85, 0.35, 0.25, 0.95)
		"ended":
			table_col = Color(0.18, 0.16, 0.2, 0.95)
			rim_col = Color(0.7, 0.6, 0.35, 0.9)
		_:
			table_col = Color(0.16, 0.14, 0.2, 0.95)
			rim_col = Color(0.5, 0.45, 0.65, 0.85)

	# outer rim
	draw_circle(center, outer_r + 8.0, rim_col)
	# table top
	draw_circle(center, outer_r, table_col)
	# inner wood ring
	draw_arc(center, outer_r * 0.72, 0.0, TAU, 48, rim_col.darkened(0.25), 3.0, true)
	# center emblem
	var emblem := "🐺" if _phase == "night" else ("☀️" if _phase == "day" else "🎴")
	var font := ThemeDB.fallback_font
	var fs := 22
	var tw := font.get_string_size(emblem, HORIZONTAL_ALIGNMENT_LEFT, -1, fs)
	draw_string(font, center - tw * 0.5 + Vector2(0, fs * 0.35), emblem, HORIZONTAL_ALIGNMENT_LEFT, -1, fs)
