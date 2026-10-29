# Koema single-owner authentication

Koema has one owner account and no public registration, invitations, or service tokens. Passwords use Node's asynchronous scrypt implementation with a unique random salt. The browser receives a random 32-byte opaque session token; SQLite stores only its SHA-256 hash. Sessions slide for seven days while active and expire absolutely after thirty days. Logout deletes the server-side session.

## First owner setup

Run the owner wizard on the server over a trusted SSH administration session, as the same restricted operating-system account that runs Koema. The wizard reads the password twice with terminal echo disabled; do not pass credentials in command arguments or environment variables. Node does not load Next.js `.env` files, and this command does not inherit systemd's `EnvironmentFile`, so set `PAINEL_DB_PATH` explicitly to the same database path configured for the service. It can run once:

```sh
cd /opt/koema/current
sudo -u koema env PAINEL_DB_PATH=/var/lib/koema/painel.sqlite npm run owner:init
```

There is no public setup route. The database directory and file must be writable only by the Koema service account.

## Recovery

To replace a forgotten owner password, sign in to the VM over SSH, stop the Koema service, and run the interactive reset as the service account. This updates the owner credentials and revokes all sessions. Start the service again and sign in over HTTPS:

```sh
sudo systemctl stop koema
cd /opt/koema/current
sudo -u koema env PAINEL_DB_PATH=/var/lib/koema/painel.sqlite npm run owner:reset
sudo systemctl start koema
```

Keep a protected, current copy of the SQLite database before owner recovery. Restoring a data-only Koema export does not restore the owner identity; initialize or recover the owner separately.

## Production reverse proxy

Set `KOEMA_PUBLIC_ORIGIN` to the exact canonical HTTPS origin, for example `https://koema.souzareis.me`. Browser mutation Origin checks use this value instead of the internal loopback HTTP URL and ignore forwarded host/protocol headers. The listener must remain private on loopback.

Caddy must overwrite the single client-address header before forwarding to the private application listener:

```caddyfile
koema.souzareis.me {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Real-IP {remote_host}
    }
}
```

Only set `KOEMA_TRUST_PROXY=1` if this reverse-proxy policy is active and the app remains on loopback. Then login throttling uses both a global key and the overwritten `X-Real-IP`; otherwise all clients share the global 15-minute limiter. This global limit bounds storage and hashing work but means five failed attempts can temporarily block another legitimate login. Failed credentials share one response; the rate-limit response is 429.

Production cookies are host-only, `HttpOnly`, `Secure`, `SameSite=Lax`, and scoped to `/`. The login endpoint caps JSON at 4 KiB, and scrypt work is asynchronous and limited to two concurrent derivations per process. All existing data, calendar, backup, and auth mutation routes require a valid server-side session. The proxy redirect is only a navigation convenience; the page and each data handler verify the session themselves.

Auth tables are separate from Koema's `PRAGMA user_version` migrations. Portable exports whitelist task and personal-data tables, set SQLite `secure_delete`, drop auth tables, and vacuum before writing the export. Import validation rejects unknown auth tables, so backup restore never replaces the owner or sessions.
