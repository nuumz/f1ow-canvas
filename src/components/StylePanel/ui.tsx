/**
 * StylePanel — Shared UI primitives
 *
 * Provides consistent, theme-aware building blocks for the StylePanel:
 *   • PanelButton      — icon button with toggle / action variants
 *   • PanelTextButton  — text-label button (font size, scale mode, …)
 *   • PanelSection     — labelled section wrapper with optional header action
 *   • ButtonRow        — horizontal flex row for button groups
 *   • CompactDropdownPicker — inline compact dropdown selector
 */

import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { FlowCanvasTheme } from '../../lib/FlowCanvasProps';

// ─────────────────────────────────────────────────────────────────────────────
// PanelButton
// ─────────────────────────────────────────────────────────────────────────────

export interface PanelButtonProps {
    /** Theme for color tokens */
    theme: FlowCanvasTheme;
    /**
     * 'toggle'  (default) — highlights with border + tinted bg when `isActive`
     * 'action'             — no active state; hover-only background tint
     */
    variant?: 'toggle' | 'action';
    /** Active / selected state (used in toggle variant) */
    isActive?: boolean;
    /** When hovered, use danger (red) color instead of accent */
    dangerHover?: boolean;
    onClick?: () => void;
    title?: string;
    disabled?: boolean;
    width?: number | string;
    height?: number;
    style?: React.CSSProperties;
    /**
     * Children may be a render-prop that receives `isHighlighted` so icons
     * can change colour on hover/active without needing external hover state.
     *
     * `isHighlighted` is true when the button is hovered OR active.
     */
    children: React.ReactNode | ((isHighlighted: boolean) => React.ReactNode);
}

export const PanelButton: React.FC<PanelButtonProps> = ({
    theme,
    variant = 'toggle',
    isActive = false,
    dangerHover = false,
    onClick,
    title,
    disabled = false,
    width = 28,
    height = 28,
    style,
    children,
}) => {
    const [isHovered, setIsHovered] = useState(false);
    const isHighlighted = isActive || isHovered;

    const borderColor = (): string => {
        if (variant === 'toggle' && isActive) return `1.5px solid ${theme.activeToolColor}`;
        return '1px solid #e0e3e7';
    };

    const bgColor = (): string => {
        if (variant === 'toggle' && isActive) return `${theme.activeToolColor}10`;
        if (isHovered) return '#f3f4f6';
        return 'transparent';
    };

    return (
        <button
            title={title}
            onClick={disabled ? undefined : onClick}
            disabled={disabled}
            onMouseEnter={() => !disabled && setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            style={{
                width,
                height,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 5,
                border: borderColor(),
                background: bgColor(),
                cursor: disabled ? 'not-allowed' : 'pointer',
                color: isActive ? theme.activeToolColor : theme.textColor,
                transition: 'background 0.1s, border-color 0.1s',
                outline: 'none',
                padding: 0,
                opacity: disabled ? 0.35 : 1,
                flexShrink: 0,
                ...style,
            }}
        >
            {typeof children === 'function'
                ? children(isHighlighted)
                : children}
        </button>
    );
};

/** Computed icon color helper — use inside PanelButton's render-prop children */
export const iconColor = (
    isHighlighted: boolean,
    theme: FlowCanvasTheme,
    options?: { danger?: boolean; isActive?: boolean },
): string => {
    if (options?.isActive) return theme.activeToolColor;
    if (isHighlighted) {
        return options?.danger ? '#e03131' : theme.activeToolColor;
    }
    return theme.textColor;
};

// ─────────────────────────────────────────────────────────────────────────────
// PanelTextButton
// ─────────────────────────────────────────────────────────────────────────────

export interface PanelTextButtonProps {
    theme: FlowCanvasTheme;
    isActive?: boolean;
    onClick?: () => void;
    title?: string;
    disabled?: boolean;
    flex?: number | string;
    width?: number | string;
    children: React.ReactNode;
    style?: React.CSSProperties;
}

export const PanelTextButton: React.FC<PanelTextButtonProps> = ({
    theme,
    isActive = false,
    onClick,
    title,
    disabled,
    flex = 1,
    width,
    children,
    style,
}) => (
    <button
        title={title}
        onClick={onClick}
        disabled={disabled}
        style={{
            flex,
            width,
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
            ...style,
        }}
    >
        {children}
    </button>
);

// ─────────────────────────────────────────────────────────────────────────────
// PanelSection
// ─────────────────────────────────────────────────────────────────────────────

export interface PanelSectionProps {
    theme: FlowCanvasTheme;
    /** Section label rendered as small bold uppercase caption */
    label?: string;
    /** Optional element rendered on the right side of the header (e.g. a dropdown) */
    headerAction?: React.ReactNode;
    /** Section body content — can be omitted for header-only sections */
    children?: React.ReactNode;
    style?: React.CSSProperties;
}

export const PanelSection: React.FC<PanelSectionProps> = ({
    theme,
    label,
    headerAction,
    children,
    style,
}) => (
    <div style={{ marginBottom: 10, ...style }}>
        {label && (
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: headerAction ? 'space-between' : 'flex-start',
                marginBottom: headerAction ? 0 : 5,
            }}>
                <span style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: theme.mutedTextColor,
                    letterSpacing: 0.2,
                }}>
                    {label}
                </span>
                {headerAction}
            </div>
        )}
        {children}
    </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// ButtonRow
// ─────────────────────────────────────────────────────────────────────────────

export const ButtonRow: React.FC<{
    children: React.ReactNode;
    gap?: number;
    wrap?: boolean;
    /** Number of equal-width grid columns. Defaults to 4 so all button groups
     *  fill the full panel width without needing to specify it every time.
     *  Pass 0 (or false-y) to fall back to flex layout (e.g. for wrap rows). */
    columns?: number;
    style?: React.CSSProperties;
}> = ({ children, gap = 5, wrap = false, columns = 4, style }) => (
    <div style={{
        display: columns ? 'grid' : 'flex',
        gridTemplateColumns: columns ? `repeat(${columns}, 1fr)` : undefined,
        gap,
        justifyContent: columns ? undefined : 'flex-start',
        flexWrap: !columns && wrap ? 'wrap' : 'nowrap',
        ...style,
    }}>
        {children}
    </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// CompactDropdownPicker
// ─────────────────────────────────────────────────────────────────────────────

export interface CompactPickerOption {
    value: string | number;
    /** Icon render-prop that receives the current display color */
    icon: React.ReactNode | ((color: string) => React.ReactNode);
    label: string;
}

export interface CompactDropdownPickerProps {
    options: CompactPickerOption[];
    value: string | number;
    onChange: (value: string | number) => void;
    theme: FlowCanvasTheme;
    label: string;
    isOpen: boolean;
    onToggle: () => void;
    pickerRef: React.RefObject<HTMLDivElement | null>;
    /** Number of columns in the dropdown grid. Defaults to all items in a single row. */
    columns?: number;
    /** Additional styles applied to the outer wrapper element */
    style?: React.CSSProperties;
}

export const CompactDropdownPicker: React.FC<CompactDropdownPickerProps> = ({
    options,
    value,
    onChange,
    theme,
    label,
    isOpen,
    onToggle,
    pickerRef,
    columns,
    style,
}) => {
    const current = options.find(o => o.value === value) ?? options[0];
    const btnRef = useRef<HTMLButtonElement>(null);
    const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);

    useEffect(() => {
        if (isOpen && btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            setDropPos({ top: rect.bottom + 3, left: rect.left });
        } else {
            setDropPos(null);
        }
    }, [isOpen]);

    return (
        <div ref={pickerRef as React.RefObject<HTMLDivElement>} style={{ position: 'relative', display: 'inline-flex', ...style }}>
            {/* Trigger button */}
            <button
                ref={btnRef}
                title={`${label}: ${current.label}`}
                onClick={onToggle}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    width: '100%',
                    height: 28,
                    padding: '0 8px',
                    borderRadius: 6,
                    border: isOpen ? `1.5px solid ${theme.activeToolColor}` : '1px solid #e0e3e7',
                    background: isOpen ? `${theme.activeToolColor}10` : 'transparent',
                    cursor: 'pointer',
                    color: isOpen ? theme.activeToolColor : theme.textColor,
                    outline: 'none',
                    transition: 'background 0.15s, border-color 0.15s',
                    boxShadow: isOpen ? `0 0 0 2px ${theme.activeToolColor}20` : 'none',
                }}
            >
                {typeof current.icon === 'function'
                    ? current.icon(isOpen ? theme.activeToolColor : theme.textColor)
                    : current.icon}
            </button>

            {/* Dropdown portal */}
            {isOpen && dropPos && createPortal(
                <div
                    data-compact-dropdown="true"
                    style={{
                        position: 'fixed',
                        top: dropPos.top,
                        left: dropPos.left,
                        background: theme.panelBg,
                        border: `1px solid ${theme.toolbarBorder}`,
                        borderRadius: 6,
                        padding: 3,
                        boxShadow: '0 3px 12px rgba(0,0,0,0.1)',
                        zIndex: 9999,
                        display: 'grid',
                        gridTemplateColumns: columns
                            ? `repeat(${columns}, 26px)`
                            : `repeat(${options.length}, 26px)`,
                        gap: 1,
                    }}
                >
                    {options.map(opt => {
                        const isActive = opt.value === value;
                        const iconColor = isActive ? theme.activeToolColor : theme.textColor;
                        return (
                            <button
                                key={String(opt.value)}
                                title={opt.label}
                                onClick={() => { onChange(opt.value); onToggle(); }}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    width: 26,
                                    height: 26,
                                    borderRadius: 4,
                                    border: isActive
                                        ? `1.5px solid ${theme.activeToolColor}`
                                        : '1px solid transparent',
                                    background: isActive
                                        ? `${theme.activeToolColor}10`
                                        : 'transparent',
                                    cursor: 'pointer',
                                    color: iconColor,
                                    outline: 'none',
                                }}
                            >
                                {typeof opt.icon === 'function' ? opt.icon(iconColor) : opt.icon}
                            </button>
                        );
                    })}
                </div>,
                document.body,
            )}
        </div>
    );
};
