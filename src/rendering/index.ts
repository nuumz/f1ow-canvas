/**
 * rendering/index.ts — Barrel export for the tile-based rendering module.
 */

// Tile cache
export { TileCache, tileKey } from './tileCache';
export type { TileCoord } from './tileCache';

// Tile renderer
export {
    TileRenderer,
    TILE_SIZE,
    discreteZoom,
    worldTileSize,
    getVisibleTiles,
    tileBounds,
    getElementTiles,
} from './tileRenderer';
export type { TileDrawFn, TileRendererOptions } from './tileRenderer';

// React hook
export { useTileRenderer } from './useTileRenderer';
export type { UseTileRendererOptions, UseTileRendererReturn } from './useTileRenderer';
