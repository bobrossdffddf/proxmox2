# Troubleshooting

## "Could not get VM IP" / `waitForGuestIp` timeout

The QEMU guest agent isn't running inside the template. Either it wasn't installed (Windows) or the systemd unit isn't enabled (Linux). Boot the template manually, fix it, snapshot, retry.

If the agent *is* running but the VM has no IP yet, your DHCP server may be slow or the VM is on a VLAN that doesn't have one. Confirm by booting the template manually and running `ipconfig` / `ip a`.

## Tile click does nothing

Open the browser dev console. Most likely a `403`/`401` (token expired -> log in again) or a `429` (quota hit).

## "Cluster at capacity"

Bumped against `MAX_CLUSTER_VMS`. Edit `.env`, `docker compose up -d` (just restarts the backend container).

## Sessions stuck in `provisioning`

`docker compose exec backend node dist/scripts/resetStuckSessions.js`. Queues a cleanup for everything alive. Then watch logs with `docker compose logs -f backend`.

## RDP canvas shows "Disconnected" immediately

Almost always one of:
- Wrong RDP credentials in `templates.yaml`. Open the template manually, log in once with the credentials, confirm they're correct, snapshot, retry.
- Network Level Authentication mismatch. Try setting `security: any` (already the default we send to guacd). If still failing, disable NLA on the template.
- Firewall blocking 3389. Confirm by `nc -vz <guest-ip> 3389` from inside the backend container: `docker compose exec backend sh -c 'nc -vz <ip> 3389'`.

## "guacd: connection refused"

The `guacd` container isn't healthy. `docker compose ps` should show it Up. If it's restarting, `docker compose logs guacd`. Usually means the host kernel is missing AF_UNIX or similar — rare.

## Performance is bad over the network

guacd has a `dpi`/`width`/`height` setting we pass on every connect. Lower the resolution in `backend/src/rdp/proxy.ts` (look for `width: 1280, height: 800`). Smaller frames means less bandwidth.

## I changed `templates.yaml` and the dashboard didn't update

`docker compose restart backend`. The backend caches the parsed YAML for the lifetime of the process. (Admin -> POST /api/admin/reload also works if you don't want to bounce the container.)

## I forgot the admin password

```
docker compose exec backend node dist/scripts/createUser.js <username> <new-password> admin
```

The script upserts: same username -> new password.
