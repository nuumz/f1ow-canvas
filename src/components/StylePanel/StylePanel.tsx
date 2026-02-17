import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useCanvasStore } from '../../store/useCanvasStore';
import { STROKE_COLORS, FILL_COLORS, FONT_SIZES, FONT_FAMILIES, ARROWHEAD_TYPES, LINE_TYPES, ROUGHNESS_CONFIGS } from '../../constants';
import type { FlowCanvasTheme } from '../../lib/FlowCanvasProps';
import type { ArrowElement, LineElement, ImageElement, ImageScaleMode, Arrowhead, LineType } from '../../types';

interface Props {
    theme: FlowCanvasTheme;
}

// ─── Color Palette Constants ──────────────────────────────────
const SWATCH_SIZE = 20;
const SWATCH_GAP = 3;
const SWATCHES_PER_ROW = 7;

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
    <svg width="14" height="14" viewBox="0 0 14 14">
        <line x1="2" y1="7" x2="12" y2="7" stroke={color} strokeWidth={thickness} strokeLinecap="round" />
    </svg>
);

/** Stroke style — solid / dashed / dotted line */
const StrokeStyleIcon: React.FC<{ style: 'solid' | 'dashed' | 'dotted'; color: string }> = ({ style, color }) => (
    <svg width="14" height="14" viewBox="0 0 14 14">
        <line x1="1" y1="7" x2="13" y2="7" stroke={color} strokeWidth="1.5" strokeLinecap="round"
            strokeDasharray={style === 'dashed' ? '3.5 2.5' : style === 'dotted' ? '1 2.5' : undefined} />
    </svg>
);

/** Sloppiness — increasing waviness */
const SloppinessIcon: React.FC<{ level: number; color: string }> = ({ level, color }) => (
    <svg width="14" height="14" viewBox="0 0 14 14">
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
    <svg width="14" height="14" viewBox="0 0 14 14">
        {type === 'sharp' ? (
            <polyline points="2,11 7,3 12,11" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        ) : type === 'elbow' ? (
            <polyline points="2,11 2,3 12,3 12,11" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="square" strokeLinejoin="miter" />
        ) : (
            <path d="M2,11 Q7,0 12,11" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
        )}
    </svg>
);

/** Arrowhead preview — line with head indicator */
const ArrowheadPreviewIcon: React.FC<{ arrowhead: Arrowhead | null; end: 'start' | 'end'; color: string }> = ({ arrowhead, end, color }) => {
    const preview = arrowhead
        ? ARROWHEAD_TYPES.find(a => a.type === arrowhead)?.preview ?? '—'
        : '×';
    return (
        <svg width="32" height="14" viewBox="0 0 32 14">
            <line x1="4" y1="7" x2="28" y2="7" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
            {end === 'start' ? (
                <text x="1" y="11" fontSize="10" fill={color} fontFamily="system-ui">{preview}</text>
            ) : (
                <text x="21" y="11" fontSize="10" fill={color} fontFamily="system-ui" textAnchor="start">{preview}</text>
            )}
        </svg>
    );
};

// ─── Generic Icon wrapper ─────────────────────────────────────
const SvgIcon: React.FC<{ children: React.ReactNode; color: string; size?: number }> = ({ children, color, size = 14 }) => (
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
    const arrowPickerRef = useRef<HTMLDivElement>(null);
    const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);

    // Close arrowhead picker on outside click
    useEffect(() => {
        if (!openArrowPicker) return;
        const handleMouseDown = (e: MouseEvent) => {
            if (arrowPickerRef.current && !arrowPickerRef.current.contains(e.target as Node)) {
                setOpenArrowPicker(null);
            }
        };
        document.addEventListener('mousedown', handleMouseDown);
        return () => document.removeEventListener('mousedown', handleMouseDown);
    }, [openArrowPicker]);

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

    // Show linear sections when tool is active (even without selection)
    const isLinearTool = activeTool === 'arrow' || activeTool === 'line';
    const isArrowTool = activeTool === 'arrow';
    const showLinearSection = isLinearSelected || isLinearTool;
    const showArrowheadSection = isArrowSelected || isArrowTool;

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

    // ─── Style Helpers ────────────────────────────────────────

    const panelStyle: React.CSSProperties = {
        position: 'absolute',
        left: 12,
        top: 64,
        zIndex: 50,
        width: 188,
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

    const sectionStyle: React.CSSProperties = {
        marginBottom: 10,
    };

    const labelStyle: React.CSSProperties = {
        display: 'block',
        fontSize: 10,
        fontWeight: 600,
        color: theme.mutedTextColor,
        marginBottom: 4,
        letterSpacing: 0.2,
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

    const toggleBtnStyle = (isActive: boolean, hoverKey?: string): React.CSSProperties => ({
        width: 38,
        height: 38,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
        border: isActive ? `1.5px solid ${theme.activeToolColor}` : '1px solid #e0e3e7',
        background: isActive
            ? `${theme.activeToolColor}10`
            : (hoverKey && hoveredBtn === hoverKey ? '#f3f4f6' : 'transparent'),
        cursor: 'pointer',
        color: isActive ? theme.activeToolColor : theme.textColor,
        transition: 'background 0.1s, border-color 0.1s',
        outline: 'none',
        padding: 0,
    });

    const actionBtnStyle = (hoverKey: string): React.CSSProperties => ({
        width: 38,
        height: 38,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
        border: '1px solid #e0e3e7',
        background: hoveredBtn === hoverKey ? '#f3f4f6' : 'transparent',
        cursor: 'pointer',
        color: theme.textColor,
        transition: 'background 0.1s',
        outline: 'none',
        padding: 0,
    });

    const dividerStyle: React.CSSProperties = {
        height: 1,
        background: theme.toolbarBorder,
        margin: '8px 0',
        border: 'none',
    };

    const colorGridStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: `repeat(${SWATCHES_PER_ROW}, ${SWATCH_SIZE}px)`,
        gap: SWATCH_GAP,
    };

    const toggleRowStyle: React.CSSProperties = {
        display: 'flex',
        gap: 3,
        justifyContent: 'flex-start',
    };

    // Arrowhead picker styles
    const arrowheadBtnStyle = (isActive: boolean, hoverKey: string): React.CSSProperties => ({
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 38,
        borderRadius: 6,
        border: isActive ? `1.5px solid ${theme.activeToolColor}` : '1px solid #e0e3e7',
        background: isActive
            ? `${theme.activeToolColor}10`
            : (hoveredBtn === hoverKey ? '#f3f4f6' : 'transparent'),
        cursor: 'pointer',
        color: isActive ? theme.activeToolColor : theme.textColor,
        transition: 'background 0.1s',
        outline: 'none',
        padding: 0,
    });

    const arrowheadGridStyle: React.CSSProperties = {
        position: 'absolute',
        left: 0,
        right: 0,
        top: '100%',
        marginTop: 3,
        background: theme.panelBg,
        border: `1px solid ${theme.toolbarBorder}`,
        borderRadius: 6,
        padding: 4,
        boxShadow: '0 3px 12px rgba(0,0,0,0.1)',
        zIndex: 100,
        display: 'grid',
        gridTemplateColumns: 'repeat(6, 1fr)',
        gap: 1,
    };

    const arrowheadOptionStyle = (isActive: boolean, hoverKey: string): React.CSSProperties => ({
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 24,
        borderRadius: 4,
        border: isActive ? `1.5px solid ${theme.activeToolColor}` : '1px solid transparent',
        background: isActive
            ? `${theme.activeToolColor}10`
            : (hoveredBtn === hoverKey ? '#f3f4f6' : 'transparent'),
        cursor: 'pointer',
        fontSize: 11,
        color: isActive ? theme.activeToolColor : theme.textColor,
        outline: 'none',
        padding: 0,
    });

    const textBtnStyle = (isActive: boolean): React.CSSProperties => ({
        flex: 1,
        padding: '3px 0',
        borderRadius: 4,
        border: isActive ? `1.5px solid ${theme.activeToolColor}` : '1px solid #e0e3e7',
        background: isActive ? `${theme.activeToolColor}10` : 'transparent',
        cursor: 'pointer',
        fontSize: 10,
        fontWeight: 500,
        color: isActive ? theme.activeToolColor : theme.textColor,
        textAlign: 'center',
        outline: 'none',
    });

    return (
        <div style={panelStyle}>

            {/* ════════ Stroke Color ════════ */}
            <div style={sectionStyle}>
                <span style={labelStyle}>Stroke</span>
                <div style={colorGridStyle}>
                    {STROKE_COLORS.map((c) => (
                        <button
                            key={c}
                            style={swatchStyle(c, displayStyle.strokeColor === c)}
                            onClick={() => apply({ strokeColor: c })}
                            title={c}
                        />
                    ))}
                </div>
            </div>

            {/* ════════ Background / Fill (hidden for linear) ════════ */}
            {!isLinearSelected && !isLinearTool && (
                <div style={sectionStyle}>
                    <span style={labelStyle}>Background</span>
                    <div style={colorGridStyle}>
                        {FILL_COLORS.map((c) => (
                            <button
                                key={c}
                                style={swatchStyle(c, displayStyle.fillColor === c)}
                                onClick={() => apply({ fillColor: c })}
                                title={c === 'transparent' ? 'None' : c}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* ════════ Stroke Width ════════ */}
            <div style={sectionStyle}>
                <span style={labelStyle}>Stroke width</span>
                <div style={toggleRowStyle}>
                    {STROKE_WIDTH_TIERS.map((w) => {
                        const active = displayStyle.strokeWidth === w.value;
                        const key = `sw-${w.value}`;
                        return (
                            <button
                                key={w.value}
                                style={toggleBtnStyle(active, key)}
                                onClick={() => apply({ strokeWidth: w.value })}
                                title={w.label}
                                onMouseEnter={() => setHoveredBtn(key)}
                                onMouseLeave={() => setHoveredBtn(null)}
                            >
                                <StrokeWidthIcon
                                    thickness={w.thickness}
                                    color={active ? theme.activeToolColor : theme.textColor}
                                />
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ════════ Stroke Style ════════ */}
            <div style={sectionStyle}>
                <span style={labelStyle}>Stroke style</span>
                <div style={toggleRowStyle}>
                    {STROKE_STYLE_CONFIGS.map((st) => {
                        const active = displayStyle.strokeStyle === st.value;
                        const key = `ss-${st.value}`;
                        return (
                            <button
                                key={st.value}
                                style={toggleBtnStyle(active, key)}
                                onClick={() => apply({ strokeStyle: st.value })}
                                title={st.label}
                                onMouseEnter={() => setHoveredBtn(key)}
                                onMouseLeave={() => setHoveredBtn(null)}
                            >
                                <StrokeStyleIcon
                                    style={st.value}
                                    color={active ? theme.activeToolColor : theme.textColor}
                                />
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ════════ Sloppiness ════════ */}
            <div style={sectionStyle}>
                <span style={labelStyle}>Sloppiness</span>
                <div style={toggleRowStyle}>
                    {ROUGHNESS_CONFIGS.map((r) => {
                        const active = displayStyle.roughness === r.value;
                        const key = `sl-${r.value}`;
                        return (
                            <button
                                key={r.value}
                                style={toggleBtnStyle(active, key)}
                                onClick={() => apply({ roughness: r.value })}
                                title={r.label}
                                onMouseEnter={() => setHoveredBtn(key)}
                                onMouseLeave={() => setHoveredBtn(null)}
                            >
                                <SloppinessIcon
                                    level={r.value}
                                    color={active ? theme.activeToolColor : theme.textColor}
                                />
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ════════ Arrow / Line Type ════════ */}
            {showLinearSection && (
                <div style={sectionStyle}>
                    <span style={labelStyle}>{(isArrowSelected || isArrowTool) ? 'Arrow type' : 'Line type'}</span>
                    <div style={toggleRowStyle}>
                        {LINE_TYPES.map((lt) => {
                            const active = selectedLinear
                                ? (selectedLinear as ArrowElement | LineElement).lineType === lt.type
                                : currentLineType === lt.type;
                            const key = `lt-${lt.type}`;
                            return (
                                <button
                                    key={lt.type}
                                    style={toggleBtnStyle(active, key)}
                                    title={lt.label}
                                    onMouseEnter={() => setHoveredBtn(key)}
                                    onMouseLeave={() => setHoveredBtn(null)}
                                    onClick={() => {
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
                                    }}
                                >
                                    <LineTypeIcon
                                        type={lt.type}
                                        color={active ? theme.activeToolColor : theme.textColor}
                                    />
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* ════════ Arrowheads ════════ */}
            {showArrowheadSection && (
                <div style={{ ...sectionStyle, position: 'relative' }} ref={arrowPickerRef}>
                    <span style={labelStyle}>Arrowheads</span>
                    <div style={toggleRowStyle}>
                        <button
                            style={arrowheadBtnStyle(openArrowPicker === 'start', 'ah-start')}
                            title={`Start: ${selectedLinear ? (selectedLinear as ArrowElement).startArrowhead ?? 'None' : currentStartArrowhead ?? 'None'}`}
                            onClick={() => setOpenArrowPicker(openArrowPicker === 'start' ? null : 'start')}
                            onMouseEnter={() => setHoveredBtn('ah-start')}
                            onMouseLeave={() => setHoveredBtn(null)}
                        >
                            <ArrowheadPreviewIcon
                                arrowhead={selectedLinear ? (selectedLinear as ArrowElement).startArrowhead : currentStartArrowhead}
                                end="start"
                                color={openArrowPicker === 'start' ? theme.activeToolColor : theme.textColor}
                            />
                        </button>
                        <button
                            style={arrowheadBtnStyle(openArrowPicker === 'end', 'ah-end')}
                            title={`End: ${selectedLinear ? (selectedLinear as ArrowElement).endArrowhead ?? 'None' : currentEndArrowhead ?? 'None'}`}
                            onClick={() => setOpenArrowPicker(openArrowPicker === 'end' ? null : 'end')}
                            onMouseEnter={() => setHoveredBtn('ah-end')}
                            onMouseLeave={() => setHoveredBtn(null)}
                        >
                            <ArrowheadPreviewIcon
                                arrowhead={selectedLinear ? (selectedLinear as ArrowElement).endArrowhead : currentEndArrowhead}
                                end="end"
                                color={openArrowPicker === 'end' ? theme.activeToolColor : theme.textColor}
                            />
                        </button>
                    </div>
                    {openArrowPicker && (
                        <div style={arrowheadGridStyle}>
                            {ARROWHEAD_TYPES.map((ah) => {
                                const currentValue = selectedLinear
                                    ? (openArrowPicker === 'start'
                                        ? (selectedLinear as ArrowElement).startArrowhead
                                        : (selectedLinear as ArrowElement).endArrowhead)
                                    : (openArrowPicker === 'start' ? currentStartArrowhead : currentEndArrowhead);
                                const isActive = currentValue === ah.type;
                                const key = `ahg-${ah.type ?? 'none'}`;
                                return (
                                    <button
                                        key={ah.type ?? 'none'}
                                        style={arrowheadOptionStyle(isActive, key)}
                                        title={ah.label}
                                        onMouseEnter={() => setHoveredBtn(key)}
                                        onMouseLeave={() => setHoveredBtn(null)}
                                        onClick={() => {
                                            if (selectedLinear) {
                                                const prop = openArrowPicker === 'start' ? 'startArrowhead' : 'endArrowhead';
                                                updateElement(selectedLinear.id, { [prop]: ah.type } as Partial<ArrowElement>);
                                                pushHistory();
                                            }
                                            if (openArrowPicker === 'start') {
                                                setCurrentStartArrowhead(ah.type);
                                            } else {
                                                setCurrentEndArrowhead(ah.type);
                                            }
                                            setOpenArrowPicker(null);
                                        }}
                                    >
                                        {ah.preview}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* ════════ Opacity ════════ */}
            <div style={sectionStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
                    <span style={labelStyle}>Opacity</span>
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
            </div>

            {/* ════════ Font Size (text) ════════ */}
            {hasTextSelected && (
                <>
                    <hr style={dividerStyle} />
                    <div style={sectionStyle}>
                        <span style={labelStyle}>Font size</span>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                            {FONT_SIZES.map((sz) => (
                                <button
                                    key={sz}
                                    style={{ ...textBtnStyle(displayStyle.fontSize === sz), flex: 'none', width: 28, padding: '2px 0' }}
                                    onClick={() => apply({ fontSize: sz })}
                                >
                                    {sz}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* ════════ Font Family (text) ════════ */}
                    <div style={sectionStyle}>
                        <span style={labelStyle}>Font family</span>
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
                    </div>
                </>
            )}

            {/* ════════ Image Scale Mode ════════ */}
            {selectedImage && (
                <>
                    <hr style={dividerStyle} />
                    <div style={sectionStyle}>
                        <span style={labelStyle}>Scale mode</span>
                        <div style={toggleRowStyle}>
                            {(['stretch', 'fit', 'fill'] as ImageScaleMode[]).map((mode) => {
                                const active = selectedImage.scaleMode === mode;
                                return (
                                    <button
                                        key={mode}
                                        style={textBtnStyle(active)}
                                        title={mode === 'stretch' ? 'Stretch to fill' : mode === 'fit' ? 'Fit (contain)' : 'Fill (cover)'}
                                        onClick={() => {
                                            updateElement(selectedImage.id, { scaleMode: mode } as Partial<ImageElement>);
                                            pushHistory();
                                        }}
                                    >
                                        {mode.charAt(0).toUpperCase() + mode.slice(1)}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* ════════ Image Corner Radius ════════ */}
                    <div style={sectionStyle}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
                            <span style={labelStyle}>Corner radius</span>
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
                    </div>

                    {/* ════════ Image Replace ════════ */}
                    <div style={sectionStyle}>
                        <button
                            style={{
                                width: '100%', padding: '5px 0', borderRadius: 4,
                                border: `1px solid ${theme.toolbarBorder}`, background: 'transparent',
                                cursor: 'pointer', fontSize: 10, fontWeight: 500, color: theme.textColor,
                                outline: 'none',
                            }}
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
                        </button>
                    </div>
                </>
            )}

            {/* ════════ Layers ════════ */}
            {hasSelection && (
                <>
                    <hr style={dividerStyle} />
                    <div style={sectionStyle}>
                        <span style={labelStyle}>Layers</span>
                        <div style={toggleRowStyle}>
                            {([
                                { fn: sendToBack, icon: LayerIcons.sendToBack, tip: 'Send to back', key: 'ly-stb' },
                                { fn: sendBackward, icon: LayerIcons.sendBackward, tip: 'Send backward', key: 'ly-sb' },
                                { fn: bringForward, icon: LayerIcons.bringForward, tip: 'Bring forward', key: 'ly-bf' },
                                { fn: bringToFront, icon: LayerIcons.bringToFront, tip: 'Bring to front', key: 'ly-btf' },
                            ] as const).map(({ fn, icon, tip, key }) => (
                                <button
                                    key={key}
                                    style={actionBtnStyle(key)}
                                    title={tip}
                                    onMouseEnter={() => setHoveredBtn(key)}
                                    onMouseLeave={() => setHoveredBtn(null)}
                                    onClick={() => { fn(selectedIds); pushHistory(); }}
                                >
                                    {icon(hoveredBtn === key ? theme.activeToolColor : theme.textColor)}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* ════════ Actions ════════ */}
                    <div style={sectionStyle}>
                        <span style={labelStyle}>Actions</span>
                        <div style={toggleRowStyle}>
                            <button
                                style={actionBtnStyle('act-dup')}
                                title="Duplicate (⌘D)"
                                onMouseEnter={() => setHoveredBtn('act-dup')}
                                onMouseLeave={() => setHoveredBtn(null)}
                                onClick={() => duplicateElements(selectedIds)}
                            >
                                {ActionIcons.duplicate(hoveredBtn === 'act-dup' ? theme.activeToolColor : theme.textColor)}
                            </button>
                            <button
                                style={actionBtnStyle('act-del')}
                                title="Delete (⌫)"
                                onMouseEnter={() => setHoveredBtn('act-del')}
                                onMouseLeave={() => setHoveredBtn(null)}
                                onClick={() => { deleteElements(selectedIds); pushHistory(); }}
                            >
                                {ActionIcons.delete(hoveredBtn === 'act-del' ? '#e03131' : theme.textColor)}
                            </button>
                            <button
                                style={{ ...actionBtnStyle('act-link'), opacity: 0.35, cursor: 'not-allowed' }}
                                title="Add link (coming soon)"
                                disabled
                            >
                                {ActionIcons.link(theme.mutedTextColor)}
                            </button>
                            <button
                                style={actionBtnStyle('act-ung')}
                                title="Ungroup"
                                onMouseEnter={() => setHoveredBtn('act-ung')}
                                onMouseLeave={() => setHoveredBtn(null)}
                                onClick={() => {
                                    const store = useCanvasStore.getState();
                                    store.ungroupElements(selectedIds);
                                    pushHistory();
                                }}
                            >
                                {ActionIcons.ungroup(hoveredBtn === 'act-ung' ? theme.activeToolColor : theme.textColor)}
                            </button>
                        </div>
                    </div>
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
