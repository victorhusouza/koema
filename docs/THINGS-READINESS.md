# Things import readiness

This change prepares Koema's structures. Importing a real Things export and deploying these changes remain separate steps. Personal source databases and exported content stay outside Git; tests use invented data.

## Agreed placement mapping

| Things list | Koema destination |
| --- | --- |
| Anytime | Someday (`Algum dia`) |
| Someday | Someday (`Algum dia`) |
| This Evening | Today (`Hoje`) |
| Today | Today (`Hoje`) |
| Upcoming | Planned date, preserving the source date |
| Inbox | Inbox (`Caixa de entrada`) |

The mapping applies after identifying the source list, not by guessing from one private SQLite enum. Original completion timestamps and source metadata must remain intact for Logbook items. The approved import scope includes completed history.

## Structures

- Projects can have no area and carry notes, planned dates, deadlines, tags, and ordering.
- Project headings keep their identity and order. Moving a task to another project clears an incompatible heading.
- Tags support parent tags and shortcuts. Task views include tags inherited from their project and area.
- Tasks carry checklist state, reminder instants, creation/modification timestamps, and immutable source identifiers for a future importer.
- Recurring schedules preserve their template separately from generated occurrences. Calendar schedules can generate occurrences independently of completion; after-completion schedules wait for the prior occurrence. Paused rules retain history and existing tasks.
- Native legacy recurrence continues to work. Portable backups include the new personal-data structures and remain compatible with older Koema exports.

## PWA and notifications

The installable PWA uses a push-only service worker. It does not cache private pages, API responses, calendars, or authentication state for offline access. Notification permission follows an explicit user action.

A separate scheduler process is required for reminders while the app is closed. Its deployment, key generation, and real iPhone delivery must be validated after publication. Subscription credentials and delivery state are excluded from portable data exports. See [notification setup](NOTIFICATIONS.md).

## Import acceptance

Before a real import, generate a preview that compares every supported structure and field, keeps Things identifiers to prevent duplicates, and lists any unrecognized recurrence rule. Unknown source rules must remain unconverted until reviewed. Raw Things synchronization settings and authentication tokens are not part of the task-data import. Keep the source export unchanged and take a current server backup before applying the reviewed migration.
