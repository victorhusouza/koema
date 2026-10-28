import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listIcalEvents, openIcalStore, validateGoogleIcalUrl } from '../lib/google-ical.ts';

const url = 'https://calendar.google.com/calendar/ical/account%40gmail.com/private-secret-token/basic.ics';
const calendar = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:daily@example.test\r\nDTSTAMP:20261026T120000Z\r\nDTSTART;TZID=America/Belem:20261027T090000\r\nDTEND;TZID=America/Belem:20261027T100000\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEXDATE;TZID=America/Belem:20261028T090000\r\nSUMMARY:Reunião diária\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:daily@example.test\r\nDTSTAMP:20261026T120000Z\r\nRECURRENCE-ID;TZID=America/Belem:20261029T090000\r\nDTSTART;TZID=America/Belem:20261028T110000\r\nDTEND;TZID=America/Belem:20261028T120000\r\nSUMMARY:Reunião reagendada\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:daily@example.test\r\nDTSTAMP:20261026T120000Z\r\nRECURRENCE-ID;TZID=America/Belem:20261030T090000\r\nDTSTART;TZID=America/Belem:20261030T090000\r\nDTEND;TZID=America/Belem:20261030T100000\r\nSTATUS:CANCELLED\r\nSUMMARY:Reunião cancelada\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:all-day@example.test\r\nDTSTAMP:20261026T120000Z\r\nDTSTART;VALUE=DATE:20261028\r\nDTEND;VALUE=DATE:20261029\r\nSUMMARY:Dia reservado\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

test('accepts only Google secret iCal URLs over HTTPS', () => {
 assert.equal(validateGoogleIcalUrl(url), url);
 for (const value of ['http://calendar.google.com/calendar/ical/a/private-b/basic.ics', 'https://evil.example/calendar/ical/a/private-b/basic.ics', 'https://calendar.google.com/calendar/ical/a/public/basic.ics', `${url}?redirect=https://evil.test`]) {
  assert.throws(() => validateGoogleIcalUrl(value), /endereço iCal secreto/);
 }
});

test('expands recurrence with exclusions and includes all-day events', async () => {
 const events = await listIcalEvents(url, '2026-10-28', async () => new Response(calendar, { headers: { 'Content-Type': 'text/calendar' } }));
 assert.equal(events.length, 2);
 assert.deepEqual(events.map(event => event.title).sort(), ['Dia reservado', 'Reunião reagendada']);
 assert.equal(events.find(event => event.title === 'Dia reservado')?.allDay, true);
 assert.equal(events.find(event => event.title === 'Dia reservado')?.date, '2026-10-28');
 const previousDay = await listIcalEvents(url, '2026-10-27', async () => new Response(calendar, { headers: { 'Content-Type': 'text/calendar' } }));
 assert.equal(previousDay.some(event => event.title === 'Dia reservado'), false, 'VALUE=DATE keeps the ICS day independent of host timezone');
 const moved = events.find(event => event.title === 'Reunião reagendada');
 assert.equal(moved?.date, '2026-10-28');
 assert.equal(moved?.time, '11:00');
 const nextDay = await listIcalEvents(url, '2026-10-29', async () => new Response(calendar, { headers: { 'Content-Type': 'text/calendar' } }));
 assert.equal(nextDay.length, 0, 'a moved recurrence is not left at the original date');
 const cancelled = await listIcalEvents(url, '2026-10-30', async () => new Response(calendar, { headers: { 'Content-Type': 'text/calendar' } }));
 assert.equal(cancelled.length, 0, 'a cancelled recurrence override is omitted');
});

test('rejects redirects outside the Google calendar host without fetching them', async () => {
 let calls = 0;
 await assert.rejects(listIcalEvents(url, '2026-10-28', async () => {
  calls += 1;
  return new Response(null, { status: 302, headers: { Location: 'https://169.254.169.254/latest/meta-data' } });
 }), /endereço não permitido/);
 assert.equal(calls, 1);
});

test('stores the secret URL encrypted and preserves it across store reopen', () => {
 const dir = mkdtempSync(join(tmpdir(), 'painel-ical-'));
 const dbPath = join(dir, 'panel.sqlite'); const keyPath = join(dir, '.calendar.key');
 const config = { dbPath, keyPath };
 try {
  const store = openIcalStore(config); store.saveUrl(url); store.close();
  const db = new DatabaseSync(dbPath);
  try { const raw = db.prepare("SELECT value FROM google_calendar_metadata WHERE key='ical_url'").get() as { value: string }; assert.equal(raw.value.includes('private-secret-token'), false); } finally { db.close(); }
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  const reopened = openIcalStore(config); try { assert.equal(reopened.readUrl(), url); reopened.remove(); assert.equal(reopened.hasUrl(), false); } finally { reopened.close(); }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('removing the iCal address clears the active source and exposes no secret', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'painel-ical-route-'));
 const previousDb = process.env.PAINEL_DB_PATH;
 const previousKey = process.env.GOOGLE_TOKEN_KEY_FILE;
 process.env.PAINEL_DB_PATH = join(dir, 'panel.sqlite');
 process.env.GOOGLE_TOKEN_KEY_FILE = join(dir, '.calendar.key');
 try {
  const { POST, GET, DELETE } = await import('../app/api/calendar-feed/route.ts');
  const response = await POST(new Request('http://localhost/api/calendar-feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }));
  assert.equal(response.status, 200);
  const status = await (await GET()).json();
  assert.equal(status.source, 'ical');
  assert.equal(JSON.stringify(status).includes('private-secret-token'), false);
  assert.equal((await DELETE(new Request('http://localhost/api/calendar-feed', { method: 'DELETE' }))).status, 200);
  const disconnected = await (await GET()).json();
  assert.equal(disconnected.source, null);
  assert.equal(disconnected.configured, false);
 } finally {
  if (previousDb === undefined) delete process.env.PAINEL_DB_PATH; else process.env.PAINEL_DB_PATH = previousDb;
  if (previousKey === undefined) delete process.env.GOOGLE_TOKEN_KEY_FILE; else process.env.GOOGLE_TOKEN_KEY_FILE = previousKey;
  rmSync(dir, { recursive: true, force: true });
 }
});
