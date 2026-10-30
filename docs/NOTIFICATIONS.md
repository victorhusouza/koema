# Web Push notifications

Koema sends generic Web Push reminders from a separate Node scheduler process. The web application stores subscriptions encrypted in the same SQLite database as tasks. The scheduler materializes calendar schedules and sends due reminder notifications while the subscribing login session is valid.

## Browser setup

The user must sign in, install Koema to the Home Screen, then enable notifications from the app with a direct tap. The browser asks for notification permission only after that tap. On iPhone and iPad, Web Push requires iOS/iPadOS 16.4 or later and a Home Screen web app; an ordinary Safari tab does not receive background pushes.

Enablement registers the service worker, requests a browser push subscription, and sends that subscription to `POST /api/notifications/subscriptions`. The page reads `GET /api/notifications/config` first. It requires an authenticated session and returns the public VAPID key only when server keys are valid. `POST /api/notifications/test` sends a generic notification to the active devices bound to the current login session. `DELETE /api/notifications/subscriptions` removes the current device using `{ "endpoint": "..." }`.

Closing the browser does not stop delivery. Delivery is best-effort and requires an active scheduler, a valid push-provider subscription, and a live Koema session. Push services may retain a message for up to one hour while a device is offline; delivery still depends on the device reconnecting before that retention period expires. Web Push is not a native offline alarm. Sessions expire after their existing sliding and absolute limits. Signing out or resetting the owner revokes the session and stops future pushes from its devices. A device must subscribe again after signing in with a new session.

Notifications never include task titles, notes, or checklist contents. The push payload contains a generic message and a Koema task URL. The service worker constrains notification clicks to the same app origin.

## Server keys

Generate one VAPID key file on the server as the service account. The example below creates a private directory owned by `koema`, so the service can read the key while other users cannot. Use a contact address controlled by the operator, or the canonical public HTTPS origin:

```sh
sudo install -d -o koema -g koema -m 0700 /var/lib/koema-push
sudo -u koema /opt/nodejs/bin/node --experimental-strip-types /opt/koema/current/scripts/generate-push-keys.ts --output /var/lib/koema-push/vapid.key --subject https://koema.example
```

The command uses exclusive file creation and sets the file mode to `0600`. It prints the path and public key only. It refuses to overwrite an existing file. Store the file outside the application directory, database directory, backups, and source control. Do not copy private keys into logs, browser responses, support tickets, or backups. The application accepts `WEB_PUSH_KEY_FILE` as its preferred key source. For deployments that use environment values instead, provide `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, and `WEB_PUSH_SUBJECT` together.

The key file contains JSON with `publicKey`, `privateKey`, and `subject`. The application validates the P-256 keypair and key-file permissions. Subscription records are encrypted with AES-256-GCM using a key derived from the VAPID private key, with a fresh random IV and authentication tag for every record. Only a SHA-256 endpoint hash is stored outside the encrypted subscription. Rotating the VAPID pair also changes the at-rest encryption key; arrange for existing devices to unsubscribe and subscribe again when rotating keys.

Subscriptions are accepted only from HTTPS endpoints on the supported FCM, Mozilla, Apple, and Windows notification provider hosts. The server rejects arbitrary URLs, nonstandard ports, URL credentials, query strings, and fragments. Delivery uses direct HTTPS requests with a 10-second socket timeout and no redirect following.

## Scheduler process

Configure the app and scheduler process with the same database path and public origin. Keep the `koema` service account able to read and write the active database and its WAL files. The key file is owned by `koema` with mode `0600`; keep its parent directory private as in the command above.

Example `/etc/koema/koema.env`:

```sh
PAINEL_DB_PATH=/var/lib/koema/painel.sqlite
KOEMA_PUBLIC_ORIGIN=https://koema.example
WEB_PUSH_KEY_FILE=/var/lib/koema-push/vapid.key
KOEMA_SCHEDULER_ENABLED=1
```

Make `/etc/koema/koema.env` readable by `koema` (for example, owner `root`, group `koema`, mode `0640`). Install `deploy/koema-scheduler.service.example` as a systemd unit after adjusting its application path for the host. It uses `/opt/nodejs/bin/node`, matching the VM runtime. The process runs one scheduler tick and then waits 60 seconds before the next. Keep it as a single active instance for this SQLite database. It writes a heartbeat to the database on each tick, even when push keys are absent. The UI reports the scheduler as enabled only when `KOEMA_SCHEDULER_ENABLED=1` and a heartbeat is less than three minutes old.

The scheduler CLI refuses to start and exits before opening the database unless `KOEMA_SCHEDULER_ENABLED=1`. When enabled but VAPID keys are missing or invalid, the process still materializes schedules and writes heartbeats but makes no push requests. The unit does not start itself; installing or enabling it is an operator action.

The scheduler checks explicit `reminderAt` instants from the previous 24 hours through the present and asks push services to retain each message for up to 3,600 seconds. It does not notify for tasks without an explicit reminder. It rechecks that a task remains open with the same reminder and that the device session remains valid immediately before sending. Delivery claims use a SQLite lease and retry transient provider errors with bounded exponential backoff. HTTP 404 and 410 responses remove the obsolete subscription. A delivery ledger prevents repeat sends after a successful tick, though a process crash between provider acceptance and recording success can result in a retry; the stable notification tag lets the browser collapse that duplicate.

The service has a per-tick wall-clock budget, a limit of 100 newly claimed deliveries, a rotating cursor through due tasks, and a global limit of ten active device subscriptions. Delivery failures are retained without provider response bodies or endpoint URLs and are removed after 30 days. Notification tables are excluded from Koema's portable backups.

## Local checks

The focused tests use generated temporary keys, temporary SQLite databases, and injected senders. They do not call real push providers or use production keys.

```sh
node --experimental-strip-types --test tests/notifications.test.ts tests/scheduler.test.ts
```

## Scheduler readiness during deployment

The scheduler supports execution through `/opt/koema/current`, including when that
path is a symlink to a versioned release. The entrypoint compares canonical paths
so Node's module resolution cannot silently skip the worker loop.

After starting the service, run the readiness probe as the runtime user with the
production database path. For example, from the release directory:

```sh
sudo -u koema env PAINEL_DB_PATH=/var/lib/koema/painel.sqlite \
  /opt/nodejs/bin/node --experimental-strip-types scripts/check-scheduler.ts
```

The probe waits up to 30 seconds for a recent heartbeat. A missing database,
missing scheduler table, empty state, or temporarily unreadable database means
“not ready” while polling, without printing a SQLite stack trace. The probe opens
existing databases read-only and never creates tables, runs migrations, restores
data, or starts services. It exits with status 1 if readiness is not confirmed.
Keep the dashboard in maintenance until the probe and authentication checks pass.
