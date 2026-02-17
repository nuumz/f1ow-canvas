/**
 * webgl/shaders.ts — Vertex/fragment shader source for the WebGL hybrid layer.
 *
 * Renders textured quads (one per static canvas element). Each quad is a
 * rectangle in world-space with an associated texture region from the
 * element atlas.
 *
 * Attribute layout (per-instance, interleaved in a single VBO):
 *   vec2 a_position   — quad corner (unit square 0-1, shared geometry)
 *   vec4 a_worldRect   — (x, y, width, height) in world coords
 *   vec4 a_texRect     — (u, v, uWidth, vHeight) in atlas UV coords
 *   float a_opacity    — element opacity
 *   float a_rotation   — rotation in radians
 */

/** Vertex shader — transforms world-space quads to clip space. */
export const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

// Shared unit-quad corners (0=bottom-left, 1=top-right)
in vec2 a_position;

// Per-instance attributes
in vec4 a_worldRect;     // x, y, width, height
in vec4 a_texRect;       // u, v, uWidth, vHeight
in float a_opacity;
in float a_rotation;

// Uniforms
uniform mat3 u_viewMatrix; // world → NDC

out vec2 v_texCoord;
out float v_opacity;

void main() {
    // Expand unit quad to world-space rectangle
    float cx = a_worldRect.x + a_worldRect.z * 0.5;
    float cy = a_worldRect.y + a_worldRect.w * 0.5;

    // Local offset from center
    float lx = (a_position.x - 0.5) * a_worldRect.z;
    float ly = (a_position.y - 0.5) * a_worldRect.w;

    // Apply rotation
    float cosR = cos(a_rotation);
    float sinR = sin(a_rotation);
    float rx = lx * cosR - ly * sinR;
    float ry = lx * sinR + ly * cosR;

    // World position
    vec2 worldPos = vec2(cx + rx, cy + ry);

    // Transform to clip space
    vec3 clipPos = u_viewMatrix * vec3(worldPos, 1.0);
    gl_Position = vec4(clipPos.xy, 0.0, 1.0);

    // UV mapping
    v_texCoord = a_texRect.xy + a_position * a_texRect.zw;
    v_opacity = a_opacity;
}
`;

/** Fragment shader — texture sample with opacity. */
export const FRAG_SRC = /* glsl */ `#version 300 es
precision mediump float;

in vec2 v_texCoord;
in float v_opacity;

uniform sampler2D u_atlas;

out vec4 fragColor;

void main() {
    vec4 texColor = texture(u_atlas, v_texCoord);
    fragColor = texColor * v_opacity;
}
`;
