## Lightweight SFX player using Kenney Interface Sounds (CC0).
extends Node

const SFX_DIR := "res://assets/sfx/"

var _streams: Dictionary = {}  # name -> AudioStream
var _player: AudioStreamPlayer


func _ready() -> void:
	_player = AudioStreamPlayer.new()
	_player.bus = "Master"
	_player.volume_db = -4.0
	add_child(_player)
	_load_all()


func _load_all() -> void:
	var names: PackedStringArray = [
		"click", "confirm", "error", "phase", "start", "vote", "night", "day", "death"
	]
	for n in names:
		var path := SFX_DIR + n + ".ogg"
		if ResourceLoader.exists(path):
			_streams[n] = load(path)


func play(sfx_name: String) -> void:
	if not _streams.has(sfx_name):
		return
	# Overlap-friendly: spawn a short-lived player for concurrent SFX
	var p := AudioStreamPlayer.new()
	p.stream = _streams[sfx_name]
	p.volume_db = -4.0
	p.bus = "Master"
	add_child(p)
	p.finished.connect(p.queue_free)
	p.play()


func play_click() -> void:
	play("click")


func play_phase(phase: String) -> void:
	match phase:
		"night":
			play("night")
		"day":
			play("day")
		"hunt":
			play("phase")
		"ended":
			play("death")
		"lobby":
			play("confirm")
		_:
			play("phase")
