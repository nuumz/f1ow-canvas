---
name: f1ow-canvas
description: >-
  Expert development skill for the f1ow-canvas interactive drawing toolkit — a React + KonvaJS + Zustand
  library published as `<FlowCanvas>`. Covers architecture, type system, store patterns, element lifecycle,
  binding system, tool system, collaboration (CRDT/Yjs), performance optimizations, and extension patterns.
  Use this skill for ANY work on f1ow-canvas: adding features, fixing bugs, adding element types, modifying
  connectors, adjusting the tool system, store changes, collaboration work, performance tuning, export logic,
  or understanding the codebase.
argument-hint: "Describe the f1ow-canvas feature or area to work on"
metadata:
  author: phumin-k
  version: "1.0"
  project: f1ow-canvas
  stack: React 18, KonvaJS 9, Zustand 5, TypeScript strict, Vite 6
---

# f1ow-canvas — Agent Development Skill

## Project Identity

- **Name**: f1ow (npm package: `f1ow`)
- **Purpose**: Interactive canvas drawing toolkit — drop-in React component for diagrams, sketches & whiteboards
- **Stack**: React 18 + react-konva + Konva 9 + Zustand 5 + TypeScript strict + Vite 6
- **Dual mode**: Demo app (`pnpm dev` → `src/main.tsx`) and Library (`pnpm build:lib` → `dist/`)
- **Import alias**: `@/` maps to `./src/` (tsconfig paths + vite alias)
- **No CSS deps**: All UI is inline-styled React. No Tailwind, no CSS modules.

---

## Architecture Overview

```
FlowCanvas.tsx (orchestrator, ~2500 lines)
├── State: Zustand stores (useCanvasStore + useLinearEditStore)
├── Rendering: react-konva (Stage > Layer > Shape primitives)
├── Tools: tools/ (ToolHandler pattern — BaseTool.ts interface)
├── Shapes: components/shapes/ (one file per element type)
├── Canvas overlays: components/Canvas/ (Grid, Selection, ConnectionPoints, LinearHandles, Annotations)
├── UI: Toolbar, StylePanel, ContextMenu (inline-styled, themeable)
├── Utils: utils/ (connection, elbow, curve, geometry, clone, export, image, camera, performance, etc.)
├── Hooks: hooks/ (keyboard shortcuts, viewport culling, spatial index, efficient zoom, progressive render)
├── Collaboration: collaboration/ (Yjs CRDT, sync bridge, cursor overlay, worker adapter)
├── Workers: workers/ (elbow routing, SVG export — offloaded to Web Workers)
├── Rendering backends: rendering/ (tile cache/renderer), webgl/ (WebGL hybrid renderer)
└── Plugin system: utils/elementRegistry.ts (custom element type registration & validation)
```

---

## Critical: Type System (Discriminated Union)

### Element Union — ALWAYS narrow by `element.type` before accessing type-specific fields

```typescript
type CanvasElement =
  | RectangleElement  // cornerRadius
  | EllipseElement    // (no extra fields)
  | DiamondElement    // (no extra fields)
  | LineElement       // points, lineType, curvature, startBinding, endBinding
  | ArrowElement      // points, lineType, curvature, startBinding, endBinding, startArrowhead, endArrowhead
  | FreeDrawElement   // points, pressures, isComplete
  | TextElement       // text, containerId, textAlign, verticalAlign
  | ImageElement      // src, naturalWidth, naturalHeight, scaleMode, crop, cornerRadius, alt
```

### BaseElement (shared by all 8 types)

```typescript
interface BaseElement {
  id: string;           // nanoid
  type: ElementType;    // discriminator
  x, y, width, height: number;
  rotation: number;     // degrees
  style: ElementStyle;  // stroke, fill, width, opacity, strokeStyle, roughness, fontSize, fontFamily
  isLocked: boolean;
  isVisible: boolean;
  boundElements: BoundElement[] | null;  // bidirectional refs (arrows/text bound to this shape)
  groupIds?: string[];     // group hierarchy (innermost first)
  sortOrder?: string;      // CRDT fractional index for z-ordering
  _meta?: ElementMeta;     // collaboration metadata (lastModifiedBy, lastModifiedAt, version)
}
```

### Important Type Enums/Unions

| Type | Values |
|------|--------|
| `ToolType` | `select \| hand \| rectangle \| ellipse \| diamond \| line \| arrow \| freedraw \| text \| image \| eraser` |
| `ElementType` | `rectangle \| ellipse \| diamond \| line \| arrow \| freedraw \| text \| image` |
| `Arrowhead` | `arrow \| triangle \| triangle_outline \| circle \| circle_outline \| diamond \| diamond_outline \| bar \| crowfoot_one \| crowfoot_many \| crowfoot_one_or_many` |
| `LineType` | `sharp \| curved \| elbow` |
| `FreehandStyle` | `standard \| pen \| brush \| pencil` |
| `ImageScaleMode` | `fit \| fill \| stretch` |

---

## State Management — Two Zustand Stores

### 1. `useCanvasStore` (src/store/useCanvasStore.ts, ~812 lines)

Primary store — elements, selection, viewport, history, tools, grid.

**State fields:**
- `elements: CanvasElement[]` — all canvas elements
- `selectedIds: string[]` — selected element IDs
- `activeTool: ToolType` — current drawing tool
- `currentStyle: ElementStyle` — default style for new elements
- `currentLineType: LineType` — default line routing
- `currentStartArrowhead / currentEndArrowhead` — default arrowheads
- `viewport: ViewportState` — `{ x, y, scale }` (pan & zoom)
- `isDrawing: boolean`, `drawStart: Point | null` — drawing state
- `history: HistoryEntry[]`, `historyIndex: number` — diff-based undo/redo
- `showGrid: boolean`

**Key actions:**
- `addElement(el)` — validates via elementRegistry, then adds
- `updateElement(id, updates)` — validates updates, then merges
- `batchUpdateElements(updates[])` — single store write for N updates (performance!)
- `deleteElements(ids)` — cascades to bound text via containerId
- `setElements(elements)` — replaces all (validates each)
- `duplicateElements(ids)` — uses `cloneAndRemapElements`
- `convertElementType(ids, targetType)` — type conversion
- `bringToFront / sendToBack / bringForward / sendBackward` — z-ordering
- `toggleLockElements(ids)` — lock/unlock
- `groupElements(ids) / ungroupElements(ids)` — grouping
- `pushHistory(mark?)` — diff-based snapshot for undo
- `undo() / redo()` — restore from diffs
- `squashHistory(count?)` — merge continuous ops (e.g., drag)
- `pauseHistory() / resumeHistory()` — batch operations
- `zoomIn / zoomOut / resetZoom / zoomToFit / zoomToSelection` — camera

### 2. `useLinearEditStore` (src/store/useLinearEditStore.ts)

Line/arrow point editing state — active when user edits individual control points.

**State:** `elementId`, `isEditing`, `selectedPointIndices`, `hoveredPointIndex`, `hoveredMidpointIndex`, `isDraggingPoint`

### CRITICAL: State mutation rules
- **ALWAYS** use store actions — never mutate elements directly
- **ALWAYS** call `pushHistory()` after meaningful state changes
- `deleteElements()` auto-cascades to bound text (via `containerId`)
- `addElement()` and `updateElement()` validate through `elementRegistry`
- For performance-critical code (drag), use `batchUpdateElements()` — 1 array allocation vs N

---

## Binding & Connection System (utils/connection.ts)

### FixedPoint model — continuous [0-1, 0-1] coordinates on bounding box

```typescript
interface Binding {
  elementId: string;           // target shape
  fixedPoint: [number, number]; // [0-1, 0-1] on target bbox
  gap: number;                 // px gap from edge to arrow tip
  isPrecise?: boolean;         // true: edge binding, false: center-based auto-routing
}
```

**Coordinate examples:**
- `[0.5, 0]` = top center, `[1, 0.5]` = right center
- `[0, 0]` = top-left corner, `[0.3, 0.7]` = arbitrary edge position

### Bidirectional references — BOTH sides must stay in sync

1. **Connector side**: `startBinding` / `endBinding` on `ArrowElement` / `LineElement`
2. **Shape side**: `boundElements: BoundElement[]` on target shapes

**Key functions:**
- `addBoundElement(shapeId, boundEl)` — add ref to shape's boundElements
- `removeBoundElement(shapeId, boundElId)` — remove ref
- `syncBoundElements(elements, connector)` — sync both sides
- `recomputeBoundPoints(connector, allElements)` — recalculate edge attachment points
- `findConnectorsForElement(elementId, allElements)` — find all connectors bound to a shape
- `findNearestSnapTarget(pos, elements, exclude)` — snap detection during drawing
- `isConnectable(element)` — only `rectangle, ellipse, diamond, text, image` are connectable

### When modifying connections:
1. Update the `Binding` on the connector (arrow/line)
2. Update `boundElements[]` on the target shape
3. Both sides must agree — use `syncBoundElements()` after changes

---

## Tool System (src/tools/)

### Architecture: Strategy pattern via ToolHandler interface

```typescript
interface ToolHandler {
  readonly name: ToolType;
  onMouseDown(e, pos, ctx: ToolContext): void;
  onMouseMove(e, pos, ctx: ToolContext): void;
  onMouseUp(ctx: ToolContext): void;
}
```

**ToolContext** provides: elements, selectedIds, store actions, utility fns, refs, callbacks.

### Tool Registry (src/tools/toolRegistry.ts)

```
select    → SelectTool       rectangle → DrawShapeTool
ellipse   → DrawShapeTool    diamond   → DrawShapeTool
line      → LinearTool       arrow     → LinearTool
freedraw  → FreeDrawTool     text      → TextTool
image     → ImageTool        eraser    → EraserTool
hand      → NOT registered (Konva native Stage dragging)
```

### Adding a new tool — COMPLETE checklist:
1. Add type to `ToolType` union in `src/types/index.ts`
2. Add element interface extending `BaseElement` in `src/types/index.ts`
3. Add to `CanvasElement` union type
4. Create shape renderer in `src/components/shapes/`
5. Add case to `CanvasElement.tsx` switch
6. Add tool config to `TOOLS` array in `src/constants/index.ts`
7. Create `ToolHandler` in `src/tools/` and register in `toolRegistry.ts`
8. Add keyboard shortcut in `useKeyboardShortcuts.ts`
9. Export new types from `src/lib/index.ts`

---

## Shape Components (src/components/shapes/)

### Consistent props interface for ALL shapes:

```typescript
interface ShapeProps {
  element: SpecificElementType;
  isSelected: boolean;
  isGrouped?: boolean;       // disables individual drag
  onSelect: (id: string) => void;
  onChange: (id: string, updates: Partial<Element>) => void;
  onDragMove?: (id: string, updates: Partial<Element>) => void;
  onDoubleClick?: (id: string) => void;
  gridSnap?: number;
  onDragSnap?: (id, bounds) => { x, y } | null;
}
```

### Shape files:
- `RectangleShape.tsx` — Rect with cornerRadius, roughness support
- `EllipseShape.tsx` — Ellipse primitive
- `DiamondShape.tsx` — Polygon (rotated square)
- `LineShape.tsx` — Polyline with sharp/curved/elbow routing
- `ArrowShape.tsx` — Arrow with arrowheads + routing + labels
- `FreeDrawShape.tsx` — Freehand strokes with pressure-aware styles
- `TextShape.tsx` — Editable text with inline editing
- `TextLabel.tsx` — Bound text labels on connectors/shapes
- `ImageShape.tsx` — Image with fit/fill/stretch modes + crop

### CanvasElement.tsx — the switch/factory
Routes `element.type` to the correct shape component.  
Includes **LOD optimization**: at tiny viewport scale, non-selected elements degrade to colored placeholder rects or skip entirely.

---

## Line Routing — Three Modes

### 1. Sharp (`lineType: 'sharp'`)
Straight polyline segments. Points stored in flat `number[]` (x1,y1,x2,y2,...).

### 2. Curved (`lineType: 'curved'`)
Quadratic Bézier. Only start+end points stored; control point computed at render time.
- `src/utils/curve.ts` — `computeCurveControlPoint()`, `quadBezierAt()`, `quadBezierTangent()`
- Uses perpendicular offset from midpoint: `CURVE_RATIO = 0.2`
- `curvature` field on element overrides ratio

### 3. Elbow (`lineType: 'elbow'`)
Orthogonal A* routing that avoids shape bounding boxes.
- `src/utils/elbow.ts` (~1393 lines) — `computeElbowRoute()`, `computeElbowPoints()`
- Algorithm: Non-uniform grid waypoints → A* search with direction state → simplify collinear points
- Offloaded to Web Worker (`src/workers/elbowWorker.ts`) for performance
- Worker manager: `src/utils/elbowWorkerManager.ts`
- Falls back to sync (main thread) if worker unavailable

---

## History System (Undo/Redo)

### Diff-based — NOT full snapshots

```typescript
interface HistoryEntry {
  diffs: ElementDiff[];   // only what changed
  mark?: string;          // named checkpoint
  timestamp: number;      // for squash heuristics
}

interface ElementDiff {
  type: 'add' | 'modify' | 'delete';
  elementId: string;
  before?: CanvasElement;    // for modify/delete
  after?: CanvasElement;     // for add/modify
}
```

- Max 100 entries (`MAX_HISTORY`)
- Image element `src` is shared by reference (avoids duplicating large base64)
- `squashHistory(count)` merges continuous ops (drag sequences)
- `pauseHistory()` / `resumeHistory()` for batch operations

### When to push history:
- After every user-visible action COMPLETION (draw end, drag end, style change, delete)
- NOT during continuous interactions (use squash after drag sequences)
- NOT during batch internal operations (use pause/resume)

---

## Collaboration System (src/collaboration/)

### Optional — requires `yjs` + `y-websocket` (peer deps)

- **CollaborationConfig**: serverUrl, roomName, user, authToken, syncDebounceMs, awarenessThrottleMs
- **CollaborationManager**: Instance-based (supports multiple FlowCanvas instances)
- **SyncBridge**: Bidirectional Zustand ↔ Yjs sync with debouncing
- **SyncBridgeCodec**: `elementToYMap()` / `yMapToElement()` — shared serialization
- **SyncWorkerAdapter**: Offloads CRDT to Web Worker thread
- **CursorOverlay**: DOM overlay showing remote user cursors/selections
- **Awareness**: Cursor position, selection, active tool, viewport for follow-mode
- **Fractional indexing** (`utils/fractionalIndex.ts`): CRDT-compatible z-ordering
- **Operation-based history** (`utils/crdtPrep.ts`): `CanvasOperation` type for commutative ops

---

## Performance Architecture

### Viewport culling — skip off-screen elements
- `hooks/useViewportCulling.ts` — R-tree powered spatial query
- `hooks/useSpatialIndex.ts` — `SpatialIndex` (rbush) wrapper
- `utils/performance.ts` — `getVisibleBounds()`, `getElementAABB()`, `cullToViewport()`

### LOD (Level of Detail)
- `CanvasElement.tsx` — sub-pixel skip, tiny-element simplification to rects
- `hooks/useEfficientZoom.ts` — discretized zoom levels (avoids re-renders at every zoom step)

### Batched updates
- `batchUpdateElements()` — single store write for multi-element changes
- `rafThrottle()` — requestAnimationFrame-based throttling
- Microtask flushing during drag

### Progressive rendering
- `hooks/useProgressiveRender.ts` — time-sliced initial load for large canvases
- `scheduleIdleWork()`, `yieldToMain()` — idle callback scheduling

### Advanced backends (optional)
- `rendering/` — Tile-based rendering (TileCache, TileRenderer)
- `webgl/` — WebGL hybrid renderer (TextureAtlas, batch draw)

### Web Workers
- Elbow routing: `workers/elbowWorker.ts` + `utils/elbowWorkerManager.ts`
- SVG export: `workers/exportWorker.ts` + `utils/exportWorkerManager.ts`
- Worker factory: `utils/workerFactory.ts` — auto-fallback to sync mode
- Next.js compat: `contexts/WorkerConfigContext.tsx` + `workerConfig` prop

---

## Plugin / Extension System

### Element Registry (`utils/elementRegistry.ts`)

```typescript
interface CustomElementConfig<T> {
  type: string;              // unique type identifier
  displayName?: string;      // human-readable name
  validate?: (el) => true | string;  // custom field validation
  defaults?: Partial<T>;     // default values for new elements
  allowOverride?: boolean;   // replace built-in type validation
}
```

### Registration:
1. **Global**: `registerCustomElement(config)` — before any FlowCanvas renders
2. **Per-component**: `customElementTypes` prop on `<FlowCanvas>` — registered on mount

### Validation pipeline:
Every `addElement`, `updateElement`, `setElements`, `importJSON` validates through registry:
1. Base fields: `id` (non-empty string), `type` (registered), `x/y/rotation` (finite), `width/height` (≥ 0)
2. Style fields: `opacity` (0-1), `strokeWidth/fontSize` (> 0)
3. Type-specific: built-in rules + custom `validate()` callback
4. `id` and `type` changes blocked in updates (use `convertElementType` for type changes)

---

## Public API Surface — `src/lib/index.ts`

**EVERY** type, utility, and component exported from the library MUST go through `src/lib/index.ts`.

Key exports:
- Component: `FlowCanvas` (default export of `FlowCanvas.tsx`)
- Props/Ref/Theme: `FlowCanvasProps`, `FlowCanvasRef`, `FlowCanvasTheme`, `DEFAULT_THEME`
- All element types, utility types, tool types
- Store hook: `useCanvasStore`
- Constants: `DEFAULT_STYLE`, color palettes, tools config, arrowhead types
- Utilities: id, geometry, export, arrowheads, curve, connection, elbow, image, camera, performance
- Element registry: `elementRegistry`, `registerCustomElement`
- Collaboration: all types, providers, sync bridge, cursor overlay
- Rendering: tile cache/renderer, WebGL hybrid
- Workers: factory, managers

---

## File Reference — Quick Lookup

| Category | Files | Purpose |
|----------|-------|---------|
| **Core** | `src/lib/FlowCanvas.tsx` | Main orchestrator (~2500 lines) — ALL event handling |
| | `src/lib/FlowCanvasProps.ts` | Props, Ref, Theme, Context types |
| | `src/lib/index.ts` | Public API barrel export |
| **Types** | `src/types/index.ts` | ALL TypeScript types (319 lines) |
| **State** | `src/store/useCanvasStore.ts` | Primary Zustand store (812 lines) |
| | `src/store/useLinearEditStore.ts` | Linear point editing state |
| **Tools** | `src/tools/BaseTool.ts` | ToolHandler & ToolContext interfaces |
| | `src/tools/toolRegistry.ts` | Tool → handler mapping |
| | `src/tools/*.ts` | SelectTool, DrawShapeTool, LinearTool, FreeDrawTool, TextTool, ImageTool, EraserTool |
| **Shapes** | `src/components/shapes/*.tsx` | One renderer per element type (8 shapes + TextLabel) |
| **Canvas** | `src/components/Canvas/*.tsx` | Grid, SelectionBox, SelectionTransformer, ConnectionPoints, LinearHandles, Annotations |
| **UI** | `src/components/Toolbar/` | Floating toolbar |
| | `src/components/StylePanel/` | Properties panel |
| | `src/components/ContextMenu/` | Right-click menu |
| **Utils** | `src/utils/connection.ts` | FixedPoint binding system (942 lines) |
| | `src/utils/elbow.ts` | A* orthogonal routing (1393 lines) |
| | `src/utils/curve.ts` | Quadratic Bézier math |
| | `src/utils/arrowheads.ts` | 11 arrowhead variant rendering |
| | `src/utils/geometry.ts` | Math helpers |
| | `src/utils/clone.ts` | Copy/paste with ref remapping |
| | `src/utils/export.ts` | PNG, SVG, JSON export |
| | `src/utils/image.ts` | Image loading, file picker, paste/drop |
| | `src/utils/camera.ts` | Zoom, pan, animate viewport |
| | `src/utils/performance.ts` | Culling, AABB, throttling |
| | `src/utils/elementRegistry.ts` | Custom type registration & validation |
| | `src/utils/dragSync.ts` | Drag sync for bound elements |
| | `src/utils/alignment.ts` | Alignment guides |
| | `src/utils/labelMetrics.ts` | Connector label measurement |
| | `src/utils/fractionalIndex.ts` | CRDT z-ordering |
| | `src/utils/crdtPrep.ts` | Operation-based history for CRDT |
| | `src/utils/spatialIndex.ts` | R-tree spatial index |
| | `src/utils/workerFactory.ts` | Web Worker creation + fallback |
| **Hooks** | `src/hooks/useKeyboardShortcuts.ts` | Keyboard shortcut handling |
| | `src/hooks/useViewportCulling.ts` | Viewport culling |
| | `src/hooks/useSpatialIndex.ts` | Spatial index hook |
| | `src/hooks/useEfficientZoom.ts` | Discretized zoom |
| | `src/hooks/useProgressiveRender.ts` | Time-sliced rendering |
| **Collab** | `src/collaboration/CollaborationManager.ts` | Instance-based collab provider |
| | `src/collaboration/syncBridge.ts` | Zustand ↔ Yjs sync |
| | `src/collaboration/syncBridgeCodec.ts` | Element ↔ YMap serialization |
| | `src/collaboration/syncWorker.ts` | Worker-based CRDT adapter |
| | `src/collaboration/CursorOverlay.tsx` | Remote cursor rendering |
| | `src/collaboration/useCollaboration.ts` | React hook for collaboration |
| **Workers** | `src/workers/elbowWorker.ts` | Background elbow routing |
| | `src/workers/exportWorker.ts` | Background SVG export |
| **Config** | `vite.config.ts` | Build config (lib mode, worker stubs, DTS) |
| | `src/constants/index.ts` | Defaults, palettes, tool configs |

---

## Build & Validation

```bash
pnpm dev          # Vite dev server (demo app at src/main.tsx)
pnpm build:lib    # Build library → dist/ (ES + UMD + .d.ts)
pnpm typecheck    # tsc --noEmit (strict mode)
```

- Library build: `vite build --mode lib` — externals: react, react-dom, konva, react-konva, zustand, yjs, y-websocket
- nanoid, rbush, lucide-react are BUNDLED (consumers don't install these)
- Worker URLs are stubbed in lib build (consumers use `workerConfig` prop or auto-fallback)
- No test framework — validate via `pnpm typecheck` + manual testing

---

## Hard Rules — MUST follow

1. **Always use `@/` import alias** — never relative paths like `../../utils/`
2. **Always narrow `element.type`** before accessing type-specific fields
3. **Always use store actions** for mutations — never mutate element objects directly
4. **Always call `pushHistory()`** after meaningful user-visible changes
5. **Always update BOTH sides** of binding (connector + shape's boundElements)
6. **Always validate** through `elementRegistry` pipeline on add/update/import
7. **Always export** new public APIs through `src/lib/index.ts`
8. **No CSS dependencies** — use inline styles only
9. **No React Context or Redux** — only Zustand stores
10. **All drawing** via Konva primitives — never raw Canvas 2D API
11. **Image `src`** shared by reference in clones (never duplicate large base64)
12. **Keep FlowCanvas.tsx** as the central orchestrator — extract to utils/hooks for reusable logic only

---

## Common Pitfalls to Avoid

| Pitfall | Correct Approach |
|---------|-----------------|
| Accessing `element.points` without narrowing type | Check `element.type === 'line' \|\| element.type === 'arrow'` first |
| Forgetting boundElements sync after binding change | Use `syncBoundElements()` or manually update both sides |
| Creating N store updates during drag | Use `batchUpdateElements()` — single array allocation |
| Not pushing history after action | Call `pushHistory()` at action completion (not during) |
| Adding public API without lib export | Add to `src/lib/index.ts` |
| Using CSS files or Tailwind classes | Use inline styles with `FlowCanvasTheme` |
| Direct element mutation | Always go through store actions |
| Worker-dependent code without fallback | Always handle sync fallback (see `workerFactory.ts`) |
| Forgetting to handle `isLocked` elements | Check `isLocked` before allowing drag/edit/transform |
| Not handling grouped elements | Check `isGrouped` prop to disable individual drag |
