import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
 const protectedPage = request.nextUrl.pathname === '/'
  || request.nextUrl.pathname.startsWith('/prototype');
 if (protectedPage && !request.cookies.has('koema_session')) {
  return NextResponse.redirect(new URL('/login', request.url));
 }
 return NextResponse.next();
}

export const config = {
 matcher: ['/', '/prototype/:path*'],
};
