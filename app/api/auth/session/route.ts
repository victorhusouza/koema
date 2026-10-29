import { cookieHeader, verifySession } from '../../../../lib/auth.ts';

export const runtime = 'nodejs';

export async function GET(request: Request) {
 const session = await verifySession(request, true);
 if (!session) {
  return Response.json({ authenticated: false }, {
   headers: { 'Cache-Control': 'no-store' },
  });
 }
 return Response.json({ authenticated: true, username: session.username }, {
  headers: {
   'Cache-Control': 'no-store',
   'Set-Cookie': cookieHeader(session.token, session.maxAge, request),
  },
 });
}
