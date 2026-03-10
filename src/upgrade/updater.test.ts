/**
 * upgrade/updater.test.ts — Tests for upgrade utilities.
 *
 * pullAndRebuild requires real git repos + network,
 * so it is tested manually or in integration tests.
 */

import { describe, expect, it } from 'vitest';
import { pullAndRebuild } from './updater.js';

describe('pullAndRebuild', () => {
    it('is exported as a function', () => {
        expect(typeof pullAndRebuild).toBe('function');
    });
});
