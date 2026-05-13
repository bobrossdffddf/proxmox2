# Creating the Proxmox API token

WCTARange talks to your Proxmox cluster as a single API token. Create it once on any node in the cluster — Proxmox shares user/token state cluster-wide.

## Step 1 — Create a dedicated user

1. Web UI -> Datacenter -> Permissions -> Users -> **Add**.
2. User name: `wctarange`.
3. Realm: `pve` (Proxmox VE authentication).
4. Click **Add**.

## Step 2 — Create the API token

1. Datacenter -> Permissions -> **API Tokens** -> **Add**.
2. User: `wctarange@pve`.
3. Token ID: `provisioner`.
4. **Uncheck "Privilege Separation"**. If you leave it checked, the token has *zero* permissions until you grant them to the token itself; unchecking means it inherits the user's permissions, which is what we want.
5. Expire: leave blank (or set to a long horizon).
6. Click **Add**.

Proxmox shows the secret value **once**. Copy it.

You'll paste two things into `.env`:
- `PROXMOX_TOKEN_ID=wctarange@pve!provisioner`
- `PROXMOX_TOKEN_SECRET=<the UUID you just copied>`

## Step 3 — Grant permissions

Datacenter -> Permissions -> **Add** -> **User Permission**.

- Path: `/` (the root)
- User: `wctarange@pve`
- Role: choose **PVEVMAdmin** (built-in role that covers everything we need)
- Propagate: **checked**

If you prefer a least-privilege custom role, the exact privileges WCTARange uses are:

- `VM.Allocate`
- `VM.Audit`
- `VM.Clone`
- `VM.Config.Disk`
- `VM.Config.HWType`
- `VM.Config.Memory`
- `VM.Config.Network`
- `VM.Config.Options`
- `VM.Migrate`
- `VM.Monitor`
- `VM.PowerMgmt`
- `VM.Snapshot`
- `VM.Snapshot.Rollback`
- `Sys.Audit` (so we can read node status for load balancing)
- `Datastore.AllocateSpace` and `Datastore.AudioBaseStore` for the storage your clones land on

Create the role under Datacenter -> Permissions -> **Roles**, then grant it as a "User Permission" the same way.

## Step 4 — Verify

From the Docker host:

```bash
curl -k -H "Authorization: PVEAPIToken=$PROXMOX_TOKEN_ID=$PROXMOX_TOKEN_SECRET" \
  https://<one-of-your-nodes>:8006/api2/json/nodes
```

You should get back a JSON list of your cluster nodes. If you get `401`, double-check you unchecked privilege separation.
