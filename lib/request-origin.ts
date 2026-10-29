/** Compare against the actual HTTP Host: Next may normalize request.url to localhost. */
export function sameOrigin(request: Request): boolean {
 const origin = request.headers.get('origin');
 if (!origin) return true;
 try {
  const supplied = new URL(origin);
  const configured = process.env.KOEMA_PUBLIC_ORIGIN;
  const expected = configured ? new URL(configured) : new URL(request.url);
  if (configured && (expected.protocol !== 'https:' || expected.origin !== configured || expected.pathname !== '/' || expected.search || expected.hash)) return false;
  if (!configured) expected.host = request.headers.get('host') || expected.host;
  return (supplied.protocol === 'http:' || supplied.protocol === 'https:') && !supplied.username && !supplied.password && supplied.pathname === '/' && !supplied.search && !supplied.hash && supplied.origin === expected.origin;
 } catch { return false; }
}

export function strictMutationOriginAllowed(request: Request): boolean { return !!request.headers.get('origin') && sameOrigin(request); }

/** Require and validate Origin before a browser-facing mutation is parsed or run. */
export function mutationOriginError(request: Request, headers?: HeadersInit): Response | undefined {
 if (!request.headers.get('origin')) return Response.json({ error: 'A origem da solicitação não foi informada.' }, { status: 403, headers });
 if (!sameOrigin(request)) return Response.json({ error: 'Origem da solicitação não permitida.' }, { status: 403, headers });
 return undefined;
}

/** Validate an event mutation before parsing its body or opening SQLite. */
export function eventMutationError(request: Request, requireJson = true): Response | undefined {
 const originError = mutationOriginError(request);
 if (originError) return originError;
 if (requireJson && !/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) {
  return Response.json({ error: 'Envie os dados no formato JSON.' }, { status: 415 });
 }
 return undefined;
}
