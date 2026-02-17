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
 * The algorithm uses string-based fractional indices. Each index is a
 * string that can be compared lexicographically to determine order.
 *
 * Implementation: Uses a base-36 encoding with variable-length strings.
 * Between any two strings "a" and "b" where a < b, we can always
 * generate a string "c" such that a < c < b.
 *
 * Examples:
 *   generateKeyBetween(null, null)   → "a0" (first element)
 *   generateKeyBetween("a0", null)   → "a1" (after first)
 *   generateKeyBetween(null, "a0")   → "Zz" (before first)
 *   generateKeyBetween("a0", "a1")   → "a0V" (between)
 */

// ─── Constants ────────────────────────────────────────────────

/** Characters used for the integer part, in order */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length; // 62

/** The smallest and largest single characters */
const SMALLEST_CHAR = DIGITS[0]; // '0'
const LARGEST_CHAR = DIGITS[BASE - 1]; // 'z'

// ─── Core functions ───────────────────────────────────────────

/**
 * Get the midpoint character between two characters.
 * If a and b are adjacent, returns null (need to go deeper).
 */
function midChar(a: string, b: string): string | null {
    const ai = DIGITS.indexOf(a);
    const bi = DIGITS.indexOf(b);
    if (bi - ai <= 1) return null; // adjacent — no room
    const mid = Math.floor((ai + bi) / 2);
    return DIGITS[mid];
}

/**
 * Generate a fractional index key between two existing keys.
 *
 * @param a - Lower bound (null = beginning of list)
 * @param b - Upper bound (null = end of list)
 * @returns A string key that sorts between a and b
 *
 * Invariants:
 *   - If a is null and b is null, returns a default starting key
 *   - If a is null, returns a key before b
 *   - If b is null, returns a key after a
 *   - generateKeyBetween(a, b) > a && generateKeyBetween(a, b) < b
 */
export function generateKeyBetween(a: string | null, b: string | null): string {
    // Case 1: Both null — return initial key
    if (a === null && b === null) {
        return 'a0';
    }

    // Case 2: Only lower bound — append next character
    if (b === null) {
        return incrementKey(a!);
    }

    // Case 3: Only upper bound — prepend earlier character
    if (a === null) {
        return decrementKey(b);
    }

    // Case 4: Both bounds — find midpoint
    return midpoint(a, b);
}

/**
 * Generate N evenly-spaced keys between a and b.
 * Useful for initial element ordering or batch inserts.
 */
export function generateNKeysBetween(
    a: string | null,
    b: string | null,
    n: number,
): string[] {
    if (n === 0) return [];
    if (n === 1) return [generateKeyBetween(a, b)];

    // Recursive bisection for balanced key distribution:
    // Place the midpoint key first, then fill left and right halves recursively.
    // This produces evenly-spaced keys instead of skewing toward one end.
    const mid = Math.floor(n / 2);
    const midKey = generateKeyBetween(a, b);
    const left = generateNKeysBetween(a, midKey, mid);
    const right = generateNKeysBetween(midKey, b, n - mid - 1);
    return [...left, midKey, ...right];
}

// ─── Internal helpers ─────────────────────────────────────────

/**
 * Generate a key after `key` (for appending to end of list).
 */
function incrementKey(key: string): string {
    const chars = key.split('');
    // Try to increment the last character
    for (let i = chars.length - 1; i >= 0; i--) {
        const idx = DIGITS.indexOf(chars[i]);
        if (idx < BASE - 1) {
            chars[i] = DIGITS[idx + 1];
            return chars.join('');
        }
        // Carry — reset this char and continue
        chars[i] = SMALLEST_CHAR;
    }
    // All chars maxed out — append a new character
    return key + DIGITS[1]; // e.g., "zz" → "zz1"
}

/**
 * Generate a key before `key` (for prepending to start of list).
 */
function decrementKey(key: string): string {
    const chars = key.split('');
    // Try to decrement the last character
    for (let i = chars.length - 1; i >= 0; i--) {
        const idx = DIGITS.indexOf(chars[i]);
        if (idx > 0) {
            chars[i] = DIGITS[idx - 1];
            // Trim trailing smallest chars
            let result = chars.join('');
            while (result.length > 1 && result.endsWith(SMALLEST_CHAR)) {
                result = result.slice(0, -1);
            }
            return result;
        }
        // Borrow — reset this char and continue
        chars[i] = LARGEST_CHAR;
    }
    // All chars minimal — prepend a new character
    return SMALLEST_CHAR + key;
}

/**
 * Find a string that sorts between `a` and `b`.
 * Uses character-by-character comparison and midpoint insertion.
 */
function midpoint(a: string, b: string): string {
    // Pad to equal length for comparison
    const maxLen = Math.max(a.length, b.length);
    const aPad = a.padEnd(maxLen, SMALLEST_CHAR);
    const bPad = b.padEnd(maxLen, SMALLEST_CHAR);

    // Find the first differing position
    let commonPrefix = '';
    for (let i = 0; i < maxLen; i++) {
        if (aPad[i] === bPad[i]) {
            commonPrefix += aPad[i];
            continue;
        }

        // Found difference — try to find midpoint at this position
        const mid = midChar(aPad[i], bPad[i]);
        if (mid !== null) {
            return commonPrefix + mid;
        }

        // Characters are adjacent — go one level deeper
        // Use the lower char + midpoint of (remaining a, end)
        return commonPrefix + aPad[i] + incrementKey(aPad.slice(i + 1).replace(/0+$/, '') || SMALLEST_CHAR);
    }

    // Strings are equal after padding — append a midpoint character
    return a + DIGITS[Math.floor(BASE / 2)];
}

/**
 * Validate that a fractional index is well-formed.
 */
export function isValidFractionalIndex(key: string): boolean {
    if (!key || key.length === 0) return false;
    for (const ch of key) {
        if (DIGITS.indexOf(ch) === -1) return false;
    }
    return true;
}

/**
 * Compare two fractional index keys.
 * Returns negative if a < b, zero if equal, positive if a > b.
 */
export function compareFractionalKeys(a: string, b: string): number {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}
