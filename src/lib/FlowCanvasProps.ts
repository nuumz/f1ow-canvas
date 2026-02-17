import type { CanvasElement, ElementStyle, ToolType } from '../types';
import type { ContextMenuItem } from '../components/ContextMenu/ContextMenu';
import type { CollaborationConfig } from '../collaboration/types';

// Re-export ContextMenuItem for consumer convenience
export type { ContextMenuItem };

// ─── Context Menu Types ───────────────────────────────────────

/** Context passed to custom context menu renderers */
export interface ContextMenuContext {
    /** IDs of currently selected elements */
    selectedIds: string[];
    /** All elements on the canvas */
    elements: CanvasElement[];
    /** Screen-space position of the right-click */
    position: { x: number; y: number };
    /** Close the context menu */
    close: () => void;
}

// ─── FlowCanvas Props API ─────────────────────────────────────
export interface FlowCanvasProps {
    /** Initial elements to render on the canvas */
    initialElements?: CanvasElement[];

    /** Controlled elements (makes the component controlled) */
    elements?: CanvasElement[];

    /** Callback when elements change */
    onChange?: (elements: CanvasElement[]) => void;

    /** Callback when selection changes */
    onSelectionChange?: (selectedIds: string[]) => void;

    /** Callback when an element is created */
    onElementCreate?: (element: CanvasElement) => void;

    /** Callback when an element is deleted */
    onElementDelete?: (ids: string[]) => void;

    /**
     * Callback when an element is double-clicked.
     * Return `true` to prevent the default behavior (create/edit bound text).
     * Return `false` or `undefined` to let the default behavior proceed.
     */
    onElementDoubleClick?: (elementId: string, element: CanvasElement) => boolean | void;

    /** Width of the canvas (default: 100% of container) */
    width?: number | string;

    /** Height of the canvas (default: 100% of container) */
    height?: number | string;

    /** Which tools to display in toolbar */
    tools?: ToolType[];

    /** Default drawing style */
    defaultStyle?: Partial<ElementStyle>;

    /** Show/hide the toolbar */
    showToolbar?: boolean;

    /** Show/hide the style panel */
    showStylePanel?: boolean;

    /** Show/hide the status bar */
    showStatusBar?: boolean;

    /** Show grid by default */
    showGrid?: boolean;

    /** Enable keyboard shortcuts */
    enableShortcuts?: boolean;

    /** Theme customization */
    theme?: Partial<FlowCanvasTheme>;

    /** Readonly mode — disable editing */
    readOnly?: boolean;

    /** Additional CSS class for the root container */
    className?: string;

    // ─── Context Menu Customization ───────────────────────────

    /**
     * Additional context menu items to append after the built-in items.
     * Can be static items or a function that receives selection context.
     */
    contextMenuItems?: ContextMenuItem[] | ((ctx: ContextMenuContext) => ContextMenuItem[]);

    /**
     * Completely replace the built-in context menu with a custom renderer.
     * When provided, the built-in context menu is NOT shown.
     * Return a React element to render as the context menu.
     */
    renderContextMenu?: (ctx: ContextMenuContext) => React.ReactNode;

    // ─── Collaboration ────────────────────────────────────────

    /**
     * Enable real-time CRDT collaboration.
     * Pass a `CollaborationConfig` to connect, or `undefined`/`null` to disable.
     */
    collaboration?: CollaborationConfig | null;

    // ─── Worker Configuration ─────────────────────────────────

    /**
     * Configure Web Workers for background processing (elbow routing, SVG export).
     *
     * **Why this is needed:**
     * - f1ow-canvas uses Web Workers for performance-intensive operations
     * - Vite bundles workers as separate files in `/assets/` directory
     * - Next.js and other bundlers cannot resolve these paths automatically
     *
     * **Options:**
     * 1. **Auto mode (default)**: Workers enabled in Vite, auto-fallback in Next.js
     * 2. **Disabled mode**: Set `workerConfig.disabled = true` to force sync mode
     * 3. **Custom URLs**: Provide worker file URLs for Next.js (see below)
     *
     * **For Next.js users:**
     * Copy worker files from `node_modules/f1ow-canvas/dist/assets/` to your
     * `public/workers/` directory, then configure:
     *
     * ```tsx
     * <FlowCanvas
     *   workerConfig={{
     *     elbowWorkerUrl: '/workers/elbowWorker.js',
     *     exportWorkerUrl: '/workers/exportWorker.js'
     *   }}
     * />
     * ```
     *
     * If omitted or workers fail to load, f1ow-canvas automatically falls back
     * to synchronous (main-thread) processing.
     */
    workerConfig?: {
        /** Custom URL for elbow routing worker (Next.js users) */
        elbowWorkerUrl?: string;
        /** Custom URL for SVG export worker (Next.js users) */
        exportWorkerUrl?: string;
        /** Disable all workers (force sync mode) */
        disabled?: boolean;
    };
}

// ─── Theme ────────────────────────────────────────────────────
export interface FlowCanvasTheme {
    /** Canvas background color */
    canvasBackground: string;
    /** Grid line color */
    gridColor: string;
    /** Selection highlight color */
    selectionColor: string;
    /** Toolbar background */
    toolbarBg: string;
    /** Toolbar border color */
    toolbarBorder: string;
    /** Panel background */
    panelBg: string;
    /** Active tool highlight */
    activeToolColor: string;
    /** Text color */
    textColor: string;
    /** Muted text color */
    mutedTextColor: string;
}

export const DEFAULT_THEME: FlowCanvasTheme = {
    canvasBackground: '#f8f9fa',
    gridColor: '#e5e5e5',
    selectionColor: '#4f8df7',
    toolbarBg: 'rgba(255, 255, 255, 0.95)',
    toolbarBorder: '#e5e7eb',
    panelBg: 'rgba(255, 255, 255, 0.95)',
    activeToolColor: '#4f46e5',
    textColor: '#374151',
    mutedTextColor: '#9ca3af',
};

// ─── Imperative Handle (ref) ──────────────────────────────────
export interface FlowCanvasRef {
    /** Get current elements */
    getElements: () => CanvasElement[];
    /** Set elements programmatically */
    setElements: (elements: CanvasElement[]) => void;
    /** Add a single element */
    addElement: (element: CanvasElement) => void;
    /** Delete elements by ids */
    deleteElements: (ids: string[]) => void;
    /** Get selected element ids */
    getSelectedIds: () => string[];
    /** Select elements by ids */
    setSelectedIds: (ids: string[]) => void;
    /** Clear selection */
    clearSelection: () => void;
    /** Set active tool */
    setActiveTool: (tool: ToolType) => void;
    /** Get active tool */
    getActiveTool: () => ToolType;
    /** Undo last action */
    undo: () => void;
    /** Redo last undone action */
    redo: () => void;
    /** Zoom to a specific scale */
    zoomTo: (scale: number) => void;
    /** Reset zoom and position */
    resetView: () => void;
    /**
     * Scroll and zoom the viewport to center a specific element.
     * Optionally specify a zoom level (defaults to current zoom, clamped to at least 1).
     */
    scrollToElement: (id: string, options?: { zoom?: number; animate?: boolean }) => void;
    /**
     * Zoom the viewport to fit all elements (or a subset) within the visible area.
     * Pass element IDs to fit only those elements; omit to fit all.
     */
    zoomToFit: (ids?: string[], options?: { padding?: number; maxZoom?: number; animate?: boolean }) => void;
    /** Export canvas as PNG data URL */
    exportPNG: () => string | null;
    /** Export elements as JSON string */
    exportJSON: () => string;
    /** Export elements as SVG string */
    exportSVG: () => string;
    /** Import elements from JSON string */
    importJSON: (json: string) => void;
    /** Get the Konva Stage instance */
    getStage: () => unknown;
}
