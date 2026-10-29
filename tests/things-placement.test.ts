import assert from 'node:assert/strict';
import test from 'node:test';
import { mapThingsPlacement } from '../lib/things-placement.ts';

test('Things Anytime and Someday share Koema Someday; evening belongs to Today', () => {
 const options = { importDay: '2026-10-29' };
 for (const source of ['anytime', 'someday'] as const) {
  assert.deepEqual(mapThingsPlacement(source, options), { when: 'Algum dia', plannedDate: null });
 }
 assert.deepEqual(mapThingsPlacement('evening', options), { when: 'Hoje', plannedDate: '2026-10-29' });
 assert.deepEqual(mapThingsPlacement('today', options), { when: 'Hoje', plannedDate: '2026-10-29' });
});

test('scheduled source dates remain exact and missing or invalid dates are rejected', () => {
 const options = { importDay: '2026-10-29', plannedDate: '2027-01-03' };
 assert.deepEqual(mapThingsPlacement('upcoming', options), { when: 'Planejada', plannedDate: '2027-01-03' });
 assert.deepEqual(mapThingsPlacement('evening', options), { when: 'Hoje', plannedDate: '2026-10-29' });
 assert.deepEqual(mapThingsPlacement('inbox', options), { when: 'Caixa de entrada', plannedDate: null });
 assert.throws(() => mapThingsPlacement('upcoming', { importDay: '2026-10-29' }));
 assert.throws(() => mapThingsPlacement('today', { importDay: '2026-02-30' }));
 assert.throws(() => mapThingsPlacement('today', { importDay: '2026-10-29', plannedDate: '4001-13-45' }));
});
