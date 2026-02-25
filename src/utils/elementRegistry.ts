/**
 * ─── Element Registry ────────────────────────────────────────────────────────
 *
 * A plugin/extension point that lets consumers register custom element types
 * alongside the 8 built-in types.  Every element passing through
 * `addElement`, `updateElement`, or `setElements` is validated here first.
 *
 * Built-in types (rectangle | ellipse | diamond | line | arrow |
 * freedraw | text | image) are pre-validated with field-level checks.
 * Custom types only need to pass the common base checks; additional
 * field validation is supplied via the `validate` callback.
 *
 * @example — register a custom type globally before rendering:
 * ```ts
 * import { registerCustomElement } from 'f1ow';
 *
 * registerCustomElement({
 *   type: 'sticky-note',
 *   displayName: 'Sticky Note',
 *   validate: (el) => typeof el.content === 'string' || 'content must be a string',
 *   defaults: { content: '', color: '#ffeb3b' },
 * });
 * ```
 *
 * @example — or pass directly to the component (registered on mount):
 * ```tsx
 * <FlowCanvas
 *   customElementTypes={[{
 *     type: 'sticky-note',
 *     validate: (el) => typeof el.content === 'string' || 'content must be a string',
 *   }]}
 * />
 * ```
 */

// ─── Public types ─────────────────────────────────────────────────────────────

/** Result of a validation call. */
export type ValidationResult =
    | { valid: true }
    | { valid: false; error: string };

/**
 * Configuration object for a custom element type.
 *
 * @template T - Shape of the custom element's extra fields.
 */
export interface CustomElementConfig<
    T extends Record<string, unknown> = Record<string, unknown>
> {
    /**
     * Unique type identifier.
     * Must not conflict with a built-in type unless `allowOverride` is `true`.
     */
    type: string;

    /** Human-readable name used in error/warning messages. Defaults to `type`. */
    displayName?: string;

    /**
     * Additional validator for type-specific fields.
     * Called **after** base-field (id, x, y, width, height, rotation, style)
     * validation passes.
     *
     * Return `true` if the element is valid, or a string describing the error.
     */
    validate?: (element: Record<string, unknown>) => true | string;

    /**
     * Default field values merged into the element object when it is added via
     * `addElement`.  Fields already present on the element are NOT overwritten.
     * Only applied to elements whose type matches this config.
     */
    defaults?: Partial<T>;

    /**
     * Allow replacing an existing registration (built-in or custom).
     * Useful when a consumer wants to tighten / relax built-in validation.
     * Default: `false`.
     */
    allowOverride?: boolean;
}

// ─── Internal constants ───────────────────────────────────────────────────────

/** All 8 built-in element types. */
const BUILTIN_TYPES = new Set<string>([
    'rectangle',
    'ellipse',
    'diamond',
    'line',
    'arrow',
    'freedraw',
    'text',
    'image',
]);

const VALID_TEXT_ALIGNS     = new Set(['left', 'center', 'right']);
const VALID_VERTICAL_ALIGNS = new Set(['top', 'middle', 'bottom']);
const VALID_IMAGE_SCALES    = new Set(['fit', 'fill', 'stretch']);
const VALID_LINE_TYPES      = new Set(['sharp', 'curved', 'elbow']);

// ─── Registry class ───────────────────────────────────────────────────────────

class ElementRegistryClass {
    private customs = new Map<string, CustomElementConfig>();

    // ── Registration ──────────────────────────────────────────

    /**
     * Register a custom element type.
     *
     * @throws If the type already exists and `allowOverride` is not `true`.
     */
    register(config: CustomElementConfig): void {
        if (BUILTIN_TYPES.has(config.type) && !config.allowOverride) {
            throw new Error(
                `[f1ow] Cannot register custom element type "${config.type}" — ` +
                `it conflicts with a built-in type. ` +
                `Set allowOverride: true if you intentionally want to replace the built-in validator.`,
            );
        }
        if (this.customs.has(config.type) && !config.allowOverride) {
            throw new Error(
                `[f1ow] Element type "${config.type}" is already registered. ` +
                `Set allowOverride: true to replace the existing registration.`,
            );
        }
        this.customs.set(config.type, config);
    }

    // ── Queries ───────────────────────────────────────────────

    /** Returns `true` if the type is known (built-in or custom). */
    isRegistered(type: string): boolean {
        return BUILTIN_TYPES.has(type) || this.customs.has(type);
    }

    /** Retrieve the custom config for a type (undefined for built-in types). */
    getCustomConfig(type: string): CustomElementConfig | undefined {
        return this.customs.get(type);
    }

    /** All registered type names, built-in first then custom. */
    getRegisteredTypes(): string[] {
        return [...BUILTIN_TYPES, ...this.customs.keys()];
    }

    // ── Validation ────────────────────────────────────────────

    /**
     * Validate a full element before it enters the canvas store.
     *
     * Checks:
     * 1. Non-null object with required base fields (id, type, x, y, w, h, rotation, style)
     * 2. `type` is a known/registered type
     * 3. Type-specific field checks for all 8 built-in types
     * 4. Custom `validate` callback (custom types only)
     */
    validateElement(element: unknown): ValidationResult {
        if (!element || typeof element !== 'object' || Array.isArray(element)) {
            return { valid: false, error: 'Element must be a non-null object' };
        }
        const el = element as Record<string, unknown>;

        // ── id ──────────────────────────────────────────────
        if (typeof el.id !== 'string' || el.id.trim() === '') {
            return { valid: false, error: 'Element id must be a non-empty string' };
        }
        const id = el.id as string;

        // ── type ─────────────────────────────────────────────
        if (typeof el.type !== 'string' || !this.isRegistered(el.type)) {
            return {
                valid: false,
                error: `Unknown element type "${el.type}". ` +
                    `Valid types: ${this.getRegisteredTypes().join(', ')}`,
            };
        }

        // ── coordinates ──────────────────────────────────────
        if (typeof el.x !== 'number' || !isFinite(el.x)) {
            return { valid: false, error: `"${id}": x must be a finite number` };
        }
        if (typeof el.y !== 'number' || !isFinite(el.y)) {
            return { valid: false, error: `"${id}": y must be a finite number` };
        }
        if (typeof el.width !== 'number' || !isFinite(el.width) || el.width < 0) {
            return { valid: false, error: `"${id}": width must be a non-negative finite number` };
        }
        if (typeof el.height !== 'number' || !isFinite(el.height) || el.height < 0) {
            return { valid: false, error: `"${id}": height must be a non-negative finite number` };
        }
        if (typeof el.rotation !== 'number' || !isFinite(el.rotation)) {
            return { valid: false, error: `"${id}": rotation must be a finite number` };
        }

        // ── style ─────────────────────────────────────────────
        const styleCheck = this._validateStyle(id, el.style);
        if (!styleCheck.valid) return styleCheck;

        // ── built-in type-specific fields ─────────────────────
        if (BUILTIN_TYPES.has(el.type as string)) {
            const typeCheck = this._validateBuiltinFields(el);
            if (!typeCheck.valid) return typeCheck;
        }

        // ── custom validator ──────────────────────────────────
        const customCfg = this.customs.get(el.type as string);
        if (customCfg?.validate) {
            let result: true | string;
            try {
                result = customCfg.validate(el);
            } catch (err) {
                // If the consumer's validate() throws, treat as a validation failure
                // so the element is rejected cleanly rather than crashing the store.
                const name = customCfg.displayName ?? customCfg.type;
                return {
                    valid: false,
                    error: `Custom element "${name}" validator threw for "${id}": ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                };
            }
            if (result !== true) {
                const name = customCfg.displayName ?? customCfg.type;
                return {
                    valid: false,
                    error: `Custom element "${name}" validation failed for "${id}": ${result}`,
                };
            }
        }

        return { valid: true };
    }

    /**
     * Validate a partial update before it is applied to an existing element.
     *
     * Prevents overwriting immutable fields (`id` and `type`), and checks
     * numeric fields for finiteness.
     */
    validateUpdate(updates: Record<string, unknown>): ValidationResult {
        if ('id' in updates) {
            return { valid: false, error: 'Cannot overwrite element id via updateElement' };
        }
        if ('type' in updates) {
            return {
                valid: false,
                error: 'Cannot overwrite element type via updateElement — use convertElementType instead',
            };
        }
        for (const key of ['x', 'y', 'width', 'height', 'rotation'] as const) {
            if (key in updates) {
                const v = updates[key];
                if (typeof v !== 'number' || !isFinite(v)) {
                    return { valid: false, error: `Update field "${key}" must be a finite number, got: ${v}` };
                }
            }
        }
        return { valid: true };
    }

    // ── Defaults ──────────────────────────────────────────────

    /**
     * Merge custom `defaults` into the element.
     * Existing fields on the element take priority — defaults only fill gaps.
     * Only active when the element's type has a custom config with `defaults`.
     */
    applyDefaults<T extends { type?: unknown }>(element: T): T {
        const type = element.type as string | undefined;
        if (!type) return element;
        const cfg = this.customs.get(type);
        if (!cfg?.defaults) return element;
        // Defaults fill missing keys; element fields win on conflict.
        return { ...cfg.defaults, ...element } as T;
    }

    // ── Private helpers ───────────────────────────────────────

    private _validateStyle(id: string, style: unknown): ValidationResult {
        if (!style || typeof style !== 'object' || Array.isArray(style)) {
            return { valid: false, error: `"${id}": missing or invalid style object` };
        }
        const s = style as Record<string, unknown>;

        if (typeof s.strokeColor !== 'string') {
            return { valid: false, error: `"${id}": style.strokeColor must be a string` };
        }
        if (typeof s.fillColor !== 'string') {
            return { valid: false, error: `"${id}": style.fillColor must be a string` };
        }
        if (typeof s.strokeWidth !== 'number' || !isFinite(s.strokeWidth) || s.strokeWidth < 0) {
            return { valid: false, error: `"${id}": style.strokeWidth must be a non-negative number` };
        }
        if (typeof s.opacity !== 'number' || !isFinite(s.opacity) || s.opacity < 0 || s.opacity > 1) {
            return { valid: false, error: `"${id}": style.opacity must be between 0 and 1` };
        }
        if (typeof s.fontSize !== 'number' || !isFinite(s.fontSize) || s.fontSize <= 0) {
            return { valid: false, error: `"${id}": style.fontSize must be a positive number` };
        }
        return { valid: true };
    }

    private _validateBuiltinFields(el: Record<string, unknown>): ValidationResult {
        const type = el.type as string;
        const id   = el.id   as string;

        switch (type) {
            case 'rectangle':
                if (
                    typeof el.cornerRadius !== 'number' ||
                    !isFinite(el.cornerRadius as number) ||
                    (el.cornerRadius as number) < 0
                ) {
                    return {
                        valid: false,
                        error: `rectangle "${id}": cornerRadius must be a non-negative number`,
                    };
                }
                break;

            case 'line':
            case 'arrow': {
                if (
                    !Array.isArray(el.points) ||
                    el.points.length < 4 ||
                    (el.points as unknown[]).some((p) => typeof p !== 'number' || !isFinite(p))
                ) {
                    return {
                        valid: false,
                        error: `${type} "${id}": points must be an array of at least 4 finite numbers [x1,y1,x2,y2,...]`,
                    };
                }
                if (typeof el.lineType !== 'string' || !VALID_LINE_TYPES.has(el.lineType as string)) {
                    return {
                        valid: false,
                        error: `${type} "${id}": lineType must be one of ${[...VALID_LINE_TYPES].join(' | ')}`,
                    };
                }
                break;
            }

            case 'freedraw': {
                if (
                    !Array.isArray(el.points) ||
                    el.points.length < 2 ||
                    (el.points as unknown[]).some((p) => typeof p !== 'number' || !isFinite(p))
                ) {
                    return {
                        valid: false,
                        error: `freedraw "${id}": points must be an array of at least 2 finite numbers`,
                    };
                }
                break;
            }

            case 'text': {
                if (typeof el.text !== 'string') {
                    return { valid: false, error: `text "${id}": text must be a string` };
                }
                if (!VALID_TEXT_ALIGNS.has(el.textAlign as string)) {
                    return {
                        valid: false,
                        error: `text "${id}": textAlign must be one of ${[...VALID_TEXT_ALIGNS].join(' | ')}`,
                    };
                }
                if (!VALID_VERTICAL_ALIGNS.has(el.verticalAlign as string)) {
                    return {
                        valid: false,
                        error: `text "${id}": verticalAlign must be one of ${[...VALID_VERTICAL_ALIGNS].join(' | ')}`,
                    };
                }
                break;
            }

            case 'image': {
                if (typeof el.src !== 'string' || el.src.trim() === '') {
                    return { valid: false, error: `image "${id}": src must be a non-empty string` };
                }
                if (!VALID_IMAGE_SCALES.has(el.scaleMode as string)) {
                    return {
                        valid: false,
                        error: `image "${id}": scaleMode must be one of ${[...VALID_IMAGE_SCALES].join(' | ')}`,
                    };
                }
                break;
            }

            // ellipse, diamond — no extra required fields beyond BaseElement
        }

        return { valid: true };
    }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

/**
 * The global element registry singleton.
 *
 * Pre-populated with field-level validators for all 8 built-in element types.
 * Imported by the canvas store to gate every element mutation.
 *
 * Use `elementRegistry.register()` or the `registerCustomElement()` helper
 * to add new element types before rendering `<FlowCanvas>`.
 */
export const elementRegistry = new ElementRegistryClass();

/**
 * Shorthand to register a custom element type on the global registry.
 *
 * Equivalent to `elementRegistry.register(config)`.
 *
 * @example
 * ```ts
 * import { registerCustomElement } from 'f1ow';
 *
 * registerCustomElement({
 *   type: 'sticky-note',
 *   displayName: 'Sticky Note',
 *   validate: (el) => typeof el.content === 'string' || 'content must be a string',
 *   defaults: { content: '', color: '#ffeb3b' },
 * });
 * ```
 */
export function registerCustomElement(config: CustomElementConfig): void {
    elementRegistry.register(config);
}
