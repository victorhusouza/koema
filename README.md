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

The database and encryption key are stored in `data/`, which is excluded from Git. Local `.env` files are excluded as well. New installations include demonstration data.

Authentication is not implemented yet. Keep the application restricted to your own computer until hosting and authentication are prepared. Backup and restore are planned features.

## Validation

```sh
npm test
npm run typecheck
npm run build
```

Tests use temporary databases and simulated calendar responses.

## Repository language

Use English for repository documentation, technical comments, issue and pull request descriptions, and commit messages. User-facing application text remains in Brazilian Portuguese.
