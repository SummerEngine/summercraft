shader_type canvas_item;
// Frosted-glass backing for the HUD (Chat D). Blurs whatever is behind the panel
// (the 3D diorama) and tints it dark + translucent, masked to a rounded rect — so
// panels read as clean frosted glass instead of opaque slabs. Drawn on a ColorRect
// sized to fill its panel; frost_rect.gd feeds rect_size/radius on resize.
//
// Mobile-renderer safe: hint_screen_texture triggers a back-buffer copy; the blur
// is a fixed 9-tap box so cost is bounded per panel.

uniform sampler2D screen_tex : hint_screen_texture, filter_linear;
uniform vec4 tint : source_color = vec4(0.055, 0.065, 0.095, 0.46); // dark glass over the blur
uniform vec4 rim_color : source_color = vec4(1.0, 1.0, 1.0, 0.10);  // AA'd edge line (replaces stylebox border)
uniform float blur : hint_range(0.0, 8.0) = 4.0;   // tap spread in screen pixels (creamy glass)
uniform vec2 rect_size = vec2(200.0, 200.0);       // ColorRect size in px (set per-instance)
uniform float radius = 18.0;                        // corner radius in px
uniform float edge_soft = 2.0;                      // AA feather in px (smooth rounded corners)
uniform float rim = 1.6;                            // rim thickness in px

// Signed distance to a rounded rect centred in `rect_size`.
float rrect_sd(vec2 p, vec2 half_size, float r) {
	vec2 q = abs(p) - (half_size - vec2(r));
	return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

void fragment() {
	vec2 p = UV * rect_size;
	float d = rrect_sd(p - rect_size * 0.5, rect_size * 0.5, radius);
	float mask = 1.0 - smoothstep(-edge_soft, edge_soft, d);
	if (mask <= 0.002) {
		discard;
	}

	vec2 px = SCREEN_PIXEL_SIZE * blur;
	vec3 col = texture(screen_tex, SCREEN_UV).rgb * 0.25;
	col += texture(screen_tex, SCREEN_UV + vec2(px.x, 0.0)).rgb * 0.125;
	col += texture(screen_tex, SCREEN_UV - vec2(px.x, 0.0)).rgb * 0.125;
	col += texture(screen_tex, SCREEN_UV + vec2(0.0, px.y)).rgb * 0.125;
	col += texture(screen_tex, SCREEN_UV - vec2(0.0, px.y)).rgb * 0.125;
	col += texture(screen_tex, SCREEN_UV + px).rgb * 0.0625;
	col += texture(screen_tex, SCREEN_UV - px).rgb * 0.0625;
	col += texture(screen_tex, SCREEN_UV + vec2(px.x, -px.y)).rgb * 0.0625;
	col += texture(screen_tex, SCREEN_UV + vec2(-px.x, px.y)).rgb * 0.0625;

	// desaturate the blurred backdrop so the world's colour can't muddy the glass —
	// the panel reads as crisp neutral charcoal regardless of what's behind it
	float lum = dot(col, vec3(0.299, 0.587, 0.114));
	col = mix(col, vec3(lum), 0.65);
	// composite the dark glass tint over the (now neutral) blurred backdrop
	vec3 frosted = mix(col, tint.rgb, tint.a);
	// a faint top-edge sheen so the glass catches light (very subtle)
	float sheen = (1.0 - smoothstep(0.0, 0.10, UV.y)) * 0.05;
	frosted += sheen;
	// AA'd inner rim near the edge — gives the panel definition WITHOUT a stylebox
	// border (which aliases on the mobile renderer at rounded corners). d is the
	// signed distance: ~0 at the edge, negative inside; the rim peaks at the edge.
	float rimf = smoothstep(-rim - edge_soft, -edge_soft, d);
	frosted += rim_color.rgb * (rimf * rim_color.a);
	COLOR = vec4(frosted, mask);
}
