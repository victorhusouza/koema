import { validDate } from './task-dates.ts';
import { capitalizeInitial } from './text.ts';

export type ManualEvent = { id: number; title: string; date: string; time: string | null };
export class EventInputError extends Error {}

export function validateEventInput(input: unknown, partial = false): Omit<ManualEvent, 'id'> | Partial<Omit<ManualEvent, 'id'>> {
 if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EventInputError('Dados do compromisso inválidos.');
 const value = input as Record<string, unknown>;
 if (Object.keys(value).some(key => !['title', 'date', 'time'].includes(key))) throw new EventInputError('Dados do compromisso inválidos.');
 const result: Partial<Omit<ManualEvent, 'id'>> = {};
 if (!partial || 'title' in value) {
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 500) throw new EventInputError('Informe um título de até 500 caracteres.');
  result.title = capitalizeInitial(value.title.trim());
 }
 if (!partial || 'date' in value) {
  if (!validDate(value.date)) throw new EventInputError('Informe uma data válida no formato AAAA-MM-DD.');
  result.date = value.date as string;
 }
 if ('time' in value || !partial) {
  if (value.time === null || value.time === '') result.time = null;
  else if (typeof value.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) result.time = value.time;
  else throw new EventInputError('Informe um horário válido ou deixe em branco.');
 }
 return result;
}
