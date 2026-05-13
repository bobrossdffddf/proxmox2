# Building a template VM

A "template" in WCTARange is a Proxmox template VM on your cluster that:

1. Has the QEMU guest agent installed and running.
2. Listens for RDP (Windows) or VNC (Linux).
3. Is marked as a Proxmox template (right-click VM -> Convert to template).

Templates aren't started directly. WCTARange keeps booted clones staged, assigns each clone to exactly one user, and deletes that clone when the user is done. Snapshots are optional. If `snapshot_name` is blank or omitted in `config/templates.yaml`, cleanup skips rollback and simply deletes the clone.

## Windows 11 / Server 2022 template

1. Create a VM the normal way. Install Windows, run Windows Update.
2. Install your CyberPatriot scoring engine + any pre-baked vulnerabilities.
3. Install the **QEMU guest agent**: download `virtio-win.iso` from Fedora, mount it in the VM, install `qemu-ga-x86_64.msi`. Enable the service. (Proxmox: VM Hardware -> QEMU Guest Agent -> Enabled.)
4. Enable Remote Desktop:
   - Settings -> System -> Remote Desktop -> On.
   - Set a local Administrator password matching what you'll put in `templates.yaml`.
   - If you don't want to deal with Network Level Authentication, disable NLA (System Properties -> Remote -> uncheck "Allow connections only from computers running Remote Desktop with Network Level Authentication"). Guacamole can handle NLA but disabling it removes a class of credential issues.
5. Configure Windows for DHCP (the default).
6. Shut down cleanly.
7. Right-click the VM in Proxmox and **Convert to template**.
8. Note the VMID (e.g. `9001`). Put it in `config/templates.yaml` under `proxmox_template_id`.

## Ubuntu 22.04 template

1. Install Ubuntu 22.04 server, run `apt update && apt upgrade`.
2. `apt install qemu-guest-agent tightvncserver xfce4 xfce4-goodies`.
3. `systemctl enable --now qemu-guest-agent`.
4. Create a `cyber` user with a known password.
5. Configure VNC to listen on `:0` (port 5900). One simple way: a systemd service that runs `x11vnc -forever -display :1 -passwd ChangeMe123!`.
6. `shutdown -h now`. Convert to template.

## Important caveats

- **One template per Proxmox storage pool.** Linked clones need to live on the same storage as the template they clone from. Easiest: keep both on `local-zfs` (or whatever your default is).
- **One template per node, or shared storage.** If your cluster doesn't have shared storage, replicate each template to every node so the load balancer can clone on whichever node it picks. With shared storage (Ceph, NFS), one copy suffices.
- **VMID range.** WCTARange picks clone VMIDs randomly in `[VM_ID_RANGE_START, VM_ID_RANGE_END]`. Make sure your templates and any other production VMs sit outside that range.
