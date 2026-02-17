/**
 * ContextMenu.tsx — Right-click context menu for canvas elements.
 * Shows relevant actions based on selection state.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';

export interface ContextMenuItem {
    label: string;
    shortcut?: string;
    action: () => void;
    disabled?: boolean;
    divider?: boolean;
}

interface ContextMenuProps {
    x: number;
    y: number;
    items: ContextMenuItem[];
    onClose: () => void;
    theme: {
        panelBg: string;
        toolbarBorder: string;
        textColor: string;
        mutedTextColor: string;
        activeToolColor: string;
    };
}

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose, theme }) => {
    const menuRef = useRef<HTMLDivElement>(null);
    const [adjustedPos, setAdjustedPos] = useState({ x, y });
    const [visible, setVisible] = useState(false);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    // Adjust position to keep menu within viewport + trigger fade-in
    useEffect(() => {
        const el = menuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const parent = el.parentElement;
        if (!parent) return;
        const parentRect = parent.getBoundingClientRect();

        let ax = x;
        let ay = y;

        if (x + rect.width > parentRect.width) {
            ax = Math.max(0, x - rect.width);
        }
        if (y + rect.height > parentRect.height) {
            ay = Math.max(0, y - rect.height);
        }

        setAdjustedPos({ x: ax, y: ay });
        // Trigger fade-in on next frame
        requestAnimationFrame(() => setVisible(true));
    }, [x, y]);

    // Stable close handler that uses ref to avoid re-registering listeners
    const closeMenu = useCallback(() => {
        onCloseRef.current();
    }, []);

    // Close on outside click, right-click, scroll, or Escape
    useEffect(() => {
        const handlePointerDown = (e: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                closeMenu();
            }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeMenu();
        };
        const handleScroll = () => closeMenu();

        // Use requestAnimationFrame instead of setTimeout for more reliable timing
        const rafId = requestAnimationFrame(() => {
            document.addEventListener('pointerdown', handlePointerDown, true);
            document.addEventListener('keydown', handleKeyDown, true);
            window.addEventListener('scroll', handleScroll, true);
        });
        return () => {
            cancelAnimationFrame(rafId);
            document.removeEventListener('pointerdown', handlePointerDown, true);
            document.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('scroll', handleScroll, true);
        };
    }, [closeMenu]);

    return (
        <div
            ref={menuRef}
            style={{
                position: 'absolute',
                left: adjustedPos.x,
                top: adjustedPos.y,
                zIndex: 1000,
                background: theme.panelBg,
                border: `1px solid ${theme.toolbarBorder}`,
                borderRadius: 8,
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                padding: '4px 0',
                minWidth: 180,
                backdropFilter: 'blur(8px)',
                userSelect: 'none',
                opacity: visible ? 1 : 0,
                transform: visible ? 'scale(1)' : 'scale(0.95)',
                transformOrigin: 'top left',
                transition: 'opacity 0.12s ease-out, transform 0.12s ease-out',
            }}
            onContextMenu={(e) => e.preventDefault()}
        >
            {items.map((item, i) => (
                <React.Fragment key={i}>
                    {item.divider && (
                        <div
                            style={{
                                height: 1,
                                background: theme.toolbarBorder,
                                margin: '4px 0',
                            }}
                        />
                    )}
                    <button
                        onClick={() => {
                            if (!item.disabled) {
                                item.action();
                                onClose();
                            }
                        }}
                        disabled={item.disabled}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            width: '100%',
                            padding: '6px 12px',
                            border: 'none',
                            background: 'transparent',
                            color: item.disabled ? theme.mutedTextColor : theme.textColor,
                            fontSize: 13,
                            cursor: item.disabled ? 'default' : 'pointer',
                            textAlign: 'left',
                            fontFamily: 'inherit',
                            lineHeight: '20px',
                        }}
                        onMouseEnter={(e) => {
                            if (!item.disabled) {
                                (e.currentTarget as HTMLElement).style.background =
                                    theme.activeToolColor + '18';
                            }
                        }}
                        onMouseLeave={(e) => {
                            (e.currentTarget as HTMLElement).style.background = 'transparent';
                        }}
                    >
                        <span>{item.label}</span>
                        {item.shortcut && (
                            <span
                                style={{
                                    color: theme.mutedTextColor,
                                    fontSize: 11,
                                    marginLeft: 24,
                                    opacity: 0.8,
                                }}
                            >
                                {item.shortcut}
                            </span>
                        )}
                    </button>
                </React.Fragment>
            ))}
        </div>
    );
};

export default React.memo(ContextMenu);
