shader_type spatial;
render_mode cull_back, diffuse_burley, specular_schlick_ggx;

// Cheap stylized moat water for the cozy diorama island. No screen textures, no
// depth fetch, no reflections — just two scrolling low-freq noise layers driving a
// gentle color gradient + a soft specular sparkle band, so it reads as friendly
// Clash-style water and stays cheap on the mobile renderer. World-space XZ drives
// the ripples so it tiles seamlessly under the island.

uniform vec3 water_shallow : source_color = vec3(0.27, 0.66, 0.86); // bright rim near the island
uniform vec3 water_deep    : source_color = vec3(0.10, 0.36, 0.66); // open-water blue
uniform vec3 foam_tint     : source_color = vec3(0.74, 0.92, 1.0);  // crest highlight
uniform float ripple_scale = 0.10;   // world-space frequency of the swells
uniform float flow_speed   = 0.18;   // how fast the water drifts
uniform float sparkle      = 0.35;   // strength of the moving highlight band
uniform float island_half  = 45.5;   // distance from center where shallow->deep blends (matches island vertex reach)

varying vec3 world_pos;

float hash21(vec2 p) {
	p = fract(p * vec2(123.34, 345.45));
	p += dot(p, p + 34.345);
	return fract(p.x * p.y);
}

float vnoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	float a = hash21(i);
	float b = hash21(i + vec2(1.0, 0.0));
	float c = hash21(i + vec2(0.0, 1.0));
	float d = hash21(i + vec2(1.0, 1.0));
	return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec2 uvp = world_pos.xz;
	float t = TIME * flow_speed;

	// Two scrolling swell layers crossing each other for living water.
	float a = vnoise(uvp * ripple_scale + vec2(t, t * 0.6));
	float b = vnoise(uvp * ripple_scale * 1.7 - vec2(t * 0.8, t * 0.4));
	float swell = (a + b) * 0.5;

	// Shallow bright rim near the island fading to open-water deep blue.
	float dist = length(uvp) / island_half;
	float depth_mix = smoothstep(0.7, 1.6, dist);
	vec3 col = mix(water_shallow, water_deep, depth_mix);

	// Lift the crests slightly toward the shallow tone for a friendly shimmer.
	col = mix(col, water_shallow, smoothstep(0.55, 0.85, swell) * 0.4);

	// A soft moving highlight band so the surface catches the warm sun.
	float band = smoothstep(0.78, 0.95, swell);
	col = mix(col, foam_tint, band * sparkle);

	ALBEDO = col;
	ROUGHNESS = 0.12;
	METALLIC = 0.0;
	SPECULAR = 0.6;
}
