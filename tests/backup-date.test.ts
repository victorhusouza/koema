import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDateKey } from '../lib/dates.ts';

test('backup filename date follows the Belém calendar day across UTC midnight', () => {
 assert.equal(localDateKey('2026-10-29T02:30:00.000Z'), '2026-10-28');
 assert.equal(localDateKey('2026-10-29T03:00:00.000Z'), '2026-10-29');
});
