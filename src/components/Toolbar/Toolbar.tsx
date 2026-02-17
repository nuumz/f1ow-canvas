import React from 'react';
import {
    Hand, MousePointer2, Square, Circle, Diamond,
    Minus, ArrowUpRight, Pencil, Type, Eraser,
    Undo2, Redo2, Download, Grid3x3,
    ZoomIn, ZoomOut, Maximize, Trash2,
    ImageIcon,
} from 'lucide-react';
import { useCanvasStore } from '../../store/useCanvasStore';
import type { ToolType } from '../../types';
import type { ToolConfig } from '../../constants';
import type { FlowCanvasTheme } from '../../lib/FlowCanvasProps';

const ICON_MAP: Record<string, React.ReactNode> = {
    Hand: <Hand size={18} />,
    MousePointer2: <MousePointer2 size={18} />,
    Square: <Square size={18} />,
    Circle: <Circle size={18} />,
    Diamond: <Diamond size={18} />,
    Minus: <Minus size={18} />,
    ArrowUpRight: <ArrowUpRight size={18} />,
    Pencil: <Pencil size={18} />,
    Type: <Type size={18} />,
    ImageIcon: <ImageIcon size={18} />,
    Eraser: <Eraser size={18} />,
};

// ─── Styles ─────────────────────────────────────────────────
const s = {
    bar: (theme: FlowCanvasTheme): React.CSSProperties => ({
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        background: theme.toolbarBg,
        backdropFilter: 'blur(8px)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        borderRadius: 12,
        padding: '5px 8px',
        border: `1px solid ${theme.toolbarBorder}`,
    }),
    btn: (active: boolean, theme: FlowCanvasTheme): React.CSSProperties => ({
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 34,
        height: 34,
        borderRadius: 8,
        border: 'none',
        cursor: 'pointer',
        transition: 'background 150ms, color 150ms',
        background: active ? `${theme.activeToolColor}18` : 'transparent',
        color: active ? theme.activeToolColor : theme.mutedTextColor,
        outline: active ? `1px solid ${theme.activeToolColor}40` : 'none',
    }),
    sep: (theme: FlowCanvasTheme): React.CSSProperties => ({
        width: 1,
        height: 24,
        background: theme.toolbarBorder,
        margin: '0 4px',
    }),
    zoomText: (theme: FlowCanvasTheme): React.CSSProperties => ({
        fontSize: 11,
        color: theme.mutedTextColor,
        minWidth: 40,
        textAlign: 'center',
        userSelect: 'none',
    }),
};

interface Props {
    visibleTools: ToolConfig[];
    theme: FlowCanvasTheme;
}

const Toolbar: React.FC<Props> = ({ visibleTools, theme }) => {
    // Granular selectors — only re-render when the specific slice changes
    const activeTool = useCanvasStore((s) => s.activeTool);
    const setActiveTool = useCanvasStore((s) => s.setActiveTool);
    const undo = useCanvasStore((s) => s.undo);
    const redo = useCanvasStore((s) => s.redo);
    const selectedIds = useCanvasStore((s) => s.selectedIds);
    const deleteElements = useCanvasStore((s) => s.deleteElements);
    const showGrid = useCanvasStore((s) => s.showGrid);
    const toggleGrid = useCanvasStore((s) => s.toggleGrid);
    const zoomIn = useCanvasStore((s) => s.zoomIn);
    const zoomOut = useCanvasStore((s) => s.zoomOut);
    const resetZoom = useCanvasStore((s) => s.resetZoom);
    const scale = useCanvasStore((s) => s.viewport.scale);
    const elements = useCanvasStore((s) => s.elements);

    const handleExportJSON = () => {
        const json = JSON.stringify(elements, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.download = 'canvas.json';
        a.href = url;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    return (
        <div style={s.bar(theme)}>
            {/* Drawing Tools */}
            {visibleTools.map((tool) => (
                <button
                    key={tool.type}
                    style={s.btn(activeTool === tool.type, theme)}
                    onClick={() => setActiveTool(tool.type as ToolType)}
                    title={`${tool.label} (${tool.shortcut})`}
                >
                    {ICON_MAP[tool.icon]}
                </button>
            ))}

            <div style={s.sep(theme)} />

            {/* Undo / Redo */}
            <button style={s.btn(false, theme)} onClick={undo} title="Undo (⌘Z)">
                <Undo2 size={18} />
            </button>
            <button style={s.btn(false, theme)} onClick={redo} title="Redo (⌘⇧Z)">
                <Redo2 size={18} />
            </button>

            <div style={s.sep(theme)} />

            {/* Delete */}
            <button
                style={{ ...s.btn(false, theme), opacity: selectedIds.length === 0 ? 0.3 : 1 }}
                onClick={() => deleteElements(selectedIds)}
                disabled={selectedIds.length === 0}
                title="Delete (Del)"
            >
                <Trash2 size={18} />
            </button>

            {/* Grid */}
            <button
                style={s.btn(showGrid, theme)}
                onClick={toggleGrid}
                title="Toggle Grid (G)"
            >
                <Grid3x3 size={18} />
            </button>

            <div style={s.sep(theme)} />

            {/* Zoom */}
            <button style={s.btn(false, theme)} onClick={() => zoomOut()} title="Zoom Out">
                <ZoomOut size={18} />
            </button>
            <span style={s.zoomText(theme)}>
                {Math.round(scale * 100)}%
            </span>
            <button style={s.btn(false, theme)} onClick={() => zoomIn()} title="Zoom In">
                <ZoomIn size={18} />
            </button>
            <button style={s.btn(false, theme)} onClick={() => resetZoom()} title="Reset Zoom">
                <Maximize size={18} />
            </button>

            <div style={s.sep(theme)} />

            {/* Export */}
            <button style={s.btn(false, theme)} onClick={handleExportJSON} title="Export JSON">
                <Download size={18} />
            </button>
        </div>
    );
};

export default Toolbar;
