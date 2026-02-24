import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
    Hand, MousePointer2, Square, Circle, Diamond,
    Minus, ArrowUpRight, ArrowUp, ArrowDown,
    Pencil, Eraser,
    Type, StickyNote, ImageIcon,
    Undo2, Redo2, Download, Grid3x3,
    ZoomIn, ZoomOut, Maximize, Trash2,
    ChevronUp, ChevronDown, Copy,
    MoreHorizontal,
    AlignLeft, AlignCenter, AlignRight,
    AlignStartVertical, AlignCenterVertical, AlignEndVertical,
    ChevronsUp, ChevronsDown,
    RotateCcw, RotateCw, FlipHorizontal, FlipVertical,
    Group, Ungroup, Lock, Unlock,
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
    StickyNote: <StickyNote size={18} />,
};

interface Props {
    visibleTools: ToolConfig[];
    theme: FlowCanvasTheme;
    position?: 'top' | 'bottom';
}

interface SubToolAction {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
}

interface ShapeItem {
    icon: React.ReactNode;
    label: string;
    tool: ToolType | null; // null = not yet implemented
}

// ─── Style helpers ────────────────────────────────────────────
const mkBtnStyle = (
    active: boolean,
    theme: FlowCanvasTheme,
    disabled?: boolean,
): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 34,
    borderRadius: 8,
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background 150ms, color 150ms',
    background: active ? `${theme.activeToolColor}20` : 'transparent',
    color: active ? theme.activeToolColor : disabled ? `${theme.mutedTextColor}55` : theme.mutedTextColor,
    outline: active ? `1.5px solid ${theme.activeToolColor}50` : 'none',
    flexShrink: 0,
    opacity: disabled ? 0.45 : 1,
});

const mkSepStyle = (theme: FlowCanvasTheme): React.CSSProperties => ({
    width: 1, height: 22,
    background: theme.toolbarBorder,
    margin: '0 3px', flexShrink: 0,
});

const mkBarStyle = (theme: FlowCanvasTheme): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 1,
    background: theme.toolbarBg,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    boxShadow: '0 2px 10px rgba(0,0,0,0.08)',
    borderRadius: 12,
    padding: '5px 8px',
    border: `1px solid ${theme.toolbarBorder}`,
});

// ─── useAnchoredPos — live-recalculate portal position on resize/scroll ──────
function useAnchoredPos(
    anchorRef: React.RefObject<Element | null>,
    compute: (rect: DOMRect) => { top: number; left: number },
    enabled: boolean,
): { top: number; left: number } | null {
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const computeRef = useRef(compute);
    computeRef.current = compute;

    const recalc = useCallback(() => {
        if (anchorRef.current) {
            setPos(computeRef.current(anchorRef.current.getBoundingClientRect()));
        }
    }, [anchorRef]);

    useEffect(() => {
        if (!enabled) { setPos(null); return; }
        recalc();
        window.addEventListener('resize', recalc);
        window.addEventListener('scroll', recalc, true);
        return () => {
            window.removeEventListener('resize', recalc);
            window.removeEventListener('scroll', recalc, true);
        };
    }, [enabled, recalc]);

    return pos;
}

// ─── Shared Popup Component ───────────────────────────────────
const ToolbarPopup: React.FC<{
    anchorRef: React.RefObject<HTMLElement | null>;
    onClose: () => void;
    theme: FlowCanvasTheme;
    placement: 'top' | 'bottom';
    computePos: (rect: DOMRect, placement: 'top' | 'bottom') => { top: number; left: number };
    transform: string;
    dataAttribute: string;
    style?: React.CSSProperties;
    children: React.ReactNode;
    isOpen: boolean;
}> = ({ anchorRef, onClose, theme, placement, computePos, transform, dataAttribute, style, children, isOpen }) => {
    const pos = useAnchoredPos(anchorRef, (r) => computePos(r, placement), isOpen);

    useEffect(() => {
        if (!isOpen) return;
        const handle = (e: MouseEvent) => {
            if (anchorRef.current && anchorRef.current.contains(e.target as Node)) return;
            if (!(e.target as Element).closest(`[${dataAttribute}]`)) onClose();
        };
        const handleResize = () => onClose();
        document.addEventListener('mousedown', handle);
        window.addEventListener('resize', handleResize);
        return () => {
            document.removeEventListener('mousedown', handle);
            window.removeEventListener('resize', handleResize);
        };
    }, [isOpen, onClose, dataAttribute, anchorRef]);

    if (!isOpen || !pos) return null;

    return createPortal(
        <div
            {...{ [dataAttribute]: "true" }}
            style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                transform,
                background: theme.toolbarBg,
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                border: `1px solid ${theme.toolbarBorder}`,
                borderRadius: 12,
                boxShadow: '0 8px 28px rgba(0,0,0,0.12)',
                zIndex: 9999,
                ...style,
            }}
        >
            {children}
        </div>,
        document.body
    );
};

// ─── Shared Popup Icon Button ─────────────────────────────────
const PopupIconButton: React.FC<{
    icon: React.ReactNode;
    label: string;
    disabled?: boolean;
    isActive?: boolean;
    onClick: () => void;
    theme: FlowCanvasTheme;
    size?: number;
}> = ({ icon, label, disabled, isActive, onClick, theme, size = 36 }) => {
    return (
        <button
            title={label}
            disabled={disabled}
            onClick={disabled ? undefined : onClick}
            style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: size, height: size, borderRadius: 8,
                border: `1px solid ${isActive ? `${theme.activeToolColor}50` : 'transparent'}`,
                background: isActive ? `${theme.activeToolColor}18` : 'transparent',
                cursor: disabled ? 'default' : 'pointer',
                color: isActive
                    ? theme.activeToolColor
                    : disabled
                        ? `${theme.mutedTextColor}55`
                        : theme.mutedTextColor,
                opacity: disabled ? 0.4 : 1,
                transition: 'background 120ms, color 120ms, border-color 120ms',
            }}
            onMouseEnter={(e) => {
                if (!disabled && !isActive) {
                    e.currentTarget.style.background = `${theme.activeToolColor}14`;
                    e.currentTarget.style.color = theme.activeToolColor;
                    e.currentTarget.style.borderColor = `${theme.activeToolColor}30`;
                }
            }}
            onMouseLeave={(e) => {
                if (!isActive) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = disabled ? `${theme.mutedTextColor}55` : theme.mutedTextColor;
                    e.currentTarget.style.borderColor = 'transparent';
                }
            }}
        >
            {icon}
        </button>
    );
};

// ─── Sub-tools popup (grid) ───────────────────────────────────
const SubToolsPopup: React.FC<{
    actions: SubToolAction[];
    anchorRef: React.RefObject<HTMLButtonElement | null>;
    onClose: () => void;
    theme: FlowCanvasTheme;
    placement?: 'top' | 'bottom';
}> = ({ actions, anchorRef, onClose, theme, placement = 'bottom' }) => {
    return (
        <ToolbarPopup
            isOpen={true}
            anchorRef={anchorRef}
            onClose={onClose}
            theme={theme}
            placement={placement}
            computePos={(r, p) => p === 'top'
                ? { top: r.bottom + 8, left: r.left + r.width / 2 }
                : { top: r.top - 12, left: r.left + r.width / 2 }
            }
            transform={placement === 'top' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)'}
            dataAttribute="data-subtools-popup"
            style={{
                padding: 8,
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 36px)',
                gap: 4,
            }}
        >
            {actions.map((action, i) => (
                <PopupIconButton
                    key={i}
                    icon={action.icon}
                    label={action.label}
                    disabled={action.disabled}
                    onClick={() => { action.onClick(); onClose(); }}
                    theme={theme}
                />
            ))}
        </ToolbarPopup>
    );
};

// ─── Shape picker popup ────────────────────────────────────────
const ShapePickerPopup: React.FC<{
    shapes: ShapeItem[];
    activeTool: ToolType;
    anchorRef: React.RefObject<HTMLButtonElement | null>;
    onSelect: (tool: ToolType) => void;
    onClose: () => void;
    theme: FlowCanvasTheme;
    placement?: 'top' | 'bottom';
}> = ({ shapes, activeTool, anchorRef, onSelect, onClose, theme, placement = 'bottom' }) => {
    return (
        <ToolbarPopup
            isOpen={true}
            anchorRef={anchorRef}
            onClose={onClose}
            theme={theme}
            placement={placement}
            computePos={(r, p) => p === 'top'
                ? { top: r.bottom + 8, left: r.right }
                : { top: r.top - 12, left: r.right }
            }
            transform={placement === 'top' ? 'translate(-100%, 0)' : 'translate(-100%, -100%)'}
            dataAttribute="data-shape-picker"
            style={{
                padding: 8,
                display: 'grid',
                gridTemplateColumns: 'repeat(5, 40px)',
                gap: 4,
            }}
        >
            {shapes.filter(s => s.tool !== null).map((shape, i) => (
                <PopupIconButton
                    key={i}
                    icon={shape.icon}
                    label={shape.label}
                    disabled={shape.tool === null}
                    isActive={shape.tool !== null && activeTool === shape.tool}
                    onClick={() => {
                        if (shape.tool) {
                            onSelect(shape.tool);
                            onClose();
                        }
                    }}
                    theme={theme}
                    size={40}
                />
            ))}
        </ToolbarPopup>
    );
};

// ─── Zoom picker ──────────────────────────────────────────────
const ZoomPicker: React.FC<{
    scale: number; theme: FlowCanvasTheme;
    onZoomIn: () => void; onZoomOut: () => void; onReset: () => void;
    placement?: 'top' | 'bottom';
}> = ({ scale, theme, onZoomIn, onZoomOut, onReset, placement = 'bottom' }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    return (
        <div ref={ref} style={{ position: 'relative' }}>
            <button
                style={{ ...mkBtnStyle(open, theme), width: 'auto', padding: '0 6px', gap: 2, fontSize: 11, minWidth: 52 }}
                onClick={() => setOpen(!open)}
                title="Zoom"
            >
                <span style={{ minWidth: 32, textAlign: 'center', userSelect: 'none' }}>
                    {Math.round(scale * 100)}%
                </span>
                <ChevronDown size={12} />
            </button>
            <ToolbarPopup
                isOpen={open}
                anchorRef={ref}
                onClose={() => setOpen(false)}
                theme={theme}
                placement={placement}
                computePos={(r, p) => p === 'top'
                    ? { top: r.bottom + 6, left: r.left }
                    : { top: r.top - 6, left: r.left }
                }
                transform={placement === 'top' ? 'translateY(0)' : 'translateY(-100%)'}
                dataAttribute="data-zoom-dropdown"
                style={{
                    padding: 4, minWidth: 130,
                }}
            >
                {[
                    { icon: <ZoomIn size={14} />, label: 'Zoom In', fn: () => { onZoomIn(); setOpen(false); } },
                    { icon: <ZoomOut size={14} />, label: 'Zoom Out', fn: () => { onZoomOut(); setOpen(false); } },
                    { icon: <Maximize size={14} />, label: 'Reset Zoom', fn: () => { onReset(); setOpen(false); } },
                ].map(({ icon, label, fn }) => (
                    <button key={label} onClick={fn}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            width: '100%', padding: '6px 8px', border: 'none',
                            background: 'transparent', color: theme.textColor,
                            cursor: 'pointer', borderRadius: 4, fontSize: 12,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = `${theme.activeToolColor}14`; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                        {icon}<span>{label}</span>
                    </button>
                ))}
            </ToolbarPopup>
        </div>
    );
};

// ─── Main Toolbar ─────────────────────────────────────────────
const Toolbar: React.FC<Props> = ({ visibleTools, theme, position = 'bottom' }) => {
    const activeTool         = useCanvasStore((s) => s.activeTool);
    const setActiveTool      = useCanvasStore((s) => s.setActiveTool);
    const undo               = useCanvasStore((s) => s.undo);
    const redo               = useCanvasStore((s) => s.redo);
    const selectedIds        = useCanvasStore((s) => s.selectedIds);
    const elements           = useCanvasStore((s) => s.elements);
    const deleteElements     = useCanvasStore((s) => s.deleteElements);
    const duplicateElements  = useCanvasStore((s) => s.duplicateElements);
    const bringToFront       = useCanvasStore((s) => s.bringToFront);
    const bringForward       = useCanvasStore((s) => s.bringForward);
    const sendBackward       = useCanvasStore((s) => s.sendBackward);
    const sendToBack         = useCanvasStore((s) => s.sendToBack);
    const toggleLockElements = useCanvasStore((s) => s.toggleLockElements);
    const ungroupElements    = useCanvasStore((s) => s.ungroupElements);
    const pushHistory        = useCanvasStore((s) => s.pushHistory);
    const showGrid           = useCanvasStore((s) => s.showGrid);
    const toggleGrid         = useCanvasStore((s) => s.toggleGrid);
    const zoomIn             = useCanvasStore((s) => s.zoomIn);
    const zoomOut            = useCanvasStore((s) => s.zoomOut);
    const resetZoom          = useCanvasStore((s) => s.resetZoom);
    const scale              = useCanvasStore((s) => s.viewport.scale);

    // ⋯ button → sub-tools (align/layer/transform)
    const [showMoreTools, setShowMoreTools] = useState(false);
    const moreRef = useRef<HTMLButtonElement>(null);

    // ^ button → shape picker
    const [showShapePicker, setShowShapePicker] = useState(false);
    const chevronRef = useRef<HTMLButtonElement>(null);

    const hasSelection      = selectedIds.length > 0;
    const hasMultiSelection = selectedIds.length > 1;
    const isLocked = hasSelection && elements.filter(e => selectedIds.includes(e.id)).every(e => e.isLocked);

    const handleExportJSON = () => {
        const blob = new Blob([JSON.stringify(elements, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), { href: url, download: 'canvas.json' });
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
    };

    const subTools: SubToolAction[] = [
        // Row 1 – Align H
        { icon: <AlignLeft size={16} />,           label: 'Align Left',     disabled: !hasMultiSelection, onClick: () => {} },
        { icon: <AlignCenter size={16} />,         label: 'Align Center H', disabled: !hasMultiSelection, onClick: () => {} },
        { icon: <AlignRight size={16} />,          label: 'Align Right',    disabled: !hasMultiSelection, onClick: () => {} },
        { icon: <AlignCenterVertical size={16} />, label: 'Align Center V', disabled: !hasMultiSelection, onClick: () => {} },
        // Row 2 – Align V
        { icon: <AlignStartVertical size={16} />,  label: 'Align Top',    disabled: !hasMultiSelection, onClick: () => {} },
        { icon: <AlignEndVertical size={16} />,    label: 'Align Bottom', disabled: !hasMultiSelection, onClick: () => {} },
        { icon: <FlipHorizontal size={16} />,      label: 'Flip H',       disabled: !hasSelection, onClick: () => {} },
        { icon: <FlipVertical size={16} />,        label: 'Flip V',       disabled: !hasSelection, onClick: () => {} },
        // Row 3 – Layers
        { icon: <ChevronsUp size={16} />,   label: 'Bring to Front', disabled: !hasSelection, onClick: () => { bringToFront(selectedIds); pushHistory(); } },
        { icon: <ArrowUp size={16} />,      label: 'Bring Forward',  disabled: !hasSelection, onClick: () => { bringForward(selectedIds); pushHistory(); } },
        { icon: <ArrowDown size={16} />,    label: 'Send Backward',  disabled: !hasSelection, onClick: () => { sendBackward(selectedIds); pushHistory(); } },
        { icon: <ChevronsDown size={16} />, label: 'Send to Back',   disabled: !hasSelection, onClick: () => { sendToBack(selectedIds); pushHistory(); } },
        // Row 4 – Transform
        { icon: <RotateCcw size={16} />,                                               label: 'Rotate Left 90°',  disabled: !hasSelection, onClick: () => {} },
        { icon: <RotateCw size={16} />,                                                label: 'Rotate Right 90°', disabled: !hasSelection, onClick: () => {} },
        { icon: isLocked ? <Unlock size={16} /> : <Lock size={16} />,                 label: isLocked ? 'Unlock' : 'Lock', disabled: !hasSelection, onClick: () => { toggleLockElements(selectedIds); pushHistory(); } },
        { icon: <Ungroup size={16} />,                                                 label: 'Ungroup',          disabled: !hasSelection, onClick: () => { ungroupElements(selectedIds); pushHistory(); } },
        // Row 5 – Canvas
        { icon: <Grid3x3 size={16} />,  label: showGrid ? 'Hide Grid' : 'Show Grid', disabled: false, onClick: toggleGrid },
        { icon: <Download size={16} />, label: 'Export JSON',                         disabled: false, onClick: handleExportJSON },
        { icon: <Maximize size={16} />, label: 'Reset Zoom',                          disabled: false, onClick: resetZoom },
        { icon: <Group size={16} />,    label: 'Select All',                          disabled: false, onClick: () => {} },
    ];

    // Shape picker: only available (implemented) tools, excluding tools already in main bar
    const shapes: ShapeItem[] = [
        { icon: <Square size={16} />,        label: 'Rectangle', tool: 'rectangle' },
        { icon: <Circle size={16} />,        label: 'Ellipse',   tool: 'ellipse'   },
        { icon: <Diamond size={16} />,       label: 'Diamond',   tool: 'diamond'   },
        { icon: <Minus size={16} />,         label: 'Line',      tool: 'line'       },
        { icon: <ArrowUpRight size={16} />,  label: 'Arrow',     tool: 'arrow'      },
    ];

    const filteredShapes = shapes.filter(shape => {
        if (shape.tool === null) return true;
        return !visibleTools.some(t => t.type === shape.tool);
    });

    const handleToolSelect = (tool: ToolType) => setActiveTool(tool);

    // Filter out actions that are already in the main toolbar or action strip
    const filteredSubTools = subTools.filter(action => {
        // Actions that are already in the action strip
        if (['Undo', 'Redo', 'Delete', 'Duplicate'].includes(action.label)) return false;
        return true;
    });

    const isTop = position === 'top';

    // Two-layer wrapper pattern:
    // Outer: full-width anchor — NO transform (avoids CSS overflow:hidden + transform clipping quirk)
    // Inner: actual toolbar content, centered via flexbox
    return (
        <div style={{
            position: 'absolute',
            ...(isTop ? { top: 16 } : { bottom: 16 }),
            left: 0,
            right: 0,
            zIndex: 50,
            display: 'flex',
            justifyContent: 'center',
            alignItems: isTop ? 'flex-start' : 'flex-end',
            pointerEvents: 'none',
        }}>
        <div style={{
            display: 'flex',
            flexDirection: isTop ? 'column-reverse' : 'column',
            alignItems: 'center',
            maxWidth: 'calc(100% - 32px)',
            gap: 0,
            pointerEvents: 'none',
        }}>
            {/* ── Action strip ── */}
            {/* bottom: visually on top of main tools → rounded top, no bottom border */}
            {/* top:    visually below main tools  → rounded bottom, no top border   */}
            <div style={{ ...mkBarStyle(theme), pointerEvents: 'auto', ...(isTop
                ? { borderRadius: '0 0 12px 12px', borderTop: 'none' }
                : { borderRadius: '12px 12px 0 0', borderBottom: 'none' }
            ) }}>
                <button style={mkBtnStyle(false, theme)} onClick={undo} title="Undo (⌘Z)">
                    <Undo2 size={16} />
                </button>
                <button style={mkBtnStyle(false, theme)} onClick={redo} title="Redo (⌘⇧Z)">
                    <Redo2 size={16} />
                </button>
                <div style={mkSepStyle(theme)} />
                <button style={mkBtnStyle(false, theme, !hasSelection)} disabled={!hasSelection}
                    onClick={() => { if (hasSelection) deleteElements(selectedIds); }} title="Delete (⌫)">
                    <Trash2 size={16} />
                </button>
                <button style={mkBtnStyle(false, theme, !hasSelection)} disabled={!hasSelection}
                    onClick={() => { if (hasSelection) duplicateElements(selectedIds); }} title="Duplicate (⌘D)">
                    <Copy size={16} />
                </button>
                {filteredSubTools.length > 0 && (
                    <>
                        <div style={mkSepStyle(theme)} />
                        {/* ⋯ → align/layer/transform popup */}
                        <button
                            ref={moreRef}
                            style={mkBtnStyle(showMoreTools, theme)}
                            onClick={() => {
                                setShowMoreTools(!showMoreTools);
                                setShowShapePicker(false);
                            }}
                            title="More actions"
                        >
                            <MoreHorizontal size={16} />
                        </button>
                    </>
                )}
            </div>

            {/* ── Main tools bar ── */}
            {/* bottom: fully rounded (sits below action strip) */}
            {/* top:    visually on top → rounded top, no bottom border */}
            <div style={{ ...mkBarStyle(theme), pointerEvents: 'auto', ...(isTop
                ? { borderRadius: '12px 12px 0 0', borderBottom: 'none' }
                : {}
            ) }}>
                {visibleTools.map((tool) => (
                    <button
                        key={tool.type}
                        style={mkBtnStyle(activeTool === tool.type, theme)}
                        onClick={() => setActiveTool(tool.type as ToolType)}
                        title={`${tool.label} (${tool.shortcut})`}
                    >
                        {ICON_MAP[tool.icon]}
                    </button>
                ))}
                <div style={mkSepStyle(theme)} />
                <ZoomPicker scale={scale} theme={theme} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} placement={position} />
                {filteredShapes.length > 0 && (
                    <>
                        <div style={mkSepStyle(theme)} />
                        {/* ^ → shape picker popup */}
                        <button
                            ref={chevronRef}
                            style={mkBtnStyle(showShapePicker, theme)}
                            onClick={() => {
                                setShowShapePicker(!showShapePicker);
                                setShowMoreTools(false);
                            }}
                            title="More shapes"
                        >
                            <ChevronUp size={16} />
                        </button>
                    </>
                )}
            </div>

            {/* ── Sub-tools popup (⋯ → align/layer/transform) ── */}
            {showMoreTools && filteredSubTools.length > 0 && (
                <SubToolsPopup
                    actions={filteredSubTools}
                    anchorRef={moreRef}
                    onClose={() => setShowMoreTools(false)}
                    theme={theme}
                    placement={position}
                />
            )}

            {/* ── Shape picker popup (^ → shape grid) ── */}
            {showShapePicker && filteredShapes.length > 0 && (
                <ShapePickerPopup
                    shapes={filteredShapes}
                    activeTool={activeTool}
                    anchorRef={chevronRef}
                    onSelect={handleToolSelect}
                    onClose={() => setShowShapePicker(false)}
                    theme={theme}
                    placement={position}
                />
            )}
        </div>
        </div>
    );
};

export default Toolbar;

