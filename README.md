# Koema

A personal dashboard for daily briefings, tasks, projects, and calendar events. Built with Next.js, TypeScript, and SQLite.

## Run locally

Requires Node.js 24 or later.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000/prototype. The server listens on the local computer only. The application interface is in Brazilian Portuguese.

## Features

- Tasks with notes, checklists, planned dates, deadlines, Today, Upcoming, and a Logbook.
- Areas, projects, and Someday lists.
- Daily, weekly, and monthly recurrence. Monthly tasks use the last available day in shorter months while preserving their original day for subsequent months.
- Daily briefings with history and automatic saving.
- Manual appointments and read-only Google Calendar access through a secret iCal address, with Today and Tomorrow views.

See the [calendar setup guide](docs/GOOGLE_CALENDAR.md).

## Local data

The SQLite database defaults to `data/painel.sqlite`; the iCal encryption key defaults to `data/.google-calendar.key`. Both are excluded from Git. Set `PAINEL_DB_PATH` to use a different database file; the app needs permission to create and update the file and its parent directory. Choose a stable, durable local directory rather than temporary or ephemeral storage. Local `.env` files are excluded as well. New installations include demonstration data.

### Offline backup and restore

1. Stop the Koema process and wait for it to exit. For a consistent SQLite copy, use SQLite's `.backup` command if the `sqlite3` utility is available, for example: `sqlite3 "${PAINEL_DB_PATH:-data/painel.sqlite}" ".backup /secure/backup/painel.sqlite"`. Otherwise copy the database and any matching `-wal`/`-shm` sidecar files together while the app is stopped; never copy only a live main file or a WAL by itself, and never delete a live WAL to force a backup.
2. Copy the database backup and, when present, `data/.google-calendar.key` to protected backup storage. If `PAINEL_DB_PATH` or `GOOGLE_TOKEN_KEY_FILE` points elsewhere, back up those files instead. If `GOOGLE_TOKEN_ENCRYPTION_KEY` is set, preserve that secret separately in the same protected backup plan.
3. To verify a backup, copy it into a disposable directory and start Koema with `PAINEL_DB_PATH` set to that copied database. When using a key-file override, point `GOOGLE_TOKEN_KEY_FILE` at the copied key. Open the dashboard and confirm tasks, briefings, manual appointments, and—if configured—the iCal connection can be read. Keep the original backup untouched.
4. To restore, stop Koema, preserve the current database and key as a separate copy, then place the verified database and matching key at their configured paths. Start Koema and confirm the dashboard opens before removing any retained copies.

The key encrypts the saved iCal secret (and legacy OAuth connection data). Tasks, briefings, and manual appointments are stored in SQLite and are not encrypted by this key. Losing the key makes the saved calendar secret unreadable; it does not encrypt or unlock the other records.

Authentication is not implemented yet. Keep the application restricted to your own computer until hosting and authentication are prepared. Backups and restores are manual; the procedure above does not add an automated backup feature.

## Validation

```sh
npm test
npm run typecheck
npm run build
```

Tests use temporary databases and simulated calendar responses.

## Repository language

Use English for repository documentation, technical comments, issue and pull request descriptions, and commit messages. User-facing application text remains in Brazilian Portuguese.
