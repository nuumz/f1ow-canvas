/**
 * image.ts — Utilities for image loading, file-to-dataURL conversion,
 * paste/drop handling, and image element creation.
 */

import type { ImageElement, ElementStyle } from '@/types';
import { generateId } from './id';
import { DEFAULT_STYLE } from '@/constants';

// ─── Max dimensions for initial placement ─────────────────────
const MAX_INITIAL_WIDTH = 800;
const MAX_INITIAL_HEIGHT = 600;

/**
 * Read a File (image) as a base64 data URL.
 */
export function fileToDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}

/**
 * Load an HTMLImageElement from a src URL (data URL or external).
 * Returns the loaded image with its natural dimensions.
 */
export function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = src;
    });
}

/**
 * Compute element dimensions that fit the image within max bounds
 * while preserving aspect ratio.
 */
export function computeImageElementDimensions(
    naturalWidth: number,
    naturalHeight: number,
    maxWidth = MAX_INITIAL_WIDTH,
    maxHeight = MAX_INITIAL_HEIGHT,
): { width: number; height: number } {
    if (naturalWidth <= maxWidth && naturalHeight <= maxHeight) {
        return { width: naturalWidth, height: naturalHeight };
    }
    const aspect = naturalWidth / naturalHeight;
    const boxAspect = maxWidth / maxHeight;
    if (aspect > boxAspect) {
        return { width: maxWidth, height: maxWidth / aspect };
    }
    return { width: maxHeight * aspect, height: maxHeight };
}

/**
 * Create an ImageElement from a loaded image and its data URL.
 */
export function createImageElement(
    src: string,
    naturalWidth: number,
    naturalHeight: number,
    x: number,
    y: number,
    style: ElementStyle = { ...DEFAULT_STYLE },
): ImageElement {
    const dims = computeImageElementDimensions(naturalWidth, naturalHeight);
    return {
        id: generateId(),
        type: 'image',
        x: x - dims.width / 2,
        y: y - dims.height / 2,
        width: dims.width,
        height: dims.height,
        rotation: 0,
        style: { ...style, fillColor: 'transparent' },
        isLocked: false,
        isVisible: true,
        boundElements: null,
        src,
        naturalWidth,
        naturalHeight,
        scaleMode: 'stretch',
        crop: null,
        cornerRadius: 0,
        alt: '',
    };
}

/**
 * Extract image files from a DataTransfer (paste/drop).
 */
export function getImageFilesFromDataTransfer(dt: DataTransfer): File[] {
    const files: File[] = [];
    if (dt.files) {
        for (let i = 0; i < dt.files.length; i++) {
            const f = dt.files[i];
            if (f.type.startsWith('image/')) files.push(f);
        }
    }
    return files;
}

/**
 * Check synchronously whether a ClipboardEvent contains image data.
 * Must be called during the event handler (before any await),
 * because browsers invalidate clipboardData after the handler returns.
 */
export function extractImageDataFromClipboard(e: ClipboardEvent): {
    file: File | null;
    imgUrl: string | null;
} {
    const dt = e.clipboardData;
    if (!dt) return { file: null, imgUrl: null };

    // Check for image files first (e.g. screenshot paste, copy-image)
    const files = getImageFilesFromDataTransfer(dt);
    if (files.length > 0) {
        return { file: files[0], imgUrl: null };
    }

    // Check for HTML with <img> tags (e.g., copy image from browser)
    const html = dt.getData('text/html');
    if (html) {
        const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (match?.[1]) {
            return { file: null, imgUrl: match[1] };
        }
    }

    return { file: null, imgUrl: null };
}

/**
 * Check synchronously whether a ClipboardEvent has image content.
 */
export function clipboardHasImage(e: ClipboardEvent): boolean {
    const { file, imgUrl } = extractImageDataFromClipboard(e);
    return file !== null || imgUrl !== null;
}

/**
 * Resolve the extracted clipboard image data into a data URL.
 * This is the async part — call AFTER synchronous extraction.
 */
export async function resolveImageSource(data: { file: File | null; imgUrl: string | null }): Promise<string | null> {
    if (data.file) {
        return fileToDataURL(data.file);
    }
    if (data.imgUrl) {
        try {
            const img = await loadImage(data.imgUrl);
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.drawImage(img, 0, 0);
                return canvas.toDataURL('image/png');
            }
        } catch {
            // If CORS fails, use the URL directly
            return data.imgUrl;
        }
    }
    return null;
}

/**
 * Open a file picker dialog for images.
 * Returns an array of selected image files.
 */
export function openImageFilePicker(): Promise<File[]> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.style.display = 'none';
        input.onchange = () => {
            const files: File[] = [];
            if (input.files) {
                for (let i = 0; i < input.files.length; i++) {
                    files.push(input.files[i]);
                }
            }
            resolve(files);
            document.body.removeChild(input);
        };
        input.oncancel = () => {
            resolve([]);
            document.body.removeChild(input);
        };
        document.body.appendChild(input);
        input.click();
    });
}
