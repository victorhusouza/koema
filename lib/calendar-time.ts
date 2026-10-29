export const DEFAULT_CALENDAR_TIME_ZONE = 'America/Belem';

/** Convert an instant to the calendar's local civil date and 24-hour time. */
export function calendarDateTime(value: Date | string, timeZone = DEFAULT_CALENDAR_TIME_ZONE): { date: string; time: string } {
 const instant = value instanceof Date ? value : new Date(value);
 const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
 }).formatToParts(instant);
 const part = (type: string) => parts.find(item => item.type === type)?.value || '00';
 return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}
