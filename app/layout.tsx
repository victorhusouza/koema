import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Koema — Painel de vida', description: 'Seu dia, com espaço para o que importa. Prévia local com dados fictícios.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="pt-BR"><body>{children}</body></html>; }
