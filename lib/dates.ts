/** Calendar date for the dashboard's configured business timezone. */
export function localDateKey(value: Date | string, timeZone = 'America/Belem'): string {
 const date = value instanceof Date ? value : new Date(value);
 if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
 const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
 const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
 const year = part('year'), month = part('month'), day = part('day');
 if (!year || !month || !day) throw new RangeError(`Could not format date in ${timeZone}`);
 return `${year}-${month}-${day}`;
}
