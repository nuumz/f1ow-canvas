// ─── f1ow-canvas: Interactive canvas drawing toolkit built on KonvaJS ──

// Main component
export { default as FlowCanvas } from './FlowCanvas';

// Types (props, ref, theme, context menu)
export type {
    FlowCanvasProps,
    FlowCanvasRef,
    FlowCanvasTheme,
    ContextMenuItem,
    ContextMenuContext,
} from './FlowCanvasProps';
export { DEFAULT_THEME } from './FlowCanvasProps';

// Annotation types (for renderAnnotation prop)
export type {
    AnnotationContext,
    AnnotationScreenBounds,
    RenderAnnotationFn,
} from '../components/Canvas/AnnotationsOverlay';

// Element types
export type {
    CanvasElement,
    RectangleElement,
    EllipseElement,
    DiamondElement,
    LineElement,
    ArrowElement,
    FreeDrawElement,
    TextElement,
    ImageElement,
    BaseElement,
    ElementStyle,
    ElementType,
    ToolType,
    Point,
    ViewportState,
    ConnectionAnchor,
    BoundElement,
    Binding,
    SnapTarget,
    Arrowhead,
    LineType,
    TextAlign,
    VerticalAlign,
    ImageScaleMode,
    ImageCrop,
    ElementMeta,
    CanvasOperation,
} from '../types';

// Store hook (for advanced usage)
export { useCanvasStore } from '../store/useCanvasStore';

// Constants
export { DEFAULT_STYLE, STROKE_COLORS, FILL_COLORS, STROKE_WIDTHS, TOOLS, ARROWHEAD_TYPES, LINE_TYPES, ROUGHNESS_CONFIGS } from '../constants';

// Utilities
export { generateId } from '../utils/id';
export { distance, normalizeRect, rotatePoint, isPointInRect, getDiamondPoints, getStrokeDash } from '../utils/geometry';
export { exportToDataURL, downloadPNG, exportToJSON, downloadJSON, exportToSVG, downloadSVG } from '../utils/export';
export { drawArrowhead, arrowheadSize, flatToPoints } from '../utils/arrowheads';
export { computeCurveControlPoint, quadBezierAt, quadBezierTangent, curveArrowPrev, CURVE_RATIO } from '../utils/curve';

// Label metrics — shared constants & measurement for connector labels
export { LABEL_PADDING_H, LABEL_PADDING_V, LABEL_CORNER, LABEL_LINE_HEIGHT, LABEL_MIN_WIDTH, measureLabelText, computePillSize } from '../utils/labelMetrics';

// Element registry — custom type registration & validation
export { elementRegistry, registerCustomElement } from '../utils/elementRegistry';
export type { CustomElementConfig, ValidationResult } from '../utils/elementRegistry';

// Elbow routing utilities
export {
    computeElbowPoints,
    computeElbowRoute,
    simplifyElbowPath,
    clearElbowRouteCache,
    directionFromFixedPoint,
    directionFromPoints,
    directionFromShapeToPoint,
    directionFromEdgePoint,
    getElbowPreferredDirection,
} from '../utils/elbow';
export type { Direction } from '../utils/elbow';
export {
    getConnectionPoints,
    getEdgePoint,
    getEdgePointFromFixedPoint,
    computeFixedPoint,
    getAnchorPosition,
    findNearestSnapTarget,
    isConnectable,
    recomputeBoundPoints,
    findConnectorsForElement,
    addBoundElement,
    removeBoundElement,
    syncBoundElements,
} from '../utils/connection';

// Image utilities
export {
    fileToDataURL,
    loadImage,
    computeImageElementDimensions,
    createImageElement,
    getImageFilesFromDataTransfer,
    extractImageDataFromClipboard,
    clipboardHasImage,
    resolveImageSource,
    openImageFilePicker,
} from '../utils/image';

// Performance utilities
export {
    getVisibleBounds,
    getElementAABB,
    aabbOverlaps,
    cullToViewport,
    buildElementMap,
    cloneElementsForHistory,
    rafThrottle,
    batchElementUpdates,
} from '../utils/performance';
export type { AABB } from '../utils/performance';

// Efficient zoom (LOD / discretised zoom levels)
export { computeEfficientZoom, useEfficientZoom } from '../hooks/useEfficientZoom';

// Spatial index (R-tree powered viewport culling & hit testing)
export { SpatialIndex, getSharedSpatialIndex, elementToSpatialItem } from '../utils/spatialIndex';
export type { SpatialItem } from '../utils/spatialIndex';

// Elbow routing Worker manager
export { getElbowWorkerManager, disposeElbowWorkerManager } from '../utils/elbowWorkerManager';
export type { RouteParams } from '../utils/elbowWorkerManager';

// Worker factory and configuration (Next.js compatibility)
export { createWorker, isWorkerSupported } from '../utils/workerFactory';
export type { WorkerConfig } from '../utils/workerFactory';
export { WorkerConfigContext, useWorkerConfig } from '../contexts/WorkerConfigContext';
export type { WorkerConfigContextValue } from '../contexts/WorkerConfigContext';

// Camera / viewport utilities
export {
    zoomAtPoint,
    getNextZoomStep,
    getPrevZoomStep,
    getElementsBounds,
    computeZoomToFit,
    animateViewport,
    cancelViewportAnimation,
    ZOOM_STEPS,
    DEFAULT_ANIMATION_DURATION,
} from '../utils/camera';
export type { ZoomAtPointOptions, ZoomToFitOptions } from '../utils/camera';

// Tool system
export { getToolHandler } from '../tools';
export type { ToolHandler, ToolContext } from '../tools';

// ─── Phase 3: Advanced Optimizations ──────────────────────────

// SoA parallel views (cache-friendly spatial queries)
export { SpatialSoA, getSharedSpatialSoA, ELEMENT_TYPE_MAP } from '../utils/spatialSoA';
export type { SpatialSoAData } from '../utils/spatialSoA';

// Progressive rendering (time-sliced initial load)
export { useProgressiveRender, scheduleIdleWork, yieldToMain } from '../hooks/useProgressiveRender';
export type { UseProgressiveRenderOptions, ProgressiveRenderState } from '../hooks/useProgressiveRender';

// Export Worker (background SVG export)
export { getExportWorkerManager, disposeExportWorkerManager, ExportWorkerManager } from '../utils/exportWorkerManager';

// Fractional indexing (CRDT-compatible z-ordering)
export {
    generateKeyBetween,
    generateNKeysBetween,
    isValidFractionalIndex,
    compareFractionalKeys,
} from '../utils/fractionalIndex';

// CRDT structural prep (operation-based history)
export {
    OperationLog,
    opAdd,
    opDelete,
    opMove,
    opResize,
    opStyle,
    opRotate,
    opReorder,
    opUpdatePoints,
    opSetText,
    opBatch,
    applyOperation,
    detectOperations,
} from '../utils/crdtPrep';
export type { OperationEntry } from '../utils/crdtPrep';

// ─── Phase 4: CRDT Real-Time Collaboration (Yjs) ─────────────

// Collaboration types
export type {
    CollaborationUser,
    AwarenessState,
    CollaborationConfig,
    ConnectionStatus,
    CollaborationEvent,
} from '../collaboration/types';

// Collaboration provider management (legacy singleton API)
export {
    createCollaborationProvider,
    destroyCollaborationProvider,
    getYDoc,
    getYProvider,
    getYElements,
    isCollaborationActive,
    onStatusChange,
    updateAwareness,
    getRemoteAwareness,
} from '../collaboration/yjsProvider';

// Sync bridge (legacy singleton API)
export { startSync, stopSync } from '../collaboration/syncBridge';

// Sync codec (shared serialization for Yjs ↔ CanvasElement)
export { elementToYMap, yMapToElement, SYNC_FIELDS, STYLE_FIELDS } from '../collaboration/syncBridgeCodec';

// Instance-based collaboration manager (supports multiple FlowCanvas instances)
export { CollaborationManager } from '../collaboration/CollaborationManager';

// Web Worker-based sync adapter (offloads CRDT to worker thread)
export { SyncWorkerAdapter } from '../collaboration/syncWorker';
export type { WorkerInMessage, WorkerOutMessage, SyncWorkerCallbacks } from '../collaboration/syncWorker';

// React hook
export { useCollaboration } from '../collaboration/useCollaboration';
export type { UseCollaborationReturn } from '../collaboration/useCollaboration';

// Cursor overlay component
export { default as CursorOverlay } from '../collaboration/CursorOverlay';

// ─── Phase 4: Tile-Based Rendering ───────────────────────────

// Tile cache
export { TileCache, tileKey } from '../rendering/tileCache';
export type { TileCoord } from '../rendering/tileCache';

// Tile renderer
export {
    TileRenderer,
    TILE_SIZE,
    discreteZoom,
    worldTileSize,
    getVisibleTiles,
    tileBounds,
    getElementTiles,
} from '../rendering/tileRenderer';
export type { TileDrawFn, TileRendererOptions } from '../rendering/tileRenderer';

// Tile renderer hook
export { useTileRenderer } from '../rendering/useTileRenderer';
export type { UseTileRendererOptions, UseTileRendererReturn } from '../rendering/useTileRenderer';

// ─── Phase 4: WebGL Hybrid Rendering ─────────────────────────

// Texture atlas
export { TextureAtlas } from '../webgl/textureAtlas';
export type { AtlasRegion, AtlasEntry, ElementRasterFn } from '../webgl/textureAtlas';

// WebGL hybrid renderer
export { WebGLHybridRenderer } from '../webgl/WebGLHybridRenderer';
export type { WebGLHybridRendererOptions } from '../webgl/WebGLHybridRenderer';

// GL utilities
export { buildViewMatrix } from '../webgl/glUtils';

// React hook
export { useWebGLHybrid } from '../webgl/useWebGLHybrid';
export type { UseWebGLHybridOptions, UseWebGLHybridReturn } from '../webgl/useWebGLHybrid';
