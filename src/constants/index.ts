import type { ElementStyle, ToolType, Arrowhead, LineType } from '@/types';

// ─── Default Element Style ────────────────────────────────────
export const DEFAULT_STYLE: ElementStyle = {
    strokeColor: '#1e1e1e',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    strokeStyle: 'solid',
    roughness: 0,
    fontSize: 20,
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
};

// ─── Color Palette ────────────────────────────────────────────
export const STROKE_COLORS = [
    '#1e1e1e',
    '#e03131',
    '#2f9e44',
    '#1971c2',
    '#f08c00',
    '#6741d9',
    '#c2255c',
    '#0c8599',
    '#868e96',
];

export const FILL_COLORS = [
    'transparent',
    '#ffc9c9',
    '#b2f2bb',
    '#a5d8ff',
    '#ffec99',
    '#d0bfff',
    '#fcc2d7',
    '#99e9f2',
    '#e9ecef',
];

// ─── Stroke Widths ────────────────────────────────────────────
export const STROKE_WIDTHS = [1, 2, 3, 4, 6];

// ─── Tool List (for toolbar rendering) ────────────────────────
export interface ToolConfig {
    type: ToolType;
    label: string;
    shortcut: string;
    icon: string; // lucide icon name
}

export const TOOLS: ToolConfig[] = [
    { type: 'hand', label: 'Hand (Pan)', shortcut: 'H', icon: 'Hand' },
    { type: 'select', label: 'Select', shortcut: 'V', icon: 'MousePointer2' },
    { type: 'rectangle', label: 'Rectangle', shortcut: 'R', icon: 'Square' },
    { type: 'ellipse', label: 'Ellipse', shortcut: 'O', icon: 'Circle' },
    { type: 'diamond', label: 'Diamond', shortcut: 'D', icon: 'Diamond' },
    { type: 'line', label: 'Line', shortcut: 'L', icon: 'Minus' },
    { type: 'arrow', label: 'Arrow', shortcut: 'A', icon: 'ArrowUpRight' },
    { type: 'freedraw', label: 'Pencil', shortcut: 'P', icon: 'Pencil' },
    { type: 'text', label: 'Text', shortcut: 'T', icon: 'Type' },
    { type: 'image', label: 'Image', shortcut: 'I', icon: 'ImageIcon' },
    { type: 'eraser', label: 'Eraser', shortcut: 'E', icon: 'Eraser' },
];

// ─── Zoom ─────────────────────────────────────────────────────
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;
export const ZOOM_STEP = 0.1;

// ─── Font ─────────────────────────────────────────────────────
export const FONT_SIZES = [12, 16, 20, 24, 28, 36, 48, 64];

export const FONT_FAMILIES = [
    { label: 'Sans-serif', value: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif' },
    { label: 'Serif', value: 'Georgia, Cambria, Times New Roman, Times, serif' },
    { label: 'Monospace', value: 'SF Mono, Menlo, Consolas, Liberation Mono, monospace' },
    { label: 'Hand-drawn', value: 'Segoe Print, Comic Sans MS, cursive' },
];

// ─── Selection Shadow (used by all shape components) ─────────
export const SELECTION_SHADOW = {
    color: '#4f8df7',
    blur: 6,
    opacity: 0.5,
} as const;

// ─── Grid ─────────────────────────────────────────────────────
export const GRID_SIZE = 20;

// ─── Arrowhead Types ──────────────────────────────────────────
export interface ArrowheadConfig {
    type: Arrowhead | null;
    label: string;
    /** Small SVG-like preview character for UI */
    preview: string;
}

export const ARROWHEAD_TYPES: ArrowheadConfig[] = [
    { type: null, label: 'None', preview: '—' },
    { type: 'arrow', label: 'Arrow', preview: '▷' },
    { type: 'triangle', label: 'Triangle', preview: '▶' },
    { type: 'triangle_outline', label: 'Triangle Outline', preview: '△' },
    { type: 'circle', label: 'Circle', preview: '●' },
    { type: 'circle_outline', label: 'Circle Outline', preview: '○' },
    { type: 'diamond', label: 'Diamond', preview: '◆' },
    { type: 'diamond_outline', label: 'Diamond Outline', preview: '◇' },
    { type: 'bar', label: 'Bar', preview: '|' },
    { type: 'crowfoot_one', label: 'One', preview: '||' },
    { type: 'crowfoot_many', label: 'Many', preview: '>|' },
    { type: 'crowfoot_one_or_many', label: 'One or Many', preview: '>||' },
];

// ─── Line Types (routing) ─────────────────────────────────────
export interface LineTypeConfig {
    type: LineType;
    label: string;
    preview: string;
}

export const LINE_TYPES: LineTypeConfig[] = [
    { type: 'sharp', label: 'Sharp', preview: '╱' },
    { type: 'curved', label: 'Curved', preview: '∿' },
    { type: 'elbow', label: 'Elbow', preview: '⌐' },
];

// ─── Roughness / Sloppiness ───────────────────────────────────
export interface RoughnessConfig {
    value: number;
    label: string;
}

export const ROUGHNESS_CONFIGS: RoughnessConfig[] = [
    { value: 0, label: 'Architect' },
    { value: 1, label: 'Artist' },
    { value: 2, label: 'Cartoonist' },
];
