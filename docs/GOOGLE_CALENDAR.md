# Read-only Google Calendar

Koema displays Google Calendar events alongside manual appointments. Only one Google source is active at a time. Calendar access never creates, edits, or deletes Google events and does not access Gmail.

## Set up iCal

1. Open Google Calendar settings in your browser.
2. Select your calendar under its calendar settings and open **Integrate calendar**.
3. Copy the **Secret address in iCal format**. Do not use the public address or make your calendar public.
4. In Koema, open **Google Agenda**, paste the address into **Endereço secreto iCal**, and select **Salvar e consultar agenda**.

Treat this address as a credential: anyone with it can read the calendar feed. Some managed accounts may restrict access to secret addresses.

## Updates and supported events

Events refresh when the dashboard opens, when its window regains focus, every 15 minutes while open, and when you select **Atualizar**. Choose **Hoje** or **Amanhã** to inspect either day.

The feed may lag behind changes in Google Calendar; this integration does not provide instant updates or webhooks. Recurrence, exceptions, time zones, and all-day events are parsed with `node-ical`. Times are displayed in `America/Belem`.

## Storage and disconnection

The secret URL is encrypted with AES-256-GCM in the local SQLite database. The automatically generated 32-byte key is stored at `data/.google-calendar.key` with mode `0600`. Both are excluded from Git. Optional `GOOGLE_TOKEN_ENCRYPTION_KEY` or `GOOGLE_TOKEN_KEY_FILE` settings can override key configuration.

Keep the database and encryption key together in protected backups. Tasks, briefings, and manual appointments are ordinary SQLite records, not encrypted with this key. See the [offline backup and restore procedure](../README.md#offline-backup-and-restore), including how to verify a disposable copy. The API never returns the secret URL. **Remover endereço salvo** deletes local access without activating another source. To invalidate the feed address at Google, reset the secret address in Google Calendar settings.

Requests accept only HTTPS secret-feed URLs on `calendar.google.com`, validate redirects, and enforce response-size and timeout limits. Feed errors are shown separately from an empty calendar.

## Future direct connection

The earlier OAuth backend remains available in the source, but is hidden from the current interface. It requires developer-owned Google Cloud OAuth credentials and the `calendar.events.readonly` scope. It is not needed for iCal. See `.env.example` for optional configuration names; never commit credentials.

## References

- [Google Calendar: sync with other applications](https://support.google.com/calendar/answer/37648)
- [Google OAuth web server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)
