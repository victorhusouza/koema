# Koema

A personal dashboard for daily briefings, tasks, projects, and calendar events. Built with Next.js, TypeScript, and SQLite.

## Run locally

Requires Node.js 24 or later.

```sh
npm ci
PAINEL_DB_PATH="$PWD/data/painel.sqlite" npm run owner:init
npm run dev
```

Create the single owner in an interactive terminal, then open http://127.0.0.1:3000. The command sets the same explicit database path used by the app's default configuration. For a custom local database path, set `PAINEL_DB_PATH` explicitly for both `owner:init` and the app process; the Node CLI does not load Next.js `.env` files. The server listens on the local computer only. The application interface is in Brazilian Portuguese.

## Features

- Tasks with notes, checklists, planned dates, deadlines, Today, Upcoming, and a Logbook.
- Case- and accent-insensitive search across saved task and project titles, including completed records.
- Areas, projects, and Someday lists, with labeled create/edit forms and manual project completion.
- Daily, weekdays, weekends, weekly, and monthly recurrence. Monthly tasks use the last available day in shorter months while preserving their original day for subsequent months.
- Daily briefings with history and automatic saving.
- Manual appointments and read-only Google Calendar access through a secret iCal address, with Today and Tomorrow views.

See the [calendar setup guide](docs/GOOGLE_CALENDAR.md).

See [authentication and owner recovery](docs/AUTHENTICATION.md) before hosting. Koema has no public registration or setup page; first owner setup and password recovery run only in an interactive SSH or local terminal.

See the [future hosting plan](docs/HOSTING-PLAN.md) for an unapproved deployment outline. It does not provision infrastructure or transfer data.

## Local data

The SQLite database defaults to `data/painel.sqlite`; the iCal encryption key defaults to `data/.google-calendar.key`. Both are excluded from Git. Set `PAINEL_DB_PATH` to use a different database file; the app needs permission to create and update the file and its parent directory. Choose a stable, durable local directory rather than temporary or ephemeral storage. Local `.env` files are excluded as well. New installations include demonstration data.

### Local backup and restore check

Open the navigation menu and choose **Backup e restauração**. Export downloads a consistent `.sqlite` snapshot, including tasks and their history, areas, projects, briefings, and manual appointments. The Google Calendar connection, saved feed address, and credentials are excluded; reconnect the calendar after using a backup if needed.

To verify a backup, select the exported file and choose **Verificar e salvar cópia separada**. Koema checks SQLite integrity and schema compatibility, then writes a uniquely named copy under `restored-backups` beside the active database. This verifies the backup and keeps it available for a deliberate manual recovery; it does not replace the active database. The panel reports the backup date, schema and app versions, and record counts. Files are limited to 64 MB and local requests require a matching browser origin.

Keep exported files in protected storage. The feature does not encrypt backup files or switch the active database. Portable exports also exclude owner and session records, so the owner account must be initialized separately after restoring data. Authenticated browser mutations still require a matching request origin.

## Validation

```sh
npm test
npm run typecheck
npm run build
```

Tests use temporary databases and simulated calendar responses.

## Repository language

Use English for repository documentation, technical comments, issue and pull request descriptions, and commit messages. User-facing application text remains in Brazilian Portuguese.

## License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 Victor Hugo Souza do Nascimento.
