extends Control
# ============================================================================
#  InteractionPanel — the per-agent command CARD (Chat D / The Interface).
#
#  The clean dark-glass card docked bottom-right. After the decomposition this is
#  a SHELL + the transcript: it owns the agent header (label · persona · repo ·
#  task · colour-coded status pill · close), the role-coloured RichTextLabel
#  transcript (autoscroll + optimistic echo merge), the actions row (Diff /
#  Approve / Merge) and the prompt input (Send + Talk) — and it HOSTS a DiffView
#  instance for the actual diff rendering (it no longer renders diffs itself).
#  In the dive it switches to COMPACT mode (transcript folded, header + diff +
#  context kept) so the same card backs the conversation surface.
#
#  Pure view. It only emits signals; the Hud autoload owns it, relays its signals
#  out as the frozen contract signals, and pushes fresh AgentView dicts via
#  show_agent()/update_agent() each poll so status + transcript stay live. Diff
#  text arrives via show_diff() (Hud -> B fetches GET /agents/:id/diff -> here ->
#  the hosted DiffView). No sidecar comms here.
#
#  ── FROZEN local API (KEEP — B is mid-migration; do not break these) ─────────
#    signals: send_prompt, request_voice, diff_requested, approve_requested,
#             merge_requested, closed
#    methods: show_agent(agent), update_agent(agent), hide_panel(),
#             append_line(text), get_agent_id() -> String, set_compact(on),
#             show_diff(text)
#  These signatures are unchanged from the pre-decomposition card so any caller
#  from the pre-Hud wiring keeps working. Additions are additive only.
#
#  Production: anchored bottom-right with a responsive Root (reflows portrait
#  720x1280 + landscape projector), upsert-only refresh (no transcript flicker /
#  no scroll jump on the 1s poll — the BBCode is rebuilt only when the merged
#  content actually changes), graceful empty/missing data, Juice on open / close /
#  compact / state-flip, a UiSounds.play() at every interaction site (send / talk
#  / diff / approve / merge / close / hover).
# ============================================================================

# --- FROZEN local signals (unchanged) ---
signal send_prompt(agent_id: String, prompt: String)
signal request_voice(agent_id: String)
signal diff_requested(agent_id: String)
signal approve_requested(agent_id: String)
signal merge_requested(project_id: String)
signal closed()
signal operator_run_requested(mission_id: String)  # Ada-only: the live Aiven world_pulse beat

# --- FROZEN-additive: character/session verbs (mirror the send_prompt seam) ──────
# The card today is the SESSION view of a character. These three verbs reach the
# sidecar through the SAME path as send_prompt: card -> Hud relay -> B (world_manager
# connects via has_signal) -> sidecar_bridge HTTP. The card never talks to the sidecar.
#   new_chat_requested  -> B POSTs /agents/:id/new-session ; on success B clears the card
#                          via Hud.session_started()/show_agent() (see start_fresh_chat()).
#   send_away_requested -> B POSTs /agents/:id/send-away (archive + sleep).
#   sessions_requested  -> B GETs  /agents/:id/sessions and hands the list back via
#                          Hud.show_sessions()/show_sessions() here.
#   session_view_requested(agent_id, session_id) -> B fetches that archived transcript
#                          and hands it back via show_session_transcript().
signal new_chat_requested(agent_id: String)
signal send_away_requested(agent_id: String)
signal sessions_requested(agent_id: String)
signal session_view_requested(agent_id: String, session_id: String)

# The card hosts a DiffView (scenes/ui/diff_view.tscn) instead of rendering diffs
# inline — the shell hands raw text down via show_diff(); DiffView does the rest.
const DIFF_VIEW := preload("res://scenes/ui/diff_view.tscn")
# Scripts bound by path (preload) so they resolve even though scripts/ui is not in the
# editor's global class cache. The hosted DiffView instance is held untyped (dynamic
# dispatch) — like the shell holds its components — so no DiffView type is needed.
const Juice := preload("res://scripts/ui/juice.gd")
const UiSounds := preload("res://scripts/ui/ui_sounds.gd")
const MdBBCode := preload("res://scripts/ui/md_bbcode.gd")

# ── Responsive layout tunables (anchors, not magic per-resolution numbers) ───
# The card is sized as a fraction of the viewport, clamped to a comfortable
# px band, then docked bottom-right with a uniform inset. This reflows cleanly
# between portrait 720x1280 (card spans most of the width) and a wide projector
# (card stays a readable column on the right). Recomputed on every resize only.
const CARD_W_FRAC := 0.46     # target width as a fraction of viewport width
const CARD_W_MIN  := 360.0
const CARD_W_MAX  := 560.0
const CARD_H_FRAC := 0.62     # target height as a fraction of viewport height
const CARD_H_MIN  := 420.0
const CARD_H_MAX  := 820.0
const CARD_INSET  := 24.0     # gap from the screen edges
const MARGIN_PAD  := 18       # inner content margin
# Shared stale rule (INTERFACES.md §2: heartbeat_age_s > 15 == stale). Single local
# source until the shared SummerUI token lands (ui_theme.gd is outside this lane).
const STALE_AGE_S := 15.0

@onready var _root: Panel = $Root
@onready var _margin: MarginContainer = $Root/Margin
@onready var _header: Label = $Root/Margin/VBox/HeaderRow/TitleCol/Header
@onready var _persona: Label = $Root/Margin/VBox/HeaderRow/TitleCol/Persona
# StatusPill lives inside a plain Control wrapper (NOT a Container) so its position
# is owned by nobody — HeaderRow (an HBoxContainer) re-sorts on every header reflow
# (label/persona/detail width changes each poll), and a container rewrites a child's
# position, which would fight idle_bob's looping position:y tween and make the bob
# stutter/snap. The wrapper takes the pill's footprint for layout; the pill (free to
# move inside it) is the bob/pulse/cheer/slam target. Mirrors FleetRoster's dot wrapper.
@onready var _status_pill_wrap: Control = $Root/Margin/VBox/HeaderRow/StatusPillWrap
@onready var _status_pill: PanelContainer = $Root/Margin/VBox/HeaderRow/StatusPillWrap/StatusPill
@onready var _status_dot: Label = $Root/Margin/VBox/HeaderRow/StatusPillWrap/StatusPill/Row/Dot
@onready var _status_label: Label = $Root/Margin/VBox/HeaderRow/StatusPillWrap/StatusPill/Row/StatusLabel
@onready var _close_button: Button = $Root/Margin/VBox/HeaderRow/CloseButton
@onready var _repo_label: Label = $Root/Margin/VBox/RepoLabel
@onready var _detail: Label = $Root/Margin/VBox/Detail
@onready var _sep: HSeparator = $Root/Margin/VBox/Sep
@onready var _transcript: RichTextLabel = $Root/Margin/VBox/TranscriptScroll/Transcript
@onready var _scroll: ScrollContainer = $Root/Margin/VBox/TranscriptScroll
# DiffSection hosts a DiffView instance (added in _ready) instead of inline nodes.
@onready var _diff_section: VBoxContainer = $Root/Margin/VBox/DiffSection
@onready var _diff_host: Control = $Root/Margin/VBox/DiffSection/DiffHost
@onready var _actions_row: HBoxContainer = $Root/Margin/VBox/ActionsRow
@onready var _diff_button: Button = $Root/Margin/VBox/ActionsRow/DiffButton
@onready var _approve_button: Button = $Root/Margin/VBox/ActionsRow/ApproveButton
@onready var _merge_button: Button = $Root/Margin/VBox/ActionsRow/MergeButton
# Copy-transcript affordance (built in code; not in the .tscn). A ghost button in the
# actions row that copies the full conversation thread to the OS clipboard.
var _copy_button: Button = null
@onready var _prompt_input: LineEdit = $Root/Margin/VBox/InputRow/PromptInput
@onready var _send_button: Button = $Root/Margin/VBox/InputRow/SendButton
@onready var _talk_button: Button = $Root/Margin/VBox/InputRow/TalkButton

# The hosted diff renderer (instanced into _diff_host in _ready).
var _diff_view = null  # DiffView instance (untyped: dynamic dispatch, no global class needed)

# ── Live activity feed (built in code; not in the .tscn) ─────────────────────
# A small "what it's doing RIGHT NOW" surface under the detail line: the latest
# per-tool pulse ("⚙ Bash: npm run dev") plus a couple of recent lines, upserted in
# place (no per-frame alloc, no flicker), and an optional "Open localhost ↗" chip
# when a service URL is detected. Fed by the shell (Hud.activity / Hud.service),
# which relays A's tool_activity / service WS events for the open agent.
var _activity_box: VBoxContainer = null      # holds the recent activity lines
var _activity_lines: Array[Label] = []       # reused label pool (newest last)
var _service_chip: Button = null             # "Open localhost ↗"
var _service_url: String = ""
const ACTIVITY_KEEP := 3                       # how many recent activity lines to show
const ACTIVITY_LINE_SIZE := SummerUI.FS_LABEL

var _agent_id: String = ""
var _repo_id: String = ""
var _repo_path: String = ""
var _state: String = ""
var _kind: String = ""
var _compact: bool = false
var _diff_open: bool = false
var _was_visible: bool = false
var _was_stale: bool = false
# Last diff text forwarded to the hosted DiffView. DiffView.set_diff is internally
# render-guarded, but Juice.flash is not — so we only flash on a genuine text change
# (B re-hands the same diff on the 1s poll while the section is open). Also lets the
# dive re-forward the last diff deterministically when entering compact.
var _last_diff_text: String = ""
# Latched while a voice session is live so a double-tap of Talk can't fire
# request_voice twice (C has no idempotency contract here). Reset on dive exit.
var _voice_active: bool = false

# ── Session toolbar + history (built in code; not in the .tscn) ──────────────
# A thin verb row docked under HeaderRow: [New chat] (accent) · [History ▸] toggle ·
# [⋯] overflow. Send away is demoted to the overflow menu behind a confirm step so it
# cannot be triggered in one tap. The history panel below it lists the character's past
# sessions (A's SessionSummary[]), newest first; each row is clickable to view that
# archived transcript read-only. Built once in _build_session_bar(); fed by
# show_sessions() / show_session_transcript() (B relays A's GET /agents/:id/sessions).
var _session_bar: HBoxContainer = null
var _new_chat_button: Button = null
var _send_away_button: Button = null    # kept for signal wiring; reached only via overflow
var _history_button: Button = null
var _overflow_button: Button = null     # ⋯ ghost button; opens the overflow confirm panel
var _overflow_panel: PanelContainer = null  # tiny confirm panel shown on overflow click
var _overflow_confirm_pending: bool = false  # true while awaiting the confirm tap
var _history_panel: VBoxContainer = null   # holds the session rows (hidden until toggled)
var _history_open: bool = false
var _history_loading: bool = false
var _sessions: Array = []                  # last SessionSummary[] handed back by B
# When viewing an archived session read-only, the live transcript is swapped out for the
# archived lines; this holds the live state so "Back to live" restores it without a poll.
var _viewing_session_id: String = ""

# Server transcript tail (last seen) + view-side optimistic echoes ("you: …").
# Echoes are held separately so the 1s poll's server tail can't wipe the user's
# line; pruned once the server tail grows past them; cleared on switch/close.
var _server_lines: Array[String] = []
var _pending_echoes: Array[String] = []
var _chat_list: VBoxContainer = null   # Claude-style message bubbles (replaces the flat RTL)
var _thinking: bool = false            # show a "thinking…" row while awaiting a reply
# Streaming-ready (spec §2): C emits partial agent text; we render it in the LAST
# agent bubble in place (no new turn per token). "" => not streaming. Held apart
# from _server_lines so the 1s poll's server tail can't fight the live partial; the
# final full line arrives via the server tail (and stream_end() clears the buffer).
var _stream_text: String = ""
# Hash of the last rendered merged transcript — we only rebuild the BBCode (an
# allocation) when the merged content actually changes, so the 1s poll neither
# flickers nor jumps the scroll while idle.
var _last_render_hash: int = 0
# True while the user is at/near the bottom — only then do we autoscroll, so a
# user scrolled up to read history isn't yanked back down by an incoming line.
var _stick_bottom: bool = true
# Looping idle bob on the status pill while waiting/idle so a resting card is never
# dead-static. Held so it can be killed before restart (loops never stack) and on hide.
var _idle_tw: Tween = null

func _ready() -> void:
	# World clicks pass through the empty Control; the Root panel itself eats
	# clicks (set in the scene) so taps on the card never fall through to 3D.
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	visible = false
	_was_visible = false

	_style()
	_instance_diff_view()
	_build_chat()
	_build_copy_button()
	# (Build affordances after _build_chat so the actions row exists.)
	_build_activity()
	_build_session_bar()
	_wire()

	# Responsive: lay out now and on every viewport resize. No per-frame work.
	var vp := get_viewport()
	if vp != null and not vp.size_changed.is_connected(_relayout):
		vp.size_changed.connect(_relayout)
	_relayout()

	# Fold the diff section closed until the user asks for a diff.
	_diff_section.visible = false
	_diff_open = false
	_render_transcript(true)

func _exit_tree() -> void:
	# Persistent HUD leaf — won't free before the viewport in practice, but disconnect
	# for production-grade completeness, and stop any looping idle tween.
	var vp := get_viewport()
	if vp != null and vp.size_changed.is_connected(_relayout):
		vp.size_changed.disconnect(_relayout)
	Juice.stop(_idle_tw)
	_idle_tw = null

# ── Styling (theme ONLY via SummerUI) ───────────────────────────────────────
func _style() -> void:
	_root.mouse_filter = Control.MOUSE_FILTER_STOP  # the card swallows wheel/clicks; the world can't see them
	SummerUI.attach_frost(_root, SummerUI.BG_SOLID, 16, 0, true)  # frosted glass card (blur + tint)
	_margin.add_theme_constant_override("margin_left", MARGIN_PAD)
	_margin.add_theme_constant_override("margin_right", MARGIN_PAD)
	_margin.add_theme_constant_override("margin_top", MARGIN_PAD)
	_margin.add_theme_constant_override("margin_bottom", MARGIN_PAD)

	($Root/Margin/VBox as VBoxContainer).add_theme_constant_override("separation", 8)
	_actions_row.add_theme_constant_override("separation", 8)
	($Root/Margin/VBox/InputRow as HBoxContainer).add_theme_constant_override("separation", 8)
	($Root/Margin/VBox/HeaderRow as HBoxContainer).add_theme_constant_override("separation", 8)

	# Font sizes via the SummerUI type-scale tokens (single source) so a global
	# room-legibility tune reaches the card — no forked magic numbers.
	_header.add_theme_color_override("font_color", SummerUI.TEXT)
	_header.add_theme_font_size_override("font_size", SummerUI.FS_TITLE)
	_persona.add_theme_color_override("font_color", SummerUI.TEXT_DIM)
	_persona.add_theme_font_size_override("font_size", SummerUI.FS_LABEL)
	_repo_label.add_theme_color_override("font_color", SummerUI.TEXT_FAINT)
	_repo_label.add_theme_font_size_override("font_size", SummerUI.FS_PILL)
	_repo_label.clip_text = true  # a long repo name can never widen the card
	_detail.add_theme_color_override("font_color", SummerUI.TEXT_DIM)
	_detail.add_theme_font_size_override("font_size", SummerUI.FS_LABEL)
	_detail.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART

	_status_label.add_theme_font_size_override("font_size", SummerUI.FS_PILL)
	# Dot + label sit in a tight Row inside the pill (spec §2: small state DOT + neutral label).
	($Root/Margin/VBox/HeaderRow/StatusPillWrap/StatusPill/Row as HBoxContainer).add_theme_constant_override("separation", 6)
	_status_dot.add_theme_font_size_override("font_size", SummerUI.FS_PILL)
	_transcript.add_theme_color_override("default_color", SummerUI.TEXT)
	_transcript.add_theme_font_size_override("normal_font_size", SummerUI.FS_BODY)
	_transcript.scroll_following = false  # we manage autoscroll ourselves
	# Wrap long replies inside the card. An agent's answer can be a whole paragraph;
	# with fit_content the RTL would otherwise grow to its longest line and overflow
	# the card off-screen. Force word-wrap AND disable the scroll's horizontal axis so
	# the card width is the hard bound — the text wraps and the column scrolls vertically.
	_transcript.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_transcript.fit_content = true
	_transcript.size_flags_horizontal = Control.SIZE_FILL
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_scroll.add_theme_stylebox_override("panel", SummerUI.sb(SummerUI.BG_INPUT, 10))

	_prompt_input.add_theme_stylebox_override("normal", SummerUI.sb(SummerUI.BG_INPUT, 9, SummerUI.BORDER, 1, 8))
	_prompt_input.add_theme_stylebox_override("focus", SummerUI.sb(SummerUI.BG_INPUT, 9, SummerUI.BORDER_FOCUS, 1, 8))
	_prompt_input.add_theme_color_override("font_color", SummerUI.TEXT)
	_prompt_input.add_theme_color_override("font_placeholder_color", SummerUI.TEXT_FAINT)

	SummerUI.accent_button(_send_button)
	SummerUI.primary_button(_talk_button)
	SummerUI.ghost_button(_diff_button)
	SummerUI.success_button(_approve_button)
	SummerUI.accent_button(_merge_button)
	SummerUI.icon_button(_close_button)

func _instance_diff_view() -> void:
	_diff_view = DIFF_VIEW.instantiate()
	if _diff_view == null:
		return
	_diff_view.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_diff_host.add_child(_diff_view)

func _wire() -> void:
	_send_button.pressed.connect(_on_send)
	_prompt_input.text_submitted.connect(_on_text_submitted)
	_talk_button.pressed.connect(_on_talk)
	_diff_button.pressed.connect(_on_diff_pressed)
	_approve_button.pressed.connect(_on_approve)
	_merge_button.pressed.connect(_on_merge)
	_close_button.pressed.connect(_on_close)
	# Make the repo label clickable — opens the repo folder in Finder.
	_repo_label.mouse_filter = Control.MOUSE_FILTER_STOP
	_repo_label.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	_repo_label.gui_input.connect(_on_repo_label_input)
	# Track whether the user is parked at the bottom of the transcript.
	if not _scroll.get_v_scroll_bar().value_changed.is_connected(_on_scrolled):
		_scroll.get_v_scroll_bar().value_changed.connect(_on_scrolled)
	# A soft hover tick on every interactive control.
	for c in [_send_button, _talk_button, _diff_button, _approve_button, _merge_button, _close_button]:
		(c as Control).mouse_entered.connect(_on_hover)

func _on_hover() -> void:
	UiSounds.play("hover")

func _on_repo_label_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		_on_repo_clicked()

func _on_repo_clicked() -> void:
	if _repo_path != "":
		OS.shell_show_in_file_manager(_repo_path)
		UiSounds.play("select")

# ── Responsive layout — anchors, recomputed only on resize ──────────────────
func _relayout() -> void:
	var vp := get_viewport()
	if vp == null:
		return
	var vps: Vector2 = vp.get_visible_rect().size
	if vps.x <= 0.0 or vps.y <= 0.0:
		return
	var w: float = clampf(vps.x * CARD_W_FRAC, CARD_W_MIN, CARD_W_MAX)
	# Never wider than the viewport minus both insets (portrait safety).
	w = minf(w, vps.x - CARD_INSET * 2.0)
	var h: float
	if _compact:
		# Compact (dive): the transcript + input are folded away, so a full-height
		# card would leave a big empty gap where the transcript was — reads as broken
		# on the projector. Hug the content instead: let the VBox report its minimum
		# (header + detail + diff section) and size the card to that, clamped so it
		# never exceeds the normal band or the viewport.
		var content := _root.get_combined_minimum_size().y
		if content <= 0.0:
			content = CARD_H_MIN
		h = clampf(content, CARD_H_MIN * 0.5, CARD_H_MAX)
		h = minf(h, vps.y - CARD_INSET * 2.0)
	else:
		h = clampf(vps.y * CARD_H_FRAC, CARD_H_MIN, CARD_H_MAX)
		h = minf(h, vps.y - CARD_INSET * 2.0)
	# Dock bottom-right via the bottom-right anchor + negative offsets.
	_root.anchor_left = 1.0
	_root.anchor_top = 1.0
	_root.anchor_right = 1.0
	_root.anchor_bottom = 1.0
	_root.offset_left = -(w + CARD_INSET)
	_root.offset_top = -(h + CARD_INSET)
	_root.offset_right = -CARD_INSET
	_root.offset_bottom = -CARD_INSET

# Deferred relayout for the compact toggle: size to the re-sorted content, then pulse
# at the final size (avoids the one-frame height pop from pulsing a stale size).
func _relayout_then_pulse() -> void:
	# No pulse on resize — pulsing the card while it also grows (diff open / compact
	# toggle) reads as a "pop". Just resize cleanly to the re-sorted content.
	_relayout()

# ── FROZEN: open / refresh ──────────────────────────────────────────────────

# Open (or switch to) an agent. `agent` is the frozen AgentView dict. On a switch,
# clears transcript echoes + the hosted DiffView; plays Juice.slide_in +
# UiSounds "panel_open"/"select". Null-safe on current_task / target_base_id.
func show_agent(agent: Dictionary) -> void:
	var new_id := SummerUI.s(agent.get("agent_id"), "")
	var switching := new_id != _agent_id
	_agent_id = new_id
	_repo_id = SummerUI.s(agent.get("repo_id"), "")

	if switching:
		# Fresh agent => drop the previous transcript echoes + diff.
		_pending_echoes.clear()
		_server_lines.clear()
		_stream_text = ""
		_thinking = false
		_last_render_hash = 0
		_stick_bottom = true
		_diff_open = false
		_diff_section.visible = false
		_last_diff_text = ""
		_clear_activity()  # a new agent must not inherit the prior agent's live actions / service chip
		# Session view is per-character: a new agent starts on its LIVE chat with a fresh
		# (un-fetched) history, never inheriting the prior character's archived view/list.
		_viewing_session_id = ""
		_sessions = []
		_close_history()
		# Invalidate the upsert guards so _apply re-writes persona/detail colour for the
		# new agent even if it shares the prior agent's kind/stale (don't pre-set _kind
		# here — _apply owns it, and pre-setting would make kind_changed read false).
		_kind = ""
		_was_stale = false
		if _diff_view != null:
			_diff_view.clear()

	# Always open EXPANDED. A prior dive may have latched _compact=true and (if the
	# card never became visible) exit_dive's `if visible` guard never cleared it —
	# which would fold the transcript + input row away on the next open and leave
	# the operator unable to type. Reset the layout here so every open is usable;
	# the dive re-requests compact explicitly via set_compact(true) right after.
	if _compact:
		_compact = false
		_scroll.visible = true
		($Root/Margin/VBox/InputRow as HBoxContainer).visible = true
		_sep.visible = true

	_state = ""  # force the first _apply to treat the state as a transition
	_apply(agent)
	_render_transcript(true)
	_set_session_bar_visible(true)  # the card is the SESSION view — show the verb row

	visible = true
	_was_visible = true
	Juice.slide_in(_root, Vector2(0.0, 40.0))
	UiSounds.play("panel_open")
	if switching:
		UiSounds.play("select")

# Refresh the OPEN agent in place from a fresh AgentView (the 1s poll). No-op if
# the card is hidden or the id doesn't match. Upserts header/status/transcript
# without flicker; fires Juice.pulse + UiSounds on a state transition.
func update_agent(agent: Dictionary) -> void:
	if not visible:
		return
	if SummerUI.s(agent.get("agent_id"), "") != _agent_id:
		return
	_apply(agent)
	_render_transcript(false)

# Apply an AgentView dict to the header/status/detail. Diffs state transitions to
# fire the right Juice/UiSounds beat exactly once, never on a no-op poll.
func _apply(agent: Dictionary) -> void:
	var label := SummerUI.s(agent.get("label"), _agent_id)
	if label == "":
		label = "Agent"
	_header.text = label

	var kind := SummerUI.s(agent.get("character_kind"), _kind)
	var kind_changed := kind != _kind
	_kind = kind
	var persona := kind.capitalize() if kind != "" else ""
	_persona.text = persona
	if persona != "":
		# Only rewrite the persona colour when the kind actually changed — add_theme_color_override
		# is a dict write + redraw, and _apply runs every 1s poll; a pure view upserts only on change.
		if kind_changed:
			_persona.add_theme_color_override("font_color", SummerUI.kind_color(kind))
		_persona.visible = true
	else:
		# Clear the kind accent when hiding so a later show with a default-gray kind
		# can't briefly inherit a prior kind's colour for a frame.
		if kind_changed:
			_persona.add_theme_color_override("font_color", SummerUI.TEXT_DIM)
		_persona.visible = false

	# Show the SHORT repo name ("web"), NEVER the raw filesystem path — the full path
	# would expand the card off-screen. Fall back to the path's basename. (Clipped in _style.)
	var repo := SummerUI.s(agent.get("repo_id"), "")
	if repo == "":
		repo = SummerUI.s(agent.get("repo_path"), "").get_file()
	_repo_label.text = repo
	_repo_path = SummerUI.s(agent.get("repo_path"), "")
	_repo_label.tooltip_text = _repo_path
	_repo_label.visible = repo != ""

	# current_task is string|null — shown plainly as a quiet subtitle. No red "⚠ stale ·"
	# prefix echoing the prompt — that read as nonsense. (Stale handling lives in the
	# roster's dim; the card just states what the agent is working on.)
	var task := SummerUI.s(agent.get("current_task"), "")
	var status_line := SummerUI.s(agent.get("status_line"), "")
	var detail := task if task != "" else status_line
	_detail.text = detail
	_detail.visible = detail != ""

	var new_state := SummerUI.s(agent.get("state"), "waiting")
	_set_state(new_state)
	_update_action_visibility()
	# Replace the server transcript tail (held apart from optimistic echoes).
	_ingest_server_tail(agent.get("transcript_tail", []))

# Drive the status pill + fire the transition beat (Juice + UiSounds) once.
func _set_state(new_state: String) -> void:
	if new_state == _state:
		return
	var prev := _state
	_state = new_state
	var pal := SummerUI.state_palette(new_state)
	_status_label.text = String(pal["label"])
	_status_label.add_theme_color_override("font_color", pal["fg"])
	# The DOT is the only hue (spec §1: colour = signal); the label stays neutral.
	_status_dot.add_theme_color_override("font_color", pal["dot"])
	_status_pill.add_theme_stylebox_override("panel", SummerUI.pill(pal["bg"]))
	# The wrapper is a plain Control (so the pill's position is bob-free) and does NOT
	# auto-size to the pill — mirror the pill's footprint onto it so HeaderRow reserves
	# the right width. Only runs on a real state transition (label text can change here),
	# and deferred so the pill's combined_minimum_size reflects the new label/stylebox.
	call_deferred("_sync_pill_wrap")

	# Idle motion: bob the pill gently while waiting/idle (never dead-static); stop
	# it the moment the agent leaves idle. Always kill before restart so loops can't
	# stack. Runs regardless of the first-apply guard below.
	var idle := new_state == "waiting"
	Juice.stop(_idle_tw)
	_idle_tw = null
	if idle:
		_idle_tw = Juice.idle_bob(_status_pill)

	# Skip the celebratory/alarm beat on the very first apply (prev == "") — only
	# real in-session transitions cheer/slam; opening a card shouldn't fire them.
	if prev == "":
		Juice.pulse(_status_pill)
		return
	match new_state:
		"working":
			Juice.pulse(_status_pill)
			UiSounds.play("state_working")
		"done":
			Juice.done_cheer(_status_pill)
			UiSounds.play("done_cheer")
		"blocked":
			Juice.lock_slam(_status_pill)
			UiSounds.play("blocked")
		_:
			Juice.pulse(_status_pill)

# Mirror the pill's footprint onto its plain-Control wrapper so HeaderRow reserves the
# correct width (the wrapper doesn't auto-size to its child). Deferred from _set_state so
# the pill has re-sorted to the new label/stylebox. Null-safe; one-shot per transition.
func _sync_pill_wrap() -> void:
	if _status_pill == null or _status_pill_wrap == null:
		return
	_status_pill_wrap.custom_minimum_size = _status_pill.get_combined_minimum_size()

# Approve shows only when awaiting review; Merge only when a project context
# exists and there's reviewable work. Diff is always available.
func _update_action_visibility() -> void:
	var awaiting := SummerUI.awaits_approval(_state)
	_approve_button.visible = awaiting
	# Merge isn't a demo beat (route stays wired) — keep it hidden (SLAM Fix 2).
	_merge_button.visible = false

# ── Chat (Claude-style message bubbles) ─────────────────────────────────────
# Swap the flat RichTextLabel for a real message list: user turns in a rounded
# bubble, agent turns as plain wrapped text with a ✦ mark, a "thinking…" row while
# awaiting a reply. Lives in _scroll (which has horizontal scroll disabled, so the
# card width is the wrap bound). We own autoscroll.
func _build_chat() -> void:
	if _transcript != null and is_instance_valid(_transcript):
		_scroll.remove_child(_transcript)
		_transcript.queue_free()
		_transcript = null
	_chat_list = VBoxContainer.new()
	_chat_list.name = "ChatList"
	_chat_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_chat_list.add_theme_constant_override("separation", 14)
	_chat_list.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_scroll.add_child(_chat_list)

# ── Copy transcript (ghost button in the actions row; built in code) ─────────
# A small "⧉ Copy" ghost affordance docked at the LEFT of the actions row. It
# copies the full conversation thread (the same _server_lines + _pending_echoes
# the card renders) to the OS clipboard via DisplayServer.clipboard_set, bbcode
# stripped, role prefixes kept ("user:"/"agent:"). Null-safe throughout.
func _build_copy_button() -> void:
	if _actions_row == null:
		return
	_copy_button = Button.new()
	_copy_button.name = "CopyButton"
	_copy_button.text = "⧉ Copy"
	_copy_button.focus_mode = Control.FOCUS_NONE
	_copy_button.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	_copy_button.tooltip_text = "Copy the whole conversation to the clipboard"
	SummerUI.ghost_button(_copy_button)
	_actions_row.add_child(_copy_button)
	# Dock it first (leftmost) so Diff/Approve/Merge keep their order to its right.
	_actions_row.move_child(_copy_button, 0)
	_copy_button.pressed.connect(_on_copy_transcript)
	_copy_button.mouse_entered.connect(_on_hover)

# Build the plain-text thread from the SAME lines the card renders. Server tail
# first, then optimistic echoes, bbcode stripped, role prefixes normalised so a
# pasted thread reads "user: …" / "agent: …". Returns "" when there's nothing.
func _build_transcript_text() -> String:
	var merged: Array[String] = []
	merged.append_array(_server_lines)
	merged.append_array(_pending_echoes)
	# A live streaming partial isn't in either array yet — include it as the trailing
	# agent turn so a copy mid-stream isn't missing the latest reply.
	if _stream_text != "":
		merged.append("agent: " + _stream_text)
	var out: Array[String] = []
	for line in merged:
		var s := String(line).strip_edges()
		if s == "":
			continue
		var low := s.to_lower()
		var role := ""
		var body := s
		if low.begins_with("you:") or low.begins_with("user:") or low.begins_with("you (") or low.begins_with("user ("):
			role = "user"
			var ci := s.find(":")
			body = (s.substr(ci + 1) if ci >= 0 else s).strip_edges()
		elif low.begins_with("agent:") or low.begins_with("agent ("):
			role = "agent"
			var ca := s.find(":")
			body = (s.substr(ca + 1) if ca >= 0 else s).strip_edges()
		else:
			role = "agent"  # unprefixed server output is the agent's voice (mirrors _render_transcript)
		out.append("%s: %s" % [role, _strip_bbcode(body)])
	return "\n".join(out)

# Strip BBCode tags (e.g. [color=…]…[/color], [b], [url=…]) so the clipboard text
# is plain prose. The card's agent turns are MdBBCode-rendered RichText, but the
# raw lines we hold are markdown/plain — this guards any tag that slipped through.
func _strip_bbcode(text: String) -> String:
	var re := RegEx.new()
	# Match any [tag] / [/tag] / [tag=value]; non-greedy so "[" without "]" is kept.
	if re.compile("\\[/?[a-zA-Z][^\\]]*\\]") != OK:
		return text
	return re.sub(text, "", true)

func _on_copy_transcript() -> void:
	var text := _build_transcript_text()
	if text == "":
		# Nothing to copy yet — still give feedback, just don't write an empty clipboard.
		UiSounds.play("click")
		if _copy_button != null:
			Juice.pop(_copy_button)
		return
	DisplayServer.clipboard_set(text)
	UiSounds.play("select")
	if _copy_button != null:
		Juice.pop(_copy_button)

# ── Live activity feed (built once, fed by the shell) ────────────────────────
# A compact column inserted into the VBox right under Detail (above Sep): a faint
# "ACTIVITY" header is omitted (the lines speak for themselves); we keep up to
# ACTIVITY_KEEP recent "⚙ <tool>: <summary>" lines + an optional service chip.
# Hidden until the first activity/service arrives so a resting card shows no empty box.
func _build_activity() -> void:
	var vbox := $Root/Margin/VBox as VBoxContainer
	_activity_box = VBoxContainer.new()
	_activity_box.name = "ActivityBox"
	_activity_box.add_theme_constant_override("separation", 2)
	_activity_box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_activity_box.visible = false
	vbox.add_child(_activity_box)
	# Insert directly after Detail (index of Detail + 1), before Sep. Null-safe: if the
	# Detail node moved, fall back to leaving it appended (still renders, just lower).
	var detail_idx := _detail.get_index()
	if detail_idx >= 0:
		vbox.move_child(_activity_box, detail_idx + 1)

	# Pre-create the reusable line pool (newest appended last, oldest trimmed off top).
	for i in ACTIVITY_KEEP:
		var l := Label.new()
		l.add_theme_font_size_override("font_size", ACTIVITY_LINE_SIZE)
		l.add_theme_color_override("font_color", SummerUI.TEXT_DIM)
		l.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
		l.clip_text = true
		l.mouse_filter = Control.MOUSE_FILTER_IGNORE
		l.visible = false
		_activity_box.add_child(l)
		_activity_lines.append(l)

	# The "Open localhost ↗" chip — hidden until a service URL is detected.
	_service_chip = Button.new()
	_service_chip.name = "ServiceChip"
	_service_chip.visible = false
	_service_chip.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_service_chip.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	SummerUI.ghost_button(_service_chip)
	_service_chip.pressed.connect(_on_service_pressed)
	_service_chip.mouse_entered.connect(_on_hover)
	_activity_box.add_child(_service_chip)

# ── Session toolbar + history (built once, fed by the shell) ─────────────────
# A verb row under HeaderRow: New chat (accent) · History (ghost toggle) · ⋯ overflow.
# Send away is behind the overflow: ⋯ opens an inline confirm panel (label + Yes + Cancel)
# so it cannot be triggered in a single accidental tap. Below the session bar a
# collapsible history panel lists A's SessionSummary[]. The bar is hidden until an agent
# is shown (show_agent toggles it) so a resting/empty card has no dangling verbs. Built
# in code (like the activity box) — no .tscn edit.
func _build_session_bar() -> void:
	var vbox := $Root/Margin/VBox as VBoxContainer

	_session_bar = HBoxContainer.new()
	_session_bar.name = "SessionBar"
	_session_bar.add_theme_constant_override("separation", 8)
	_session_bar.visible = false  # shown by show_agent() once we have an agent_id

	_new_chat_button = Button.new()
	_new_chat_button.name = "NewChatButton"
	_new_chat_button.text = "New chat"
	_new_chat_button.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	SummerUI.accent_button(_new_chat_button)   # accent primary (spec §4)
	_session_bar.add_child(_new_chat_button)

	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	spacer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_session_bar.add_child(spacer)

	_history_button = Button.new()
	_history_button.name = "HistoryButton"
	_history_button.text = "History ▸"
	_history_button.toggle_mode = false
	_history_button.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	SummerUI.ghost_button(_history_button)
	_session_bar.add_child(_history_button)

	# ⋯ overflow button — "Send away" lives behind this, behind a confirm step.
	_overflow_button = Button.new()
	_overflow_button.name = "OverflowButton"
	_overflow_button.text = "⋯"
	_overflow_button.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	_overflow_button.tooltip_text = "More options"
	SummerUI.ghost_button(_overflow_button)
	_session_bar.add_child(_overflow_button)

	vbox.add_child(_session_bar)
	# Sit directly under HeaderRow (index of HeaderRow + 1), above RepoLabel. Null-safe.
	var hdr := $Root/Margin/VBox/HeaderRow as HBoxContainer
	var hdr_idx := hdr.get_index() if hdr != null else -1
	if hdr_idx >= 0:
		vbox.move_child(_session_bar, hdr_idx + 1)

	# Overflow confirm panel — shown inline below the session bar when ⋯ is tapped.
	# Contains: "Send away?" label + Yes + Cancel. Hidden by default.
	_overflow_panel = PanelContainer.new()
	_overflow_panel.name = "OverflowPanel"
	_overflow_panel.add_theme_stylebox_override("panel", SummerUI.sb(SummerUI.BG_INPUT, 10, SummerUI.BORDER, 1, 8))
	_overflow_panel.visible = false
	_overflow_panel.mouse_filter = Control.MOUSE_FILTER_STOP

	var op_hbox := HBoxContainer.new()
	op_hbox.add_theme_constant_override("separation", 8)

	var op_label := Label.new()
	op_label.name = "OverflowLabel"
	op_label.text = "Send away?"
	op_label.add_theme_font_size_override("font_size", SummerUI.FS_LABEL)
	op_label.add_theme_color_override("font_color", SummerUI.TEXT_DIM)
	op_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	op_hbox.add_child(op_label)

	var op_spacer := Control.new()
	op_spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	op_spacer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	op_hbox.add_child(op_spacer)

	_send_away_button = Button.new()
	_send_away_button.name = "SendAwayButton"
	_send_away_button.text = "Yes"
	_send_away_button.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	SummerUI.ghost_button(_send_away_button)
	op_hbox.add_child(_send_away_button)

	var cancel_btn := Button.new()
	cancel_btn.name = "OverflowCancelButton"
	cancel_btn.text = "Cancel"
	cancel_btn.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	SummerUI.ghost_button(cancel_btn)
	op_hbox.add_child(cancel_btn)

	_overflow_panel.add_child(op_hbox)
	vbox.add_child(_overflow_panel)
	vbox.move_child(_overflow_panel, _session_bar.get_index() + 1)

	# Collapsible history panel — a thin column of clickable session rows.
	_history_panel = VBoxContainer.new()
	_history_panel.name = "HistoryPanel"
	_history_panel.add_theme_constant_override("separation", 4)
	_history_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_history_panel.visible = false
	vbox.add_child(_history_panel)
	vbox.move_child(_history_panel, _overflow_panel.get_index() + 1)

	_new_chat_button.pressed.connect(_on_new_chat)
	_overflow_button.pressed.connect(_on_overflow_toggle)
	_send_away_button.pressed.connect(_on_send_away_confirmed)
	cancel_btn.pressed.connect(_on_overflow_cancel)
	_history_button.pressed.connect(_on_history_toggle)
	for c in [_new_chat_button, _overflow_button, _send_away_button, cancel_btn, _history_button]:
		c.mouse_entered.connect(_on_hover)

# Show/hide the verb row with the card. Called from show_agent / hide_panel so a hidden
# or agent-less card never shows dangling session verbs.
func _set_session_bar_visible(on: bool) -> void:
	if _session_bar != null:
		_session_bar.visible = on
	if not on:
		_close_history()
		_close_overflow()

# ── New chat: start a fresh session for THIS character ───────────────────────
# Emits new_chat_requested(agent_id); the shell relays it to B (POST /agents/:id/
# new-session). We do NOT clear the transcript here — we wait for B's success callback
# (Hud.session_started -> start_fresh_chat()) so a failed/503 start doesn't blank the
# card. The button is briefly disabled to swallow a double-tap (no idempotency on B).
func _on_new_chat() -> void:
	if _agent_id == "":
		return
	UiSounds.play("select")
	if _new_chat_button != null:
		Juice.pop(_new_chat_button)
	new_chat_requested.emit(_agent_id)

# B calls this (via Hud.session_started) once a fresh session actually started. Clears the
# transcript to an empty chat so the next reply begins a clean conversation. Null-safe.
func start_fresh_chat() -> void:
	_pending_echoes.clear()
	_server_lines.clear()
	_stream_text = ""
	_thinking = false
	_viewing_session_id = ""
	_last_render_hash = 0
	_stick_bottom = true
	_close_history()
	_render_transcript(true)
	UiSounds.play("panel_open")

# ── Overflow menu: ⋯ button opens a tiny confirm panel for Send away ─────────
func _on_overflow_toggle() -> void:
	if _overflow_panel == null:
		return
	var open := not _overflow_panel.visible
	if open:
		_overflow_panel.visible = true
		_overflow_confirm_pending = false
		if _overflow_button != null:
			Juice.pop(_overflow_button)
		UiSounds.play("click")
		call_deferred("_relayout")
	else:
		_close_overflow()

func _close_overflow() -> void:
	_overflow_confirm_pending = false
	if _overflow_panel != null:
		_overflow_panel.visible = false
	call_deferred("_relayout")

func _on_overflow_cancel() -> void:
	UiSounds.play("click")
	_close_overflow()

# ── Send away: confirmed via the overflow panel (two-tap gated) ──────────────
func _on_send_away_confirmed() -> void:
	if _agent_id == "":
		return
	UiSounds.play("reject")
	if _send_away_button != null:
		Juice.pop(_send_away_button)
	_close_overflow()
	send_away_requested.emit(_agent_id)

# ── History toggle + list ────────────────────────────────────────────────────
func _on_history_toggle() -> void:
	UiSounds.play("tab_switch")
	if _history_open:
		_close_history()
		return
	_history_open = true
	if _history_button != null:
		_history_button.text = "History ▾"
	_history_panel.visible = true
	# Ask B for the latest session list every time it's opened (cheap; newest-first).
	_history_loading = true
	_render_history()
	if _agent_id != "":
		sessions_requested.emit(_agent_id)
	if not Juice.reduced_motion:
		Juice.pop(_history_panel)
	call_deferred("_relayout")

func _close_history() -> void:
	_history_open = false
	_history_loading = false
	if _history_button != null:
		_history_button.text = "History ▸"
	if _history_panel != null:
		_history_panel.visible = false
	call_deferred("_relayout")

# B hands back A's GET /agents/:id/sessions result (SessionSummary[]). We render it
# newest-first (A already sorts; we don't re-sort). Null-safe: a non-Array clears.
func show_sessions(sessions) -> void:
	_history_loading = false
	if sessions is Array:
		_sessions = sessions
	else:
		_sessions = []
	if _history_open:
		_render_history()
		call_deferred("_relayout")

func _render_history() -> void:
	if _history_panel == null:
		return
	for c in _history_panel.get_children():
		c.queue_free()

	if _history_loading:
		_history_panel.add_child(_history_hint("Loading sessions…"))
		return
	if _sessions.is_empty():
		_history_panel.add_child(_history_hint("No past sessions yet."))
		return

	for entry in _sessions:
		if not (entry is Dictionary):
			continue
		_history_panel.add_child(_session_row(entry))

func _history_hint(text: String) -> Control:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", SummerUI.FS_LABEL)
	l.add_theme_color_override("font_color", SummerUI.TEXT_FAINT)
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return l

# One clickable session row: a ghost button labelled "<summary> · <when>". Clicking it
# emits session_view_requested(agent_id, session_id); B fetches the archived transcript
# and hands it back via show_session_transcript(). A live session (ended_at == null) is
# marked with a small ● LIVE tag and is not separately fetchable (it's the open chat).
func _session_row(entry: Dictionary) -> Control:
	var sid := SummerUI.s(entry.get("session_id"), "")
	var summary := SummerUI.s(entry.get("summary"), "")
	var ended := SummerUI.s(entry.get("ended_at"), "")
	var is_live := ended == ""
	if summary == "":
		summary = "(no summary)"
	var when := _short_time(SummerUI.s(entry.get("started_at"), ""))
	var label := summary
	if when != "":
		label = "%s · %s" % [summary, when]
	if is_live:
		label = "● LIVE  " + label

	var btn := Button.new()
	btn.text = label
	btn.alignment = HORIZONTAL_ALIGNMENT_LEFT
	btn.clip_text = true
	btn.tooltip_text = summary
	btn.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	SummerUI.ghost_button(btn)
	if sid == _viewing_session_id and sid != "":
		# Mark the row currently being viewed.
		btn.add_theme_color_override("font_color", SummerUI.ACCENT_HI)
	btn.mouse_entered.connect(_on_hover)
	btn.pressed.connect(func() -> void: _on_session_clicked(sid, is_live))
	return btn

func _on_session_clicked(session_id: String, is_live: bool) -> void:
	UiSounds.play("select")
	if is_live or session_id == "":
		# The live session IS the open chat — restore the live transcript rather than
		# fetch (it's not archived). A poll will repaint it next tick.
		_viewing_session_id = ""
		_render_history()
		return
	_viewing_session_id = session_id
	_render_history()  # re-mark the selected row
	session_view_requested.emit(_agent_id, session_id)

# B hands back the archived transcript for a viewed session (read-only). We render the
# lines into the chat list and skip live poll repaints while a session is being viewed
# (guarded in _render_transcript via _viewing_session_id). Null-safe.
func show_session_transcript(session_id: String, lines) -> void:
	if session_id != _viewing_session_id or session_id == "":
		return  # the user moved on / returned to live before this landed
	_server_lines.clear()
	_pending_echoes.clear()
	_stream_text = ""
	_thinking = false
	if lines is Array:
		for v in lines:
			_server_lines.append(SummerUI.s(v, ""))
	_last_render_hash = 0
	_stick_bottom = true
	# Force a rebuild bypassing the live-view guard (we WANT the archived lines shown).
	_render_archived()

# Render the archived lines directly (bypasses the _viewing_session_id guard in
# _render_transcript, which is there to stop the 1s poll from stomping the archive).
func _render_archived() -> void:
	if _chat_list == null or _compact:
		return
	for c in _chat_list.get_children():
		c.queue_free()
	if _server_lines.is_empty():
		_chat_list.add_child(_history_hint("This session has no recorded transcript."))
		return
	for line in _server_lines:
		var s := String(line)
		var low := s.to_lower()
		if low.begins_with("you:") or low.begins_with("user:") or low.begins_with("you (") or low.begins_with("user ("):
			var ci := s.find(":")
			_chat_list.add_child(_user_bubble((s.substr(ci + 1) if ci >= 0 else s).strip_edges()))
		elif low.begins_with("agent:") or low.begins_with("agent ("):
			var ca := s.find(":")
			_chat_list.add_child(_agent_msg((s.substr(ca + 1) if ca >= 0 else s).strip_edges()))
		else:
			_chat_list.add_child(_agent_msg(s))
	_autoscroll_deferred()

# ── FROZEN-additive: live activity (shell relays A's tool_activity for the open agent) ──
# Push the latest per-tool pulse. `tool` is the tool name ("Bash", "Edit"); `summary`
# is the already-redacted detail. Upserts in place: shifts the line pool up by one and
# writes the newest at the bottom, dimmer→brighter so the freshest reads first. No
# allocation on the hot path (labels are pooled), flicker-free, null-safe.
func set_activity(tool: String, summary: String) -> void:
	if _activity_box == null:
		return
	var t := tool.strip_edges()
	var s := summary.strip_edges()
	var line := ""
	if t != "" and s != "":
		line = "⚙ %s: %s" % [t, s]
	elif s != "":
		line = "⚙ %s" % s
	elif t != "":
		line = "⚙ %s" % t
	else:
		return
	# Skip a pure repeat of the freshest line (B may re-hand the same pulse on a poll).
	var newest := _activity_lines[ACTIVITY_KEEP - 1] if not _activity_lines.is_empty() else null
	if newest != null and newest.visible and newest.text == line:
		return
	# Shift the visible texts up by one (drop the oldest), write the newest at the bottom.
	for i in range(ACTIVITY_KEEP - 1):
		var cur := _activity_lines[i + 1]
		var prev := _activity_lines[i]
		prev.text = cur.text
		prev.visible = cur.visible
	var last := _activity_lines[ACTIVITY_KEEP - 1]
	last.text = line
	last.visible = true
	# Recolour the column so the newest (bottom) is brightest and older lines recede.
	_recolour_activity()
	_activity_box.visible = true
	if not Juice.reduced_motion:
		Juice.pulse(last)

# Fade older activity lines so the eye lands on the most recent action.
func _recolour_activity() -> void:
	var visible_count := 0
	for l in _activity_lines:
		if l.visible:
			visible_count += 1
	# Bottom (newest) = TEXT_DIM; each older step a touch fainter.
	var seen := 0
	for i in range(ACTIVITY_KEEP - 1, -1, -1):
		var l := _activity_lines[i]
		if not l.visible:
			continue
		var col := SummerUI.TEXT_DIM if seen == 0 else SummerUI.TEXT_FAINT
		l.add_theme_color_override("font_color", col)
		seen += 1

# ── FROZEN-additive: service URL chip (shell relays A's service event) ───────
# Show an "Open localhost ↗" chip that opens the URL in the OS browser. Empty url
# hides the chip. Idempotent on the same url (no re-show flicker on a repeat event).
func set_service(url: String) -> void:
	if _service_chip == null:
		return
	var u := url.strip_edges()
	if u == _service_url:
		return
	_service_url = u
	if u == "":
		_service_chip.visible = false
		return
	_service_chip.text = "Open localhost ↗"
	_service_chip.tooltip_text = u
	_service_chip.visible = true
	_activity_box.visible = true
	if not Juice.reduced_motion:
		Juice.pop(_service_chip)

func _on_service_pressed() -> void:
	if _service_url == "":
		return
	UiSounds.play("select")
	OS.shell_open(_service_url)

# Reset the activity surface (on agent switch / close) so a new agent never inherits
# the prior agent's actions or service chip.
func _clear_activity() -> void:
	if _activity_box == null:
		return
	for l in _activity_lines:
		l.text = ""
		l.visible = false
	_service_url = ""
	if _service_chip != null:
		_service_chip.visible = false
	_activity_box.visible = false

func _empty_hint() -> Control:
	var l := Label.new()
	l.text = "No messages yet — send this agent its first task below."
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.add_theme_font_size_override("font_size", SummerUI.FS_LABEL)
	l.add_theme_color_override("font_color", SummerUI.TEXT_FAINT)
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return l

# User turn: a wide rounded bubble, indented from the left (Claude style). Fills the
# remaining width so the Label autowraps reliably; never overflows the card.
func _user_bubble(text: String) -> Control:
	var row := MarginContainer.new()
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_theme_constant_override("margin_left", 40)
	var bubble := PanelContainer.new()
	bubble.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	bubble.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bubble.add_theme_stylebox_override("panel", SummerUI.sb(Color(1, 1, 1, 0.07), 14, Color(1, 1, 1, 0.06), 1, 13))
	var lbl := Label.new()
	lbl.text = text
	lbl.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	lbl.add_theme_font_size_override("font_size", SummerUI.FS_BODY)
	lbl.add_theme_color_override("font_color", SummerUI.TEXT)
	lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bubble.add_child(lbl)
	row.add_child(bubble)
	return row

# Agent turn: full-width plain wrapped text with a ✦ mark — like Claude's assistant.
func _agent_msg(text: String) -> Control:
	var row := HBoxContainer.new()
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_theme_constant_override("separation", 10)
	var mark := Label.new()
	mark.text = "✦"
	mark.add_theme_font_size_override("font_size", SummerUI.FS_BODY)
	mark.add_theme_color_override("font_color", SummerUI.ACCENT)
	mark.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	mark.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(mark)
	var lbl := RichTextLabel.new()
	lbl.bbcode_enabled = true
	lbl.fit_content = true
	lbl.scroll_active = false
	lbl.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	lbl.add_theme_font_size_override("normal_font_size", SummerUI.FS_BODY)
	lbl.add_theme_color_override("default_color", SummerUI.TEXT)
	lbl.text = MdBBCode.to_bbcode(text)
	# Selectable so the operator can drag-highlight + copy a single reply (the Copy
	# button grabs the whole thread; this covers a one-line grab). Needs mouse hits,
	# so this label opts back IN to picking (the rest of the row stays click-through).
	lbl.selection_enabled = true
	lbl.mouse_filter = Control.MOUSE_FILTER_STOP
	row.add_child(lbl)
	return row

func _thinking_row() -> Control:
	var row := HBoxContainer.new()
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_theme_constant_override("separation", 10)
	var mark := Label.new()
	mark.text = "✦"
	mark.add_theme_font_size_override("font_size", SummerUI.FS_BODY)
	mark.add_theme_color_override("font_color", SummerUI.ACCENT)
	mark.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(mark)
	var lbl := Label.new()
	lbl.text = "thinking…"
	lbl.add_theme_font_size_override("font_size", SummerUI.FS_LABEL)
	lbl.add_theme_color_override("font_color", SummerUI.TEXT_DIM)
	lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(lbl)
	if not Juice.reduced_motion:
		Juice.pulse(mark)
	return row

# Show a thinking indicator after the user sends, until the agent's reply lands.
func set_thinking(on: bool) -> void:
	if _thinking == on:
		return
	_thinking = on
	_stick_bottom = true
	_render_transcript(true)

# ── Streaming-ready hook (spec §2) ───────────────────────────────────────────
# Render partial agent text in place: each call replaces the live streaming bubble
# (no new turn per token). C emits partials; D renders. Hides the thinking row the
# moment the first token lands. stream_end() drops the buffer once the full line has
# round-tripped through the server tail (so it isn't shown twice).
func stream_partial(text: String) -> void:
	var t := text.strip_edges()
	if t == _stream_text:
		return
	_stream_text = t
	if t != "":
		_thinking = false  # a token is here — the agent is no longer just "thinking"
	_stick_bottom = true
	_render_transcript(true)

# Commit/clear the streaming buffer (the final full line lands via the server tail).
func stream_end() -> void:
	if _stream_text == "":
		return
	_stream_text = ""
	_render_transcript(true)

# ── Transcript (server tail + optimistic echoes, flicker-free) ───────────────

# A message identity key: strip the role prefix (you:/user:/agent:/(voice)), trim, lowercase.
# So the optimistic echo "user: Hi" and the server tail "user: Hi" collapse to one line.
func _norm(line: String) -> String:
	var s := String(line)
	var ci := s.find(":")
	if ci >= 0 and ci <= 8:
		s = s.substr(ci + 1)
	return s.strip_edges().to_lower()

# Replace the server-side tail. Prunes any optimistic echo the server has now
# echoed back (so a line isn't shown twice once it round-trips).
func _ingest_server_tail(tail) -> void:
	_server_lines.clear()
	if tail is Array:
		for v in tail:
			_server_lines.append(SummerUI.s(v, ""))
	# Drop any optimistic echo whose normalised text now appears in the server tail
	# (the round-tripped line), so the user's message never renders twice.
	var server_keys := {}
	for l in _server_lines:
		server_keys[_norm(l)] = true
	var kept: Array[String] = []
	for e in _pending_echoes:
		if not server_keys.has(_norm(e)):
			kept.append(e)
	_pending_echoes = kept

# Append a free-form line (typed echo, voice captions, transcribed speech). Held
# like the typed echo so the next poll merges it after the server tail instead of
# wiping it. Drives an immediate render + autoscroll.
func append_line(text: String) -> void:
	var t := text.strip_edges()
	if t == "":
		return
	_pending_echoes.append(t)
	_stick_bottom = true
	_render_transcript(false)

# Rebuild the transcript BBCode ONLY when the merged content changed. `force`
# bypasses the hash (used on open / compact toggle). Autoscrolls to bottom only
# when the user was already parked there (no yank while reading history).
func _render_transcript(force: bool) -> void:
	if _chat_list == null:
		return
	# Viewing an archived session read-only: the 1s poll must NOT stomp the archived
	# lines back to the live tail. _render_archived() owns the chat while a session is
	# being viewed; "Back to live" (clicking the LIVE row) clears _viewing_session_id and
	# the next poll repaints normally.
	if _viewing_session_id != "":
		return
	# Compact (dive) folds the chat away — skip the rebuild on a hidden ScrollContainer.
	# Lines still accumulate and render correctly on exit_dive (which forces a rebuild).
	if _compact:
		return
	var merged: Array[String] = []
	merged.append_array(_server_lines)
	merged.append_array(_pending_echoes)

	var streaming := _stream_text != ""
	var last_low := String(merged[-1]).to_lower() if not merged.is_empty() else ""
	# Thinking shows only while waiting on the FIRST token (last turn is the user's and
	# nothing is streaming yet). A live partial replaces it.
	var waiting := _thinking and not streaming and (last_low.begins_with("you") or last_low.begins_with("user"))
	if not waiting:
		_thinking = false

	# Fold the live partial into the hash so each token re-renders, but never reuse the
	# cached hash across a partial change.
	var h := _hash_lines(merged) + (1 if waiting else 0) + (hash(_stream_text) if streaming else 0)
	if not force and h == _last_render_hash:
		return
	_last_render_hash = h

	for c in _chat_list.get_children():
		c.queue_free()

	if merged.is_empty() and not waiting and not streaming:
		_chat_list.add_child(_empty_hint())
		return

	for line in merged:
		var s := String(line)
		var low := s.to_lower()
		# User turns: our optimistic echo ("you: …") AND the server tail ("user: …" /
		# "you (voice): …"). Strip the role prefix — the bubble shape conveys who spoke.
		if low.begins_with("you:") or low.begins_with("user:") or low.begins_with("you (") or low.begins_with("user ("):
			var ci := s.find(":")
			_chat_list.add_child(_user_bubble((s.substr(ci + 1) if ci >= 0 else s).strip_edges()))
		elif low.begins_with("agent:") or low.begins_with("agent ("):
			var ca := s.find(":")
			_chat_list.add_child(_agent_msg((s.substr(ca + 1) if ca >= 0 else s).strip_edges()))
		else:
			_chat_list.add_child(_agent_msg(s))
	if streaming:
		# The live partial agent reply — rendered in place as the trailing agent turn.
		_chat_list.add_child(_agent_msg(_stream_text))
	if waiting:
		_chat_list.add_child(_thinking_row())

	if _stick_bottom:
		_autoscroll_deferred()

# Colour a transcript line by its role prefix (you: / agent / system) for room
# legibility. Escapes BBCode so diff/code text can't break the markup.
func _format_line(raw: String) -> String:
	var esc := raw.replace("[", "[lb]")
	var lower := raw.to_lower()
	# Default server agent output to BLUE_HI (most transcript lines are the agent and
	# may carry no prefix — defaulting to plain TEXT silently degraded the role colour
	# across the room). Only the operator's own echo (which we control, prefixed
	# "you: ") is ACCENT_HI; the loose `begins_with("you ")` heuristic is dropped to
	# avoid mis-colouring any agent sentence that happens to start with "you".
	var col: Color = SummerUI.BLUE_HI
	if lower.begins_with("you:"):
		col = SummerUI.ACCENT_HI
	elif lower.begins_with("system") or lower.begins_with("⚠") or lower.begins_with("error"):
		col = SummerUI.TEXT_FAINT
	return "[color=#%s]%s[/color]" % [col.to_html(false), esc]

# Compact an ISO timestamp to "HH:MM" (or the date if older). Best-effort + null-safe:
# any unparseable string falls back to the raw value's first 16 chars so the row still
# carries something. A's started_at is ISO 8601 (e.g. "2026-06-25T14:03:22.000Z").
func _short_time(iso: String) -> String:
	var s := iso.strip_edges()
	if s == "":
		return ""
	var t_idx := s.find("T")
	if t_idx > 0 and s.length() >= t_idx + 6:
		var date := s.substr(0, t_idx)         # 2026-06-25
		var hm := s.substr(t_idx + 1, 5)       # 14:03
		# Today => just the time; otherwise date + time.
		var today := Time.get_date_string_from_system()
		if date == today:
			return hm
		return "%s %s" % [date, hm]
	return s.substr(0, 16)

func _hash_lines(lines: Array[String]) -> int:
	# Cheap order-sensitive hash; avoids rebuilding BBCode on identical polls.
	var h := 0
	for l in lines:
		h = (h * 31 + hash(l)) & 0x7fffffff
	return h

func _autoscroll_deferred() -> void:
	# Defer one frame so fit_content has updated the content height first.
	call_deferred("_do_autoscroll")

func _do_autoscroll() -> void:
	var bar := _scroll.get_v_scroll_bar()
	if bar != null:
		_scroll.scroll_vertical = int(bar.max_value)

func _on_scrolled(_v: float) -> void:
	var bar := _scroll.get_v_scroll_bar()
	if bar == null:
		return
	# "Parked at bottom" within a small tolerance => keep autoscrolling.
	_stick_bottom = (bar.value + bar.page) >= (bar.max_value - 8.0)

# ── FROZEN: close / state ────────────────────────────────────────────────────

# Close the card and reset all per-agent state. Plays UiSounds "panel_close".
func hide_panel() -> void:
	var was := _was_visible
	visible = false
	_was_visible = false
	_agent_id = ""
	_repo_id = ""
	_state = ""
	_kind = ""
	_diff_open = false
	_diff_section.visible = false
	_last_diff_text = ""
	_voice_active = false
	if _talk_button != null:
		_talk_button.disabled = false
	_pending_echoes.clear()
	_server_lines.clear()
	_stream_text = ""
	_thinking = false
	_last_render_hash = 0
	_viewing_session_id = ""
	_sessions = []
	_set_session_bar_visible(false)
	_clear_activity()
	Juice.stop(_idle_tw)
	_idle_tw = null
	if _diff_view != null:
		_diff_view.clear()
	if was:
		UiSounds.play("panel_close")

# The currently-open agent_id ("" if hidden).
func get_agent_id() -> String:
	return _agent_id

# Slim mode for the dive: fold the transcript away, keep header + diff + context.
# Tweened via Juice. Idempotent.
func set_compact(on: bool) -> void:
	if on == _compact:
		return
	_compact = on
	# Fold the transcript + input; keep header, detail and the diff section.
	_scroll.visible = not on
	($Root/Margin/VBox/InputRow as HBoxContainer).visible = not on
	_sep.visible = not on
	# The dive is the conversation surface — fold the session verb row + history + overflow too.
	if _session_bar != null:
		_session_bar.visible = not on
	if on:
		_close_history()
		_close_overflow()
	# Entering compact, the diff IS the surface — make sure the freed space is
	# occupied by something visible rather than a dead gap (header+detail+nothing).
	if on:
		_diff_section.visible = true
		_diff_open = true
		# The diff IS the surface in the dive. If a diff was forwarded before the dive
		# (and possibly cleared on an agent switch right before), re-render the cached
		# text so the surface is deterministic regardless of poll timing — never a blank
		# DiffView host waiting on the next show_diff() to land.
		if _diff_view != null and _last_diff_text != "":
			_diff_view.set_diff(_last_diff_text)
	# The card now hugs its content in compact; recompute once the container has
	# re-sorted (visibility changes don't update combined_minimum_size this frame).
	# Leaving compact: the transcript was skipped while folded, so force a rebuild
	# (captions/echoes may have accumulated during the dive) and re-stick to bottom.
	if not on:
		_stick_bottom = true
		_render_transcript(true)
	# Defer the relayout so it reads the re-sorted combined_minimum_size (an immediate
	# pass would size the card to a stale height for one frame — a visible pop), and
	# pulse after so the bump animates at the final hugged size, not the stale one.
	call_deferred("_relayout_then_pulse")

# ── FROZEN: diff ────────────────────────────────────────────────────────────
# Receive raw `git diff` text (from GET /agents/:id/diff, fetched by B and handed
# down). Forwards it to the hosted DiffView and opens the diff section. Empty text
# => DiffView shows its empty state. The shell calls this in reply to diff_requested.
func show_diff(text: String) -> void:
	if not _diff_section.visible:
		_diff_section.visible = true
	_diff_section.modulate.a = 1.0  # clear any leftover alpha from a collapse fade
	_diff_open = true
	# Only flash on a genuine text change — re-handing identical diff text on the 1s
	# poll while the section is open must not strobe the DiffView to ACCENT every second.
	var changed := text != _last_diff_text
	_last_diff_text = text
	if _diff_view != null:
		_diff_view.set_diff(text)
		if changed:
			Juice.flash(_diff_view, SummerUI.ACCENT)

# ── Interaction handlers (emit the FROZEN signals up to the Hud shell) ───────
# Each plays the matching UiSounds at its site (see ui_sounds.gd EVENTS).

func _on_send() -> void:
	if _agent_id == "":
		return
	var text := _prompt_input.text.strip_edges()
	if text == "":
		return
	_prompt_input.clear()
	# Optimistic echo so the user sees their line instantly. Use "user: " to match the
	# server tail's format, so the echo is de-duped (not shown twice) when it round-trips.
	append_line("user: " + text)
	UiSounds.play("send")
	send_prompt.emit(_agent_id, text)
	set_thinking(true)  # show the "thinking…" indicator until the agent replies

func _on_text_submitted(_text: String) -> void:
	_on_send()  # Enter in the input == Send.

func _on_talk() -> void:
	if _agent_id == "":
		return
	# Latch: ignore a re-press while a voice session is already live so a presenter
	# double-tapping Talk can't fire two request_voice starts (C guarantees no
	# idempotency here). Reset on dive exit via set_voice_active(false) / hide_panel().
	if _voice_active:
		return
	_set_voice_active(true)
	# Talk is a committing tap → "click". The cinematic "dive_in" whoosh is owned by
	# the shell at the actual enter_dive; playing it here would double the whoosh and
	# drift from the sound board's documented WHEN for dive_in.
	UiSounds.play("click")
	request_voice.emit(_agent_id)

# Drive the Talk button's live/disabled state for a voice session. The shell resets
# this (false) when the dive exits; hide_panel() also clears it. Kept tiny + idempotent
# so the shell can call it without coordinating internal card state.
func _set_voice_active(on: bool) -> void:
	_voice_active = on
	if _talk_button != null:
		_talk_button.disabled = on

func _on_diff_pressed() -> void:
	UiSounds.play("click")
	if _diff_open:
		# Toggle the section closed with a brief fade so the collapse doesn't read as
		# a glitch next to the animated open (Game-Feel Bible §6 — tweens everywhere).
		_diff_open = false
		_collapse_diff_section()
		return
	_diff_section.visible = true
	_diff_section.modulate.a = 1.0  # clear any leftover alpha from a collapse fade
	_diff_open = true
	if _diff_view != null:
		_diff_view.set_loading()
	if _agent_id != "":
		diff_requested.emit(_agent_id)

# Fade the diff section out, then hide it once the fade lands (skips straight to
# hidden under reduced motion). Guarded so a re-open mid-fade isn't stomped: if the
# user re-opened (_diff_open true) by the time the tween finishes, leave it visible
# and reset its alpha.
func _collapse_diff_section() -> void:
	if Juice.reduced_motion:
		_diff_section.visible = false
		_diff_section.modulate.a = 1.0
		return
	var tw := _diff_section.create_tween()
	tw.tween_property(_diff_section, "modulate:a", 0.0, 0.14) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN)
	tw.tween_callback(func() -> void:
		if _diff_open:
			# Re-opened during the fade — keep it shown.
			_diff_section.modulate.a = 1.0
		else:
			_diff_section.visible = false
			_diff_section.modulate.a = 1.0)

func _on_approve() -> void:
	if _agent_id == "":
		return
	UiSounds.play("approve")
	Juice.done_cheer(_approve_button)
	approve_requested.emit(_agent_id)

func _on_merge() -> void:
	if _repo_id == "":
		return
	UiSounds.play("merge")
	Juice.done_cheer(_merge_button)
	merge_requested.emit(_repo_id)

func _on_close() -> void:
	hide_panel()
	closed.emit()
