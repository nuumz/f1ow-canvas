import type { CanvasElement, BoundElement } from '@/types';
import { generateId } from './id';

/**
 * Deep-clone a single element to avoid shared references on nested objects.
 */
function deepCloneElement(el: CanvasElement): CanvasElement {
    const clone: any = { ...el };
    // Deep-clone mutable nested objects
    if (clone.style) clone.style = { ...clone.style };
    if (clone.boundElements) clone.boundElements = clone.boundElements.map((be: BoundElement) => ({ ...be }));
    if (clone.startBinding) clone.startBinding = { ...clone.startBinding };
    if (clone.endBinding) clone.endBinding = { ...clone.endBinding };
    if (clone.groupIds) clone.groupIds = [...clone.groupIds];
    // Deep-clone points array (LineElement / ArrowElement)
    if (Array.isArray(clone.points)) {
        clone.points = clone.points.map((p: any) => ({ ...p }));
    }
    // Deep-clone crop (ImageElement)
    if (clone.crop) clone.crop = { ...clone.crop };
    return clone as CanvasElement;
}

/**
 * Clone a set of elements with proper id remapping for all cross-references.
 *
 * Handles:
 * - Auto-including bound text of containers
 * - Generating new ids and building old→new id map
 * - Remapping containerId, boundElements, startBinding, endBinding
 * - Remapping groupIds (generates new groupIds so clones form independent groups)
 * - Deep-cloning nested objects (style, points, bindings) to prevent shared references
 * - Nullifying dangling refs (when referenced element not in clone set)
 *
 * @param originals - Elements to clone (e.g., selected or clipboard)
 * @param allElements - Full element list for looking up missing bound text
 *                      (pass `originals` itself if source is clipboard)
 * @param offset - Positional offset for the clones (default 20)
 * @returns { clones, idMap, selectedCloneIds }
 */
export function cloneAndRemapElements(
    originals: CanvasElement[],
    allElements: CanvasElement[],
    offset: number = 20,
): {
    clones: CanvasElement[];
    idMap: Map<string, string>;
    selectedCloneIds: string[];
} {
    const originalIds = new Set(originals.map((el) => el.id));

    // Auto-include bound text elements not already in originals
    const extraTextIds = new Set<string>();
    for (const el of originals) {
        if (el.boundElements) {
            for (const be of el.boundElements) {
                if (be.type === 'text' && !originalIds.has(be.id)) {
                    extraTextIds.add(be.id);
                }
            }
        }
    }
    const toDuplicate = [
        ...originals,
        ...allElements.filter((el) => extraTextIds.has(el.id)),
    ];

    // Build old→new id mapping
    const idMap = new Map<string, string>();
    for (const el of toDuplicate) {
        idMap.set(el.id, generateId());
    }

    // Build old→new groupId mapping (so cloned groups are independent)
    const groupIdMap = new Map<string, string>();
    for (const el of toDuplicate) {
        if (el.groupIds) {
            for (const gid of el.groupIds) {
                if (!groupIdMap.has(gid)) {
                    groupIdMap.set(gid, generateId());
                }
            }
        }
    }

    const clones = toDuplicate.map((el) => {
        const newId = idMap.get(el.id)!;
        // Deep-clone to avoid shared references on nested objects
        const dup: any = deepCloneElement(el);
        dup.id = newId;
        dup.x = el.x + offset;
        dup.y = el.y + offset;

        // Remap containerId
        if (dup.containerId && idMap.has(dup.containerId)) {
            dup.containerId = idMap.get(dup.containerId);
        } else if (dup.containerId) {
            dup.containerId = null;
        }

        // Remap boundElements refs
        if (dup.boundElements) {
            dup.boundElements = dup.boundElements
                .map((be: BoundElement) =>
                    idMap.has(be.id) ? { ...be, id: idMap.get(be.id)! } : null,
                )
                .filter(Boolean);
            if (dup.boundElements.length === 0) dup.boundElements = null;
        }

        // Remap bindings (startBinding / endBinding)
        if (dup.startBinding && idMap.has(dup.startBinding.elementId)) {
            dup.startBinding = { ...dup.startBinding, elementId: idMap.get(dup.startBinding.elementId) };
        } else if (dup.startBinding) {
            dup.startBinding = null;
        }
        if (dup.endBinding && idMap.has(dup.endBinding.elementId)) {
            dup.endBinding = { ...dup.endBinding, elementId: idMap.get(dup.endBinding.elementId) };
        } else if (dup.endBinding) {
            dup.endBinding = null;
        }

        // Remap groupIds — generate new group IDs so clones are independent
        if (dup.groupIds && dup.groupIds.length > 0) {
            dup.groupIds = dup.groupIds.map((gid: string) => groupIdMap.get(gid) ?? gid);
        }

        return dup as CanvasElement;
    });

    // Only these belong to the original selection (not auto-included text)
    const selectedCloneIds = clones
        .filter((c) => {
            const origId = [...idMap.entries()].find(([, v]) => v === c.id)?.[0];
            return origId ? originalIds.has(origId) : false;
        })
        .map((c) => c.id);

    return { clones, idMap, selectedCloneIds };
}

/**
 * Gather elements for copy, auto-including:
 * - Bound text of containers
 * - All group members of selected elements' groups
 */
export function gatherElementsForCopy(
    selectedIds: string[],
    allElements: CanvasElement[],
): CanvasElement[] {
    const gatheredSet = new Set(selectedIds);

    // Collect all group IDs from selected elements
    const groupIdsToInclude = new Set<string>();
    for (const el of allElements) {
        if (gatheredSet.has(el.id) && el.groupIds) {
            for (const gid of el.groupIds) {
                groupIdsToInclude.add(gid);
            }
        }
    }

    // Include all group members
    if (groupIdsToInclude.size > 0) {
        for (const el of allElements) {
            if (!gatheredSet.has(el.id) && el.groupIds) {
                for (const gid of el.groupIds) {
                    if (groupIdsToInclude.has(gid)) {
                        gatheredSet.add(el.id);
                        break;
                    }
                }
            }
        }
    }

    // Include bound text not explicitly selected
    for (const el of allElements) {
        if (gatheredSet.has(el.id) && el.boundElements) {
            for (const be of el.boundElements) {
                if (be.type === 'text' && !gatheredSet.has(be.id)) {
                    gatheredSet.add(be.id);
                }
            }
        }
    }

    return allElements.filter((el) => gatheredSet.has(el.id));
}
