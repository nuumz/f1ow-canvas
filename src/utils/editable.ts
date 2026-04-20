const CONTENT_EDITABLE_SELECTOR = [
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
].join(', ');

type EditableTarget = EventTarget & {
    tagName?: string;
    isContentEditable?: boolean;
    blur?: () => void;
    closest?: (selector: string) => EventTarget | null;
};

function asEditableTarget(target: EventTarget | null): EditableTarget | null {
    if (!target || typeof target !== 'object') return null;
    return target as EditableTarget;
}

function getEditableTag(target: EditableTarget | null): string | null {
    if (!target?.tagName) return null;
    return target.tagName.toUpperCase();
}

function getContentEditableHost(target: EditableTarget): EditableTarget | null {
    if (target.isContentEditable) return target;

    const host = target.closest?.(CONTENT_EDITABLE_SELECTOR);
    if (!host || typeof host !== 'object') return null;

    return host as EditableTarget;
}

export function isTextEditingTarget(target: EventTarget | null): boolean {
    const editableTarget = asEditableTarget(target);
    if (!editableTarget) return false;

    const tag = getEditableTag(editableTarget);
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;

    return getContentEditableHost(editableTarget) !== null;
}

export function blurTextEditingTarget(target: EventTarget | null): boolean {
    const editableTarget = asEditableTarget(target);
    if (!editableTarget) return false;

    const tag = getEditableTag(editableTarget);
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        editableTarget.blur?.();
        return true;
    }

    const host = getContentEditableHost(editableTarget);
    if (!host) return false;

    host.blur?.();
    return true;
}