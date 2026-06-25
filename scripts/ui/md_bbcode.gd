extends RefCounted
# No class_name — bound via preload const, like every scripts/ui helper.
# Converts a SAFE subset of Markdown to Godot BBCode for agent message bubbles:
#   **bold**  `inline code`  ```fenced blocks```  - bullets  ## headings
# Anything else passes through as plain text. Stray BBCode in the source is
# neutralised first so model output can't inject tags.

static func to_bbcode(src: String) -> String:
	var s := src.replace("[", "[lb]")  # neutralise any literal BBCode in model output
	var out := PackedStringArray()
	var in_fence := false
	for raw_line in s.split("\n"):
		var line := raw_line as String
		if line.strip_edges().begins_with("```"):
			in_fence = not in_fence
			out.append("[code]" if in_fence else "[/code]")
			continue
		if in_fence:
			out.append(line)
			continue
		# headings: ## Foo  -> bold
		var h := line.strip_edges()
		if h.begins_with("#"):
			out.append("[b]%s[/b]" % h.lstrip("#").strip_edges())
			continue
		# bullets: "- x" / "* x" -> "• x"
		if h.begins_with("- ") or h.begins_with("* "):
			# Preserve leading indentation: h is the stripped line, so (line.length - h.length) == indent width.
			line = line.substr(0, line.length() - h.length()) + "•  " + h.substr(2)
		out.append(_inline(line))
	return "\n".join(out)

static func _inline(line: String) -> String:
	# inline code `x` -> [code]x[/code]
	line = _wrap_pairs(line, "`", "[code]", "[/code]")
	# bold **x** -> [b]x[/b]  (do after code so backticked ** is left alone-ish)
	line = _wrap_pairs(line, "**", "[b]", "[/b]")
	return line

static func _wrap_pairs(line: String, mark: String, open_tag: String, close_tag: String) -> String:
	var parts := line.split(mark)
	# 0 or 1 marks means nothing to pair.
	if parts.size() < 3:
		return line
	# Greedily consume pairs (open+content+close); any leftover odd mark at the end
	# is emitted as a literal mark so already-matched pairs still get styled.
	var out := ""
	var i := 0
	# Consume complete pairs: each pair uses parts[i] (literal), parts[i+1] (content), parts[i+2] (next literal start).
	# We step by 2 through marks, so advance i by 2 each iteration (skipping mark-delimited segments).
	while i + 2 < parts.size():
		out += parts[i]
		out += open_tag + parts[i + 1] + close_tag
		i += 2
	# Emit the final literal segment(s).
	# If i == parts.size()-1: all marks paired evenly, emit trailing literal.
	# If i == parts.size()-2: one unmatched mark remains between parts[i] and parts[i+1];
	#   reconstruct it literally so already-styled pairs are preserved.
	if i + 1 < parts.size():
		out += parts[i] + mark + parts[i + 1]
	else:
		out += parts[i]
	return out
