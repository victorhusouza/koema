import ical, { type EventInstance, type VEvent } from 'node-ical';
import { openCalendarFeedStore, GoogleCalendarError } from './google-calendar.ts';
import { validDate } from './task-dates.ts';
import { calendarDateTime, DEFAULT_CALENDAR_TIME_ZONE } from './calendar-time.ts';

const MAX_ICS_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 5000;
export type IcalEvent = { id: string; title: string; date: string; time: string | null; endTime: string | null; allDay: boolean; meetingUrl: string | null };
export type FeedConfig = { dbPath: string; keyPath?: string; encryptionKey?: string };

export function validateGoogleIcalUrl(value: unknown): string {
 if (typeof value !== 'string' || value.length > 2048) throw new GoogleCalendarError('Cole um endereço iCal secreto válido do Google Agenda.', 'invalid_ical_url');
 let url: URL;
 try { url = new URL(value.trim()); } catch { throw new GoogleCalendarError('Cole um endereço iCal secreto válido do Google Agenda.', 'invalid_ical_url'); }
 if (url.protocol !== 'https:' || url.hostname !== 'calendar.google.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/calendar\/ical\/[^/]+\/private-[^/]+\/basic\.ics$/.test(url.pathname)) {
  throw new GoogleCalendarError('Use o endereço iCal secreto do Google Agenda, com HTTPS.', 'invalid_ical_url');
 }
 return url.toString();
}

function feedConfig(env: Partial<NodeJS.ProcessEnv> = process.env): FeedConfig {
 return { dbPath: env.PAINEL_DB_PATH || `${process.cwd()}/data/painel.sqlite`, keyPath: env.GOOGLE_TOKEN_KEY_FILE, encryptionKey: env.GOOGLE_TOKEN_ENCRYPTION_KEY };
}
export function openIcalStore(config = feedConfig()) { return openCalendarFeedStore(config); }

async function fetchCalendarText(initialUrl: string, fetcher: typeof fetch): Promise<string> {
 let current = validateGoogleIcalUrl(initialUrl);
 for (let redirects = 0; redirects <= 3; redirects++) {
  let response: Response;
  try { response = await fetcher(current, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Accept: 'text/calendar, text/plain;q=0.9' } }); }
  catch { throw new GoogleCalendarError('Não foi possível consultar o Google Agenda. Verifique a conexão e tente novamente.', 'ical_fetch_error'); }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
   const location = response.headers.get('location');
   if (!location || redirects === 3) throw new GoogleCalendarError('O Google Agenda redirecionou a consulta de forma inválida.', 'ical_redirect_error');
   try { current = validateGoogleIcalUrl(new URL(location, current).toString()); }
   catch { throw new GoogleCalendarError('O Google Agenda redirecionou a consulta para um endereço não permitido.', 'ical_redirect_error'); }
   continue;
  }
  if (!response.ok) throw new GoogleCalendarError('Não foi possível consultar o Google Agenda. Verifique o endereço e tente novamente.', 'ical_fetch_error');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ICS_BYTES) throw new GoogleCalendarError('A agenda retornou dados acima do limite permitido.', 'ical_too_large');
  if (!response.body) throw new GoogleCalendarError('O Google Agenda retornou uma resposta vazia inválida.', 'ical_invalid');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
   while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > MAX_ICS_BYTES) { await reader.cancel(); throw new GoogleCalendarError('A agenda retornou dados acima do limite permitido.', 'ical_too_large'); }
    chunks.push(value);
   }
  } catch (error) {
   if (error instanceof GoogleCalendarError) throw error;
   throw new GoogleCalendarError('Não foi possível ler a resposta do Google Agenda. Tente novamente.', 'ical_fetch_error');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new GoogleCalendarError('O Google Agenda retornou um calendário inválido. Confira o endereço secreto.', 'ical_invalid'); }
 }
 throw new GoogleCalendarError('O Google Agenda redirecionou a consulta de forma inválida.', 'ical_redirect_error');
}

function normalizeInstance(event: VEvent, instance: EventInstance): IcalEvent | null {
 const effectiveEvent = instance.event || event;
 if (effectiveEvent.status === 'CANCELLED' || !(instance.start instanceof Date) || !(instance.end instanceof Date)) return null;
 const start = instance.isFullDay
  ? { date: `${String(instance.start.getFullYear()).padStart(4, '0')}-${String(instance.start.getMonth() + 1).padStart(2, '0')}-${String(instance.start.getDate()).padStart(2, '0')}`, time: '00:00' }
  : calendarDateTime(instance.start, DEFAULT_CALENDAR_TIME_ZONE);
 const end = calendarDateTime(instance.end, DEFAULT_CALENDAR_TIME_ZONE);
 const title = typeof instance.summary === 'string' && instance.summary.trim() ? instance.summary.trim() : 'Evento sem título';
 let meetingUrl: string | null = null;
 const candidateUrl = effectiveEvent.url || event.url;
 if (typeof candidateUrl === 'string') { try { const parsed = new URL(candidateUrl); if (parsed.protocol === 'https:') meetingUrl = parsed.toString(); } catch {} }
 return { id: `${event.uid}:${instance.start.toISOString()}`, title, date: start.date, time: instance.isFullDay ? null : start.time, endTime: instance.isFullDay || end.date !== start.date ? null : end.time, allDay: instance.isFullDay, meetingUrl };
}

export async function listIcalEvents(secretUrl: string, date: string, fetcher: typeof fetch = fetch): Promise<IcalEvent[]> {
 if (!validDate(date)) throw new GoogleCalendarError('Informe uma data válida para consultar a agenda.', 'invalid_date');
 const ics = await fetchCalendarText(secretUrl, fetcher);
 if (!ics.includes('BEGIN:VCALENDAR') || !ics.includes('END:VCALENDAR')) throw new GoogleCalendarError('O Google Agenda retornou um calendário inválido. Confira o endereço secreto.', 'ical_invalid');
 let parsed: ReturnType<typeof ical.sync.parseICS>;
 try { parsed = await ical.async.parseICS(ics); }
 catch { throw new GoogleCalendarError('Não foi possível interpretar os eventos do Google Agenda. Tente atualizar novamente.', 'ical_invalid'); }
 const start = new Date(`${date}T00:00:00-03:00`); const end = new Date(`${date}T23:59:59.999-03:00`);
 const values = Object.values(parsed).filter((item): item is VEvent => !!item && item.type === 'VEVENT');
 if (values.length > MAX_EVENTS) throw new GoogleCalendarError('A agenda contém eventos demais para carregar com segurança.', 'ical_too_many_events');
 const result: IcalEvent[] = [];
 try {
  for (const event of values) {
   const instances = ical.expandRecurringEvent(event, { from: start, to: end, includeOverrides: true, excludeExdates: true, expandOngoing: true });
   for (const instance of instances) {
    const normalized = normalizeInstance(event, instance);
    if (!normalized) continue;
    const overlapsDay = instance.start < new Date(end.getTime() + 1) && instance.end > start;
    if (normalized.date === date) result.push(normalized);
    else if (overlapsDay && instance.start < start) result.push({ ...normalized, date, endTime: null });
   }
  }
 } catch { throw new GoogleCalendarError('Não foi possível expandir uma recorrência do Google Agenda. Tente atualizar novamente.', 'ical_invalid'); }
 result.sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.title.localeCompare(b.title, 'pt-BR'));
 return result;
}
