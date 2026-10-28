import { authorizationUrl, googleConfig, makeState, redirectResponse } from '../../../../lib/google-calendar.ts';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
 const config = googleConfig();
 if (!config) return redirectResponse(new URL('/prototype?google_calendar=unconfigured', request.url));
 try {
  const state = makeState(); const secure = new URL(config.redirectUri).protocol === 'https:';
  return redirectResponse(authorizationUrl(config, state.value), [
   `painel_google_oauth_state=${state.value}; Max-Age=600; Path=/api/google; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
   `painel_google_oauth_state_expires=${state.expires}; Max-Age=600; Path=/api/google; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
  ]);
 } catch { return redirectResponse(new URL('/prototype?google_calendar=error', request.url)); }
}
