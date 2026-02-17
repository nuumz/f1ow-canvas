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
 * Upload a 2D texture from an ImageBitmap or OffscreenCanvas.
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return tex;
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
