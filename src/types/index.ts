// ─── Tool Types ───────────────────────────────────────────────
export type ToolType =
    | 'select'
    | 'hand'
    | 'rectangle'
    | 'ellipse'
    | 'diamond'
    | 'line'
    | 'arrow'
    | 'freedraw'
    | 'text'
    | 'image'
    | 'eraser';

// ─── Element Types ────────────────────────────────────────────
export type ElementType =
    | 'rectangle'
    | 'ellipse'
    | 'diamond'
    | 'line'
    | 'arrow'
    | 'freedraw'
    | 'text'
    | 'image';

// ─── Arrowhead Variants ───────────────────────────────────────
export type Arrowhead =
    | 'arrow'            // standard open-arrow ▷
    | 'triangle'         // solid filled triangle ▶
    | 'triangle_outline' // hollow triangle △
    | 'circle'           // solid circle ●
    | 'circle_outline'   // hollow circle ○
    | 'diamond'          // solid diamond ◆
    | 'diamond_outline'  // hollow diamond ◇
    | 'bar'              // vertical bar |
    | 'crowfoot_one'     // crow's foot — one  ||
    | 'crowfoot_many'    // crow's foot — many >|
    | 'crowfoot_one_or_many'; // crow's foot — one or many >||

// ─── Line Type (routing) ──────────────────────────────────────
export type LineType = 'sharp' | 'curved' | 'elbow';

// ─── Style ────────────────────────────────────────────────────
export interface ElementStyle {
    strokeColor: string;
    fillColor: string;
    strokeWidth: number;
    opacity: number;
    strokeStyle: 'solid' | 'dashed' | 'dotted';
    roughness: number;
    fontSize: number;
    fontFamily: string;
}

// ─── Base Element ─────────────────────────────────────────────
export interface BaseElement {
    id: string;
    type: ElementType;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    style: ElementStyle;
    isLocked: boolean;
    isVisible: boolean;
    /** Bidirectional refs: arrows/text bound to this element */
    boundElements: BoundElement[] | null;
    /** Group hierarchy: element belongs to these groups (innermost first, outermost last) */
    groupIds?: string[];
    /**
     * Fractional index for CRDT-compatible z-ordering.
     * When present, elements are sorted by this field instead of array position.
     * Uses lexicographic string comparison (e.g., "a0" < "a1" < "a2").
     * Generated via `generateKeyBetween()` from `utils/fractionalIndex.ts`.
     * @see {@link ../utils/fractionalIndex.ts}
     */
    sortOrder?: string;
    /**
     * Collaboration metadata for CRDT sync.
     * Optional — only populated when collaboration features are active.
     */
    _meta?: ElementMeta;
}

// ─── Element Collaboration Metadata ───────────────────────────
/**
 * Metadata for CRDT-based collaborative editing.
 * Stored alongside each element but not rendered — used for
 * conflict resolution, presence tracking, and version history.
 */
export interface ElementMeta {
    /** Unique ID of the user who last modified this element */
    lastModifiedBy?: string;
    /** Timestamp (ms since epoch) of the last modification */
    lastModifiedAt?: number;
    /** Monotonically increasing version counter */
    version?: number;
}

// ─── Operation Types (CRDT Prep) ──────────────────────────────
/**
 * Intent-based operations for CRDT-compatible history.
 * Stores the *intent* of a change rather than before/after snapshots.
 * Each operation is designed to be commutative and associative,
 * making it suitable for conflict-free replication.
 */
export type CanvasOperation =
    | { type: 'add'; element: CanvasElement }
    | { type: 'delete'; elementId: string }
    | { type: 'move'; elementId: string; dx: number; dy: number }
    | { type: 'resize'; elementId: string; width: number; height: number; x?: number; y?: number }
    | { type: 'style'; elementId: string; changes: Partial<ElementStyle> }
    | { type: 'rotate'; elementId: string; rotation: number }
    | { type: 'reorder'; elementId: string; sortOrder: string }
    | { type: 'updatePoints'; elementId: string; points: number[] }
    | { type: 'setText'; elementId: string; text: string }
    | { type: 'batch'; operations: CanvasOperation[] };

// ─── Shape Elements ───────────────────────────────────────────
export interface RectangleElement extends BaseElement {
    type: 'rectangle';
    cornerRadius: number;
}

export interface EllipseElement extends BaseElement {
    type: 'ellipse';
}

export interface DiamondElement extends BaseElement {
    type: 'diamond';
}

export interface LineElement extends BaseElement {
    type: 'line';
    points: number[];
    /** Routing type: sharp = straight segments, curved = smooth */
    lineType: LineType;
    /** Curvature ratio for curved mode (perpendicular offset / distance). Default 0.2. */
    curvature?: number;
    startBinding: Binding | null;
    endBinding: Binding | null;
}

export interface ArrowElement extends BaseElement {
    type: 'arrow';
    points: number[];
    /** Arrowhead at the start of the arrow (null = none) */
    startArrowhead: Arrowhead | null;
    /** Arrowhead at the end of the arrow (null = none) */
    endArrowhead: Arrowhead | null;
    /** @deprecated Use startArrowhead / endArrowhead. Kept for backward compat. */
    startArrow?: boolean;
    /** @deprecated Use startArrowhead / endArrowhead. Kept for backward compat. */
    endArrow?: boolean;
    /** Routing type: sharp = straight segments, curved = smooth Bézier */
    lineType: LineType;
    /** Curvature ratio for curved mode (perpendicular offset / distance). Default 0.2. */
    curvature?: number;
    startBinding: Binding | null;
    endBinding: Binding | null;
}

export interface FreeDrawElement extends BaseElement {
    type: 'freedraw';
    points: number[];
}

export type TextAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';

// ─── Image Scale Mode ─────────────────────────────────────────
export type ImageScaleMode = 'fit' | 'fill' | 'stretch';

/** Optional crop region for images (values in pixels on the original image) */
export interface ImageCrop {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface TextElement extends BaseElement {
    type: 'text';
    text: string;
    /** ID of the container shape this text is bound to (null = standalone) */
    containerId: string | null;
    /** Horizontal text alignment inside container */
    textAlign: TextAlign;
    /** Vertical text alignment inside container */
    verticalAlign: VerticalAlign;
}

export interface ImageElement extends BaseElement {
    type: 'image';
    /** Base64 data URL or external URL of the image */
    src: string;
    /** Original intrinsic width of the loaded image (px) */
    naturalWidth: number;
    /** Original intrinsic height of the loaded image (px) */
    naturalHeight: number;
    /** How the image fits inside its bounding box */
    scaleMode: ImageScaleMode;
    /** Optional crop region on the original image */
    crop: ImageCrop | null;
    /** Border radius (px) for rounded image corners */
    cornerRadius: number;
    /** Alt / label text used in SVG export and accessibility */
    alt: string;
}

// ─── Union Type ───────────────────────────────────────────────
export type CanvasElement =
    | RectangleElement
    | EllipseElement
    | DiamondElement
    | LineElement
    | ArrowElement
    | FreeDrawElement
    | TextElement
    | ImageElement;

// ─── Canvas State ─────────────────────────────────────────────
export interface Point {
    x: number;
    y: number;
}

export interface ViewportState {
    x: number;
    y: number;
    scale: number;
}

export interface SelectionBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

// ─── Connection / Binding ─────────────────────────────────────
/**
 * @deprecated Use fixedPoint binding instead. Kept for backward-compat exports.
 */
export type ConnectionAnchor = 'top' | 'bottom' | 'left' | 'right' | 'center';

/** Bidirectional reference stored on shapes to track bound connectors/text */
export type BoundElement = {
    id: string;
    type: 'arrow' | 'line' | 'text';
};

/** Describes one end of a connector (arrow/line) bound to a shape */
export interface Binding {
    /** The element this end is connected to */
    elementId: string;
    /**
     * Continuous attachment ratio [0-1, 0-1] on target's bounding box.
     * e.g. [0.5, 0] = top center, [1, 0.5] = right center, [0.3, 0.7] = arbitrary.
     */
    fixedPoint: [number, number];
    /** Gap between the edge of the shape and the arrow tip (px) */
    gap: number;
    /**
     * Whether to bind to the exact fixedPoint position, or to the shape center.
     * When false (default), the arrow connects from/to the shape's center,
     * producing cleaner visuals with auto-routed connections.
     * When true, the arrow connects to the exact fixedPoint on the shape.
     */
    isPrecise?: boolean;
}

/** Snap candidate returned while drawing */
export interface SnapTarget {
    elementId: string;
    /** Continuous attachment point ratio on target bbox */
    fixedPoint: [number, number];
    /** Computed edge-point position in world coordinates */
    position: Point;
    /**
     * Whether this snap uses precise (edge) binding or center binding.
     * Automatically determined by cursor proximity to shape edge vs center.
     * - `true`:  cursor is near the edge → attaches to that specific edge point
     * - `false`: cursor is in the center zone → attaches to center for auto-routing
     */
    isPrecise: boolean;
}

// ─── Linear Element Editor ────────────────────────────────────
/** State for editing individual points of a line/arrow element */
export interface LinearEditState {
    /** ID of the element currently being edited */
    elementId: string;
    /** Whether the editor is in full editing mode (point manipulation) */
    isEditing: boolean;
    /** Indices of currently selected points */
    selectedPointIndices: number[];
    /** Index of the point the cursor is hovering over (-1 = none) */
    hoveredPointIndex: number;
    /** Index of the midpoint the cursor is hovering over (null = none) */
    hoveredMidpointIndex: number | null;
    /** Whether a point is currently being dragged */
    isDraggingPoint: boolean;
}
