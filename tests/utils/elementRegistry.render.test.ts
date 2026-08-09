import { describe, it, expect, afterEach } from 'vitest';
import { elementRegistry } from '@/utils/elementRegistry';

describe('elementRegistry custom render', () => {
    afterEach(() => {
        elementRegistry.unregister('sticky-note-test');
    });

    it('stores and returns a custom render callback', () => {
        const render = () => null;
        elementRegistry.register({
            type: 'sticky-note-test',
            displayName: 'Sticky Note',
            render,
        });

        const config = elementRegistry.getCustomConfig('sticky-note-test');
        expect(config?.render).toBe(render);
    });

    it('unregister removes the custom type', () => {
        elementRegistry.register({ type: 'sticky-note-test' });
        elementRegistry.unregister('sticky-note-test');
        expect(elementRegistry.getCustomConfig('sticky-note-test')).toBeUndefined();
    });
});
