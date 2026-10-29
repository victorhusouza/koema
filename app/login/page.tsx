'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
 const router = useRouter();
 const [username, setUsername] = useState('');
 const [password, setPassword] = useState('');
 const [error, setError] = useState('');
 const [pending, setPending] = useState(false);

 async function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (pending) return;
  setPending(true);
  setError('');
  try {
   const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
   });
   const body = await response.json();
   if (!response.ok) throw new Error(body.error || 'Não foi possível entrar.');
   setPassword('');
   router.replace('/prototype');
   router.refresh();
  } catch (cause) {
   setError(cause instanceof Error ? cause.message : 'Não foi possível entrar.');
  } finally {
   setPending(false);
  }
 }

 return (
  <main className="login-shell">
   <section className="login-card">
    <div className="login-mark">K</div>
    <p className="login-eyebrow">SEU ESPAÇO, NO SEU RITMO</p>
    <h1>Bem-vindo de volta.</h1>
    <p className="login-copy">Entre no seu painel pessoal.</p>
    <form onSubmit={submit}>
     <label htmlFor="username">Usuário</label>
     <input
      id="username"
      name="username"
      autoComplete="username"
      autoFocus
      required
      value={username}
      onChange={event => setUsername(event.currentTarget.value)}
     />
     <label htmlFor="password">Senha</label>
     <input
      id="password"
      name="password"
      type="password"
      autoComplete="current-password"
      required
      value={password}
      onChange={event => setPassword(event.currentTarget.value)}
     />
     {error && <p className="login-error" role="alert">{error}</p>}
     <button className="primary login-submit" disabled={pending}>
      {pending ? 'Entrando…' : 'Entrar'}
     </button>
    </form>
   </section>
  </main>
 );
}
