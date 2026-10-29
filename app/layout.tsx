import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Koema — Painel de Vida', description: 'Seu dia, com espaço para o que importa.', applicationName: 'Koema', appleWebApp: { capable: true, title: 'Koema', statusBarStyle: 'black-translucent' }, icons: { apple: '/icons/koema-180.png' } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="pt-BR"><body>{children}</body></html>; }
