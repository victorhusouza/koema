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
- Recurring schedules preserve their template separately from generated occurrences. Calendar schedules keep fixed calendar dates while allowing only one open occurrence per rule; after-completion schedules calculate the next date from the actual completion date. Paused rules retain history and existing tasks.
- Native legacy recurrence continues to work. Portable backups include the new personal-data structures and remain compatible with older Koema exports.

## PWA and notifications

The installable PWA uses a push-only service worker. It does not cache private pages, API responses, calendars, or authentication state for offline access. Notification permission follows an explicit user action.

A separate scheduler process is required for reminders while the app is closed. Its deployment, key generation, and real iPhone delivery must be validated after publication. Subscription credentials and delivery state are excluded from portable data exports. See [notification setup](NOTIFICATIONS.md).

## Import acceptance

Before a real import, generate a preview that compares every supported structure and field, keeps Things identifiers to prevent duplicates, and lists any unrecognized recurrence rule. Unknown source rules must remain unconverted until reviewed. Raw Things synchronization settings and authentication tokens are not part of the task-data import. Keep the source export unchanged and take a current server backup before applying the reviewed migration.

## Offline preview tooling

`scripts/things_preview.py` reads a whitelist of source tables and fields, refuses
an existing output directory, and creates a new private Koema preview database.
It has no server connection or production import mode. `review.json` is private
and can contain task titles; keep the entire output outside Git. Do not restore
this preview as a production backup: unresolved fields and schedule associations
remain explicitly unapproved.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_things_preview.py'
python3 scripts/things_preview.py --source /private/path/main.sqlite \
  --output /private/new-preview-directory --day YYYY-MM-DD
```

Civil date and reminder encodings were cross-checked against the
[things.py implementation](https://thingsapi.github.io/things.py/things/database.html).
Recurrence frequency candidates were compared with
[things-cloud-mcp](https://github.com/wbopan/things-cloud-mcp/blob/main/main.go).
Its repeat-mode interpretation conflicts with
[dongxi's format notes](https://pkg.go.dev/github.com/kern/dongxi/dongxi);
therefore candidates must not be activated until confirmed against the source
application. Unknown offsets remain unconverted. The preview never runs a
scheduler or generates occurrences. Completed source records retain completion
instants; source identifiers and historical links are retained for reconciliation.

Explicit mode confirmations can be provided through `--confirmed-modes`, a private
JSON map from exact `things:<uuid>` identifiers to `calendar`. A confirmation is
scoped to that source identifier; matching raw mode codes do not confirm other
rules. Occurrences link to candidate templates using their original scheduled
civil date, even if an overdue task is displayed under Today. Conflicting source
occurrences are reported rather than automatically merged. Preview creation
never materializes schedules; any generator verification must use a separate,
discardable database copy.

## Applying a reviewed import

`import_things_preview.py` merges the six personal-data tables inside a single
SQLite transaction. It requires existing schema-version-7 databases and never
copies authentication, calendars, sessions, subscriptions, or other system tables.
Identifiers are remapped for task, schedule, heading, project, area and tag links.
Existing tasks stay unchanged. Matching area/tag names can be reused; conflicting
projects stop the transaction for review instead of overwriting data.

A source-fingerprint ledger makes a repeated package a no-op, even when a user
has edited or deleted imported records. A different package under the same source
fingerprint is refused. Full server backups preserve this ledger; portable task
exports do not currently include it. Source identifiers provide additional
record-level duplicate protection, but do not replace the ledger after a portable
restore. Tests cover rollback after task insertion, conflicts, relationship
remapping, history preservation, repeat imports and private-table isolation.

Production execution must stop the app and scheduler behind maintenance mode,
create a consistent root-private backup, rehearse the merge on that fresh backup,
then apply the same package to the active database. Validate transaction completion,
integrity, scheduler heartbeat, login and unauthenticated API protection before
reopening the site. Failures keep maintenance enabled and preserve backups for
review; never automatically restore an old database after accepting new writes.

## Single pending occurrence policy

The user chose one open occurrence per recurring rule. An existing overdue,
future, imported, or edited occurrence blocks new calendar copies. Once it is
completed, the next occurrence follows the original fixed calendar rule; its
anchor does not shift to the completion date. Missed dates while paused are not
backfilled as a queue. If today's occurrence was already completed, its unique
schedule/date key prevents recreating it. Existing history is retained.

`scripts/resume-imported-schedules.ts --database PATH` previews restoration of
temporary cleanup pauses; `--apply` performs the transaction. The utility restores
only Things rules recorded as active before cleanup, preserves original pauses,
skips expired rules and rules edited since the archive, and records a resume
ledger so rerunning it cannot undo a later user pause. Run it only after deploying
the single-pending generator, taking a full backup and stopping concurrent writes.
The utility changes rules and cursors only; it never deletes or recreates tasks.

The `cleanup_demo_tasks.py` helper now implements the user's final cleanup scope:
keep tasks with Things source identifiers and archive every other task, including
manual tasks and generated occurrences. Its name reflects its original, narrower
use; it must not be treated as a general automatic demo-data detector. The cleanup
was a one-off operator action. Do not run it during ordinary deployments: it would
archive genuine Koema tasks created after migration. Both cleanup helpers preserve
recovery records in `things_cleanup_archive` and require a separate full backup.
