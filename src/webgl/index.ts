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
    buildViewMatrix,
} from './glUtils';

// Texture atlas
export { TextureAtlas } from './textureAtlas';
export type { AtlasRegion, AtlasEntry, ElementRasterFn } from './textureAtlas';

// WebGL hybrid renderer
export { WebGLHybridRenderer } from './WebGLHybridRenderer';
export type { WebGLHybridRendererOptions } from './WebGLHybridRenderer';

// React hook
export { useWebGLHybrid } from './useWebGLHybrid';
export type { UseWebGLHybridOptions, UseWebGLHybridReturn } from './useWebGLHybrid';
