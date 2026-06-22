/**
 * fractionalIndex.ts — Fractional indexing utilities for CRDT-compatible
 * element ordering.
 *
 * Fractional indices allow inserting elements between any two existing
 * elements without shifting array indices — essential for:
 *   - Conflict-free concurrent reordering (CRDT)
 *   - O(1) insert-between operations (no array splice)
 *   - Stable sort order across distributed replicas
 *
 * Each index is a string that compares lexicographically to determine
 * order: between any two keys `a < b` we can always derive `c` with
 * `a < c < b`.
 *
 * Implementation: a faithful port of the battle-tested "fractional-indexing"
 * algorithm by David Greenspan (rocicorp), described in
 * "Implementing Fractional Indexing"
 * (https://observablehq.com/@dgreensp/implementing-fractional-indexing).
 * Original source is published under CC0. The keys consist of a variable
 * length base-62 integer part (its length encoded by the leading character)
 * followed by an unbounded fractional part — this is what guarantees the
 * `a < result < b` invariant for every input, including adjacent keys.
 *
 * Examples:
 *   generateKeyBetween(null, null)   → "a0" (first element)
 *   generateKeyBetween("a0", null)   → "a1" (after first)
 *   generateKeyBetween(null, "a0")   → "Zz" (before first)
 *   generateKeyBetween("a0", "a1")   → "a0V" (between)
 */

// ─── Constants ────────────────────────────────────────────────

/** Base-62 digit alphabet, in ascending character-code order. */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The reserved "smallest" integer part — never a valid key on its own. */
const SMALLEST_INTEGER = 'A' + DIGITS[0].repeat(26);

// ─── Internal helpers (David Greenspan algorithm) ──────────────

/**
 * Find a fractional string strictly between `a` and `b`.
 * `a` may be the empty string; `b` is null (open end) or a non-empty string.
 * Neither may have a trailing zero digit.
 */
function midpoint(a: string, b: string | null, digits: string): string {
    const zero = digits[0];
    if (b !== null && a >= b) {
        throw new Error(`${a} >= ${b}`);
    }
    if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) {
        throw new Error('trailing zero');
    }
    if (b) {
        // Strip the longest common prefix, padding `a` with zeros as needed.
        let n = 0;
        while ((a[n] || zero) === b[n]) {
            n++;
        }
        if (n > 0) {
            return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), digits);
        }
    }
    // First digits (or lack of digit) differ.
    const digitA = a ? digits.indexOf(a[0]) : 0;
    const digitB = b !== null ? digits.indexOf(b[0]) : digits.length;
    if (digitB - digitA > 1) {
        const midDigit = Math.round(0.5 * (digitA + digitB));
        return digits[midDigit];
    }
    // First digits are consecutive.
    if (b && b.length > 1) {
        return b.slice(0, 1);
    }
    // `b` is null or a single digit: recurse on `a`'s tail toward the open end.
    return digits[digitA] + midpoint(a.slice(1), null, digits);
}

/** Expected length of the integer part given its leading character. */
function getIntegerLength(head: string): number {
    if (head >= 'a' && head <= 'z') {
        return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
    }
    if (head >= 'A' && head <= 'Z') {
        return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
    }
    throw new Error(`invalid order key head: ${head}`);
}

function validateInteger(int: string): void {
    if (int.length !== getIntegerLength(int[0])) {
        throw new Error(`invalid integer part of order key: ${int}`);
    }
}

function getIntegerPart(key: string): string {
    const integerPartLength = getIntegerLength(key[0]);
    if (integerPartLength > key.length) {
        throw new Error(`invalid order key: ${key}`);
    }
    return key.slice(0, integerPartLength);
}

function validateOrderKey(key: string, digits: string): void {
    if (key === SMALLEST_INTEGER) {
        throw new Error(`invalid order key: ${key}`);
    }
    // getIntegerPart throws on a bad leading char or too-short key.
    const i = getIntegerPart(key);
    const f = key.slice(i.length);
    if (f.slice(-1) === digits[0]) {
        throw new Error(`invalid order key: ${key}`);
    }
}

/** Increment the integer part. Returns null when the largest integer is exceeded. */
function incrementInteger(x: string, digits: string): string | null {
    validateInteger(x);
    const [head, ...digs] = x.split('');
    let carry = true;
    for (let i = digs.length - 1; carry && i >= 0; i--) {
        const d = digits.indexOf(digs[i]) + 1;
        if (d === digits.length) {
            digs[i] = digits[0];
        } else {
            digs[i] = digits[d];
            carry = false;
        }
    }
    if (carry) {
        if (head === 'Z') return 'a' + digits[0];
        if (head === 'z') return null;
        const h = String.fromCharCode(head.charCodeAt(0) + 1);
        if (h > 'a') {
            digs.push(digits[0]);
        } else {
            digs.pop();
        }
        return h + digs.join('');
    }
    return head + digs.join('');
}

/** Decrement the integer part. Returns null when the smallest integer is exceeded. */
function decrementInteger(x: string, digits: string): string | null {
    validateInteger(x);
    const [head, ...digs] = x.split('');
    let borrow = true;
    for (let i = digs.length - 1; borrow && i >= 0; i--) {
        const d = digits.indexOf(digs[i]) - 1;
        if (d === -1) {
            digs[i] = digits.slice(-1);
        } else {
            digs[i] = digits[d];
            borrow = false;
        }
    }
    if (borrow) {
        if (head === 'a') return 'Z' + digits.slice(-1);
        if (head === 'A') return null;
        const h = String.fromCharCode(head.charCodeAt(0) - 1);
        if (h < 'Z') {
            digs.push(digits.slice(-1));
        } else {
            digs.pop();
        }
        return h + digs.join('');
    }
    return head + digs.join('');
}

// ─── Core functions ───────────────────────────────────────────

/**
 * Generate a fractional index key between two existing keys.
 *
 * @param a - Lower bound (null = beginning of list)
 * @param b - Upper bound (null = end of list)
 * @returns A string key that sorts strictly between a and b
 *
 * Invariants:
 *   - If a and b are both null, returns the default starting key ("a0")
 *   - If a is null, returns a key < b
 *   - If b is null, returns a key > a
 *   - Otherwise: a < generateKeyBetween(a, b) < b
 */
export function generateKeyBetween(a: string | null, b: string | null): string {
    const digits = DIGITS;
    if (a !== null) validateOrderKey(a, digits);
    if (b !== null) validateOrderKey(b, digits);
    if (a !== null && b !== null && a >= b) {
        throw new Error(`${a} >= ${b}`);
    }

    if (a === null) {
        if (b === null) {
            return 'a' + digits[0];
        }
        const ib = getIntegerPart(b);
        const fb = b.slice(ib.length);
        if (ib === SMALLEST_INTEGER) {
            return ib + midpoint('', fb, digits);
        }
        if (ib < b) {
            return ib;
        }
        const res = decrementInteger(ib, digits);
        if (res === null) {
            throw new Error('cannot decrement any more');
        }
        return res;
    }

    if (b === null) {
        const ia = getIntegerPart(a);
        const fa = a.slice(ia.length);
        const i = incrementInteger(ia, digits);
        return i === null ? ia + midpoint(fa, null, digits) : i;
    }

    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const ib = getIntegerPart(b);
    const fb = b.slice(ib.length);
    if (ia === ib) {
        return ia + midpoint(fa, fb, digits);
    }
    const i = incrementInteger(ia, digits);
    if (i === null) {
        throw new Error('cannot increment any more');
    }
    if (i < b) {
        return i;
    }
    return ia + midpoint(fa, null, digits);
}

/**
 * Generate N distinct keys, in sorted order, between a and b.
 * Useful for initial element ordering or batch inserts.
 */
export function generateNKeysBetween(
    a: string | null,
    b: string | null,
    n: number,
): string[] {
    if (n === 0) return [];
    if (n === 1) return [generateKeyBetween(a, b)];

    if (b === null) {
        let c = generateKeyBetween(a, b);
        const result = [c];
        for (let i = 0; i < n - 1; i++) {
            c = generateKeyBetween(c, b);
            result.push(c);
        }
        return result;
    }

    if (a === null) {
        let c = generateKeyBetween(a, b);
        const result = [c];
        for (let i = 0; i < n - 1; i++) {
            c = generateKeyBetween(a, c);
            result.push(c);
        }
        result.reverse();
        return result;
    }

    // Both bounds present — bisect for balanced, short keys.
    const mid = Math.floor(n / 2);
    const c = generateKeyBetween(a, b);
    return [
        ...generateNKeysBetween(a, c, mid),
        c,
        ...generateNKeysBetween(c, b, n - mid - 1),
    ];
}

// ─── Validation & comparison ──────────────────────────────────

/**
 * Validate that a fractional index is well-formed (valid integer part,
 * no trailing zero in the fractional part, not the reserved smallest key).
 */
export function isValidFractionalIndex(key: string): boolean {
    if (typeof key !== 'string' || key.length === 0) return false;
    try {
        validateOrderKey(key, DIGITS);
        return true;
    } catch {
        return false;
    }
}

/**
 * Compare two fractional index keys.
 * Returns negative if a < b, zero if equal, positive if a > b.
 */
export function compareFractionalKeys(a: string, b: string): number {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}
