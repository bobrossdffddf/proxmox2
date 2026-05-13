# Go-live checklist

Use this once before opening the portal to students. About 30 minutes of work.

## On Proxmox

- [ ] API token created (`docs/proxmox-token.md`).
- [ ] Token tested with the `curl` from that doc, returns a JSON node list.
- [ ] At least one VM template built (`docs/templates.md`):
  - [ ] QEMU guest agent installed + running.
  - [ ] RDP (Windows) or VNC (Linux) listening on the documented port.
  - [ ] Snapshot named `baseline`.
  - [ ] VM converted to template (Proxmox marks it with the lock icon).
  - [ ] Template VMID is outside the `VM_ID_RANGE_START..VM_ID_RANGE_END` you'll use.
- [ ] If you don't have shared storage, each template is replicated to every node you've listed in `nodes.yaml`.

## On the Docker host

- [ ] `.env` filled in (every value, no placeholders).
- [ ] `config/nodes.yaml` lists your real node hostnames + IPs.
- [ ] `config/templates.yaml` has one entry per template, with the *correct* `proxmox_template_id`, `username`, `password`.
- [ ] `docker compose up -d` starts everything cleanly.
- [ ] `docker compose ps` shows postgres, redis, guacd, backend, frontend all healthy/Up.
- [ ] `curl http://localhost:3000/healthz` returns `{"ok":true}`.

## Bootstrap

- [ ] First admin created:
      ```
      docker compose exec backend node dist/scripts/createUser.js admin <yourpass> admin
      ```
- [ ] Logged in via the browser at the `FRONTEND_PORT` you chose.
- [ ] Dashboard shows tiles for every enabled template.

## End-to-end smoke test

- [ ] Click one tile. Toast says "VM requested".
- [ ] Within 60-90 seconds, a row appears with status `running` and the **Open** button is active.
- [ ] **Open** loads the Windows/Linux desktop in the browser.
- [ ] Mouse + keyboard work. You can log in to Windows / move around the GUI.
- [ ] Click **Stop**. Row disappears from "active sessions" within ~20 seconds.
- [ ] Confirm the clone was actually destroyed on Proxmox (VM list, not just powered off).

## Hardening before opening it to 60 students

- [ ] HTTPS in front (Caddy, Nginx Proxy Manager, or run the frontend with a real cert).
- [ ] Network ACL so the Docker host can only reach Proxmox + student VLAN, nothing else.
- [ ] Student VLAN is firewalled away from your main LAN.
- [ ] `MAX_VMS_PER_USER` and `MAX_CLUSTER_VMS` set sensibly (default 2 / 60).
- [ ] A backup plan: `pg_dump` against the postgres container into your normal homelab backup. The audit log is the only thing here you really care about preserving.
- [ ] You've actually run the inactivity timeout: leave a session idle for the configured minutes, confirm it gets cleaned up.
