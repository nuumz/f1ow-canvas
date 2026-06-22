/**
 * webgl/glUtils.ts — Low-level WebGL helper functions.
 *
 * Provides shader compilation, program linking, buffer creation, and
 * texture management utilities used by the WebGL hybrid renderer.
 */

/**
 * Compile a GLSL shader from source.
 * @throws Error with compiler log on failure.
 */
export function compileShader(
    gl: WebGL2RenderingContext,
    type: number,
    source: string,
): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Failed to create shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) ?? 'Unknown error';
        gl.deleteShader(shader);
        throw new Error(`Shader compile error: ${log}`);
    }
    return shader;
}

/**
 * Link vertex + fragment shaders into a program.
 * @throws Error with linker log on failure.
 */
export function linkProgram(
    gl: WebGL2RenderingContext,
    vertShader: WebGLShader,
    fragShader: WebGLShader,
): WebGLProgram {
    const program = gl.createProgram();
    if (!program) throw new Error('Failed to create program');
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) ?? 'Unknown error';
        gl.deleteProgram(program);
        throw new Error(`Program link error: ${log}`);
    }
    return program;
}

/**
 * Create and compile a full shader program from source strings.
 */
export function createProgram(
    gl: WebGL2RenderingContext,
    vertSrc: string,
    fragSrc: string,
): WebGLProgram {
    const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    const program = linkProgram(gl, vert, frag);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    return program;
}

/**
 * Create a WebGL buffer and upload data.
 */
export function createBuffer(
    gl: WebGL2RenderingContext,
    data: ArrayBufferView,
    usage: number = gl.STATIC_DRAW,
): WebGLBuffer {
    const buf = gl.createBuffer();
    if (!buf) throw new Error('Failed to create buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    return buf;
}

/**
 * Upload (allocate) a full 2D texture from an ImageBitmap or OffscreenCanvas.
 *
 * The source is a straight-alpha 2D canvas, but the renderer composites with
 * premultiplied-alpha blending (`ONE, ONE_MINUS_SRC_ALPHA`) on a
 * `premultipliedAlpha: true` context. We therefore ask WebGL to premultiply
 * on upload (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`) so the whole pipeline is
 * premultiplied end-to-end — otherwise edges of transparent shapes get dark
 * fringes / over-bright halos.
 */
export function uploadTexture(
    gl: WebGL2RenderingContext,
    source: ImageBitmap | OffscreenCanvas | HTMLCanvasElement,
    existingTexture?: WebGLTexture | null,
): WebGLTexture {
    const tex = existingTexture ?? gl.createTexture();
    if (!tex) throw new Error('Failed to create texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return tex;
}

/**
 * Upload only a sub-rectangle of `source` into an already-allocated texture
 * via `texSubImage2D`, avoiding a full reallocation of the (potentially
 * ~64 MB) atlas every frame.
 *
 * WebGL2 honours the integer unpack pixel-store params even for
 * TexImageSource uploads, so `UNPACK_ROW_LENGTH/SKIP_PIXELS/SKIP_ROWS` are
 * used to select the dirty sub-rect out of the full-size source canvas.
 * Premultiply is applied to stay consistent with {@link uploadTexture}.
 */
export function uploadTextureSubRect(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    source: ImageBitmap | OffscreenCanvas | HTMLCanvasElement,
    x: number,
    y: number,
    width: number,
    height: number,
    sourceWidth: number,
): void {
    if (width <= 0 || height <= 0) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, sourceWidth);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, source);
    // Reset so later uploads aren't affected by this sub-rect selection.
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
}

/**
 * Build the 3×3 view matrix that transforms world coordinates to NDC.
 *
 * The Konva viewport has:
 *   - `x`, `y`: translation (pan offset) in screen pixels
 *   - `scale`: zoom factor
 *
 * NDC range: [-1, 1] for both axes with Y up.
 * World → Screen: screenX = worldX * scale + viewportX
 * Screen → NDC:   ndcX = screenX / (width/2) - 1
 *
 * Combined: ndcX = (worldX * scale + viewportX) * 2 / width - 1
 */
export function buildViewMatrix(
    viewportX: number,
    viewportY: number,
    scale: number,
    canvasWidth: number,
    canvasHeight: number,
): Float32Array {
    // mat3 in column-major order
    const sx = (2 * scale) / canvasWidth;
    const sy = (-2 * scale) / canvasHeight; // flip Y for WebGL
    const tx = (2 * viewportX) / canvasWidth - 1;
    const ty = (-2 * viewportY) / canvasHeight + 1;

    // prettier-ignore
    return new Float32Array([
        sx, 0, 0,
        0, sy, 0,
        tx, ty, 1,
    ]);
}
