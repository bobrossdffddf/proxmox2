# WCTARange

Self-hosted, browser-rendered VM lab portal for the WCTA CyberPatriot club. Students log in, click a tile, and get a full Windows or Linux desktop in their browser — no client install. VMs run on the Proxmox cluster, get cloned from clean templates on demand, are load-balanced across nodes, and are thrown away (or reverted to a baseline snapshot) when the session ends.

## What it does

- **Tile dashboard** — students see one tile per practice image, auto-populated from `config/templates.yaml`. Add a template, add a tile.
- **One-click launch** — clone a template (linked clone, instant), power it on, wait for the guest IP, hand the student a browser RDP session.
- **100% browser rendering** — `guacd` translates RDP/VNC into the Guacamole protocol, `guacamole-lite` proxies it over WebSocket, the frontend draws it on an HTML5 canvas. No mstsc.exe, no plugins.
- **Load balancing** — backend queries every Proxmox node, picks the one with the lowest combined CPU + memory utilization.
- **Heartbeat-based cleanup** — frontend sends a heartbeat every 10s while the user is interacting. If we don't hear from them for 30 minutes (configurable), the session is cleaned up. Hard cap of 4 hours per session.
- **Snapshot revert on cleanup** — when a session ends, the VM is reverted to the template's `baseline` snapshot before being deleted. This protects baked-in scoring software that "can't be erased."
- **Audit log** — every login, VM request, and cleanup is written to `audit_log`.
- **Quotas** — max VMs per user and max VMs cluster-wide are enforced in the provisioning queue.

## Architecture

```
Browser
  React tile dashboard
  guacamole-common-js canvas
        |
        | HTTPS + WebSocket
        v
Backend (Node.js + Express + TypeScript)
  - Auth (JWT, bcrypt)
  - Proxmox cluster client (load balancer)
  - Session manager (heartbeat tracking)
  - BullMQ workers: provisioning + cleanup + inactivity sweeper
  - WebSocket proxy (guacamole-lite -> guacd)
        |
        +---> PostgreSQL (users, sessions, audit log)
        +---> Redis (BullMQ + heartbeat cache)
        +---> guacd (RDP/VNC protocol translator)
        +---> Proxmox API on each cluster node
```

Everything except `guacd` is your code or a stock Docker image. Bring it up with `docker compose up -d`.

## Prerequisites

1. A Proxmox cluster (any number of nodes, named whatever).
2. One VM template per practice image, with:
   - QEMU guest agent installed and running (so we can discover the DHCP IP).
   - For Windows: RDP enabled, a known local admin account, NLA either disabled or with credentials we'll pass through Guacamole.
   - For Linux: a VNC server listening on `:0` (or `xrdp` if you prefer RDP).
   - A snapshot named `baseline` representing the clean state we revert to.
3. A Proxmox API token with the permissions listed in [`docs/proxmox-token.md`](docs/proxmox-token.md).
4. A Docker host with at least 4 GB RAM and network access to:
   - Every Proxmox node on TCP 8006 (API).
   - Every student VM on TCP 3389 (RDP) or 5900 (VNC).

## First-time setup

```bash
# 1. Clone and enter
git clone <your fork>
cd WCTARange

# 2. Copy and fill in the env file
cp .env.example .env
$EDITOR .env

# 3. Tell the system about your Proxmox cluster
$EDITOR config/nodes.yaml

# 4. Tell the system about your practice images
$EDITOR config/templates.yaml

# 5. Bring everything up
docker compose up -d

# 6. Wait ~30 seconds for postgres + backend to settle, then create your admin user
docker compose exec backend node dist/scripts/createUser.js admin <password> admin

# 7. Open the portal
open http://localhost:8080
```

That's it. The database schema auto-applies on first boot.

## Adding a new practice image

### From a VMware export (the usual case)

Go to **Admin → Import** and drop the file on it — a `.zip` of the VM folder, an
`.ova`, or a bare disk image. It reads the bundle, works out the CPU, memory,
disks and guest OS, creates the VM on Proxmox and converts the disks, then hands
back for guest preparation and publishes the dashboard tile. No SSH, no
`qm importdisk`, no editing YAML.

Full walkthrough and requirements: [`docs/importing-vms.md`](docs/importing-vms.md).

### From a template you build yourself

1. Build the template on any Proxmox node. Install your software. Take a snapshot named `baseline`.
2. Add an entry to `config/templates.yaml`:
   ```yaml
   - id: windows11_hardening
     name: Windows 11 — Hardening Practice
     description: Locate misconfigurations on a stock Windows 11 image.
     icon: windows
     proxmox_template_id: 9001
     snapshot_name: baseline
     protocol: rdp
     port: 3389
     username: Administrator
     password: <baked-in password>
     cpu_cores: 4
     memory_mb: 4096
   ```
3. `docker compose restart backend`. The dashboard picks it up automatically — no rebuild needed.

## Removing a practice image

Go to **Admin → Images**. Every tile is listed with the Proxmox template VM it
clones from, whether that VMID actually exists on the node it points at, how
many warm and in-use clones it has, and the last staging error if it has one.

- **Hide** takes the tile off the student dashboard and leaves everything else
  alone. Reversible.
- **Delete** destroys the image and everything derived from it: running clones,
  the warm pool, and the Proxmox template VM. Clones are removed first, because
  they are linked clones and Proxmox will not delete a template while one still
  points at it. You are asked to type the image id to confirm, and get a
  per-VM report afterwards.

A tile defined in `config/templates.yaml` is hidden rather than deleted — the
file is the source of truth and the config mount is read-only. Its VMs are
still destroyed; remove the YAML entry to retire the tile for good.

## How the console connects

Two paths, picked automatically:

- **Fast** — `guacd` speaks the guest's own protocol (RDP on 3389 for Windows,
  a VNC server on 5900 for Linux) straight to the VM's IP. It sends drawing
  operations rather than pixels, resizes the guest desktop to the browser
  window, and gives you a real shared clipboard. This is the default.
- **Compatible** — QEMU's display console through the Proxmox API. Works on any
  VM at all, including one with no network or no guest OS, which makes it the
  right fallback — but it re-encodes the framebuffer as images on the Proxmox
  host and crosses an extra hop, so it is noticeably slower and has no
  clipboard channel to the guest.

If the fast path can't reach the guest, the console falls back on its own and
says why. **Display → Auto/Force** in the console toolbar overrides the choice.
For the fast path to work, a Windows image needs RDP enabled and port 3389 open
in its firewall; a Linux image needs a VNC server on 5900.

## Files you'll edit

- `.env` — secrets, timeouts, quotas.
- `config/nodes.yaml` — your Proxmox node hostnames.
- `config/templates.yaml` — hand-written practice images. Tiles created by
  **Admin → Import** live in the database instead, so this file stays optional.

Everything else is generated code.

## Where things live

- `backend/` — Node.js API + workers + WebSocket proxy.
- `frontend/` — React (Vite) tile portal + console viewer.
- `docker-compose.yml` — orchestrates postgres, redis, guacd, backend, frontend.
- `scripts/` — helper scripts (create admin user, reset stuck sessions, etc.).

## Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md).
# proxmox2
