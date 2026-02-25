import React, { useMemo, useState, useRef, useEffect } from 'react';
import { PenLine, PenTool, Pencil as PencilIcon, Brush } from 'lucide-react';
import { useCanvasStore } from '../../store/useCanvasStore';
import { STROKE_COLORS, FILL_COLORS, FONT_SIZES, FONT_FAMILIES, ARROWHEAD_TYPES, LINE_TYPES, ROUGHNESS_CONFIGS, FREEHAND_STYLES } from '../../constants';
import type { FlowCanvasTheme } from '../../lib/FlowCanvasProps';
import type { ArrowElement, LineElement, ImageElement, ImageScaleMode, Arrowhead } from '../../types';
import { PanelButton, PanelTextButton, PanelSection, ButtonRow, CompactDropdownPicker } from './ui';

interface Props {
    theme: FlowCanvasTheme;
}

// ─── Color Palette Constants ──────────────────────────────────
const SWATCH_SIZE = 20;
const SWATCH_GAP = 4;
const SWATCHES_PER_ROW = 6;

// Stroke widths — 4 tiers with proportional visual thickness
const STROKE_WIDTH_TIERS = [
    { value: 1, label: 'Thin',       thickness: 1 },
    { value: 2, label: 'Normal',     thickness: 2 },
    { value: 4, label: 'Bold',       thickness: 3.5 },
    { value: 6, label: 'Extra Bold', thickness: 5.5 },
];

const STROKE_STYLE_CONFIGS = [
    { value: 'solid'  as const, label: 'Solid' },
    { value: 'dashed' as const, label: 'Dashed' },
    { value: 'dotted' as const, label: 'Dotted' },
];

// ─── SVG Icon Components ──────────────────────────────────────

/** Stroke width — horizontal line of given thickness */
const StrokeWidthIcon: React.FC<{ thickness: number; color: string }> = ({ thickness, color }) => (
    <svg width="12" height="12" viewBox="0 0 14 14">
        <line x1="2" y1="7" x2="12" y2="7" stroke={color} strokeWidth={thickness} strokeLinecap="round" />
    </svg>
);

/** Stroke style — solid / dashed / dotted line */
const StrokeStyleIcon: React.FC<{ style: 'solid' | 'dashed' | 'dotted'; color: string }> = ({ style, color }) => (
    <svg width="12" height="12" viewBox="0 0 14 14">
        <line x1="1" y1="7" x2="13" y2="7" stroke={color} strokeWidth="1.5" strokeLinecap="round"
            strokeDasharray={style === 'dashed' ? '3.5 2.5' : style === 'dotted' ? '1 2.5' : undefined} />
    </svg>
);

/** Sloppiness — increasing waviness */
const SloppinessIcon: React.FC<{ level: number; color: string }> = ({ level, color }) => (
    <svg width="12" height="12" viewBox="0 0 14 14">
        {level === 0 ? (
            <path d="M2,9 Q5,5 7,7 Q9,9 12,5" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
        ) : level === 1 ? (
            <path d="M2,9 Q3.5,3 6,8 Q8,13 10,6 Q11,3 12,5" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
        ) : (
            <path d="M1,8 Q3,3 4.5,9 Q6,13 7,6 Q8.5,1 10,9 Q11.5,13 13,6" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
        )}
    </svg>
);

/** Line type — sharp / curved / elbow */
const LineTypeIcon: React.FC<{ type: string; color: string }> = ({ type, color }) => (
    <svg width="12" height="12" viewBox="0 0 14 14">
        {type === 'sharp' ? (
            <polyline points="2,11 7,3 12,11" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        ) : type === 'elbow' ? (
            <polyline points="2,11 2,3 12,3 12,11" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="square" strokeLinejoin="miter" />
        ) : (
            <path d="M2,11 Q7,0 12,11" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
        )}
    </svg>
);

/** Freehand style icon — uses lucide-react icons matching each pen mode */
const FREEHAND_ICONS: Record<string, React.FC<{ size: number; color: string; strokeWidth: number }>> = {
    standard: ({ size, color, strokeWidth }) => <PenLine size={size} color={color} strokeWidth={strokeWidth} />,
    pen:      ({ size, color, strokeWidth }) => <PenTool size={size} color={color} strokeWidth={strokeWidth} />,
    pencil:   ({ size, color, strokeWidth }) => <PencilIcon size={size} color={color} strokeWidth={strokeWidth} />,
    brush:    ({ size, color, strokeWidth }) => <Brush size={size} color={color} strokeWidth={strokeWidth} />,
};

const FreehandStyleIcon: React.FC<{ style: string; color: string }> = ({ style, color }) => {
    const Icon = FREEHAND_ICONS[style] ?? FREEHAND_ICONS['standard'];
    return <Icon size={16} color={color} strokeWidth={1.5} />;
};

/**
 * Rich arrowhead preview — draws a short line with a proper geometric arrowhead.
 * The arrow always points toward the 'tip' end; 'start' mirrors the SVG horizontally.
 */
const ArrowheadLineIcon: React.FC<{ arrowhead: Arrowhead | null; end: 'start' | 'end'; color: string }> = ({ arrowhead, end, color }) => {
    const y = 6;
    const tip = 18;   // right edge of drawable area
    const lineStart = 2;
    const hs = 3.5;      // half-height of arrowhead
    let lineStopX = tip;
    let head: React.ReactNode = null;

    switch (arrowhead) {
        case null:
            break;
        case 'arrow':
            lineStopX = tip - 2;
            head = <path d={`M${tip-6},${y-hs} L${tip},${y} L${tip-6},${y+hs}`}
                fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />;
            break;
        case 'triangle':
            lineStopX = tip - 6;
            head = <polygon points={`${tip},${y} ${tip-6},${y-hs} ${tip-6},${y+hs}`} fill={color} />;
            break;
        case 'triangle_outline':
            lineStopX = tip - 6;
            head = <polygon points={`${tip},${y} ${tip-6},${y-hs} ${tip-6},${y+hs}`}
                fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />;
            break;
        case 'circle':
            lineStopX = tip - 7;
            head = <circle cx={tip - 3.5} cy={y} r={3.5} fill={color} />;
            break;
        case 'circle_outline':
            lineStopX = tip - 7;
            head = <circle cx={tip - 3.5} cy={y} r={3.5} fill="none" stroke={color} strokeWidth="1.3" />;
            break;
        case 'diamond':
            lineStopX = tip - 8;
            head = <polygon points={`${tip},${y} ${tip-4},${y-hs} ${tip-8},${y} ${tip-4},${y+hs}`} fill={color} />;
            break;
        case 'diamond_outline':
            lineStopX = tip - 8;
            head = <polygon points={`${tip},${y} ${tip-4},${y-hs} ${tip-8},${y} ${tip-4},${y+hs}`}
                fill="none" stroke={color} strokeWidth="1.3" />;
            break;
        case 'bar':
            head = <line x1={tip} y1={y - hs} x2={tip} y2={y + hs}
                stroke={color} strokeWidth="1.5" strokeLinecap="round" />;
            break;
        case 'crowfoot_one':
            lineStopX = tip - 4;
            head = <>
                <line x1={tip-4} y1={y-hs} x2={tip-4} y2={y+hs} stroke={color} strokeWidth="1.3" strokeLinecap="round" />
                <line x1={tip}   y1={y-hs} x2={tip}   y2={y+hs} stroke={color} strokeWidth="1.3" strokeLinecap="round" />
            </>;
            break;
        case 'crowfoot_many':
            lineStopX = tip - 7;
            head = <>
                <path d={`M${tip},${y-hs} L${tip-7},${y} L${tip},${y+hs}`}
                    fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                <line x1={tip} y1={y-hs} x2={tip} y2={y+hs} stroke={color} strokeWidth="1.3" strokeLinecap="round" />
            </>;
            break;
        case 'crowfoot_one_or_many':
            lineStopX = tip - 7;
            head = <>
                <path d={`M${tip},${y-hs} L${tip-7},${y} L${tip},${y+hs}`}
                    fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                <line x1={tip-3.5}  y1={y-hs} x2={tip-3.5}  y2={y+hs} stroke={color} strokeWidth="1.3" strokeLinecap="round" />
                <line x1={tip}    y1={y-hs} x2={tip}    y2={y+hs} stroke={color} strokeWidth="1.3" strokeLinecap="round" />
            </>;
            break;
    }

    // 'start' = arrowhead on left → mirror the SVG horizontally
    const groupTransform = end === 'start' ? 'scale(-1,1) translate(-20,0)' : undefined;

    return (
        <svg width={14} height={12} viewBox="0 0 20 12" fill="none">
            <g transform={groupTransform}>
                <line x1={lineStart} y1={y} x2={lineStopX} y2={y}
                    stroke={color} strokeWidth="1.5" strokeLinecap="round" />
                {head}
            </g>
        </svg>
    );
};

// ─── Generic Icon wrapper ─────────────────────────────────────
const SvgIcon: React.FC<{ children: React.ReactNode; color: string; size?: number }> = ({ children, color, size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
    </svg>
);

// ─── Layer & Action Icons ─────────────────────────────────────
const LayerIcons = {
    sendToBack: (color: string) => (
        <SvgIcon color={color}>
            <path d="M14 3v4a1 1 0 0 0 1 1h4" />
            <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" opacity="0.3" />
            <polyline points="12 12 12 18" /><polyline points="9 15 12 18 15 15" />
        </SvgIcon>
    ),
    sendBackward: (color: string) => (
        <SvgIcon color={color}>
            <line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" />
        </SvgIcon>
    ),
    bringForward: (color: string) => (
        <SvgIcon color={color}>
            <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
        </SvgIcon>
    ),
    bringToFront: (color: string) => (
        <SvgIcon color={color}>
            <path d="M14 3v4a1 1 0 0 0 1 1h4" />
            <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" opacity="0.3" />
            <polyline points="12 18 12 12" /><polyline points="9 15 12 12 15 15" />
        </SvgIcon>
    ),
};

const ActionIcons = {
    duplicate: (color: string) => (
        <SvgIcon color={color}>
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </SvgIcon>
    ),
    delete: (color: string) => (
        <SvgIcon color={color}>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" /><path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </SvgIcon>
    ),
    link: (color: string) => (
        <SvgIcon color={color}>
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </SvgIcon>
    ),
    ungroup: (color: string) => (
        <SvgIcon color={color}>
            <rect x="2" y="2" width="8" height="8" rx="1" strokeDasharray="3 2" />
            <rect x="14" y="14" width="8" height="8" rx="1" strokeDasharray="3 2" />
            <path d="M14 2h4a2 2 0 0 1 2 2v4" /><path d="M2 14v4a2 2 0 0 0 2 2h4" />
        </SvgIcon>
    ),
};
// ═══════════════════════════════════════════════════════════════
// StylePanel Component
// ═══════════════════════════════════════════════════════════════
const StylePanel: React.FC<Props> = ({ theme }) => {
    // Granular selectors for better performance
    const currentStyle = useCanvasStore((s) => s.currentStyle);
    const setCurrentStyle = useCanvasStore((s) => s.setCurrentStyle);
    const selectedIds = useCanvasStore((s) => s.selectedIds);
    const elements = useCanvasStore((s) => s.elements);
    const updateElement = useCanvasStore((s) => s.updateElement);
    const pushHistory = useCanvasStore((s) => s.pushHistory);
    const toggleLockElements = useCanvasStore((s) => s.toggleLockElements);
    const deleteElements = useCanvasStore((s) => s.deleteElements);
    const duplicateElements = useCanvasStore((s) => s.duplicateElements);
    const bringToFront = useCanvasStore((s) => s.bringToFront);
    const sendToBack = useCanvasStore((s) => s.sendToBack);
    const bringForward = useCanvasStore((s) => s.bringForward);
    const sendBackward = useCanvasStore((s) => s.sendBackward);
    const activeTool = useCanvasStore((s) => s.activeTool);
    const currentLineType = useCanvasStore((s) => s.currentLineType);
    const setCurrentLineType = useCanvasStore((s) => s.setCurrentLineType);
    const currentStartArrowhead = useCanvasStore((s) => s.currentStartArrowhead);
    const setCurrentStartArrowhead = useCanvasStore((s) => s.setCurrentStartArrowhead);
    const currentEndArrowhead = useCanvasStore((s) => s.currentEndArrowhead);
    const setCurrentEndArrowhead = useCanvasStore((s) => s.setCurrentEndArrowhead);
    const [openArrowPicker, setOpenArrowPicker] = useState<'start' | 'end' | null>(null);
    const startArrowPickerRef = useRef<HTMLDivElement>(null);
    const endArrowPickerRef = useRef<HTMLDivElement>(null);
    const [openCompactPicker, setOpenCompactPicker] = useState<'sloppiness' | 'lineType' | null>(null);
    const sloppinessPickerRef = useRef<HTMLDivElement>(null);
    const lineTypePickerRef = useRef<HTMLDivElement>(null);
    const strokeColorInputRef = useRef<HTMLInputElement>(null);
    const fillColorInputRef = useRef<HTMLInputElement>(null);

    // Close arrowhead pickers on outside click
    useEffect(() => {
        if (!openArrowPicker) return;
        const handleMouseDown = (e: MouseEvent) => {
            const ref = openArrowPicker === 'start' ? startArrowPickerRef : endArrowPickerRef;
            const isInsidePicker = ref.current && ref.current.contains(e.target as Node);
            const isInsideDropdown = (e.target as Element).closest('[data-compact-dropdown="true"]');
            if (!isInsidePicker && !isInsideDropdown) {
                setOpenArrowPicker(null);
            }
        };
        document.addEventListener('mousedown', handleMouseDown);
        return () => document.removeEventListener('mousedown', handleMouseDown);
    }, [openArrowPicker]);

    // Close compact pickers on outside click
    useEffect(() => {
        if (!openCompactPicker) return;
        const handleMouseDown = (e: MouseEvent) => {
            const ref = openCompactPicker === 'sloppiness' ? sloppinessPickerRef : lineTypePickerRef;
            // Check if click is inside the picker container OR the fixed dropdown
            const isInsidePicker = ref.current && ref.current.contains(e.target as Node);
            const isInsideDropdown = (e.target as Element).closest('[data-compact-dropdown="true"]');
            
            if (!isInsidePicker && !isInsideDropdown) {
                setOpenCompactPicker(null);
            }
        };
        document.addEventListener('mousedown', handleMouseDown);
        return () => document.removeEventListener('mousedown', handleMouseDown);
    }, [openCompactPicker]);

    const hasTextSelected = useMemo(
        () => selectedIds.some((id) => elements.find((e) => e.id === id)?.type === 'text'),
        [selectedIds, elements],
    );

    const selectedLinear = useMemo(() => {
        const el = selectedIds.length === 1 ? elements.find((e) => e.id === selectedIds[0]) : null;
        if (!el) return null;
        if (el.type === 'arrow' || el.type === 'line') return el as ArrowElement | LineElement;
        return null;
    }, [selectedIds, elements]);

    const selectedImage = useMemo(() => {
        const el = selectedIds.length === 1 ? elements.find((e) => e.id === selectedIds[0]) : null;
        if (!el || el.type !== 'image') return null;
        return el as ImageElement;
    }, [selectedIds, elements]);

    const lockState = useMemo(() => {
        if (selectedIds.length === 0) return null;
        const selectedEls = elements.filter(el => selectedIds.includes(el.id));
        const allLocked = selectedEls.every(el => el.isLocked);
        const anyLocked = selectedEls.some(el => el.isLocked);
        return { allLocked, anyLocked };
    }, [selectedIds, elements]);

    const isArrowSelected = selectedLinear?.type === 'arrow';
    const isLinearSelected = selectedLinear != null;
    const hasSelection = selectedIds.length > 0;

    const isFreedrawSelected = useMemo(() => {
        return selectedIds.some((id) => elements.find((e) => e.id === id)?.type === 'freedraw');
    }, [selectedIds, elements]);

    // Show linear sections when tool is active (even without selection)
    const isLinearTool = activeTool === 'arrow' || activeTool === 'line';
    const isArrowTool = activeTool === 'arrow';
    const showLinearSection = isLinearSelected || isLinearTool;
    const showArrowheadSection = isArrowSelected || isArrowTool;
    const showFreedrawSection = isFreedrawSelected || activeTool === 'freedraw';

    // ─── Compute display style from selected element(s) ───────
    // When element(s) are selected, show their style; otherwise show the global default.
    const displayStyle = useMemo(() => {
        if (selectedIds.length === 0) return currentStyle;
        // Single selection: use that element's style directly
        if (selectedIds.length === 1) {
            const el = elements.find((e) => e.id === selectedIds[0]);
            if (el) return el.style;
        }
        // Multi-selection: use the first selected element's style as representative
        const first = elements.find((e) => selectedIds.includes(e.id));
        if (first) return first.style;
        return currentStyle;
    }, [selectedIds, elements, currentStyle]);

    const apply = (updates: Partial<typeof currentStyle>) => {
        setCurrentStyle(updates);
        if (selectedIds.length > 0) {
            selectedIds.forEach((id) => {
                const el = elements.find((e) => e.id === id);
                if (el) updateElement(id, { style: { ...el.style, ...updates } });
            });
            pushHistory();
        }
    };

    const opacityPct = Math.round(displayStyle.opacity * 100);

    // ─── Style constants ──────────────────────────────────────

    const panelStyle: React.CSSProperties = {
        position: 'absolute',
        left: 12,
        top: 64,
        zIndex: 50,
        width: 160,
        background: theme.panelBg,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        boxShadow: '0 1px 4px rgba(0,0,0,0.05), 0 3px 12px rgba(0,0,0,0.07)',
        borderRadius: 10,
        padding: '10px 10px 8px',
        border: `1px solid ${theme.toolbarBorder}`,
        maxHeight: 'calc(100vh - 90px)',
        overflowY: 'auto',
        fontFamily: 'system-ui, -apple-system, sans-serif',
    };

    const swatchStyle = (color: string, isActive: boolean): React.CSSProperties => ({
        width: SWATCH_SIZE,
        height: SWATCH_SIZE,
        borderRadius: 4,
        border: isActive ? `2px solid ${theme.activeToolColor}` : '1.5px solid #d5d8dc',
        cursor: 'pointer',
        background: color === 'transparent'
            ? 'repeating-conic-gradient(#d1d5db 0% 25%, transparent 0% 50%) 50%/6px 6px'
            : color,
        boxShadow: isActive ? `0 0 0 1.5px ${theme.activeToolColor}30` : 'none',
        outline: 'none',
        flexShrink: 0,
        transition: 'border-color 0.1s, box-shadow 0.1s',
        padding: 0,
    });

    const dividerStyle: React.CSSProperties = {
        height: 1,
        background: theme.toolbarBorder,
        margin: '10px 0',
        border: 'none',
    };

    const colorGridStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: `repeat(${SWATCHES_PER_ROW}, ${SWATCH_SIZE}px)`,
        gap: SWATCH_GAP,
    };

    return (
        <div style={panelStyle}>

            {/* ════════ Stroke Color ════════ */}
            <PanelSection label="Stroke" theme={theme}>
                <div style={colorGridStyle}>
                    {STROKE_COLORS.map((c) => (
                        <button
                            key={c}
                            style={swatchStyle(c, displayStyle.strokeColor === c)}
                            onClick={() => apply({ strokeColor: c })}
                            title={c}
                        />
                    ))}
                    <button
                        title="Custom color"
                        onClick={() => strokeColorInputRef.current?.click()}
                        style={{
                            ...swatchStyle(displayStyle.strokeColor, !STROKE_COLORS.includes(displayStyle.strokeColor)),
                            background: !STROKE_COLORS.includes(displayStyle.strokeColor)
                                ? displayStyle.strokeColor
                                : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
                            border: !STROKE_COLORS.includes(displayStyle.strokeColor)
                                ? `2px solid ${theme.activeToolColor}`
                                : '1.5px solid #d5d8dc',
                        }}
                    />
                    <input
                        ref={strokeColorInputRef}
                        type="color"
                        value={displayStyle.strokeColor.startsWith('#') ? displayStyle.strokeColor : '#000000'}
                        onChange={(e) => apply({ strokeColor: e.target.value })}
                        style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
                    />
                </div>
            </PanelSection>

            {/* ════════ Background / Fill (hidden for linear & freedraw) ════════ */}
            {!isLinearSelected && !isLinearTool && !isFreedrawSelected && activeTool !== 'freedraw' && (
                <PanelSection label="Background" theme={theme}>
                    <div style={colorGridStyle}>
                        {FILL_COLORS.map((c) => (
                            <button
                                key={c}
                                style={swatchStyle(c, displayStyle.fillColor === c)}
                                onClick={() => apply({ fillColor: c })}
                                title={c === 'transparent' ? 'None' : c}
                            />
                        ))}
                        <button
                            title="Custom color"
                            onClick={() => fillColorInputRef.current?.click()}
                            style={{
                                ...swatchStyle(displayStyle.fillColor, !FILL_COLORS.includes(displayStyle.fillColor)),
                                background: !FILL_COLORS.includes(displayStyle.fillColor)
                                    ? displayStyle.fillColor
                                    : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
                                border: !FILL_COLORS.includes(displayStyle.fillColor)
                                    ? `2px solid ${theme.activeToolColor}`
                                    : '1.5px solid #d5d8dc',
                            }}
                        />
                        <input
                            ref={fillColorInputRef}
                            type="color"
                            value={displayStyle.fillColor.startsWith('#') ? displayStyle.fillColor : '#ffffff'}
                            onChange={(e) => apply({ fillColor: e.target.value })}
                            style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
                        />
                    </div>
                </PanelSection>
            )}

            {/* ════════ Stroke Width ════════ */}
            <PanelSection label="Stroke width" theme={theme}>
                <ButtonRow columns={4}>
                    {STROKE_WIDTH_TIERS.map((w) => (
                        <PanelButton
                            key={w.value}
                            isActive={displayStyle.strokeWidth === w.value}
                            theme={theme}
                            onClick={() => apply({ strokeWidth: w.value })}
                            title={w.label}
                            width="100%"
                            height={32}
                        >
                            {(hl) => <StrokeWidthIcon thickness={w.thickness} color={hl ? theme.activeToolColor : theme.textColor} />}
                        </PanelButton>
                    ))}
                </ButtonRow>
            </PanelSection>

            {/* ════════ Stroke Style ════════ */}
            <PanelSection label="Stroke style" theme={theme}>
                <ButtonRow columns={4}>
                    {STROKE_STYLE_CONFIGS.map((st) => (
                        <PanelButton
                            key={st.value}
                            isActive={displayStyle.strokeStyle === st.value}
                            theme={theme}
                            onClick={() => apply({ strokeStyle: st.value })}
                            title={st.label}
                            width="100%"
                            height={32}
                        >
                            {(hl) => <StrokeStyleIcon style={st.value} color={hl ? theme.activeToolColor : theme.textColor} />}
                        </PanelButton>
                    ))}
                </ButtonRow>
            </PanelSection>

            {/* ════════ Sloppiness ════════ */}
            <PanelSection
                label="Sloppiness"
                theme={theme}
                headerAction={
                    <CompactDropdownPicker
                        label="Sloppiness"
                        style={{ width: 32 }}
                        value={displayStyle.roughness}
                        options={ROUGHNESS_CONFIGS.map(r => ({
                            value: r.value,
                            label: r.label,
                            icon: (color: string) => <SloppinessIcon level={r.value} color={color} />,
                        }))}
                        onChange={(v) => { apply({ roughness: v as number }); }}
                        theme={theme}
                        isOpen={openCompactPicker === 'sloppiness'}
                        onToggle={() => setOpenCompactPicker(openCompactPicker === 'sloppiness' ? null : 'sloppiness')}
                        pickerRef={sloppinessPickerRef}
                    />
                }
            />

            {/* ════════ Freehand Style ════════ */}
            {showFreedrawSection && (
                <PanelSection label="Pen style" theme={theme}>
                    <ButtonRow columns={4}>
                        {FREEHAND_STYLES.map((st) => (
                            <PanelButton
                                key={st.value}
                                isActive={(displayStyle.freehandStyle || 'standard') === st.value}
                                theme={theme}
                                onClick={() => apply({ freehandStyle: st.value })}
                                title={st.label}
                                width="100%"
                                height={32}
                            >
                                {(hl) => <FreehandStyleIcon style={st.value} color={hl ? theme.activeToolColor : theme.textColor} />}
                            </PanelButton>
                        ))}
                    </ButtonRow>
                </PanelSection>
            )}

            {/* ════════ Arrow / Line Type ════════ */}
            {showLinearSection && (
                <PanelSection
                    label={(isArrowSelected || isArrowTool) ? 'Arrow type' : 'Line type'}
                    theme={theme}
                    headerAction={
                        <CompactDropdownPicker
                            label={(isArrowSelected || isArrowTool) ? 'Arrow type' : 'Line type'}
                            style={{ width: 32 }}
                            value={selectedLinear
                                ? (selectedLinear as ArrowElement | LineElement).lineType
                                : currentLineType}
                            options={LINE_TYPES.map(lt => ({
                                value: lt.type,
                                label: lt.label,
                                icon: (color: string) => <LineTypeIcon type={lt.type} color={color} />,
                            }))}
                            onChange={(v) => {
                                const lt = LINE_TYPES.find(l => l.type === v);
                                if (!lt) return;
                                if (selectedLinear) {
                                    const updates: Partial<ArrowElement | LineElement> = { lineType: lt.type };
                                    if (lt.type === 'curved' || lt.type === 'elbow') {
                                        const lin = selectedLinear as ArrowElement | LineElement;
                                        if (lin.points.length > 4) {
                                            updates.points = [
                                                lin.points[0], lin.points[1],
                                                lin.points[lin.points.length - 2], lin.points[lin.points.length - 1],
                                            ];
                                        }
                                    }
                                    updateElement(selectedLinear.id, updates);
                                    pushHistory();
                                }
                                setCurrentLineType(lt.type);
                                setOpenCompactPicker(null);
                            }}
                            theme={theme}
                            isOpen={openCompactPicker === 'lineType'}
                            onToggle={() => setOpenCompactPicker(openCompactPicker === 'lineType' ? null : 'lineType')}
                            pickerRef={lineTypePickerRef}
                        />
                    }
                />
            )}

            {/* ════════ Arrows ════════ */}
            {showArrowheadSection && (
                <PanelSection
                    label="Arrows"
                    theme={theme}
                    headerAction={
                        <div style={{ display: 'flex', gap: 4 }}>
                            <CompactDropdownPicker
                                label="Start arrowhead"
                                style={{ width: 32 }}
                                value={(selectedLinear ? (selectedLinear as ArrowElement).startArrowhead : currentStartArrowhead) ?? '__none__'}
                                options={ARROWHEAD_TYPES.map(ah => ({
                                    value: ah.type ?? '__none__',
                                    label: ah.label,
                                    icon: (color: string) => <ArrowheadLineIcon arrowhead={ah.type} end="start" color={color} />,
                                }))}
                                onChange={(v) => {
                                    const arrowhead = v === '__none__' ? null : v as Arrowhead;
                                    if (selectedLinear) {
                                        updateElement(selectedLinear.id, { startArrowhead: arrowhead } as Partial<ArrowElement>);
                                        pushHistory();
                                    }
                                    setCurrentStartArrowhead(arrowhead);
                                }}
                                columns={4}
                                theme={theme}
                                isOpen={openArrowPicker === 'start'}
                                onToggle={() => setOpenArrowPicker(openArrowPicker === 'start' ? null : 'start')}
                                pickerRef={startArrowPickerRef}
                            />
                            <CompactDropdownPicker
                                label="End arrowhead"
                                style={{ width: 32 }}
                                value={(selectedLinear ? (selectedLinear as ArrowElement).endArrowhead : currentEndArrowhead) ?? '__none__'}
                                options={ARROWHEAD_TYPES.map(ah => ({
                                    value: ah.type ?? '__none__',
                                    label: ah.label,
                                    icon: (color: string) => <ArrowheadLineIcon arrowhead={ah.type} end="end" color={color} />,
                                }))}
                                onChange={(v) => {
                                    const arrowhead = v === '__none__' ? null : v as Arrowhead;
                                    if (selectedLinear) {
                                        updateElement(selectedLinear.id, { endArrowhead: arrowhead } as Partial<ArrowElement>);
                                        pushHistory();
                                    }
                                    setCurrentEndArrowhead(arrowhead);
                                }}
                                columns={4}
                                theme={theme}
                                isOpen={openArrowPicker === 'end'}
                                onToggle={() => setOpenArrowPicker(openArrowPicker === 'end' ? null : 'end')}
                                pickerRef={endArrowPickerRef}
                            />
                        </div>
                    }
                />
            )}

            {/* ════════ Opacity ════════ */}
            <>
                <hr style={dividerStyle} />
                <PanelSection theme={theme}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
                        <span style={{ fontSize: 10, fontWeight: 600, color: theme.mutedTextColor, letterSpacing: 0.2 }}>Opacity</span>
                        <span style={{ fontSize: 10, fontWeight: 500, color: theme.textColor }}>{opacityPct}%</span>
                    </div>
                    <input
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={opacityPct}
                        onChange={(e) => apply({ opacity: parseInt(e.target.value) / 100 })}
                        style={{ width: '100%', accentColor: theme.activeToolColor, height: 4 }}
                    />
                </PanelSection>
            </>

            {/* ════════ Font Size (text) ════════ */}
            {hasTextSelected && (
                <>
                    <hr style={dividerStyle} />
                    <PanelSection label="Font size" theme={theme}>
                        <ButtonRow columns={0} wrap gap={2}>
                            {FONT_SIZES.map((sz) => (
                                <PanelTextButton
                                    key={sz}
                                    isActive={displayStyle.fontSize === sz}
                                    theme={theme}
                                    onClick={() => apply({ fontSize: sz })}
                                    flex="none"
                                    style={{ width: 28, padding: '2px 0' }}
                                >
                                    {sz}
                                </PanelTextButton>
                            ))}
                        </ButtonRow>
                    </PanelSection>

                    {/* ════════ Font Family (text) ════════ */}
                    <PanelSection label="Font family" theme={theme}>
                        <select
                            value={displayStyle.fontFamily}
                            onChange={(e) => apply({ fontFamily: e.target.value })}
                            style={{
                                width: '100%', padding: '4px 6px', borderRadius: 4,
                                border: `1px solid ${theme.toolbarBorder}`, background: theme.panelBg,
                                color: theme.textColor, fontSize: 10, cursor: 'pointer', outline: 'none',
                            }}
                        >
                            {FONT_FAMILIES.map((f) => (
                                <option key={f.value} value={f.value}>{f.label}</option>
                            ))}
                        </select>
                    </PanelSection>
                </>
            )}

            {/* ════════ Image Scale Mode ════════ */}
            {selectedImage && (
                <>
                    <hr style={dividerStyle} />
                    <PanelSection label="Scale mode" theme={theme}>
                        <ButtonRow columns={3}>
                            {(['stretch', 'fit', 'fill'] as ImageScaleMode[]).map((mode) => (
                                <PanelTextButton
                                    key={mode}
                                    isActive={selectedImage.scaleMode === mode}
                                    theme={theme}
                                    title={mode === 'stretch' ? 'Stretch to fill' : mode === 'fit' ? 'Fit (contain)' : 'Fill (cover)'}
                                    onClick={() => {
                                        updateElement(selectedImage.id, { scaleMode: mode } as Partial<ImageElement>);
                                        pushHistory();
                                    }}
                                    flex="1"
                                >
                                    {mode.charAt(0).toUpperCase() + mode.slice(1)}
                                </PanelTextButton>
                            ))}
                        </ButtonRow>
                    </PanelSection>

                    {/* ════════ Image Corner Radius ════════ */}
                    <PanelSection theme={theme}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
                            <span style={{ fontSize: 10, fontWeight: 600, color: theme.mutedTextColor, letterSpacing: 0.2 }}>Corner radius</span>
                            <span style={{ fontSize: 10, fontWeight: 500, color: theme.textColor }}>{selectedImage.cornerRadius}px</span>
                        </div>
                        <input
                            type="range"
                            min="0"
                            max="50"
                            step="1"
                            value={selectedImage.cornerRadius}
                            onChange={(e) => {
                                updateElement(selectedImage.id, { cornerRadius: parseInt(e.target.value) } as Partial<ImageElement>);
                                pushHistory();
                            }}
                            style={{ width: '100%', accentColor: theme.activeToolColor, height: 4 }}
                        />
                    </PanelSection>

                    {/* ════════ Image Replace ════════ */}
                    <PanelSection theme={theme}>
                        <PanelTextButton
                            theme={theme}
                            style={{ width: '100%', padding: '5px 0', borderRadius: 4 }}
                            onClick={() => {
                                const input = document.createElement('input');
                                input.type = 'file';
                                input.accept = 'image/*';
                                input.onchange = async () => {
                                    const file = input.files?.[0];
                                    if (!file) return;
                                    const reader = new FileReader();
                                    reader.onload = () => {
                                        const dataURL = reader.result as string;
                                        const img = new window.Image();
                                        img.onload = () => {
                                            updateElement(selectedImage.id, {
                                                src: dataURL,
                                                naturalWidth: img.naturalWidth,
                                                naturalHeight: img.naturalHeight,
                                            } as Partial<ImageElement>);
                                            pushHistory();
                                        };
                                        img.src = dataURL;
                                    };
                                    reader.readAsDataURL(file);
                                };
                                input.click();
                            }}
                        >
                            Replace Image…
                        </PanelTextButton>
                    </PanelSection>
                </>
            )}

            {/* ════════ Layers ════════ */}
            {hasSelection && (
                <>
                    <hr style={dividerStyle} />
                    <PanelSection label="Layers" theme={theme}>
                        <ButtonRow columns={4}>
                            {([
                                { fn: sendToBack, icon: LayerIcons.sendToBack, tip: 'Send to back' },
                                { fn: sendBackward, icon: LayerIcons.sendBackward, tip: 'Send backward' },
                                { fn: bringForward, icon: LayerIcons.bringForward, tip: 'Bring forward' },
                                { fn: bringToFront, icon: LayerIcons.bringToFront, tip: 'Bring to front' },
                            ] as const).map(({ fn, icon, tip }) => (
                                <PanelButton
                                    key={tip}
                                    variant="action"
                                    theme={theme}
                                    title={tip}
                                    width="100%"
                                    height={32}
                                    onClick={() => { fn(selectedIds); pushHistory(); }}
                                >
                                    {(hl) => icon(hl ? theme.activeToolColor : theme.textColor)}
                                </PanelButton>
                            ))}
                        </ButtonRow>
                    </PanelSection>

                    {/* ════════ Actions ════════ */}
                    <PanelSection label="Actions" theme={theme}>
                        <ButtonRow columns={4}>
                            <PanelButton
                                variant="action"
                                theme={theme}
                                title="Duplicate (⌘D)"
                                width="100%"
                                height={32}
                                onClick={() => duplicateElements(selectedIds)}
                            >
                                {(hl) => ActionIcons.duplicate(hl ? theme.activeToolColor : theme.textColor)}
                            </PanelButton>
                            <PanelButton
                                variant="action"
                                theme={theme}
                                title="Delete (⌫)"
                                dangerHover
                                width="100%"
                                height={32}
                                onClick={() => { deleteElements(selectedIds); pushHistory(); }}
                            >
                                {(hl) => ActionIcons.delete(hl ? '#e03131' : theme.textColor)}
                            </PanelButton>
                            <PanelButton
                                variant="action"
                                theme={theme}
                                title="Add link (coming soon)"
                                width="100%"
                                height={32}
                                disabled
                            >
                                {ActionIcons.link(theme.mutedTextColor)}
                            </PanelButton>
                            <PanelButton
                                variant="action"
                                theme={theme}
                                title="Ungroup"
                                width="100%"
                                height={32}
                                onClick={() => {
                                    const store = useCanvasStore.getState();
                                    store.ungroupElements(selectedIds);
                                    pushHistory();
                                }}
                            >
                                {(hl) => ActionIcons.ungroup(hl ? theme.activeToolColor : theme.textColor)}
                            </PanelButton>
                        </ButtonRow>
                    </PanelSection>
                </>
            )}

            {/* ════════ Lock / Unlock ════════ */}
            {lockState && hasSelection && (
                <>
                    <hr style={dividerStyle} />
                    <button
                        style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                            width: '100%', padding: '5px 0', borderRadius: 6,
                            border: lockState.allLocked ? '1.5px solid #ff9500' : `1px solid ${theme.toolbarBorder}`,
                            background: lockState.allLocked ? '#ff950010' : 'transparent',
                            cursor: 'pointer', fontSize: 10, fontWeight: 600,
                            color: lockState.allLocked ? '#ff9500' : theme.textColor,
                            letterSpacing: 0.2, transition: 'all 0.1s ease',
                            outline: 'none', marginBottom: 2,
                        }}
                        title={lockState.allLocked ? 'Unlock position (⌘⇧L)' : 'Lock position (⌘⇧L)'}
                        onClick={() => toggleLockElements(selectedIds)}
                    >
                        {lockState.allLocked ? (
                            <>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                    <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                                </svg>
                                Unlock
                            </>
                        ) : (
                            <>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                </svg>
                                Lock Position
                            </>
                        )}
                    </button>
                </>
            )}
        </div>
    );
};

export default StylePanel;
