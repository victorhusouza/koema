/** Pure recurrence rules. Dates are civil Gregorian days (YYYY-MM-DD), independent of local timezones. */

export type RecurrenceRule = {
  mode: 'calendar' | 'after-completion';
  unit: 'day' | 'week' | 'month' | 'year';
  interval: number;
  anchorDate: string;
  weekdays?: number[];
  monthDays?: number[];
  ordinalWeekdays?: { weekday: number; ordinal: number }[];
  months?: number[];
  endDate?: string | null;
  paused?: boolean;
};

export class RecurrenceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceInputError';
  }
}

type CivilDay = { year: number; month: number; day: number };
const DAY_MS = 86_400_000;
const VALID_KEYS = new Set(['mode', 'unit', 'interval', 'anchorDate', 'weekdays', 'monthDays', 'ordinalWeekdays', 'months', 'endDate', 'paused']);

function civil(value: unknown, name: string): CivilDay {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RecurrenceInputError(`${name} must be a valid YYYY-MM-DD date`);
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RecurrenceInputError(`${name} must be a valid YYYY-MM-DD date`);
  }
  return { year, month, day };
}

function format(day: CivilDay): string {
  return `${String(day.year).padStart(4, '0')}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function dayNumber(day: CivilDay): number {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(day.year, day.month - 1, day.day);
  return Math.floor(date.getTime() / DAY_MS);
}

function fromDayNumber(value: number): CivilDay {
  const date = new Date(value * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekday(day: CivilDay): number {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(day.year, day.month - 1, day.day);
  return date.getUTCDay();
}

function normalizeNumericList(value: unknown, name: string, max: number, minimum: number, maximum: number): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new RecurrenceInputError(`${name} must be an array`);
  if (value.length === 0) throw new RecurrenceInputError(`${name} cannot be empty when provided`);
  if (value.length > max) throw new RecurrenceInputError(`${name} supports at most ${max} selectors`);
  const values: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < minimum || item > maximum) {
      throw new RecurrenceInputError(`${name} values must be safe integers from ${minimum} to ${maximum}`);
    }
    values.push(item);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

function normalizeOrdinalWeekdays(value: unknown): RecurrenceRule['ordinalWeekdays'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new RecurrenceInputError('ordinalWeekdays must be an array');
  if (value.length === 0) throw new RecurrenceInputError('ordinalWeekdays cannot be empty when provided');
  if (value.length > 35) throw new RecurrenceInputError('ordinalWeekdays supports at most 35 selectors');
  const values: { weekday: number; ordinal: number }[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new RecurrenceInputError('Each ordinalWeekdays selector must have weekday and ordinal');
    for (const key of Object.keys(item)) if (key !== 'weekday' && key !== 'ordinal') throw new RecurrenceInputError(`Unknown ordinalWeekdays field: ${key}`);
    const { weekday: day, ordinal } = item as Record<string, unknown>;
    if (typeof day !== 'number' || !Number.isSafeInteger(day) || day < 0 || day > 6) throw new RecurrenceInputError('ordinalWeekdays weekday must be from 0 to 6');
    if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ![1, 2, 3, 4, 5, -1].includes(ordinal)) throw new RecurrenceInputError('ordinalWeekdays ordinal must be 1 to 5 or -1');
    values.push({ weekday: day, ordinal });
  }
  const unique = new Map(values.map(item => [`${item.weekday}:${item.ordinal}`, item]));
  return [...unique.values()].sort((a, b) => a.weekday - b.weekday || a.ordinal - b.ordinal);
}

/** Validate and normalize user/API input into the shared recurrence contract. */
export function validateRecurrenceRule(input: unknown): RecurrenceRule {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RecurrenceInputError('Recurrence rule must be an object');
  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) if (!VALID_KEYS.has(key)) throw new RecurrenceInputError(`Unknown recurrence field: ${key}`);
  if (source.mode !== 'calendar' && source.mode !== 'after-completion') throw new RecurrenceInputError('mode must be calendar or after-completion');
  if (!['day', 'week', 'month', 'year'].includes(String(source.unit))) throw new RecurrenceInputError('unit must be day, week, month, or year');
  if (typeof source.interval !== 'number' || !Number.isSafeInteger(source.interval) || source.interval < 1 || source.interval > 1000) throw new RecurrenceInputError('interval must be a safe integer from 1 to 1000');
  civil(source.anchorDate, 'anchorDate');
  if (source.endDate !== undefined && source.endDate !== null) civil(source.endDate, 'endDate');
  if (source.endDate && (source.endDate as string) < (source.anchorDate as string)) throw new RecurrenceInputError('endDate cannot be before anchorDate');
  if (source.paused !== undefined && typeof source.paused !== 'boolean') throw new RecurrenceInputError('paused must be a boolean');

  const weekdays = normalizeNumericList(source.weekdays, 'weekdays', 7, 0, 6);
  const monthDays = normalizeNumericList(source.monthDays, 'monthDays', 32, -1, 31);
  if (monthDays?.includes(0)) throw new RecurrenceInputError('monthDays must be 1 to 31 or -1');
  const ordinalWeekdays = normalizeOrdinalWeekdays(source.ordinalWeekdays);
  const months = normalizeNumericList(source.months, 'months', 12, 1, 12);

  const rule: RecurrenceRule = {
    mode: source.mode,
    unit: source.unit as RecurrenceRule['unit'],
    interval: source.interval,
    anchorDate: source.anchorDate as string,
  };
  if (weekdays?.length) rule.weekdays = weekdays;
  if (monthDays?.length) rule.monthDays = monthDays;
  if (ordinalWeekdays?.length) rule.ordinalWeekdays = ordinalWeekdays;
  if (months?.length) rule.months = months;
  if (source.endDate !== undefined) rule.endDate = source.endDate as string | null;
  if (source.paused !== undefined) rule.paused = source.paused as boolean;

  const hasMonthSelectors = !!(rule.monthDays?.length || rule.ordinalWeekdays?.length || rule.months?.length);
  if (rule.mode === 'after-completion' && (rule.weekdays?.length || hasMonthSelectors)) {
    throw new RecurrenceInputError('after-completion rules cannot use calendar selectors');
  }
  if (rule.mode === 'calendar') {
    if (rule.unit === 'day' && hasMonthSelectors) throw new RecurrenceInputError('day rules cannot use month selectors');
    if (rule.unit === 'week' && hasMonthSelectors) throw new RecurrenceInputError('week rules cannot use month selectors');
    if (rule.unit === 'month' && rule.months?.length) throw new RecurrenceInputError('month rules cannot use months selectors');
    if ((rule.unit === 'month' || rule.unit === 'year') && rule.weekdays?.length) throw new RecurrenceInputError('weekdays are only supported for day or week rules');
  }
  return rule;
}

function monthIndex(day: CivilDay): number { return day.year * 12 + day.month - 1; }
function monthCandidates(year: number, month: number, rule: RecurrenceRule, anchor: CivilDay): CivilDay[] {
  const length = daysInMonth(year, month);
  if (!rule.monthDays?.length && !rule.ordinalWeekdays?.length) {
    return [{ year, month, day: Math.min(anchor.day, length) }];
  }
  const days = new Set<number>();
  for (const selected of rule.monthDays ?? []) days.add(selected === -1 ? length : Math.min(selected, length));
  if (rule.ordinalWeekdays?.length) {
    for (let day = 1; day <= length; day++) {
      const candidate = { year, month, day };
      if (rule.ordinalWeekdays.some(selector => weekday(candidate) === selector.weekday && (selector.ordinal === -1 ? day + 7 > length : Math.floor((day - 1) / 7) + 1 === selector.ordinal))) days.add(day);
    }
  }
  return [...days].sort((a, b) => a - b).map(day => ({ year, month, day }));
}

function firstOnOrAfter(candidates: CivilDay[], target: number, anchor: number, end: number): CivilDay | null {
  for (const candidate of candidates) {
    const number = dayNumber(candidate);
    if (number >= target && number >= anchor && number <= end) return candidate;
  }
  return null;
}

/** Return the next matching calendar day; dates are compared as civil dates, not instants. */
export function nextCalendarDate(rule: RecurrenceRule, fromDay: string, inclusive = true): string | null {
  const normalized = validateRecurrenceRule(rule);
  if (normalized.mode !== 'calendar') throw new RecurrenceInputError('nextCalendarDate requires a calendar rule');
  const from = civil(fromDay, 'fromDay');
  if (normalized.paused) return null;
  const anchor = civil(normalized.anchorDate, 'anchorDate');
  const target = dayNumber(from) + (inclusive ? 0 : 1);
  const cursor = Math.max(dayNumber(anchor), target);
  const anchorNumber = dayNumber(anchor);
  const end = normalized.endDate ? dayNumber(civil(normalized.endDate, 'endDate')) : dayNumber({ year: 9999, month: 12, day: 31 });
  if (cursor > end) return null;
  const targetDay = fromDayNumber(cursor);
  if (normalized.unit === 'day') {
    const offset = cursor - anchorNumber;
    let k = Math.ceil(offset / normalized.interval);
    if (!normalized.weekdays?.length) {
      const candidateNumber = anchorNumber + k * normalized.interval;
      return candidateNumber <= end ? format(fromDayNumber(candidateNumber)) : null;
    }
    // The weekday pattern repeats after at most seven interval steps. If none match,
    // the interval and weekday set are mathematically incompatible.
    const cycle = 7 / gcd(normalized.interval, 7);
    for (let attempt = 0; attempt < cycle; attempt++, k++) {
      const candidateNumber = anchorNumber + k * normalized.interval;
      if (candidateNumber > end || candidateNumber > dayNumber({ year: 9999, month: 12, day: 31 })) return null;
      const candidate = fromDayNumber(candidateNumber);
      if (normalized.weekdays.includes(weekday(candidate))) return format(candidate);
    }
    return null;
  }
  if (normalized.unit === 'week') {
    const anchorMonday = dayNumber(anchor) - ((weekday(anchor) + 6) % 7);
    const weekdays = normalized.weekdays ?? [weekday(anchor)];
    let best: CivilDay | null = null;
    for (const selectedWeekday of weekdays) {
      const weekdayOffset = (selectedWeekday + 6) % 7;
      const firstWeek = Math.max(0, Math.ceil((cursor - (anchorMonday + weekdayOffset)) / (normalized.interval * 7)));
      const candidateNumber = anchorMonday + weekdayOffset + firstWeek * normalized.interval * 7;
      if (candidateNumber < cursor || candidateNumber < anchorNumber || candidateNumber > end || candidateNumber > dayNumber({ year: 9999, month: 12, day: 31 })) continue;
      const candidate = fromDayNumber(candidateNumber);
      if (!best || candidateNumber < dayNumber(best)) best = candidate;
    }
    return best ? format(best) : null;
  }
  if (normalized.unit === 'month') {
    const anchorMonth = monthIndex(anchor);
    let period = Math.max(0, Math.ceil((monthIndex(targetDay) - anchorMonth) / normalized.interval));
    while (true) {
      const index = anchorMonth + period * normalized.interval;
      const year = Math.floor(index / 12);
      if (year < 1 || year > 9999) return null;
      const month = index - year * 12 + 1;
      const candidate = firstOnOrAfter(monthCandidates(year, month, normalized, anchor), cursor, anchorNumber, end);
      if (candidate) return format(candidate);
      period++;
    }
  }
  let yearPeriod = Math.max(0, Math.ceil((targetDay.year - anchor.year) / normalized.interval));
  const selectedMonths = normalized.months ?? [anchor.month];
  while (true) {
    const year = anchor.year + yearPeriod * normalized.interval;
    if (year > 9999) return null;
    for (const month of selectedMonths) {
      const candidate = firstOnOrAfter(monthCandidates(year, month, normalized, anchor), cursor, anchorNumber, end);
      if (candidate) return format(candidate);
    }
    yearPeriod++;
  }
}

function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }

function addMonths(day: CivilDay, count: number): CivilDay | null {
  const index = monthIndex(day) + count;
  const year = Math.floor(index / 12);
  if (year < 1 || year > 9999) return null;
  const month = index - year * 12 + 1;
  return { year, month, day: Math.min(day.day, daysInMonth(year, month)) };
}

/** Compute one occurrence from the date the prior occurrence was actually completed. */
export function nextAfterCompletion(rule: RecurrenceRule, completedOn: string): string | null {
  const normalized = validateRecurrenceRule(rule);
  if (normalized.mode !== 'after-completion') throw new RecurrenceInputError('nextAfterCompletion requires an after-completion rule');
  const completed = civil(completedOn, 'completedOn');
  if (normalized.paused) return null;
  const baseline = completed;
  let next: CivilDay | null;
  if (normalized.unit === 'day') next = fromDayNumber(dayNumber(baseline) + normalized.interval);
  else if (normalized.unit === 'week') next = fromDayNumber(dayNumber(baseline) + normalized.interval * 7);
  else if (normalized.unit === 'month') next = addMonths(baseline, normalized.interval);
  else next = addMonths(baseline, normalized.interval * 12);
  if (!next || next.year < 1 || next.year > 9999) return null;
  if (normalized.endDate && format(next) > normalized.endDate) return null;
  return format(next);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string { return `${count} ${count === 1 ? singular : pluralForm}`; }
function weekdayName(day: number): string { return ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][day]!; }

/** Concise Portuguese (Brazil) summary suitable for a recurrence editor. */
export function describeRecurrence(rule: RecurrenceRule): string {
  const normalized = validateRecurrenceRule(rule);
  if (normalized.paused) return 'Pausada';
  const unitLabels: Record<RecurrenceRule['unit'], [string, string]> = { day: ['dia', 'dias'], week: ['semana', 'semanas'], month: ['mês', 'meses'], year: ['ano', 'anos'] };
  const unitName = unitLabels[normalized.unit];
  let text = normalized.mode === 'after-completion' ? `A cada ${plural(normalized.interval, ...unitName)} após concluir` : normalized.interval === 1 ? `A cada ${unitName[0]}` : `A cada ${plural(normalized.interval, ...unitName)}`;
  if (normalized.mode === 'calendar' && normalized.unit === 'week') {
    const days = normalized.weekdays?.length ? normalized.weekdays : [weekday(civil(normalized.anchorDate, 'anchorDate'))];
    text += ` · ${days.map(weekdayName).join(', ')}`;
  } else if (normalized.mode === 'calendar' && normalized.unit === 'day' && normalized.weekdays?.length) {
    text += ` · ${normalized.weekdays.map(weekdayName).join(', ')}`;
  } else if (normalized.mode === 'calendar' && (normalized.unit === 'month' || normalized.unit === 'year')) {
    const months = normalized.unit === 'year' ? (normalized.months?.length ? normalized.months : [civil(normalized.anchorDate, 'anchorDate').month]) : [];
    if (months.length) text += ` · ${months.map(month => new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, month - 1, 1, 12))).replace(/^./, first => first.toLocaleUpperCase('pt-BR'))).join(', ')}`;
    const selectors: string[] = [];
    if (normalized.monthDays?.length) selectors.push(`dia ${normalized.monthDays.map(day => day === -1 ? 'último' : String(day)).join(', ')}`);
    if (normalized.ordinalWeekdays?.length) selectors.push(normalized.ordinalWeekdays.map(selector => `${selector.ordinal === -1 ? 'última' : `${selector.ordinal}ª`} ${weekdayName(selector.weekday)}`).join(', '));
    if (!selectors.length && !months.length) selectors.push(`dia ${civil(normalized.anchorDate, 'anchorDate').day}`);
    if (selectors.length) text += ` · ${selectors.join(' ou ')}`;
  }
  if (normalized.endDate) text += ` até ${new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${normalized.endDate}T12:00:00Z`))}`;
  return text;
}
