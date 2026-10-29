'use client';

import { useEffect, useState } from 'react';
import { Bell, BellOff, Smartphone } from 'lucide-react';

type Config = { configured: boolean; publicKey: string | null; schedulerEnabled?: boolean };
function applicationKey(value: string) {
 const padded = value + '='.repeat((4 - value.length % 4) % 4);
 const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
 return Uint8Array.from(raw, character => character.charCodeAt(0));
}
async function readConfig(): Promise<Config> {
 const response = await fetch('/api/notifications/config', { cache: 'no-store' });
 const body = await response.json();
 if (!response.ok) throw new Error(body.error || 'Não foi possível carregar as notificações.');
 return body;
}

export default function PushNotificationSettings() {
 const [config, setConfig] = useState<Config | null>(null);
 const [subscription, setSubscription] = useState<PushSubscription | null>(null);
 const [busyAction, setBusyAction] = useState<'enable'|'disable'|null>(null);
 const [testing, setTesting] = useState(false);
 const [message, setMessage] = useState('');
 const [error, setError] = useState('');
 const [supported, setSupported] = useState(false);
 useEffect(() => {
  const available = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  setSupported(available);
  if (!available) return;
  void (async () => {
   try {
    const [settings, registration] = await Promise.all([readConfig(), navigator.serviceWorker.register('/sw.js', { scope: '/' })]);
    setConfig(settings); setSubscription(await registration.pushManager.getSubscription());
   } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível verificar as notificações.'); }
  })();
 }, []);
 async function enable() {
  if (busyAction || !config?.configured || !config.publicKey) return;
  setBusyAction('enable'); setError(''); setMessage('');
  try {
   const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
   if (permission !== 'granted') throw new Error(permission === 'denied' ? 'As notificações estão bloqueadas neste navegador. Ative-as nos ajustes do site e tente novamente.' : 'Permita as notificações para continuar.');
   const registration = await navigator.serviceWorker.ready;
   const value = subscription ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(config.publicKey) });
   const response = await fetch('/api/notifications/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value.toJSON()) });
   const body = await response.json();
   if (!response.ok) throw new Error(body.error || 'Não foi possível ativar as notificações.');
   setSubscription(value); setMessage('Notificações ativadas neste dispositivo.');
  } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível ativar as notificações.'); }
  finally { setBusyAction(null); }
 }
 async function disable() {
  if (busyAction || !subscription) return;
  setBusyAction('disable'); setError(''); setMessage('');
  try {
   const response = await fetch('/api/notifications/subscriptions', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
   const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Não foi possível desativar as notificações.');
   await subscription.unsubscribe(); setSubscription(null); setMessage('Notificações desativadas neste dispositivo.');
  } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível desativar as notificações.'); }
  finally { setBusyAction(null); }
 }
 async function sendTest() {
  if (testing) return;
  setTesting(true); setError(''); setMessage('');
  try {
   const response=await fetch('/api/notifications/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
   const body=await response.json();if(!response.ok)throw new Error(body.error||'Não foi possível enviar um aviso de teste.');
   setMessage('Aviso de teste enviado.');
  } catch(cause) { setError(cause instanceof Error?cause.message:'Não foi possível enviar um aviso de teste.'); }
  finally { setTesting(false); }
 }
 const installed = typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & {standalone?:boolean}).standalone === true);
 return <section className="card list-view push-settings">
  <div className="section-top"><h2><Bell size={18}/> Notificações</h2></div>
  <div className="backup-content">
   <p>Receba um lembrete discreto neste dispositivo quando uma tarefa chegar ao horário definido. O aviso mostra apenas o nome do Koema. Abra o Koema periodicamente para manter sua sessão ativa.</p>
   {!supported && <p className="muted">Este navegador não oferece notificações push. No iPhone, abra o painel pelo ícone adicionado à Tela de Início.</p>}
   {supported && !config && !error && <p className="muted" role="status">Verificando se as notificações estão disponíveis…</p>}
   {supported && config && !config.configured && <p className="muted">As notificações ainda não estão disponíveis. Você pode continuar usando o painel neste dispositivo.</p>}
   {supported && config?.configured && <button className="primary" disabled={busyAction!==null} onClick={() => void enable()}><Bell size={15}/>{busyAction==='enable' ? 'Ativando…' : subscription ? 'Ativar neste dispositivo' : 'Ativar notificações'}</button>}
   {subscription && <button className="secondary" disabled={busyAction!==null} onClick={() => void disable()}><BellOff size={15}/>{busyAction==='disable' ? 'Desativando…' : 'Desativar neste dispositivo'}</button>}
   {config?.configured&&config.schedulerEnabled===false&&<p className="muted">Os avisos automáticos ainda estão em preparação. Você ainda pode ativar as notificações neste dispositivo e enviar um aviso de teste.</p>}
   {subscription && config?.configured && <button className="text-button" disabled={testing} onClick={() => void sendTest()}>{testing?'Enviando…':'Enviar aviso de teste'}</button>}
   {message && <p className="settings-success" role="status">{message}</p>}{error && <p className="save-error" role="alert">{error}</p>}
   {!installed && <div className="install-hint"><Smartphone size={17}/><span>Para receber avisos com o iPhone fechado, toque em Compartilhar e escolha <strong>Adicionar à Tela de Início</strong>. Depois, abra o Koema pelo novo ícone e ative as notificações.</span></div>}
  </div>
 </section>;
}
