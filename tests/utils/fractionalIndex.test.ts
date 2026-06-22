import { describe, expect, it } from 'vitest';

import {
    generateKeyBetween,
    generateNKeysBetween,
    isValidFractionalIndex,
    compareFractionalKeys,
} from '@/utils/fractionalIndex';

/** Deterministic PRNG (mulberry32) so any property failure is reproducible. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function isStrictlyIncreasing(keys: string[]): boolean {
    for (let i = 1; i < keys.length; i++) {
        if (!(keys[i - 1] < keys[i])) return false;
    }
    return true;
}

describe('generateKeyBetween — documented examples', () => {
    it('matches the canonical algorithm outputs', () => {
        expect(generateKeyBetween(null, null)).toBe('a0');
        expect(generateKeyBetween('a0', null)).toBe('a1');
        expect(generateKeyBetween(null, 'a0')).toBe('Zz');
        expect(generateKeyBetween('a0', 'a1')).toBe('a0V');
    });

    it('preserves the a < result < b invariant for adjacent integer keys', () => {
        // Regression: the old hand-rolled impl returned a key GREATER than the
        // upper bound for generateKeyBetween("a", "a0") because of trailing-zero
        // trimming. The integer-part encoding makes "a" an invalid key here, but
        // the equivalent adjacent case must still hold strictly.
        const mid = generateKeyBetween('a0', 'a0V');
        expect('a0' < mid).toBe(true);
        expect(mid < 'a0V').toBe(true);
    });
});

describe('generateKeyBetween — invariants on random adjacent inserts', () => {
    it('always returns a key strictly between two adjacent keys (repeated bisection)', () => {
        const rand = mulberry32(0xc0ffee);
        for (let trial = 0; trial < 200; trial++) {
            let lo = generateKeyBetween(null, null);
            let hi = generateKeyBetween(lo, null);
            // Repeatedly insert between the same shrinking interval.
            for (let depth = 0; depth < 40; depth++) {
                const mid = generateKeyBetween(lo, hi);
                expect(lo < mid, `lo=${lo} mid=${mid}`).toBe(true);
                expect(mid < hi, `mid=${mid} hi=${hi}`).toBe(true);
                // Randomly keep the left or right half.
                if (rand() < 0.5) hi = mid;
                else lo = mid;
            }
        }
    });
});

describe('insertion sequences keep a sorted list strictly increasing', () => {
    it('survives random inserts at start / end / middle', () => {
        const rand = mulberry32(42);
        for (let trial = 0; trial < 50; trial++) {
            const keys: string[] = [generateKeyBetween(null, null)];
            for (let op = 0; op < 100; op++) {
                const r = rand();
                let key: string;
                let insertAt: number;
                // Middle insert needs at least two keys; otherwise treat as end.
                if (r < 0.33) {
                    // insert at start
                    key = generateKeyBetween(null, keys[0]);
                    insertAt = 0;
                } else if (r < 0.66 || keys.length < 2) {
                    // insert at end
                    key = generateKeyBetween(keys[keys.length - 1], null);
                    insertAt = keys.length;
                } else {
                    // insert in the middle, between two adjacent keys
                    const i = Math.floor(rand() * (keys.length - 1));
                    key = generateKeyBetween(keys[i], keys[i + 1]);
                    insertAt = i + 1;
                }
                keys.splice(insertAt, 0, key);
            }
            // All keys distinct and the array order matches lexicographic order.
            expect(new Set(keys).size).toBe(keys.length);
            expect(isStrictlyIncreasing(keys)).toBe(true);
            const sorted = [...keys].sort(compareFractionalKeys);
            expect(sorted).toEqual(keys);
        }
    });
});

describe('generateNKeysBetween', () => {
    it('returns n strictly increasing keys for every bound combination', () => {
        const bounds: Array<[string | null, string | null]> = [
            [null, null],
            ['a0', null],
            [null, 'a0'],
            ['a0', 'a1'],
            ['Zz', 'a1'],
        ];
        for (const [a, b] of bounds) {
            for (const n of [0, 1, 2, 3, 5, 10, 33]) {
                const keys = generateNKeysBetween(a, b, n);
                expect(keys.length).toBe(n);
                expect(isStrictlyIncreasing(keys)).toBe(true);
                if (a !== null) expect(keys.every((k) => a < k)).toBe(true);
                if (b !== null) expect(keys.every((k) => k < b)).toBe(true);
            }
        }
    });

    it('produces keys that fit between tight adjacent bounds', () => {
        const a = generateKeyBetween(null, null);
        const b = generateKeyBetween(a, null);
        const keys = generateNKeysBetween(a, b, 20);
        expect(keys.length).toBe(20);
        expect(isStrictlyIncreasing([a, ...keys, b])).toBe(true);
    });
});

describe('isValidFractionalIndex', () => {
    it('accepts generated keys', () => {
        const keys = generateNKeysBetween(null, null, 50);
        for (const k of keys) {
            expect(isValidFractionalIndex(k)).toBe(true);
        }
    });

    it('rejects malformed keys', () => {
        expect(isValidFractionalIndex('')).toBe(false);
        expect(isValidFractionalIndex('a')).toBe(false); // integer part too short
        expect(isValidFractionalIndex('a00')).toBe(false); // trailing zero in fraction
        expect(isValidFractionalIndex('!0')).toBe(false); // bad head char
        expect(isValidFractionalIndex('0')).toBe(false); // head not a-z/A-Z
    });
});

describe('compareFractionalKeys', () => {
    it('orders lexicographically', () => {
        expect(compareFractionalKeys('a0', 'a1')).toBe(-1);
        expect(compareFractionalKeys('a1', 'a0')).toBe(1);
        expect(compareFractionalKeys('a0', 'a0')).toBe(0);
    });
});
