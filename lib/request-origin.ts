/** Compare against the actual HTTP Host: Next may normalize request.url to localhost. */
export function sameOrigin(request: Request): boolean {
 const origin = request.headers.get('origin');
 if (!origin) return true;
 try {
  const supplied = new URL(origin);
  const target = new URL(request.url);
  const host = request.headers.get('host') || target.host;
  return supplied.origin === `${target.protocol}//${host}`;
 } catch { return false; }
}

/** Validate an event mutation before parsing its body or opening SQLite. */
export function eventMutationError(request: Request, requireJson = true): Response | undefined {
 if (!request.headers.get('origin')) return Response.json({ error: 'Informe a origem da solicitação.' }, { status: 403 });
 if (!sameOrigin(request)) return Response.json({ error: 'Origem da solicitação não permitida.' }, { status: 403 });
 if (requireJson && !/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) {
  return Response.json({ error: 'Envie os dados no formato JSON.' }, { status: 415 });
 }
 return undefined;
}
