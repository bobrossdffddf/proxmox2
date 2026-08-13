# Importing a VM

Most images you'll want on the range arrive as a VMware export — a zip of the VM
folder, or an `.ova` someone handed you. **Admin → Import** takes that file and
walks it to a working dashboard tile.

Open the tab, drop the file, check what it found, click **Start import**. The one
step you still do yourself is preparing the guest, and the wizard tells you
exactly what that means when it gets there.

## What you can drop on it

| You have | What happens |
| --- | --- |
| `.zip` of a VMware folder (`.vmx` + `.vmdk`s) | Specs are read from the `.vmx`. An OVF descriptor is generated and everything is repackaged into one `.ova`. |
| `.ova` | Read directly. Disk paths inside the descriptor are flattened if needed. |
| `.zip` containing an `.ovf` + disks | The existing OVF is kept; only its file references are rewritten. |
| Bare `.vmdk`, `.qcow2`, `.raw` | Uploaded as-is. There's no metadata in a disk image, so set CPU, memory and OS yourself. |

Split disks (`disk-s001.vmdk`, `disk-flat.vmdk`) are handled: the extents ride
along in the package and the *descriptor* is what gets converted. macOS's
`__MACOSX` noise is ignored.

## What it reads out of the bundle

Before anything is sent to Proxmox, the wizard shows you what it found:

- **Guest OS** from the VMX `guestOS` id or the OVF's `vmw:osType`, mapped to a
  Proxmox `ostype` — and from there to a tile icon and a console protocol
  (Windows → RDP 3389, Linux → VNC 5900).
- **CPU and memory** from the descriptor, floored at something usable (4 GB for
  Windows, 2 GB for Linux) if the source was unreasonably small.
- **Disks** with their provisioned sizes, read from each image's own header.
- **Firmware** — an `.nvram` file in the bundle means UEFI, and it switches to
  OVMF automatically.

Anything it had to guess appears as a warning above the form. All of it is
editable before you start.

## Requirements

The automated path uses the Proxmox storage import API, which needs:

- **Proxmox VE 8.2 or newer.**
- **A storage with the `import` content type enabled** on the target node.
  Datacenter → Storage → edit `local` → tick *Import*. This is the landing zone
  for the uploaded bundle; the converted disks go wherever you pick for
  *Disk storage*.
- **API token permissions**: `Datastore.Audit`, `Datastore.AllocateSpace`,
  `Datastore.AllocateTemplate`, `VM.Allocate`, `Sys.Audit` — see `.env.example`.

If a node doesn't qualify, the wizard says why on the Import tab rather than
failing partway through, and **Show equivalent commands** gives you the exact
`qm` sequence for that specific bundle to run over SSH instead.

## Disk space

Only the uploaded bundle lands on the backend. The OVA sent to Proxmox is
assembled as it streams — disks are read out of the uploaded archive and pushed
straight onto the wire — so nothing is unpacked to disk and no second copy is
built. Budget a little over **the size of the bundle itself** in `IMPORT_DIR`
(the `import-uploads` volume). The Import tab shows the free space it has, and
an upload that wouldn't fit is refused before it starts.

`IMPORT_MAX_UPLOAD_GB` (default 128) caps a single upload.

## How the image reaches the node

By default the backend pushes the assembled OVA into Proxmox's upload endpoint.
That works, but pveproxy stages an upload in a temporary file before moving it
into the storage — and on many installs that staging area is a tmpfs sized from
RAM, so a push can die partway with nothing but `write EPIPE` even though the
target storage has plenty of room.

If a push fails that way, the import **automatically retries with the node
pulling instead**: it publishes the OVA on a single-use URL and calls Proxmox's
`download-url`, which writes straight into the storage and stages nothing.

For that the node needs an address it can reach the backend on. It's derived
from `PUBLIC_URL`'s host plus `BACKEND_PORT`, which is correct whenever the
backend port is published on the same machine. Set `IMPORT_PULL_URL_BASE`
explicitly if not — for example `http://192.168.1.10:3000`.

If you'd rather not have pushes fail first, check `df -h /tmp` and `df -h
/var/tmp` on the node; a staging area smaller than your images is the thing to
fix.

## Guest preparation — the step that isn't automated

When the disks are converted, the import **stops** and waits for you.

It has to. A VM that came out of VMware has no QEMU guest agent, and WCTARange
uses the agent to learn each clone's IP address. Without it the template will
clone fine and then hang forever waiting for an address. VMware Tools does not
substitute.

Inside the guest:

**Windows**
1. Uninstall VMware Tools.
2. Install the QEMU guest agent from the `virtio-win` ISO —
   `guest-agent\qemu-ga-x86_64.msi` — and start the *QEMU Guest Agent* service.
   If a virtio-win ISO is already on the node, the wizard mounts it for you.
3. Enable Remote Desktop and set the account password to the one you entered.
4. Leave the NIC on DHCP.

**Linux**
1. `apt install qemu-guest-agent && systemctl enable --now qemu-guest-agent`
2. Make sure a VNC server is listening on the port you configured.

Then shut the VM down and click **Guest is ready — convert to template**. The
wizard templates it and publishes the tile.

## Why the disks land on SATA

Windows images are attached to the SATA bus by default. An unmodified VMware
image has no VirtIO storage driver, so booting it from `virtio-scsi` gives an
immediate `INACCESSIBLE_BOOT_DEVICE`. SATA is emulated well enough for Windows
to boot untouched. Once the VirtIO drivers are installed you can switch the disk
over in Proxmox for the extra speed.

Linux guests go straight to `virtio-scsi` — the driver has been in-tree for
years.

The same reasoning applies to the NIC: Windows gets `e1000`, Linux gets `virtio`.

## Tiles created by import

An imported template's tile is stored in Postgres, not in
`config/templates.yaml`. That keeps the config mount read-only and means a new
tile appears without editing a file or restarting the backend. In every other
respect it's an ordinary template — staging, cloning and cleanup don't know the
difference.

If a YAML entry and an imported tile ever share an id, the YAML one wins.

Use **Remove** on the Import tab to drop a tile. That deletes the tile only; the
Proxmox template VM stays where it is.

## When something goes wrong

The import log on the tab is the whole story, including whatever Proxmox said in
its own task log. It starts recording the moment you drop a file, so a failure
during the upload shows up there too.

### The upload stops partway

The upload panel shows two counters: **sent** (what your browser handed to the
network) and **server received** (what the backend has written to disk). Which
one stopped tells you where the problem is:

| Symptom | Cause |
| --- | --- |
| Both stop together | The connection dropped, or the browser tab lost focus on a flaky network. The log will show the stall. |
| **sent** climbs, **server received** doesn't | Something between the browser and the backend is eating the body — almost always a reverse proxy in front of the app (Cloudflare, another nginx, Traefik) with its own body-size or timeout limit. The bundled nginx is already configured for this; anything you put in front of it needs the same treatment. |
| Neither ever starts, instant error | The bundle is over `IMPORT_MAX_UPLOAD_GB`, or there isn't room in `IMPORT_DIR`. Both are checked before a byte is sent, and the error says which. |

If nothing on the page explains it, the backend's own log will:

```bash
docker compose logs -f backend
```

### Common failures

| Message | Cause |
| --- | --- |
| `No storage … has the "import" content type` | Tick *Import* on a storage in Datacenter → Storage. |
| `Proxmox 8.1 predates the storage import API` | Use the generated commands, or upgrade the node. |
| `Proxmox task failed: … no such volume` | The landing storage is node-local and you picked a different node. Pick the node that owns the storage. |
| Import stuck on "Still converting disks…" | Normal for a large image. Raise `IMPORT_TASK_TIMEOUT_MINUTES` if it genuinely needs longer than 4 hours. |
| Clones hang at "waiting for guest IP" | The guest agent isn't installed or isn't running. Go back into the template and finish guest prep. |
| `No data received for N minutes` | The upload stalled. See the table above; `IMPORT_UPLOAD_STALL_MINUTES` controls how long it waits before giving up. |
| `Ran out of disk space in /app/uploads` | The `import-uploads` volume filled while receiving the upload. It needs a little more than the bundle's own size. |
| `<node> closed the connection after N of M (write EPIPE)` | pveproxy's staging area is smaller than the image. The import retries by having the node pull instead; if that can't run, set `IMPORT_PULL_URL_BASE`. |
| `Cannot use the pull transfer: no address for this backend` | `PUBLIC_URL` is localhost, so nothing can be derived. Set `IMPORT_PULL_URL_BASE`. |

A failed import cleans up after itself — the half-created VM and the uploaded
copy are both removed — so you can fix the setting and press **Retry import**
without hunting for leftovers.
