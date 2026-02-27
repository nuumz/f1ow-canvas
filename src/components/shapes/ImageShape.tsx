import React, { useEffect, useState, useCallback } from 'react';
import { Group, Image as KonvaImage, Rect } from 'react-konva';
import type Konva from 'konva';
import type { ImageElement } from '@/types';
import { snapToGrid } from '@/utils/geometry';

// ── Global image cache ───────────────────────────────────────
// Prevents costly re-decode when ImageShape remounts during
// layer transitions (selected ↔ unselected). Without this,
// useState resets to null on remount → placeholder flashes.
const IMAGE_CACHE_LIMIT = 50;
const _imgCache = new Map<string, HTMLImageElement>();

function cachedLoadImage(
    src: string,
    onLoad: (img: HTMLImageElement) => void,
    onError: () => void,
): () => void {
    // Cache hit — return synchronously (no placeholder flash)
    const cached = _imgCache.get(src);
    if (cached) {
        onLoad(cached);
        return () => {};
    }

    // Cache miss — async load
    const img = new window.Image();
    // Only set crossOrigin for real URLs — data: URLs have no origin
    // and crossOrigin can cause silent load failures in Safari.
    if (!src.startsWith('data:')) {
        img.crossOrigin = 'anonymous';
    }
    img.onload = () => {
        // LRU eviction
        if (_imgCache.size >= IMAGE_CACHE_LIMIT) {
            const oldest = _imgCache.keys().next().value;
            if (oldest !== undefined) _imgCache.delete(oldest);
        }
        _imgCache.set(src, img);
        onLoad(img);
    };
    img.onerror = () => onError();
    img.src = src;
    return () => { img.onload = null; img.onerror = null; };
}

interface Props {
    element: ImageElement;
    isSelected: boolean;
    /** When true, individual drag is disabled — the parent KonvaGroup handles dragging */
    isGrouped?: boolean;
    onSelect: (id: string) => void;
    onChange: (id: string, updates: Partial<ImageElement>) => void;
    onDragMove?: (id: string, updates: Partial<ImageElement>) => void;
    onDoubleClick?: (id: string) => void;
    gridSnap?: number;
    onDragSnap?: (id: string, bounds: { x: number; y: number; width: number; height: number }) => { x: number; y: number } | null;
}

/**
 * ImageShape — renders an image element on the Konva canvas.
 *
 * Supports three scale modes:
 *   - stretch: image fills bounding box (may distort aspect ratio)
 *   - fit (contain): image fits inside box, preserving aspect ratio, with letterbox
 *   - fill (cover): image fills box via native Konva crop, preserving aspect ratio
 *
 * Uses `onTransform` to bake Transformer scale into actual dimensions every
 * frame so that fit/fill/clip layouts recompute live during resize.
 */
const ImageShape: React.FC<Props> = ({
    element, isSelected, isGrouped, onSelect, onChange, onDragMove, onDoubleClick, gridSnap, onDragSnap,
}) => {
    const { id, x, y, width, height, rotation, src, style, crop, cornerRadius, scaleMode, isLocked } = element;
    // Initialize from global cache so the very first render already has the
    // image — critical because StaticElementsLayer caches the Layer bitmap
    // on the same frame.  If we waited for useEffect the cache would capture
    // the placeholder instead of the actual image.
    const [image, setImage] = useState<HTMLImageElement | null>(() => _imgCache.get(src) ?? null);
    const [loadError, setLoadError] = useState(() => !src);

    // ── Live dimensions during transform ─────────────────────
    // During Transformer resize, we bake scaleX/scaleY into actual w/h so
    // the fit/fill/clip calculations recompute correctly every frame.
    const [liveSize, setLiveSize] = useState<{ w: number; h: number }>({ w: width, h: height });

    // Sync from props whenever the element dimensions change externally
    useEffect(() => { setLiveSize({ w: width, h: height }); }, [width, height]);

    const rw = liveSize.w;
    const rh = liveSize.h;

    // ── Load image from src ──────────────────────────────────
    useEffect(() => {
        if (!src) { setImage(null); setLoadError(true); return; }
        return cachedLoadImage(
            src,
            (img) => { setImage(img); setLoadError(false); },
            () => { setImage(null); setLoadError(true); },
        );
    }, [src]);

    // ── Drag handlers ────────────────────────────────────────
    const handleDragMove = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
        let nx = e.target.x(), ny = e.target.y();
        if (gridSnap) {
            nx = snapToGrid(nx, gridSnap);
            ny = snapToGrid(ny, gridSnap);
            e.target.x(nx);
            e.target.y(ny);
        }
        if (!gridSnap && onDragSnap) {
            const snapped = onDragSnap(id, { x: nx, y: ny, width, height });
            if (snapped) { nx = snapped.x; ny = snapped.y; e.target.x(nx); e.target.y(ny); }
        }
        onDragMove?.(id, { x: nx, y: ny });
    }, [id, width, height, gridSnap, onDragSnap, onDragMove]);

    const handleDragEnd = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
        let nx = e.target.x(), ny = e.target.y();
        if (gridSnap) { nx = snapToGrid(nx, gridSnap); ny = snapToGrid(ny, gridSnap); }
        onChange(id, { x: nx, y: ny });
    }, [id, gridSnap, onChange]);

    // ── Transform handlers ───────────────────────────────────
    // Bake Transformer scale into actual width/height every frame so that
    // fit/fill calculations and clipFunc use correct dimensions live.
    const handleTransform = useCallback((e: Konva.KonvaEventObject<Event>) => {
        const node = e.target;
        const sx = node.scaleX();
        const sy = node.scaleY();
        const newW = Math.max(10, node.width() * sx);
        const newH = Math.max(10, node.height() * sy);
        node.setAttrs({ scaleX: 1, scaleY: 1, width: newW, height: newH });
        setLiveSize({ w: newW, h: newH });
        onDragMove?.(id, { x: node.x(), y: node.y(), width: newW, height: newH });
    }, [id, onDragMove]);

    const handleTransformEnd = useCallback((e: Konva.KonvaEventObject<Event>) => {
        const node = e.target;
        onChange(id, {
            x: node.x(),
            y: node.y(),
            width: Math.max(10, node.width()),
            height: Math.max(10, node.height()),
            rotation: node.rotation(),
        });
    }, [id, onChange]);

    // ── Compute image layout per scale mode ──────────────────
    let imgX = 0, imgY = 0, imgW = rw, imgH = rh;
    let konvaCrop: { x: number; y: number; width: number; height: number } | undefined;

    // User-defined crop takes priority
    if (crop) {
        konvaCrop = { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
    }

    if (image) {
        // Use crop dimensions as "source" size when crop is explicitly set
        const srcW = crop ? crop.width : image.naturalWidth;
        const srcH = crop ? crop.height : image.naturalHeight;

        if (scaleMode === 'fit') {
            // Contain: fit image inside box, centering with letterbox
            const imgAspect = srcW / srcH;
            const boxAspect = rw / rh;
            if (imgAspect > boxAspect) {
                imgW = rw;
                imgH = rw / imgAspect;
                imgY = (rh - imgH) / 2;
            } else {
                imgH = rh;
                imgW = rh * imgAspect;
                imgX = (rw - imgW) / 2;
            }
        } else if (scaleMode === 'fill' && !crop) {
            // Cover: compute source crop so that, when stretched to rw×rh,
            // the image fills the box with correct aspect ratio.
            const natW = image.naturalWidth;
            const natH = image.naturalHeight;
            const natAspect = natW / natH;
            const boxAspect = rw / rh;
            if (natAspect > boxAspect) {
                // Source is wider → crop left/right
                const cropW = natH * boxAspect;
                konvaCrop = { x: (natW - cropW) / 2, y: 0, width: cropW, height: natH };
            } else {
                // Source is taller → crop top/bottom
                const cropH = natW / boxAspect;
                konvaCrop = { x: 0, y: (natH - cropH) / 2, width: natW, height: cropH };
            }
            imgW = rw;
            imgH = rh;
        }
        // stretch: imgX=0, imgY=0, imgW=rw, imgH=rh (defaults)
    }

    // ── Clip function for rounded corners ────────────────────
    // Only used when cornerRadius > 0. Ensures all children (image, background,
    // border) are clipped to the rounded bounding box.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clipFunc = cornerRadius > 0 ? (ctx: any) => {
        const cr = Math.min(cornerRadius, rw / 2, rh / 2);
        ctx.beginPath();
        ctx.moveTo(cr, 0);
        ctx.lineTo(rw - cr, 0);
        ctx.arcTo(rw, 0, rw, cr, cr);
        ctx.lineTo(rw, rh - cr);
        ctx.arcTo(rw, rh, rw - cr, rh, cr);
        ctx.lineTo(cr, rh);
        ctx.arcTo(0, rh, 0, rh - cr, cr);
        ctx.lineTo(0, cr);
        ctx.arcTo(0, 0, cr, 0, cr);
        ctx.closePath();
    } : undefined;

    // Shared Group props
    const groupProps = {
        id,
        x,
        y,
        width: rw,
        height: rh,
        rotation,
        transformsEnabled: (rotation ? 'all' : 'position') as 'all' | 'position',
        draggable: !isLocked && !isGrouped,
        clipFunc,
        onClick: () => onSelect(id),
        onTap: () => onSelect(id),
        onDblClick: () => onDoubleClick?.(id),
        onDblTap: () => onDoubleClick?.(id),
        onDragMove: handleDragMove,
        onDragEnd: handleDragEnd,
        onTransform: handleTransform,
        onTransformEnd: handleTransformEnd,
    };

    // ── Placeholder (loading / error) ────────────────────────
    if (!image || loadError) {
        return (
            <Group {...groupProps}>
                <Rect
                    width={rw}
                    height={rh}
                    fill="#f0f0f0"
                    stroke={style.strokeColor}
                    strokeWidth={style.strokeWidth}
                    cornerRadius={cornerRadius}
                    opacity={style.opacity}
                    perfectDrawEnabled={false}
                    shadowForStrokeEnabled={false}
                />
            </Group>
        );
    }

    // ── Main render ──────────────────────────────────────────
    return (
        <Group
            {...groupProps}
            shadowColor={isSelected ? '#4f8df7' : undefined}
            shadowBlur={isSelected ? 6 : 0}
            shadowOpacity={isSelected ? 0.5 : 0}
        >
            {/* Hit-target: transparent rect covering the full bounding box so
                the Group always has a hit area for click/drag/select events.
                Without this, stretch/fill modes have all children as
                listening={false} and the Group becomes un-clickable. */}
            <Rect
                width={rw}
                height={rh}
                fill={scaleMode === 'fit'
                    ? (style.fillColor === 'transparent' ? undefined : style.fillColor)
                    : 'transparent'}
                cornerRadius={cornerRadius}
                perfectDrawEnabled={false}
            />

            {/* The actual image */}
            <KonvaImage
                image={image}
                x={imgX}
                y={imgY}
                width={imgW}
                height={imgH}
                crop={konvaCrop}
                opacity={style.opacity}
                listening={false}
                perfectDrawEnabled={false}
            />

            {/* Border stroke */}
            {style.strokeWidth > 0 && style.strokeColor !== 'transparent' && (
                <Rect
                    width={rw}
                    height={rh}
                    stroke={style.strokeColor}
                    strokeWidth={style.strokeWidth}
                    cornerRadius={cornerRadius}
                    listening={false}
                />
            )}
        </Group>
    );
};

export default React.memo(ImageShape);
