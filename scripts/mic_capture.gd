## MicCapture — native microphone capture for AgentCraft voice (Track G/C).
##
## PORT of a prior Godot voice prototype's mic_capture, copied effectively verbatim (it is
## self-contained: a dedicated silent audio bus + AudioEffectCapture + AudioStreamMicrophone,
## resampled to 16 kHz PCM16 and emitted as audio_chunk_ready chunks). voice_websocket.gd
## instantiates one of these as a child and base64-streams the chunks to ElevenLabs.
##
## REQUIRES project.godot:  [audio] driver/enable_input=true  — otherwise the mic bus is silent
## and this node emits nothing (the single most common "native voice is dead" cause). Works on
## macOS with that flag set (Godot 4.x).

class_name MicCapture
extends Node

signal audio_chunk_ready(chunk: PackedByteArray)
signal recording_started()
signal recording_stopped()
signal mic_level_changed(level: float)

# =============================================================================
# CONFIGURATION
# =============================================================================

## Sample rate — ElevenLabs expects 16000 Hz for STT.
const SAMPLE_RATE: int = 16000

## Capture buffer length in seconds.
const BUFFER_LENGTH: float = 0.1

## Chunk size to emit (in samples) — ~50ms chunks stream well.
const CHUNK_SIZE: int = 800  # 50ms at 16kHz

## Volume / level feedback tuning.
const MIC_SENSITIVITY: float = 8.0
const VOLUME_SMOOTHING: float = 0.4

# =============================================================================
# STATE
# =============================================================================

var is_recording: bool = false
var current_mic_level: float = 0.0

var _mic_capture: AudioEffectCapture = null
var _mic_record: AudioStreamPlayer = null
var _mic_bus_idx: int = -1
var _sample_buffer: PackedVector2Array = PackedVector2Array()

# =============================================================================
# LIFECYCLE
# =============================================================================

func _ready() -> void:
	_setup_mic_capture()
	print("[MicCapture] Initialized at %d Hz" % SAMPLE_RATE)


func _setup_mic_capture() -> void:
	# Dedicated bus for mic input capture, kept silent (-80 dB) — we only capture.
	_mic_bus_idx = AudioServer.bus_count
	AudioServer.add_bus(_mic_bus_idx)
	AudioServer.set_bus_name(_mic_bus_idx, "AIMicCapture")
	AudioServer.set_bus_volume_db(_mic_bus_idx, -80.0)

	_mic_capture = AudioEffectCapture.new()
	_mic_capture.buffer_length = BUFFER_LENGTH
	AudioServer.add_bus_effect(_mic_bus_idx, _mic_capture)

	_mic_record = AudioStreamPlayer.new()
	_mic_record.name = "AIMicInput"
	_mic_record.stream = AudioStreamMicrophone.new()
	_mic_record.bus = "AIMicCapture"
	_mic_record.volume_db = 0.0
	add_child(_mic_record)


func _exit_tree() -> void:
	stop_recording()
	if _mic_bus_idx >= 0 and _mic_bus_idx < AudioServer.bus_count:
		AudioServer.remove_bus(_mic_bus_idx)


# =============================================================================
# RECORDING CONTROL
# =============================================================================

func start_recording() -> void:
	if is_recording:
		return
	if _mic_capture:
		_mic_capture.clear_buffer()
	_sample_buffer.clear()
	if _mic_record and not _mic_record.playing:
		_mic_record.play()
	is_recording = true
	emit_signal("recording_started")
	print("[MicCapture] Recording started")


func stop_recording() -> void:
	if not is_recording:
		return
	if _mic_record and _mic_record.playing:
		_mic_record.stop()
	_flush_remaining_samples()
	is_recording = false
	current_mic_level = 0.0
	emit_signal("recording_stopped")
	print("[MicCapture] Recording stopped")


func _flush_remaining_samples() -> void:
	if _sample_buffer.size() > 0:
		var pcm_data := _convert_to_pcm16(_sample_buffer)
		emit_signal("audio_chunk_ready", pcm_data)
		_sample_buffer.clear()


# =============================================================================
# PROCESS
# =============================================================================

func _process(_delta: float) -> void:
	if not is_recording or not _mic_capture:
		current_mic_level = lerp(current_mic_level, 0.0, 0.3)
		return

	var frames_available := _mic_capture.get_frames_available()
	if frames_available <= 0:
		return

	var buffer := _mic_capture.get_buffer(frames_available)
	if buffer.is_empty():
		return

	_update_mic_level(buffer)

	var resampled := _resample_buffer(buffer)
	_sample_buffer.append_array(resampled)

	while _sample_buffer.size() >= CHUNK_SIZE:
		var chunk := _sample_buffer.slice(0, CHUNK_SIZE)
		_sample_buffer = _sample_buffer.slice(CHUNK_SIZE)
		var pcm_data := _convert_to_pcm16(chunk)
		emit_signal("audio_chunk_ready", pcm_data)


func _update_mic_level(buffer: PackedVector2Array) -> void:
	var sum_squares: float = 0.0
	for frame: Vector2 in buffer:
		var sample: float = (frame.x + frame.y) / 2.0
		sum_squares += sample * sample
	var rms: float = sqrt(sum_squares / buffer.size())
	var normalized: float = clampf(rms * MIC_SENSITIVITY, 0.0, 1.0)
	current_mic_level = lerp(current_mic_level, normalized, VOLUME_SMOOTHING)
	emit_signal("mic_level_changed", current_mic_level)


func _resample_buffer(buffer: PackedVector2Array) -> PackedVector2Array:
	var mix_rate := AudioServer.get_mix_rate()
	if abs(mix_rate - SAMPLE_RATE) < 100:
		return buffer
	var ratio := float(SAMPLE_RATE) / float(mix_rate)
	var new_size := int(buffer.size() * ratio)
	var resampled := PackedVector2Array()
	resampled.resize(new_size)
	for i in range(new_size):
		var src_pos := float(i) / ratio
		var src_idx := int(src_pos)
		var frac := src_pos - src_idx
		if src_idx + 1 < buffer.size():
			resampled[i] = buffer[src_idx].lerp(buffer[src_idx + 1], frac)
		elif src_idx < buffer.size():
			resampled[i] = buffer[src_idx]
	return resampled


func _convert_to_pcm16(buffer: PackedVector2Array) -> PackedByteArray:
	var pcm := PackedByteArray()
	pcm.resize(buffer.size() * 2)
	for i in range(buffer.size()):
		var sample_float := (buffer[i].x + buffer[i].y) / 2.0
		var sample_int := clampi(int(sample_float * 32767.0), -32768, 32767)
		pcm.encode_s16(i * 2, sample_int)
	return pcm


# =============================================================================
# PUBLIC API
# =============================================================================

func get_mic_level() -> float:
	return current_mic_level


func is_mic_active() -> bool:
	return is_recording
