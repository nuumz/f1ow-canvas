import React, { useState, useRef, useEffect } from 'react';
import {
    Hand, MousePointer2, Square, Circle, Diamond,
    Minus, ArrowUpRight, Pencil, Type, Eraser,
    Undo2, Redo2, Download, Grid3x3,
    ZoomIn, ZoomOut, Maximize, Trash2,
    ImageIcon, MoreHorizontal, ChevronDown
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
    btn: (active: boolean, theme: FlowCanvasTheme, isWide?: boolean): React.CSSProperties => ({
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: isWide ? 'auto' : 34,
        padding: isWide ? '0 8px' : 0,
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

const ToolbarDropdown = ({ trigger, children, theme, title }: { trigger: React.ReactNode, children: React.ReactNode, theme: FlowCanvasTheme, title?: string }) => {
    const [isOpen, setIsOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    return (
        <div ref={ref} style={{ position: 'relative', display: 'flex' }}>
            <button
                style={s.btn(isOpen, theme, true)}
                onClick={() => setIsOpen(!isOpen)}
                title={title}
            >
                {trigger}
            </button>
            {isOpen && (
                <div style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: 8,
                    background: theme.toolbarBg,
                    border: `1px solid ${theme.toolbarBorder}`,
                    borderRadius: 8,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                    padding: 4,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    minWidth: 160,
                    zIndex: 100,
                }}>
                    <div onClick={() => setIsOpen(false)} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {children}
                    </div>
                </div>
            )}
        </div>
    );
};

const DropdownItem = ({ icon, label, onClick, disabled, theme, shortcut }: { icon: React.ReactNode, label: string, onClick: () => void, disabled?: boolean, theme: FlowCanvasTheme, shortcut?: string }) => (
    <button
        onClick={(e) => {
            if (disabled) {
                e.stopPropagation();
                return;
            }
            onClick();
        }}
        disabled={disabled}
        style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '6px 8px',
            border: 'none',
            background: 'transparent',
            color: disabled ? theme.mutedTextColor : theme.textColor,
            opacity: disabled ? 0.5 : 1,
            cursor: disabled ? 'not-allowed' : 'pointer',
            borderRadius: 4,
            textAlign: 'left',
            fontSize: 13,
            transition: 'background 150ms',
        }}
        onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = `${theme.activeToolColor}18`; }}
        onMouseLeave={(e) => { if (!disabled) e.currentTarget.style.background = 'transparent'; }}
    >
        {icon}
        <span style={{ flex: 1 }}>{label}</span>
        {shortcut && <span style={{ fontSize: 11, color: theme.mutedTextColor }}>{shortcut}</span>}
    </button>
);

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
                    style={s.btn(activeTool === tool.type, theme, false)}
                    onClick={() => setActiveTool(tool.type as ToolType)}
                    title={`${tool.label} (${tool.shortcut})`}
                >
                    {ICON_MAP[tool.icon]}
                </button>
            ))}

            <div style={s.sep(theme)} />

            {/* Zoom Dropdown */}
            <ToolbarDropdown
                theme={theme}
                title="Zoom"
                trigger={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={s.zoomText(theme)}>{Math.round(scale * 100)}%</span>
                        <ChevronDown size={14} />
                    </div>
                }
            >
                <DropdownItem theme={theme} icon={<ZoomIn size={16} />} label="Zoom In" onClick={() => zoomIn()} />
                <DropdownItem theme={theme} icon={<ZoomOut size={16} />} label="Zoom Out" onClick={() => zoomOut()} />
                <DropdownItem theme={theme} icon={<Maximize size={16} />} label="Reset Zoom" onClick={() => resetZoom()} />
            </ToolbarDropdown>

            <div style={s.sep(theme)} />

            {/* Actions Dropdown */}
            <ToolbarDropdown
                theme={theme}
                title="More Actions"
                trigger={<MoreHorizontal size={18} />}
            >
                <DropdownItem theme={theme} icon={<Undo2 size={16} />} label="Undo" shortcut="⌘Z" onClick={undo} />
                <DropdownItem theme={theme} icon={<Redo2 size={16} />} label="Redo" shortcut="⌘⇧Z" onClick={redo} />
                <div style={{ height: 1, background: theme.toolbarBorder, margin: '4px 0' }} />
                <DropdownItem theme={theme} icon={<Trash2 size={16} />} label="Delete" shortcut="Del" onClick={() => deleteElements(selectedIds)} disabled={selectedIds.length === 0} />
                <div style={{ height: 1, background: theme.toolbarBorder, margin: '4px 0' }} />
                <DropdownItem theme={theme} icon={<Grid3x3 size={16} />} label={showGrid ? "Hide Grid" : "Show Grid"} shortcut="G" onClick={toggleGrid} />
                <DropdownItem theme={theme} icon={<Download size={16} />} label="Export JSON" onClick={handleExportJSON} />
            </ToolbarDropdown>
        </div>
    );
};

export default Toolbar;
