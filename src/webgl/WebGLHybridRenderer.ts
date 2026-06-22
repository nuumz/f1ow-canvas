/**
 * webgl/WebGLHybridRenderer.ts — WebGL hybrid rendering engine.
 *
 * Renders static (non-selected) canvas elements as textured quads on a
 * WebGL2 canvas layer. Interactive elements continue to be rendered via
 * the Konva layer above. This achieves 10–50× more elements at 60fps
 * compared to pure Canvas 2D.
 *
 * Architecture:
 * ```
 * ┌───────────────────────────────────────────┐
 * │ FlowCanvas React component                │
 * │  ├── Konva Grid Layer (bottom)            │
 * │  ├── WebGL Static Layer    ← this module  │
 * │  ├── Konva Interactive Layer (selected)   │
 * │  └── Konva Overlay Layer (UI decorations) │
 * └───────────────────────────────────────────┘
 * ```
 *
 * Lifecycle:
 *   1. Create WebGL2 context on a <canvas> element
 *   2. Compile shaders, setup VAO/VBO, create unit quad
 *   3. Rasterise static elements → TextureAtlas → WebGL texture
 *   4. Each frame: update view matrix, draw instanced quads
 *   5. When element is selected → remove from WebGL, let Konva render it
 *   6. When element is deselected → re-add to WebGL
 */

import type { CanvasElement, ViewportState } from '@/types';
import { VERT_SRC, FRAG_SRC } from './shaders';
import { createProgram, createBuffer, uploadTexture, uploadTextureSubRect, buildViewMatrix } from './glUtils';
import { TextureAtlas, type ElementRasterFn, type AtlasRegion } from './textureAtlas';

// ─── Types ────────────────────────────────────────────────────

export interface WebGLHybridRendererOptions {
    /** Custom element rasterisation function for the atlas */
    rasterFn?: ElementRasterFn;
    /**
     * Minimum element count before WebGL rendering kicks in.
     * Below this, standard Konva rendering is sufficient.
     * Default: 1000.
     */
    elementThreshold?: number;
}

// ─── Instance Data Layout ─────────────────────────────────────

/**
 * Per-instance data packed as floats:
 *   vec4 a_worldRect  (x, y, w, h)       — offset 0, 4 floats
 *   vec4 a_texRect    (u, v, uW, vH)     — offset 4, 4 floats
 *   float a_opacity                       — offset 8, 1 float
 *   float a_rotation                      — offset 9, 1 float
 * Total: 10 floats per instance
 */
export const FLOATS_PER_INSTANCE = 10;
const INSTANCE_DATA_SHRINK_RATIO = 0.5;
const INSTANCE_DATA_MIN_CAPACITY = FLOATS_PER_INSTANCE * 256;

// ─── Pure helpers (no GL — unit testable) ─────────────────────

/**
 * Decide whether an element must be (re)rasterised into the atlas.
 *
 * An element needs rastering when it has no atlas region yet, or when its
 * monotonic `version` (bumped by the data model on geometry/port mutation)
 * differs from the version last rasterised. This is the content signature
 * that keeps the generation counter from being bumped every frame.
 */
export function needsRaster(
    element: CanvasElement,
    lastVersion: number | undefined,
    hasRegion: boolean,
): boolean {
    return !hasRegion || lastVersion !== element.version;
}

/**
 * Pack per-instance attribute floats for `elements` into `target`.
 * Elements without an atlas region are skipped. Returns the instance count.
 *
 * `target` must have capacity for `elements.length * FLOATS_PER_INSTANCE`.
 */
export function writeInstanceData(
    elements: CanvasElement[],
    getRegion: (id: string) => AtlasRegion | null,
    target: Float32Array,
): number {
    let offset = 0;
    let rendered = 0;
    for (const el of elements) {
        const region = getRegion(el.id);
        if (!region) continue;

        // a_worldRect
        target[offset + 0] = el.x;
        target[offset + 1] = el.y;
        target[offset + 2] = el.width;
        target[offset + 3] = el.height;

        // a_texRect
        target[offset + 4] = region.u;
        target[offset + 5] = region.v;
        target[offset + 6] = region.uWidth;
        target[offset + 7] = region.vHeight;

        // a_opacity
        target[offset + 8] = el.style?.opacity ?? 1;

        // a_rotation (degrees → radians)
        target[offset + 9] = ((el.rotation ?? 0) * Math.PI) / 180;

        offset += FLOATS_PER_INSTANCE;
        rendered++;
    }
    return rendered;
}

// ─── WebGLHybridRenderer ──────────────────────────────────────

export class WebGLHybridRenderer {
    private _canvas: HTMLCanvasElement | null = null;
    private _gl: WebGL2RenderingContext | null = null;
    private _program: WebGLProgram | null = null;
    private _vao: WebGLVertexArrayObject | null = null;
    private _quadVBO: WebGLBuffer | null = null;
    private _instanceVBO: WebGLBuffer | null = null;
    private _atlasTexture: WebGLTexture | null = null;
    private _atlas: TextureAtlas;
    private _viewMatrixLoc: WebGLUniformLocation | null = null;
    private _atlasLoc: WebGLUniformLocation | null = null;
    private _instanceData: Float32Array = new Float32Array(0);
    private _instanceCount = 0;
    private _elementThreshold: number;
    private _generation = 0;
    /** Last rasterised `version` per element id — the content signature. */
    private _elementVersions = new Map<string, number>();
    private _isInitialised = false;
    private _width = 0;
    private _height = 0;

    constructor(options: WebGLHybridRendererOptions = {}) {
        this._atlas = new TextureAtlas(options.rasterFn);
        this._elementThreshold = options.elementThreshold ?? 1000;
    }

    // ── Initialisation ────────────────────────────────────────

    /**
     * Attach to a <canvas> element and initialise WebGL resources.
     * Call once when the canvas element is available (e.g. from a ref callback).
     */
    init(canvas: HTMLCanvasElement): boolean {
        if (this._isInitialised) return true;

        const gl = canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: true,
            antialias: true,
            desynchronized: true, // reduce input latency
        });
        if (!gl) {
            console.warn('[WebGLHybrid] WebGL2 not available');
            return false;
        }

        this._canvas = canvas;
        this._gl = gl;

        try {
            this._program = createProgram(gl, VERT_SRC, FRAG_SRC);
        } catch (e) {
            console.warn('[WebGLHybrid] Shader compilation failed:', e);
            return false;
        }

        // Setup uniform locations
        this._viewMatrixLoc = gl.getUniformLocation(this._program, 'u_viewMatrix');
        this._atlasLoc = gl.getUniformLocation(this._program, 'u_atlas');

        // Create VAO
        this._vao = gl.createVertexArray();
        gl.bindVertexArray(this._vao);

        // Unit quad positions (2 triangles)
        const quadVertices = new Float32Array([
            0, 0, 1, 0, 0, 1,
            0, 1, 1, 0, 1, 1,
        ]);
        this._quadVBO = createBuffer(gl, quadVertices, gl.STATIC_DRAW);

        // Bind quad position attribute
        const aPos = gl.getAttribLocation(this._program, 'a_position');
        gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVBO);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        // Instance VBO (dynamic)
        this._instanceVBO = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceVBO);
        gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);

        // Instance attribute setup
        const stride = FLOATS_PER_INSTANCE * 4; // bytes
        const aWorldRect = gl.getAttribLocation(this._program, 'a_worldRect');
        const aTexRect = gl.getAttribLocation(this._program, 'a_texRect');
        const aOpacity = gl.getAttribLocation(this._program, 'a_opacity');
        const aRotation = gl.getAttribLocation(this._program, 'a_rotation');

        if (aWorldRect >= 0) {
            gl.enableVertexAttribArray(aWorldRect);
            gl.vertexAttribPointer(aWorldRect, 4, gl.FLOAT, false, stride, 0);
            gl.vertexAttribDivisor(aWorldRect, 1);
        }
        if (aTexRect >= 0) {
            gl.enableVertexAttribArray(aTexRect);
            gl.vertexAttribPointer(aTexRect, 4, gl.FLOAT, false, stride, 16);
            gl.vertexAttribDivisor(aTexRect, 1);
        }
        if (aOpacity >= 0) {
            gl.enableVertexAttribArray(aOpacity);
            gl.vertexAttribPointer(aOpacity, 1, gl.FLOAT, false, stride, 32);
            gl.vertexAttribDivisor(aOpacity, 1);
        }
        if (aRotation >= 0) {
            gl.enableVertexAttribArray(aRotation);
            gl.vertexAttribPointer(aRotation, 1, gl.FLOAT, false, stride, 36);
            gl.vertexAttribDivisor(aRotation, 1);
        }

        gl.bindVertexArray(null);

        // Enable blending for transparent elements.
        // The atlas is uploaded with UNPACK_PREMULTIPLY_ALPHA_WEBGL (see
        // glUtils.uploadTexture), so the source is premultiplied and we use
        // the premultiplied blend equation on this premultipliedAlpha context.
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        this._isInitialised = true;
        return true;
    }

    // ── Rendering ─────────────────────────────────────────────

    /**
     * Update and render static elements.
     *
     * @param elements All canvas elements
     * @param selectedIds IDs of currently selected (interactive) elements
     * @param viewport Current viewport state
     */
    render(
        elements: CanvasElement[],
        selectedIds: ReadonlySet<string>,
        viewport: ViewportState,
    ): void {
        if (!this._isInitialised || !this._gl || !this._canvas) return;
        if (elements.length < this._elementThreshold) return;

        const gl = this._gl;

        // Update canvas size to match container
        if (this._canvas.width !== this._width || this._canvas.height !== this._height) {
            this._canvas.width = this._width;
            this._canvas.height = this._height;
        }

        gl.viewport(0, 0, this._width, this._height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // Determine static elements (not selected, not locked for editing)
        const staticElements: CanvasElement[] = [];
        for (const el of elements) {
            if (!selectedIds.has(el.id)) {
                staticElements.push(el);
            }
        }

        if (staticElements.length === 0) return;

        // Update atlas with static elements. Only (re)rasterise elements whose
        // content actually changed (new, version bumped, or evicted) — the
        // generation is bumped per change, NEVER per frame, so unchanged
        // elements keep their existing atlas slot and nothing is re-packed.
        for (const el of staticElements) {
            const hasRegion = this._atlas.getRegion(el.id) !== null;
            if (!needsRaster(el, this._elementVersions.get(el.id), hasRegion)) continue;
            this._generation++;
            const region = this._atlas.addOrUpdate(el, this._generation);
            if (region) {
                this._elementVersions.set(el.id, el.version);
            }
        }

        // Upload atlas texture only when it actually changed. Stream just the
        // dirty sub-rect via texSubImage2D; full texImage2D (realloc) is used
        // only on first upload or after a compaction/rebuild.
        if (this._atlas.isDirty) {
            const dirty = this._atlas.consumeDirty();
            if (dirty) {
                const canvas = this._atlas.getCanvas();
                if (!this._atlasTexture || dirty.full) {
                    this._atlasTexture = uploadTexture(gl, canvas, this._atlasTexture);
                } else {
                    uploadTextureSubRect(
                        gl, this._atlasTexture, canvas,
                        dirty.x, dirty.y, dirty.width, dirty.height, canvas.width,
                    );
                }
            }
        }

        // Build instance data
        this._buildInstanceData(staticElements);

        // Upload instance data
        gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceVBO);
        gl.bufferData(gl.ARRAY_BUFFER, this._instanceData, gl.DYNAMIC_DRAW);

        // Draw
        gl.useProgram(this._program);

        // Set view matrix
        const viewMatrix = buildViewMatrix(
            viewport.x, viewport.y, viewport.scale,
            this._width, this._height,
        );
        gl.uniformMatrix3fv(this._viewMatrixLoc, false, viewMatrix);

        // Bind atlas texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._atlasTexture);
        gl.uniform1i(this._atlasLoc, 0);

        // Draw instanced quads
        gl.bindVertexArray(this._vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this._instanceCount);
        gl.bindVertexArray(null);
    }

    /** Set the canvas dimensions */
    setSize(width: number, height: number): void {
        this._width = width;
        this._height = height;
    }

    /** Whether WebGL is active and threshold is met */
    get isActive(): boolean {
        return this._isInitialised;
    }

    /** Number of instances rendered last frame */
    get instanceCount(): number {
        return this._instanceCount;
    }

    /** Element count threshold for activation */
    get elementThreshold(): number {
        return this._elementThreshold;
    }

    // ── Element Management ────────────────────────────────────

    /**
     * Called when elements are modified. Marks their atlas entries as stale.
     */
    invalidateElements(ids: string[]): void {
        for (const id of ids) {
            this._atlas.remove(id);
            this._elementVersions.delete(id);
        }
    }

    /**
     * Force a full atlas rebuild (e.g. after undo, import). Elements are
     * re-rasterised lazily on the next render via the version signature.
     */
    invalidateAll(): void {
        this._atlas.rebuild([]);
        this._elementVersions.clear();
    }

    // ── Cleanup ───────────────────────────────────────────────

    dispose(): void {
        const gl = this._gl;
        if (gl) {
            if (this._program) gl.deleteProgram(this._program);
            if (this._vao) gl.deleteVertexArray(this._vao);
            if (this._quadVBO) gl.deleteBuffer(this._quadVBO);
            if (this._instanceVBO) gl.deleteBuffer(this._instanceVBO);
            if (this._atlasTexture) gl.deleteTexture(this._atlasTexture);
        }
        this._atlas.dispose();
        this._elementVersions.clear();
        this._atlasTexture = null;
        this._isInitialised = false;
        this._gl = null;
        this._canvas = null;
    }

    // ── Private ───────────────────────────────────────────────

    private _buildInstanceData(elements: CanvasElement[]): void {
        const count = elements.length;
        const needed = count * FLOATS_PER_INSTANCE;
        if (
            this._instanceData.length < needed ||
            (this._instanceData.length > INSTANCE_DATA_MIN_CAPACITY && needed < this._instanceData.length * INSTANCE_DATA_SHRINK_RATIO)
        ) {
            this._instanceData = new Float32Array(Math.max(needed, INSTANCE_DATA_MIN_CAPACITY));
        }

        this._instanceCount = writeInstanceData(
            elements,
            (id) => this._atlas.getRegion(id),
            this._instanceData,
        );
    }
}
