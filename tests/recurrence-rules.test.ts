import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRecurrence, nextAfterCompletion, nextCalendarDate, RecurrenceInputError, validateRecurrenceRule, type RecurrenceRule } from '../lib/recurrence.ts';

const calendar = (fields: Partial<RecurrenceRule> = {}): RecurrenceRule => ({ mode: 'calendar', unit: 'day', interval: 1, anchorDate: '2026-01-01', ...fields });

test('calendar daily recurrence can filter weekdays and never backfills before the anchor', () => {
  const rule = validateRecurrenceRule(calendar({ weekdays: [5, 1, 5] }));
  assert.deepEqual(rule.weekdays, [1, 5]);
  assert.equal(nextCalendarDate(rule, '2026-01-01'), '2026-01-02');
  assert.equal(nextCalendarDate(rule, '2025-12-31'), '2026-01-02');
  assert.equal(nextCalendarDate(rule, '2026-01-02', false), '2026-01-05');
});

test('weekly recurrence uses Monday week boundaries, interval, selected weekdays, and anchor floor', () => {
  const rule = calendar({ unit: 'week', interval: 2, anchorDate: '2026-01-07', weekdays: [1, 3, 5] });
  assert.equal(nextCalendarDate(rule, '2026-01-01'), '2026-01-07');
  assert.equal(nextCalendarDate(rule, '2026-01-08'), '2026-01-09');
  assert.equal(nextCalendarDate(rule, '2026-01-09', false), '2026-01-19');
  assert.equal(nextCalendarDate(calendar({ unit: 'week', anchorDate: '2026-01-07' }), '2026-01-07', false), '2026-01-14');
});

test('monthly anchor day clamps at month end and restores its day after shorter months', () => {
  const rule = calendar({ unit: 'month', anchorDate: '2026-01-31' });
  assert.equal(nextCalendarDate(rule, '2026-02-01'), '2026-02-28');
  assert.equal(nextCalendarDate(rule, '2026-02-28', false), '2026-03-31');
  const leap = calendar({ unit: 'year', anchorDate: '2024-02-29' });
  assert.equal(nextCalendarDate(leap, '2025-01-01'), '2025-02-28');
  assert.equal(nextCalendarDate(leap, '2025-02-28', false), '2026-02-28');
});

test('monthly selected days clamp and de-duplicate overlap in short months', () => {
  const rule = calendar({ unit: 'month', anchorDate: '2026-01-01', monthDays: [30, 31, -1] });
  assert.equal(nextCalendarDate(rule, '2026-02-01'), '2026-02-28');
  assert.equal(nextCalendarDate(rule, '2026-02-28', false), '2026-03-30');
  assert.equal(nextCalendarDate(rule, '2026-03-30', false), '2026-03-31');
});

test('yearly month selectors and ordinal or last weekdays skip absent dates', () => {
  const rule = validateRecurrenceRule(calendar({ unit: 'year', anchorDate: '2026-01-01', months: [2, 1], ordinalWeekdays: [{ weekday: 1, ordinal: -1 }, { weekday: 1, ordinal: 5 }] }));
  assert.deepEqual(rule.months, [1, 2]);
  assert.deepEqual(rule.ordinalWeekdays, [{ weekday: 1, ordinal: -1 }, { weekday: 1, ordinal: 5 }]);
  assert.equal(nextCalendarDate(rule, '2026-01-01'), '2026-01-26');
  assert.equal(nextCalendarDate(rule, '2026-01-26', false), '2026-02-23');
  const fifthOnly = calendar({ unit: 'month', anchorDate: '2026-02-01', ordinalWeekdays: [{ weekday: 0, ordinal: 5 }] });
  assert.equal(nextCalendarDate(fifthOnly, '2026-02-01'), '2026-03-29');
});

test('after-completion schedules use actual completion date rather than an old calendar anchor', () => {
  const rule: RecurrenceRule = { mode: 'after-completion', unit: 'month', interval: 1, anchorDate: '2020-01-31' };
  assert.equal(nextAfterCompletion(rule, '2026-01-31'), '2026-02-28');
  assert.equal(nextAfterCompletion(rule, '2026-02-28'), '2026-03-28');
  assert.equal(nextAfterCompletion({ ...rule, anchorDate: '2026-01-31' }, '2025-01-15'), '2025-02-15');
  assert.equal(nextCalendarDate(calendar({ unit: 'month', anchorDate: '2020-01-31' }), '2026-01-31', false), '2026-02-28');
  assert.throws(() => nextAfterCompletion(calendar(), '2026-01-01'), RecurrenceInputError);
});

test('impossible weekday combinations and sparse long intervals terminate quickly', () => {
  const startedAt = performance.now();
  assert.equal(nextCalendarDate(calendar({ weekdays: [2], anchorDate: '2026-01-05', interval: 7, endDate: '9999-12-31' }), '2026-01-05'), null);
  assert.equal(nextCalendarDate(calendar({ unit: 'year', interval: 1000, anchorDate: '2000-02-01', ordinalWeekdays: [{ weekday: 1, ordinal: 5 }], endDate: '9999-12-31' }), '2000-02-01'), null);
  assert.equal(nextCalendarDate(calendar({ unit: 'month', interval: 1000, anchorDate: '2000-01-31' }), '2000-01-31', false), '2083-05-31');
  assert.ok(performance.now() - startedAt < 1000, 'calendar search should jump between recurrence candidates');
});

test('pause, end date, and invalid civil dates are handled explicitly', () => {
  assert.equal(nextCalendarDate(calendar({ paused: true }), '2026-01-01'), null);
  assert.equal(nextCalendarDate(calendar({ endDate: '2026-01-02' }), '2026-01-03'), null);
  assert.equal(nextCalendarDate(calendar({ endDate: '2026-01-02' }), '2026-01-02'), '2026-01-02');
  assert.equal(nextAfterCompletion({ mode: 'after-completion', unit: 'day', interval: 1, anchorDate: '2026-01-01', endDate: '2026-01-02' }, '2026-01-02'), null);
  for (const value of ['2025-02-29', '2026-13-01', '0000-01-01', '2026-2-01']) {
    assert.throws(() => validateRecurrenceRule(calendar({ anchorDate: value })), RecurrenceInputError);
  }
  assert.throws(() => validateRecurrenceRule(calendar({ interval: 0 })), RecurrenceInputError);
  assert.throws(() => validateRecurrenceRule(calendar({ monthDays: [0] })), RecurrenceInputError);
  assert.throws(() => validateRecurrenceRule(calendar({ weekdays: [] })), RecurrenceInputError);
  assert.throws(() => validateRecurrenceRule(calendar({ monthDays: [] })), RecurrenceInputError);
  assert.throws(() => validateRecurrenceRule(calendar({ ordinalWeekdays: [] })), RecurrenceInputError);
  assert.throws(() => validateRecurrenceRule(calendar({ ordinalWeekdays: [{ weekday: 1, ordinal: 2, ignored: true } as never] })), RecurrenceInputError);
  assert.throws(() => validateRecurrenceRule({ ...calendar(), mode: 'after-completion', weekdays: [1] }), RecurrenceInputError);
});

test('date arithmetic is timezone independent and summaries are concise Portuguese', () => {
  const rule = calendar({ unit: 'week', interval: 2, anchorDate: '2026-01-05', weekdays: [1, 5], endDate: '2026-02-28' });
  assert.equal(nextCalendarDate(rule, '2026-01-05'), '2026-01-05');
  assert.match(describeRecurrence(rule), /A cada 2 semanas/);
  assert.match(describeRecurrence(rule), /segunda, sexta/);
  assert.match(describeRecurrence(calendar({ paused: true })), /Pausada/);
});
