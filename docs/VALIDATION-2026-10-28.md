# Koema validation record — 2026-10-28

## Browser checks

The local review server ran on port 3101 against a dummy database at `/private/tmp/koema-review-20261028/painel.sqlite`; the user's normal server on port 3000 and real database were not used.

- Exported a backup and confirmed the UI reported success.
- Uploaded that backup through the UI. The server verified it and saved a separate database; the displayed record counts matched the source copy.
- Created an Area and confirmed it appeared in the UI.
- Tried a duplicate Area name. The UI showed the validation error and retained the entered draft.
- Created a Project and selected its Area by name from the dropdown.
- The first Escape check exposed that it also closed the sidebar. After the fix and server restart, Escape closed only the dialog, left the sidebar open, and returned focus to the New Area button.
- Manually completed and reopened a dummy Project; edited its name and moved it to another Area.
- Created a manual appointment while Tomorrow was selected; verified the default date and that the record did not appear in Today.
- Edited and saved a dummy briefing; confirmed the text survived restarting the review server.
- Completed a recurring daily task; verified its next occurrence appeared in Upcoming and the completed one in Logbook, then reopened it successfully.

These browser checks cover only the flows listed above; they are not a complete accessibility or cross-device audit.

## Automated checks

Focused Node test suites passed for task/project behavior, briefing save and loading, recurrence, manual events, calendar feed parsing, backup export/import validation, and backup filename date formatting. Backup cases include a WAL-consistent snapshot, preservation of task recurrence/history and other local domains, exclusion of calendar connection metadata and known secret markers, corrupt/truncated/oversized/future-schema rejection, malicious filenames, and confirmation that restore writes to a separate staged database while leaving the active database unchanged.

After the final Belém-date formatting and Escape propagation edits, `npm run typecheck`, `npm run build`, `git diff --check`, and the focused backup filename date test passed. Briefing failure/date-switch and recurrence conflict checks have automated coverage; no browser fault-injection pass was performed for those cases.

## Remaining validation

- Browser fault injection for briefing network failures and all date-switch races remains a separate check; the source-level automated tests do not replace full browser coverage.
- Real Google Calendar access was not used during validation. Calendar parsing was tested with fabricated feeds.
- The hosting document is a plan only. No Oracle Cloud resource or production deployment was created or validated.

## Search, mutation checks, and cleanup

The October 28 code review follow-up replaced the fixed search demo result with saved task and project title matches. Search ignores case and accents, includes completed records, opens task details by task ID, and opens projects by project ID. The task-store list path now loads area and project catalogs once and uses indexed lookups to preserve current relational labels. Browser mutation routes share strict protocol-and-host origin checks and reject missing or malformed origins; OAuth disconnect keeps its separate configured callback-origin and state validation. Backup streaming limits and secret/database handling remain in place.

The active dashboard styling remains intact while unused variant styles and the variant switcher were removed. The Mac-specific status copy and the “Upcoming” label were retained as requested. Capitalization remains authoritative in the stores, while persisted task and manual appointment titles render as stored. Google Calendar timed-event formatting and AES-GCM payload handling now share helpers without changing stored ciphertext format; floating all-day iCal dates retain their civil-date handling.

Validation for these changes: all 57 automated tests passed with `npm test`; `npm run typecheck`, `npm run build`, and `git diff --check` passed. The all-day iCal fixture also passed under both `TZ=UTC` and `TZ=America/Belem`.

Browser follow-up on the isolated dummy database verified that an accent-free query found the saved “Projeto fictício revisado” project and opened its project view; searching “mesa” found a completed task marked “Concluída” and opened the correct task details. No personal database or real Google connection was used.
