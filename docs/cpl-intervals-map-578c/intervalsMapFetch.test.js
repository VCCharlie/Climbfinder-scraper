import { describe, it, expect } from 'vitest';
import { encodeGooglePolyline } from '../../utils/intervalsMapFetch.js';

describe('encodeGooglePolyline', () => {
    it('encodes a short lat/lng path', () => {
        const encoded = encodeGooglePolyline([
            [52.1, 5.1],
            [52.1001, 5.1002],
        ]);
        expect(encoded).toBeTruthy();
        expect(typeof encoded).toBe('string');
    });

    it('returns null for empty input', () => {
        expect(encodeGooglePolyline([])).toBeNull();
    });
});
