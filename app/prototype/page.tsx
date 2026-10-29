import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Dashboard from './dashboard';
import { AUTH_COOKIE, verifySession } from '../../lib/auth.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PrototypePage() {
 const token = (await cookies()).get(AUTH_COOKIE)?.value;
 const request = new Request('http://localhost/prototype', {
  headers: token ? { cookie: `${AUTH_COOKIE}=${token}` } : {},
 });
 if (!await verifySession(request)) redirect('/login');
 return <Dashboard />;
}
