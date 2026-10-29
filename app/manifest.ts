import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
 return {
  id: '/', name: 'Koema — Painel de Vida', short_name: 'Koema',
  description: 'Seu espaço pessoal para tarefas, projetos e presença.',
  start_url: '/prototype', scope: '/', display: 'standalone', display_override: ['standalone'],
  background_color: '#111311', theme_color: '#111311', orientation: 'any',
  icons: [
   { src: '/icons/koema-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
   { src: '/icons/koema-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
   { src: '/icons/koema-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
 };
}
