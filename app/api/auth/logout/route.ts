import { clearCookie, revokeSession, validateMutationOrigin } from '../../../../lib/auth.ts';

export const runtime = 'nodejs';

export async function POST(request: Request) {
 if (!validateMutationOrigin(request)) {
  return Response.json({ error: 'Origem da solicitação não permitida.' }, { status: 403 });
 }
 revokeSession(request);
 return Response.json({ ok: true }, {
  headers: {
   'Cache-Control': 'no-store',
   'Set-Cookie': clearCookie(request),
  },
 });
}
