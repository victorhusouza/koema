import { join } from 'node:path';
import { localDay } from './task-dates.ts';
import { openTaskStore, type Task } from './task-store.ts';
import { openNotificationStore, type DeliveryClaim, type StoredSubscription } from './notification-store.ts';
import { loadWebPushConfig, sendWebPush, type PushSubscriptionData, type WebPushConfig } from './web-push.ts';

export type NotificationSender = (config: WebPushConfig, subscription: PushSubscriptionData, payload: string) => Promise<unknown>;
export type SchedulerTickOptions = {
  dbPath?: string;
  now?: Date;
  send?: NotificationSender;
  config?: WebPushConfig | null;
  schedulerEnabled?: boolean;
  maxDurationMs?: number;
};
export type SchedulerTickResult = { materialized: number; dueTasks: number; attempted: number; sent: number; failed: number; enabled: boolean };

function dueReminder(task: Task, now: number, oldest: number): task is Task & { reminderAt: string } {
  const reminder = task.reminderAt;
  if (task.done || typeof reminder !== 'string') return false;
  const timestamp = Date.parse(reminder);
  return Number.isFinite(timestamp) && timestamp <= now && timestamp >= oldest;
}

function goneStatus(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { statusCode?: unknown }).statusCode;
  return status === 404 || status === 410;
}

function payloadFor(taskId: number, reminderAt: string) {
  const stableTag = `koema-reminder-${taskId}-${Date.parse(reminderAt)}`;
  return JSON.stringify({ title: 'Koema', body: 'Você tem um lembrete.', url: `/prototype?task=${taskId}`, tag: stableTag });
}

/** Materialize calendar schedules and deliver due reminders through encrypted active sessions. */
export async function runSchedulerTick(options: SchedulerTickOptions = {}): Promise<SchedulerTickResult> {
  const path = options.dbPath || process.env.PAINEL_DB_PATH || join(process.cwd(), 'data', 'painel.sqlite');
  const now = options.now ?? new Date();
  const timestamp = now.getTime();
  const today = localDay(now);
  const config = options.config === undefined ? (() => { try { return loadWebPushConfig(); } catch { return null; } })() : options.config;
  const notificationStore = openNotificationStore(path, { config, now: () => timestamp });
  let taskStore: ReturnType<typeof openTaskStore> | undefined;
  const result: SchedulerTickResult = { materialized: 0, dueTasks: 0, attempted: 0, sent: 0, failed: 0, enabled: false };
  try {
    notificationStore.heartbeat(timestamp);
    const enabled = options.schedulerEnabled ?? process.env.KOEMA_SCHEDULER_ENABLED === '1';
    result.enabled = enabled && !!config;
    taskStore = openTaskStore(path, { now: () => now });
    result.materialized = taskStore.materializeSchedules(today).created;
    if (!enabled || !config) return result;

    const oldest = timestamp - 24 * 60 * 60 * 1000;
    const allDue = taskStore.list().filter(task => dueReminder(task, timestamp, oldest)).sort((a, b) => a.id - b.id);
    const cursor = notificationStore.schedulerCursor();
    const firstIndex = allDue.findIndex(task => task.id > cursor);
    const rotatedDue = firstIndex < 0 ? allDue : [...allDue.slice(firstIndex), ...allDue.slice(0, firstIndex)];
    const due = rotatedDue.slice(0, 100);
    result.dueTasks = due.length;
    const subscriptions = notificationStore.activeSubscriptions(timestamp).slice(0, 10);
    if (subscriptions.length === 0 || due.length === 0) return result;
    const send = options.send ?? sendWebPush;
    const tickStarted = Date.now();
    const maxDurationMs = options.maxDurationMs ?? 45_000;

    for (const task of due) {
      if (result.attempted >= 100 || Date.now() - tickStarted >= maxDurationMs) break;
      const reminderAt = task.reminderAt!;
      let completedTaskBatch = true;
      for (const subscription of subscriptions) {
        if (result.attempted >= 100 || Date.now() - tickStarted >= maxDurationMs) { completedTaskBatch = false; break; }
        const currentTask = taskStore.get(task.id);
        if (!currentTask || currentTask.done || currentTask.reminderAt !== reminderAt || !notificationStore.isSubscriptionActive(subscription.tokenHash, subscription.endpointHash, Date.now())) continue;
        const claim = notificationStore.claimDelivery(task.id, reminderAt, subscription.endpointHash, timestamp);
        if (!claim) continue;
        const confirmedTask = taskStore.get(task.id);
        const confirmedSession = notificationStore.isSubscriptionActive(subscription.tokenHash, subscription.endpointHash, Date.now());
        if (!confirmedTask || confirmedTask.done || confirmedTask.reminderAt !== reminderAt || !confirmedSession) {
          notificationStore.releaseDelivery(claim, timestamp);
          continue;
        }
        result.attempted++;
        try {
          await send(config, subscription.subscription, payloadFor(task.id, reminderAt));
          notificationStore.markDelivered(claim, timestamp);
          result.sent++;
        } catch (error) {
          result.failed++;
          if (goneStatus(error)) {
            notificationStore.markGone(claim, timestamp);
            notificationStore.removeEndpoint(subscription.endpointHash);
          } else notificationStore.markFailed(claim, timestamp);
        }
      }
      notificationStore.setSchedulerCursor(completedTaskBatch ? task.id : task.id - 1);
    }
    return result;
  } finally {
    taskStore?.close();
    notificationStore.close();
  }
}

/** Used by the explicit test endpoint; only subscriptions bound to this live session are returned. */
export async function sendSessionTest(options: {
  dbPath: string;
  token: string;
  config: WebPushConfig;
  now?: Date;
  send?: NotificationSender;
}): Promise<{ attempted: number; sent: number; failed: number }> {
  const timestamp = (options.now ?? new Date()).getTime();
  const store = openNotificationStore(options.dbPath, { config: options.config, now: () => timestamp });
  try {
    const subscriptions: StoredSubscription[] = store.claimManualTests(options.token, timestamp);
    const result = { attempted: subscriptions.length, sent: 0, failed: 0 };
    const send = options.send ?? sendWebPush;
    const payload = JSON.stringify({ title: 'Koema', body: 'Notificações ativadas.', url: '/prototype', tag: 'koema-test' });
    for (const subscription of subscriptions) {
      if (!store.isSubscriptionActive(subscription.tokenHash, subscription.endpointHash, Date.now())) continue;
      try { await send(options.config, subscription.subscription, payload); result.sent++; }
      catch (error) { result.failed++; if (goneStatus(error)) store.removeEndpoint(subscription.endpointHash); }
    }
    return result;
  } finally { store.close(); }
}
