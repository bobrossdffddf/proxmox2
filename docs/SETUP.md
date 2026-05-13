# WCTARange — full setup, start to finish

One long walkthrough. If you do every step in order, you end up with a working portal at the end. No earlier doc knowledge required. Every command is here.

You will need:

- Your Proxmox cluster (already running).
- A laptop or workstation you can SSH from.
- Two empty VMs you will create during this guide: one Linux "Docker host" that runs WCTARange itself, and one Windows 11 (or whatever OS) template VM that students will practice on. You'll add more templates later.

Plan at a glance:

```
Phase 1: Build a Debian VM on Proxmox to run WCTARange.        ~20 min
Phase 2: Install Docker on it.                                  ~5  min
Phase 3: Put the WCTARange code on it.                          ~3  min
Phase 4: Create the Proxmox API token.                          ~3  min
Phase 5: Build the Windows 11 practice template.                ~45 min
Phase 6: Build extra templates (Server 2022, Ubuntu).           ~30 min each
Phase 7: Tell WCTARange about your nodes and templates.         ~5  min
Phase 8: First boot.                                            ~2  min
Phase 9: Create your admin user, log in, smoke test.            ~5  min
```

Total first-run time: about two and a half hours, most of which is Windows updating itself.

---

## Phase 1 — Build the Linux host that runs WCTARange

We need one Linux machine to run the WCTARange Docker stack. Easiest is to make it a VM on your existing Proxmox cluster. Debian 12 is the right pick: it's what Proxmox itself is built on, so you already speak its language. Ubuntu 22.04 works equivalently; pick whichever you prefer. Commands below are Debian 12.

### 1.1 Download the Debian 12 ISO

On any machine, in a browser, go to:

```
https://www.debian.org/CD/netinst/
```

Click "amd64" under "Small CDs". You'll get a file like `debian-12.x.x-amd64-netinst.iso` (~600 MB).

### 1.2 Upload the ISO to Proxmox

In the Proxmox web UI:

1. Datacenter -> your-node -> local (or whichever storage holds ISOs) -> **ISO Images** -> **Upload**.
2. Pick the file you downloaded. Wait for the upload to finish.

### 1.3 Create the VM

Proxmox web UI -> top right **Create VM**.

- **General tab:** Name `wctarange-host`. VM ID: anything outside your template range (e.g. 200).
- **OS tab:** ISO image = the Debian 12 ISO you just uploaded. Guest OS = Linux 6.x.
- **System tab:** keep defaults. Make sure **Qemu Agent** is checked.
- **Disks tab:** 40 GB. Storage = your normal storage pool.
- **CPU tab:** 4 cores. Type `host` (you'll get better performance for the Docker workload).
- **Memory tab:** 4096 MB minimum (8192 MB recommended for headroom).
- **Network tab:** the bridge your normal LAN is on (usually `vmbr0`). Model `VirtIO`.
- **Confirm tab:** check **Start after created**, click Finish.

### 1.4 Install Debian inside the VM

Open the VM's console in Proxmox (double-click the VM -> Console). You'll see the Debian installer.

Step through it:

- Language: English. Country: United States. Keymap: American English.
- Hostname: `wctarange-host`. Domain: leave blank (or your home domain).
- Root password: set one and write it down.
- New user: `wcta`. Password: set one and write it down.
- Disk partitioning: **Guided - use entire disk**. Select the only disk. **All files in one partition**. Finish and write changes.
- Software selection screen (after base install): **uncheck "Debian desktop environment" and "GNOME"**, **check "SSH server" and "standard system utilities"**, uncheck everything else. Continue.
- GRUB: install to `/dev/sda` (the only option offered).
- Reboot.

When the installer finishes and the VM reboots, log in as `wcta` at the console.

### 1.5 Find the VM's IP

Inside the VM:

```bash
ip -4 a | grep inet
```

You'll see something like `inet 192.168.1.42/24`. Write that down. You'll SSH to it for the rest of the guide.

### 1.6 SSH in from your laptop

From now on you can work from your normal laptop instead of the Proxmox console.

```bash
ssh wcta@192.168.1.42       # replace with the IP you wrote down
```

### 1.7 Give your user sudo

```bash
su -
apt update && apt install -y sudo
usermod -aG sudo wcta
exit
exit
```

SSH back in as `wcta`. From now on every command can be prefixed with `sudo`.

### 1.8 Set a static-ish IP (recommended)

Either:
- **Easy way (recommended):** go to your DHCP server (your router / your `vmbr0`'s DHCP) and reserve a permanent lease for this VM's MAC address.
- **Or set it inside the VM** by editing `/etc/network/interfaces`. (Skip if you did the reservation.)

---

## Phase 2 — Install Docker on the host

All commands run on the Debian host as `wcta`, with `sudo`.

### 2.1 Pull in basics

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg git
```

### 2.2 Install Docker's official APT repo

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian $(. /etc/os-release; echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
```

### 2.3 Install Docker and the Compose plugin

```bash
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### 2.4 Let your user run Docker without sudo

```bash
sudo usermod -aG docker $USER
```

Log out and back in (`exit`, then SSH in again) so the group change takes effect.

### 2.5 Confirm Docker works

```bash
docker run --rm hello-world
```

You should see "Hello from Docker!". If you see permission errors, the group change didn't take — exit and SSH in again.

---

## Phase 3 — Get the WCTARange code onto the host

You already have the project locally; the repo lives at `github.com/bobrossdffddf/proxmox2`. Get it onto the Docker host:

```bash
cd ~
git clone https://github.com/bobrossdffddf/proxmox2.git WCTARange
cd WCTARange
ls
```

You should see `backend/`, `frontend/`, `config/`, `docker-compose.yml`, `.env.example`, etc.

If the repo is private, git will prompt for a username and password. Use your GitHub username, and for the password paste a **Personal Access Token** (GitHub no longer accepts account passwords). Create one at GitHub -> Settings -> Developer settings -> Personal access tokens -> Tokens (classic) -> Generate new token, with the `repo` scope.

---

## Phase 4 — Create the Proxmox API token

You only do this once. Pick any node — Proxmox shares user/token state across the cluster.

### 4.1 Create a user

Proxmox web UI:

1. Datacenter -> Permissions -> **Users** -> **Add**.
2. User name: `wctarange`. Realm: `Proxmox VE authentication server` (`pve`). Password: set any (we won't use it, the token does the talking).
3. Click Add.

### 4.2 Create the API token

1. Datacenter -> Permissions -> **API Tokens** -> **Add**.
2. User: `wctarange@pve`. Token ID: `provisioner`.
3. **Uncheck "Privilege Separation".** (Critical. If you leave it checked, the token starts with zero permissions and we'd have to grant them to the token itself.)
4. Expire: blank.
5. Click Add.

A dialog appears with the token secret. **Copy it now.** It will never be shown again.

You now have two values:
- Token ID: `wctarange@pve!provisioner`
- Secret: a UUID like `12345678-aaaa-bbbb-cccc-1234567890ab`

### 4.3 Grant permissions to the user

1. Datacenter -> Permissions -> **Add** -> **User Permission**.
2. Path: `/`.
3. User: `wctarange@pve`.
4. Role: **PVEVMAdmin** (built-in role with everything we need).
5. Propagate: **checked**.
6. Click Add.

Then one more grant for reading node load:

1. Datacenter -> Permissions -> **Add** -> **User Permission**.
2. Path: `/`.
3. User: `wctarange@pve`.
4. Role: **PVEAuditor**.
5. Propagate: checked.
6. Add.

### 4.4 Verify the token from the Docker host

```bash
curl -k -H "Authorization: PVEAPIToken=wctarange@pve!provisioner=THE-UUID-YOU-COPIED" \
  https://YOUR-PROXMOX-NODE-IP:8006/api2/json/nodes
```

You should get a JSON blob with your cluster nodes. If you get `401`, double-check you unchecked privilege separation in step 4.2. If you get a connection error, check the IP / port 8006 is reachable from the Docker host.

---

## Phase 5 — Build the Windows 11 practice template

This is the most involved phase. Work entirely inside Proxmox.

### 5.1 Get the Windows 11 ISO

Download from Microsoft: `https://www.microsoft.com/software-download/windows11`. You want the "Windows 11 Disk Image (ISO) for x64 devices" option. Upload it to Proxmox local storage the same way you uploaded the Debian ISO in 1.2.

### 5.2 Get the VirtIO driver ISO

Proxmox uses paravirtual drivers Windows doesn't ship with. You need the VirtIO driver ISO during install.

Download:

```
https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso
```

Upload it to Proxmox the same way.

### 5.3 Create the Windows 11 VM

Proxmox web UI -> Create VM.

- **General tab:** Name `tpl-windows11`. VM ID: pick something memorable like `9001`. Check **Advanced**, set **Start at boot** to off.
- **OS tab:** ISO image = Windows 11 ISO. Guest OS Type = Microsoft Windows, Version = 11/2022.
- **System tab:**
  - Graphic card: Default
  - Machine: q35
  - BIOS: OVMF (UEFI)
  - Add EFI Disk: yes, storage = your default pool.
  - **Add TPM:** yes, storage = your default pool, version = v2.0. (Windows 11 won't install without it.)
  - Qemu Agent: **checked**.
- **Disks tab:** Bus = SCSI (yes, SCSI not SATA — needed for VirtIO). Storage = your pool. Size = 80 GB. Cache = Write back.
- **CPU tab:** 4 cores, Type `host`.
- **Memory tab:** 4096 MB.
- **Network tab:** Bridge `vmbr0`, Model `VirtIO`, Firewall checked.
- **Confirm:** uncheck "Start after created", click Finish.

### 5.4 Attach the VirtIO ISO as a second CD-ROM

The template VM you just created -> Hardware -> **Add** -> CD/DVD drive -> use ISO image = `virtio-win.iso`. Click Add.

### 5.5 Boot the VM and install Windows

Start the VM. Open its console.

Press a key when prompted to "boot from CD". The Windows installer loads.

- Language / time / keyboard: continue.
- Install now.
- Skip product key (you'll activate later if needed).
- Pick Windows 11 Pro (or whichever edition your school has licenses for).
- Accept license.
- Custom: Install Windows only.
- The disk list will be empty. Click **Load driver** -> Browse -> the VirtIO CD -> `amd64\w11`. Pick the `Red Hat VirtIO SCSI controller` driver, Next. Your 80 GB disk should now appear. Select it -> Next.
- Windows copies files and reboots. Continue through OOBE.

**Critical OOBE step:** at the "Let's connect you to a network" screen, **don't.** Press `Shift+F10` to open a command prompt, run `OOBE\BYPASSNRO`, the VM reboots, and now you can choose "I don't have internet" and create a **local account**. Username: `Administrator`, password: anything memorable (e.g. `ChangeMe123!`). Write the password down — you'll put it in `config/templates.yaml` later.

When you reach the Windows desktop, you're past the hard part.

### 5.6 Install QEMU guest agent and remaining VirtIO drivers

Inside Windows:

1. File Explorer -> `D:` drive (the VirtIO CD).
2. Run `virtio-win-gt-x64.msi`. Click through with defaults. This installs all the VirtIO drivers Windows didn't already pick up.
3. Reboot.
4. Back inside Windows, on the VirtIO CD, run `virtio-win-guest-tools.exe`. Defaults again. This installs the QEMU guest agent service.
5. Open Services (`Win+R`, `services.msc`), find "QEMU Guest Agent", make sure it's Running and Startup type Automatic.

### 5.7 Enable Remote Desktop

Settings -> System -> Remote Desktop -> **On**. Confirm.

Then make NLA optional:

1. `Win+R`, run `SystemPropertiesRemote`.
2. Under Remote Desktop, **uncheck "Allow connections only from computers running Remote Desktop with Network Level Authentication"**.
3. OK.

(Disabling NLA simplifies first-time troubleshooting. You can flip it back on later.)

### 5.8 Install whatever practice software the image needs

CyberPatriot scoring engine, intentional misconfigurations, anything else baked into the practice scenario. Whatever your competition image needs goes here.

### 5.9 Run Windows Update once

Settings -> Windows Update -> Check for updates. Let it install everything, reboot as needed, run Update again until it says you're current.

### 5.10 Shut down cleanly

Start menu -> Power -> Shut down. **Don't restart, fully shut down.**

### 5.11 Snapshot it

VM in Proxmox -> Snapshots -> **Take Snapshot**.

- Name: `baseline`
- Include RAM: unchecked
- Description: "Clean baseline. Revert here on session cleanup."

Click Take Snapshot. Wait for it to finish.

### 5.12 Remove the install media

VM -> Hardware -> the Windows 11 ISO CD-ROM -> Edit -> set to "Do not use any media". Same for the VirtIO CD.

### 5.13 Convert to template

Right-click the VM in the left sidebar -> **Convert to template**. Confirm.

The VM icon changes (shows the lock badge). It can no longer be started directly — only cloned.

### 5.14 Note the VMID

The VMID you used (e.g. `9001`) goes into `config/templates.yaml` later. Write it down.

### 5.15 Important storage note

If your Proxmox cluster does **not** have shared storage (Ceph, NFS, or similar), templates only live on the node where they were created. Linked clones need the template on the same node. So either:

- (a) Add shared storage (best long-term answer), or
- (b) Replicate the template to every node. Right-click template -> Migrate -> repeat per node. Or use Proxmox's replication feature.

---

## Phase 6 — Optional: extra templates

Same procedure as Phase 5, with deltas.

### Windows Server 2022

Identical to Windows 11 except:
- Download Server 2022 ISO from Microsoft Evaluation Center.
- Guest OS Type: Windows, Version 11/2022.
- TPM is optional (Server doesn't require it). EFI is optional too; legacy BIOS works.
- During OOBE you'll be asked to set the Administrator password. Match it to whatever you put in `templates.yaml`.
- Everything else: same. Install VirtIO drivers, install QEMU guest agent, enable RDP, install practice software, snapshot as `baseline`, convert to template.

### Ubuntu 22.04

1. Download the Ubuntu 22.04 server ISO: `https://ubuntu.com/download/server`.
2. Create VM: Linux, kernel 6.x. Disk on VirtIO bus directly (no driver dance). 40 GB disk, 2 cores, 2048 MB RAM.
3. Install Ubuntu with defaults. Create a user named `cyber` with a password matching `templates.yaml`. **Install OpenSSH server during install.**
4. After first boot, log in. Run:

   ```bash
   sudo apt update && sudo apt upgrade -y
   sudo apt install -y qemu-guest-agent xfce4 xfce4-goodies x11vnc xinit
   sudo systemctl enable --now qemu-guest-agent
   ```

5. Create a systemd unit so VNC comes up at boot. As root:

   ```bash
   sudo tee /etc/systemd/system/x11vnc.service > /dev/null <<'EOF'
   [Unit]
   Description=Start x11vnc for the cyber user
   After=multi-user.target

   [Service]
   Type=simple
   User=cyber
   ExecStartPre=/usr/bin/Xorg :1 -config /etc/X11/xorg.conf.d/dummy.conf vt7 &
   ExecStart=/usr/bin/x11vnc -forever -display :1 -rfbport 5900 -passwd ChangeMe123!
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   EOF
   sudo systemctl daemon-reload
   sudo systemctl enable x11vnc
   ```

   (Replace `ChangeMe123!` with whatever password you put in `templates.yaml`. The Xorg dummy config is a separate rabbit hole — if you don't want to wrangle headless X, just use **xrdp** instead, which works like RDP and is simpler.)

   **Simpler alternative — xrdp:**
   ```bash
   sudo apt install -y xrdp
   sudo systemctl enable --now xrdp
   sudo adduser xrdp ssl-cert
   ```
   Then in `templates.yaml` use `protocol: rdp` and `port: 3389` for the Ubuntu template too.

6. `sudo shutdown -h now`. Snapshot as `baseline`. Convert to template.

---

## Phase 7 — Tell WCTARange about your cluster and templates

Back on the Docker host, in `~/WCTARange`.

### 7.1 Set up the env file

```bash
cp .env.example .env
nano .env
```

Walk through every line. The ones you must change:

- `JWT_SECRET=` paste the output of `openssl rand -hex 64` (run it in another terminal).
- `POSTGRES_PASSWORD=` pick a random string.
- `PROXMOX_TOKEN_ID=wctarange@pve!provisioner`
- `PROXMOX_TOKEN_SECRET=` the UUID you copied in 4.2.
- `MAX_VMS_PER_USER=` keep default 2 unless you have a reason.
- `MAX_CLUSTER_VMS=` set based on your hardware (rule of thumb: total cluster RAM ÷ 4 GB).
- `VM_ID_RANGE_START / VM_ID_RANGE_END` — make sure this range doesn't include your template IDs (9001, 9002, ...) or anything else important. Defaults (10000-19999) are usually fine.

Save and exit (`Ctrl+O`, Enter, `Ctrl+X`).

### 7.2 Edit `config/nodes.yaml`

```bash
nano config/nodes.yaml
```

List every node in your cluster. The `name` field must match Proxmox's idea of the node name exactly (Datacenter -> Nodes shows the right value, usually the same as `hostname` on the node). The `host` field is the IP or DNS name that resolves from the Docker host.

Example with two nodes:

```yaml
nodes:
  - name: starbase-pve
    host: 192.168.1.10
    port: 8006
    enabled: true
  - name: starbase-pve-2
    host: 192.168.1.11
    port: 8006
    enabled: true
```

Save and exit.

### 7.3 Edit `config/templates.yaml`

```bash
nano config/templates.yaml
```

One entry per template VM you built. Critical fields:

- `proxmox_template_id`: the VMID you wrote down (e.g. 9001).
- `username` + `password`: the credentials baked into that template. Must match exactly or RDP/VNC will fail.
- `protocol`: `rdp` for Windows or xrdp-ed Linux, `vnc` for raw VNC.
- `port`: 3389 for RDP, 5900 for VNC.

Example with three templates:

```yaml
templates:
  - id: windows11_baseline
    name: Windows 11 — Baseline
    description: Stock Windows 11 image. Find and fix the misconfigurations.
    icon: windows
    proxmox_template_id: 9001
    snapshot_name: baseline
    protocol: rdp
    port: 3389
    username: Administrator
    password: ChangeMe123!
    cpu_cores: 4
    memory_mb: 4096

  - id: server2022_baseline
    name: Windows Server 2022 — Baseline
    description: Domain controller hardening practice.
    icon: server
    proxmox_template_id: 9002
    snapshot_name: baseline
    protocol: rdp
    port: 3389
    username: Administrator
    password: ChangeMe123!
    cpu_cores: 4
    memory_mb: 8192

  - id: ubuntu22_baseline
    name: Ubuntu 22.04 — Baseline
    description: Linux hardening practice.
    icon: linux
    proxmox_template_id: 9003
    snapshot_name: baseline
    protocol: rdp        # using xrdp
    port: 3389
    username: cyber
    password: ChangeMe123!
    cpu_cores: 2
    memory_mb: 2048
```

Save and exit.

---

## Phase 8 — First boot

```bash
cd ~/WCTARange
docker compose up -d
```

The first run pulls images (Postgres, Redis, guacd, Node base) and builds the backend + frontend. Expect 3-5 minutes the first time.

Watch it come up:

```bash
docker compose ps
docker compose logs -f backend
```

The backend logs should end with `backend listening` and then go quiet. Press `Ctrl+C` to stop tailing logs (it won't stop the backend).

Sanity check the health endpoint:

```bash
curl http://localhost:3000/healthz
```

You should see `{"ok":true}`.

---

## Phase 9 — Create your admin user and log in

### 9.1 Make yourself an admin user

```bash
docker compose exec backend node dist/scripts/createUser.js admin YOUR-CHOSEN-PASSWORD admin
```

Output: `User 'admin' (admin) ready.`

### 9.2 Open the portal

In your browser, on any machine that can reach the Docker host:

```
http://192.168.1.42:8080
```

(Replace the IP with whatever the Docker host is. The port matches `FRONTEND_PORT` in `.env`, default 8080.)

Log in with `admin` and the password you just set.

### 9.3 Smoke test

1. You should see one tile per template you defined in `templates.yaml`.
2. Click a tile. Toast: "VM requested".
3. Within 60-90 seconds, a row appears under "Your active sessions" with status `running` and an **Open** button.
4. Click **Open**. The Windows or Linux desktop should fill the canvas in your browser. Mouse and keyboard work.
5. Click **Stop**. Within ~20 seconds the row vanishes. Confirm in Proxmox that the cloned VM is gone (not just powered off — gone).

If any step fails, see `docs/troubleshooting.md`.

---

## Phase 10 — Adding more practice images later

Once everything works, adding a new template takes ~30 minutes of Windows install + 30 seconds of config:

1. Build the template VM in Proxmox (Phase 5 procedure).
2. Snapshot as `baseline`. Convert to template. Note its VMID.
3. On the Docker host: `nano ~/WCTARange/config/templates.yaml`. Add an entry. Save.
4. `docker compose restart backend`. (Or hit `POST /api/admin/reload` if you're slicker.)
5. Refresh the dashboard. The new tile appears.

To create accounts for your 60 students, loop the createUser command:

```bash
docker compose exec backend node dist/scripts/createUser.js alice CHOSEN-PW student
docker compose exec backend node dist/scripts/createUser.js bob   CHOSEN-PW student
# ... etc
```

Or, faster, write a one-liner shell loop over a CSV.

---

## Appendix A — Running the portal off your Windows desktop instead of a dedicated Linux VM

You probably don't want this in production, but it's handy for testing.

1. Install **Docker Desktop for Windows**: download from `https://docs.docker.com/desktop/install/windows-install/`. The installer guides you through enabling WSL 2 if needed. Reboot when asked.
2. Install **Git for Windows**: `https://git-scm.com/download/win`. Defaults are fine.
3. Open PowerShell. Clone the repo:

   ```powershell
   cd $HOME
   git clone https://github.com/bobrossdffddf/proxmox2.git WCTARange
   cd WCTARange
   ```

4. Copy and edit the env file:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   Fill in exactly the same values described in Phase 7.1.

5. Edit `config\nodes.yaml` and `config\templates.yaml` in Notepad (or VS Code). Same content as Phase 7.

6. Bring it up:

   ```powershell
   docker compose up -d
   docker compose exec backend node dist/scripts/createUser.js admin YOUR-PW admin
   ```

7. Open `http://localhost:8080` in your browser.

Caveats: your Windows machine has to stay on (and Docker Desktop has to be running) for students to use the portal. That's why a dedicated Linux VM is the better permanent home.

---

## Appendix B — Common gotchas you'll hit on day one

- **"VM requested" then nothing happens for 5 minutes.** The provisioning job is wedged. Usually means the QEMU guest agent inside the template never reported an IP. Boot the template manually, confirm the guest agent service is running, confirm DHCP gave it an IP, snapshot it again. Then `docker compose exec backend node dist/scripts/resetStuckSessions.js` to clear the orphan and try again.
- **Open button works but the canvas just says "Disconnected".** The credentials in `templates.yaml` don't match what's set in the template. Reboot the template VM manually, log in with those exact credentials to prove they work, then re-snapshot.
- **"Cluster at capacity".** You hit `MAX_CLUSTER_VMS`. Edit `.env`, then `docker compose up -d` to apply.
- **Tile click does nothing.** Open the browser dev console (F12). Token probably expired; sign out, sign in again.
- **You forgot the admin password.** Run the createUser command again with the same username — it upserts.

For everything else, see `docs/troubleshooting.md`.
