# Koema future hosting plan — Oracle Cloud Infrastructure

**Status:** planning only. No VM, network rule, volume, account, or service has been created or changed. The user approved planning a future Oracle VM with 1 vCPU and 5 GB of memory; implementation requires a separate cutover approval.

## Target and constraints

- Start with the requested 1 vCPU / 5 GB memory budget. In OCI terminology the CPU allocation is expressed as OCPUs; flexible shapes allow CPU and memory to be selected, but the exact shape and availability depend on the chosen region and platform. Confirm whether “1 vCPU” means one OCI OCPU or one virtual hardware thread, and confirm that a compatible configuration is available before provisioning. Do not infer x86 or Arm from the request. [OCI Compute shapes](https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm)
- Use a supported Linux image and the repository's required Node.js 24 or later. Verify the selected Node release, native `node:sqlite` support, application build, and process architecture on the chosen image before transferring user data.
- Run the production build as a single Koema process. Keep the application listener on loopback behind an HTTPS reverse proxy. Do not use `next dev` in production. Pick the public hostname, client access policy, and exact public/upstream listener ports during the deployment review; none are decided here.
- Keep SQLite on durable local block storage attached to that VM; do not put a WAL database on a network filesystem. For the initial deployment, operate one Koema process per database file so migrations, backups, and app-level coordination stay simple. SQLite supports concurrent connections, but adding multiple app processes would need an explicit operational design for those concerns.

## Access and network boundary

- Require the implemented native single-owner authentication before exposing personal data. The existing same-origin checks remain a request-forgery safeguard. See [AUTHENTICATION.md](AUTHENTICATION.md) for the SSH-only owner setup, recovery, session policy, and reverse-proxy origin configuration.
- Restrict network ingress to the approved HTTPS entry point and a narrowly scoped administration path. Keep direct access to the Next.js listener private to the VM. Use an OCI Network Security Group or equivalent reviewed network controls; do not open an unapproved management endpoint. [OCI Network Security Groups](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/networksecuritygroups.htm)
- The visible Google Calendar integration is the secret iCal feed, not OAuth. Keep its URL private and stored only in the protected local database. The planned server must be able to reach Google's calendar feed endpoint over HTTPS; OAuth client credentials are not required for this user-facing path. No live calendar URL or credential has been supplied or tested for this plan.
- Store any deployment-only secrets outside Git and restrict them to the Koema process. Do not copy `.env` files, OAuth credentials, or the local calendar encryption key into a public image, source tree, logs, or backup archive. If the calendar key is not migrated, the user reconnects the iCal feed after cutover.

## Persistent data and recovery

- Choose the final database directory before provisioning the application. Set `PAINEL_DB_PATH` to a stable path on the durable volume. Keep the database and any calendar key file readable only by the Koema service account; do not share the service account with shell logins or unrelated apps.
- Keep the current SQLite backup export as an application-level, data-only copy: tasks, completion history, recurrence, Areas, Projects, briefings, and manual appointments. It intentionally excludes Google Calendar connection metadata and secrets. The current import verifies the file and saves it as a separate database; it does not replace the active database.
- Before a planned migration or restore, take a fresh SQLite-consistent application export, stop the single writer, preserve the current database and key separately, and verify the candidate copy in its staging location. Compare the reported counts, check SQLite integrity, and open the dashboard against the staged database before cutover. Only after explicit approval should `PAINEL_DB_PATH` point at the selected database and Koema restart. Keep the pre-cutover database recoverable until the user confirms the deployed data.
- Add a separate protected backup of the persistent volume for VM/volume recovery. OCI Block Volume backups are encrypted at rest and support manual and policy-based schedules; they are infrastructure recovery copies and do not replace an application-consistent SQLite export. Set retention, access, and any cross-region copy only after confirming budget and recovery needs. [OCI Block Volume backups](https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/blockvolumebackups.htm)
- Perform a restore drill into a new volume or path before treating the backup policy as proven. Record the tested recovery steps, expected downtime, and who can access backup material.

## Operations and resource checks

- Build and run only one production instance. Measure steady-state and peak memory while the briefing, task history, calendar feed, and backup validation flows are active. The requested 5 GB is a planning ceiling, not a performance guarantee; review memory and disk growth before any resize.
- Add monitoring for process health, disk space, database write errors, backup age, and certificate expiry. Keep application logs free of task bodies, briefing text, secret feed URLs, and credentials.
- Schedule OS security updates and application dependency updates. Rebuild and validate before switching versions; keep a known-good application build and database backup for rollback.
- Document cost and billing for the selected shape, boot/data volume, backups, public IP or network services if needed, and any domain/certificate service before provisioning.

## Decisions required before provisioning

1. OCI region and tenancy/compartment that may contain this personal data.
2. Exact flexible shape and CPU architecture after checking regional capacity and Node 24 compatibility.
3. Linux image, domain, approved public and upstream ports, and whether access is private-only or public behind authentication.
4. Confirm the native single-owner authentication and SSH-only administrator recovery path in `AUTHENTICATION.md`.
5. Durable volume size, backup schedule/retention, where the encrypted off-host copy is held, and restore ownership.
6. Whether to migrate the current local database or start with a fresh server database. A migration requires an explicit data-transfer and cutover approval.

## Deployment gate

This document is not deployment authorization. Before provisioning or transferring any real data, review the decisions above, validate the selected resources and cost, produce the exact cutover and rollback plan, then obtain the user's go-ahead. No cloud changes are part of the approved work in this plan.
