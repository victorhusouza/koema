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
