import { clearStateCookie, cookieValue, exchangeCode, googleConfig, openGoogleStore, redirectResponse, STATE_COOKIE, stateMatches } from '../../../../lib/google-calendar.ts';
import { openIcalStore } from '../../../../lib/google-ical.ts';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
function finish(url: URL, status: string, secure: boolean) {
 const target = new URL('/prototype', url.origin); target.searchParams.set('google_calendar', status);
 return redirectResponse(target, clearStateCookie(secure));
}
export async function GET(request: Request) {
 const url = new URL(request.url); const config = googleConfig();
 if (!config) return finish(url, 'unconfigured', false);
 const secure = new URL(config.redirectUri).protocol === 'https:';
 const state = url.searchParams.get('state'); const cookie = cookieValue(request, STATE_COOKIE); const expires = cookieValue(request, `${STATE_COOKIE}_expires`);
 if (!stateMatches(state, cookie, expires)) return finish(url, 'error', secure);
 if (url.searchParams.has('error')) return finish(url, url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'error', secure);
 const code = url.searchParams.get('code'); if (!code) return finish(url, 'error', secure);
 try {
  const tokens = await exchangeCode(config, code); const store = openGoogleStore(config);
  try { store.save(tokens); } finally { store.close(); }
  const preferences = openIcalStore(); try { preferences.setSource('oauth'); } finally { preferences.close(); }
  return finish(url, 'connected', secure);
 } catch { return finish(url, 'error', secure); }
}
