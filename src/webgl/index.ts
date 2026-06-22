/**
 * webgl/index.ts — Barrel export for the WebGL hybrid rendering module.
 */

// Shaders
export { VERT_SRC, FRAG_SRC } from './shaders';

// GL utilities
export {
    compileShader,
    linkProgram,
    createProgram,
    createBuffer,
    uploadTexture,
    uploadTextureSubRect,
    buildViewMatrix,
} from './glUtils';

// Texture atlas
export { TextureAtlas } from './textureAtlas';
export type { AtlasRegion, AtlasEntry, DirtyRegion, ElementRasterFn } from './textureAtlas';

// WebGL hybrid renderer
export { WebGLHybridRenderer, needsRaster, writeInstanceData, FLOATS_PER_INSTANCE } from './WebGLHybridRenderer';
export type { WebGLHybridRendererOptions } from './WebGLHybridRenderer';

// React hook
export { useWebGLHybrid } from './useWebGLHybrid';
export type { UseWebGLHybridOptions, UseWebGLHybridReturn } from './useWebGLHybrid';
