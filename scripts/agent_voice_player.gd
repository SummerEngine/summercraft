## AgentVoicePlayer — positional voice playback for one AgentCraft character (Track G/C).
##
## DISTILLED from a prior Godot voice prototype — the AUDIO-PLAYBACK half ONLY. All of its
## walking / follow / greeting state machine is dropped: AgentCraft characters are driven by
## set_state() from the /world feed, not by a local AI. This node is added as a CHILD of the
## clicked agent character so ElevenLabs' streamed voice (16 kHz PCM16) emanates from that body
## in 3D space.
##
## ElevenLabs Conversational AI streams base64 PCM16 @ 16 kHz; voice_websocket.gd decodes each
## chunk and calls play_audio_chunk(). The chunks are queued and drip-fed to an
## AudioStreamGenerator every frame (the proven low-latency path from bob.gd).
##
## Public API (called by voice_websocket.gd):
##   start_audio_playback()            # open the stream
##   play_audio_chunk(PackedByteArray) # queue a PCM16 chunk
##   stop_audio_playback()             # stop + clear (called on interruption / end)
##   start_speaking() / stop_speaking()# toggle the speaking tell (emits speaking_changed)

extends Node3D

signal speaking_changed(speaking: bool)

# ElevenLabs Conversational AI output format.
const VOICE_MIX_RATE: int = 16000
const AUDIO_QUEUE_COMPACT_THRESHOLD: int = 50000  # compact after this many consumed samples

var is_speaking: bool = false

var _audio_player: AudioStreamPlayer3D = null
var _audio_generator: AudioStreamGenerator = null
var _audio_playback: AudioStreamGeneratorPlayback = null

# Speaking tell (a small glowing bubble above the head, like bob.gd's indicator).
var _speaking_indicator: Node3D = null
var _pulse_tween: Tween = null

# Drip-feed queue (read-position cursor avoids O(n) pop_front).
var _audio_sample_queue: PackedFloat32Array = PackedFloat32Array()
var _audio_queue_read_pos: int = 0


func _ready() -> void:
	_setup_audio_player()
	_setup_speaking_indicator()


func _setup_audio_player() -> void:
	_audio_player = AudioStreamPlayer3D.new()
	_audio_player.name = "VoicePlayer"
	_audio_player.max_distance = 60.0
	_audio_player.unit_size = 10.0
	_audio_player.attenuation_model = AudioStreamPlayer3D.ATTENUATION_LOGARITHMIC
	add_child(_audio_player)

	_audio_generator = AudioStreamGenerator.new()
	_audio_generator.mix_rate = VOICE_MIX_RATE
	_audio_generator.buffer_length = 1.0  # 1s buffer (16000 frames)
	_audio_player.stream = _audio_generator


func _setup_speaking_indicator() -> void:
	_speaking_indicator = Node3D.new()
	_speaking_indicator.name = "SpeakingIndicator"
	add_child(_speaking_indicator)

	var col := Color(0.55, 0.85, 1.0, 0.8)
	var mat := StandardMaterial3D.new()
	mat.albedo_color = col
	mat.emission_enabled = true
	mat.emission = col
	mat.emission_energy_multiplier = 1.4
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED

	var bubble := MeshInstance3D.new()
	var sphere := SphereMesh.new()
	sphere.radius = 0.12
	sphere.height = 0.24
	bubble.mesh = sphere
	bubble.material_override = mat
	bubble.position = Vector3(0.25, 2.4, 0.0)
	_speaking_indicator.add_child(bubble)

	var small := MeshInstance3D.new()
	var small_sphere := SphereMesh.new()
	small_sphere.radius = 0.05
	small_sphere.height = 0.1
	small.mesh = small_sphere
	small.material_override = mat
	small.position = Vector3(0.12, 2.2, 0.0)
	_speaking_indicator.add_child(small)

	_speaking_indicator.visible = false


func _process(_delta: float) -> void:
	_process_audio_queue()


# =============================================================================
# SPEAKING TELL
# =============================================================================

func start_speaking() -> void:
	if is_speaking:
		return
	is_speaking = true
	if _speaking_indicator:
		_speaking_indicator.visible = true
		_pulse_tween = create_tween().set_loops()
		_pulse_tween.tween_property(_speaking_indicator, "scale", Vector3(1.18, 1.18, 1.18), 0.6)
		_pulse_tween.tween_property(_speaking_indicator, "scale", Vector3.ONE, 0.6)
	speaking_changed.emit(true)


func stop_speaking() -> void:
	if not is_speaking:
		return
	is_speaking = false
	if _pulse_tween and _pulse_tween.is_valid():
		_pulse_tween.kill()
	_pulse_tween = null
	if _speaking_indicator:
		_speaking_indicator.visible = false
		_speaking_indicator.scale = Vector3.ONE
	speaking_changed.emit(false)


# =============================================================================
# AUDIO PLAYBACK
# =============================================================================

func start_audio_playback() -> void:
	if _audio_player and not _audio_player.playing:
		_audio_player.play()
		_audio_playback = _audio_player.get_stream_playback()


func stop_audio_playback() -> void:
	if _audio_player:
		_audio_player.stop()
	_audio_playback = null
	clear_audio_queue()


func clear_audio_queue() -> void:
	_audio_sample_queue.clear()
	_audio_queue_read_pos = 0


# Queue a PCM16 (16 kHz, mono) chunk straight from ElevenLabs.
func play_audio_chunk(audio_data: PackedByteArray) -> void:
	if not _audio_playback:
		start_audio_playback()
	var sample_count := audio_data.size() / 2
	for i in range(sample_count):
		var sample_int := audio_data.decode_s16(i * 2)
		_audio_sample_queue.append(sample_int / 32768.0)


# Called every frame: drip-feed queued samples into the generator buffer.
func _process_audio_queue() -> void:
	var queue_size := _audio_sample_queue.size()
	var pending := queue_size - _audio_queue_read_pos
	if not _audio_playback or pending <= 0:
		return
	var frames_pushed := 0
	while _audio_queue_read_pos < queue_size and _audio_playback.can_push_buffer(1):
		var sample := _audio_sample_queue[_audio_queue_read_pos]
		_audio_queue_read_pos += 1
		_audio_playback.push_frame(Vector2(sample, sample))
		frames_pushed += 1
		if frames_pushed >= 4000:  # cap per-frame work to avoid blocking
			break
	if _audio_queue_read_pos > AUDIO_QUEUE_COMPACT_THRESHOLD:
		_compact_audio_queue()


func _compact_audio_queue() -> void:
	if _audio_queue_read_pos <= 0:
		return
	_audio_sample_queue = _audio_sample_queue.slice(_audio_queue_read_pos)
	_audio_queue_read_pos = 0
