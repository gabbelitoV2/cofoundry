# Setup

Everything you need to do once before running your first build.

In production, GitHub Actions runs the pipeline automatically — you only need to configure the Proxmox node and set the repo secrets. The local workstation section is only needed if you want to run builds manually from your machine.

---

## Part 1 — Proxmox node

### Automated (recommended)

```sh
# one-time, from your workstation:
bun run cf bootstrap
```

Answer the prompts (target host, what kinds of recipes you'll build, tmpfs
size if asked). The command probes the node, shows you a checklist of what
it will change, asks for confirmation, then applies. The new API token
secret is shown at the end with an offer to append it to `.env`. Safe to
re-run — already-done steps are detected and skipped.

Prerequisites: passwordless SSH into the node as root (`ssh-copy-id
root@<pve-host>`).

The remaining steps in this section are preserved as a manual fallback —
useful for partial runs, debugging, or environments where you'd rather see
exactly what's being changed. `cf bootstrap` does all of them for you.

---

### Manual steps (reference)

SSH into the node and run these commands.

### 1. Create an API token

```sh
pveum user token add root@pam cofoundry --privsep=0
```

Copy the token secret (shown once) — you'll need it for the repo secrets or `.env`.

### 2. Install Packer

Packer runs **on the node** so its HTTP server is reachable by build VMs over the bridge.

```sh
wget -O- https://apt.releases.hashicorp.com/gpg \
  | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] \
  https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
  > /etc/apt/sources.list.d/hashicorp.list
apt-get update && apt-get install -y packer
```

### 3. Install `awscli` (for R2 upload)

> Skip if you're not uploading artifacts to R2 / S3.

The vzdump post-processor runs `CF_UPLOAD_CMD` on the node, so the `aws` binary must exist there:

```sh
apt-get install -y awscli
```

`cf build` forwards `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, and `AWS_DEFAULT_REGION` from your local env (or repo secrets in CI) into the remote Packer environment automatically — no config files needed on the node.

### 4. ISO cache directory

Recipes download their boot ISO into `/var/lib/vz/template/iso` (Proxmox's standard ISO storage — already exists on any node). The first build for each recipe downloads its ISO here automatically; subsequent builds skip the download.

### 5. NAT bridge for ISO-installer builds

> Skip if you only plan to build cloud-image recipes (`ubuntu-cloud-*`, etc.). Every ISO-installer recipe — Debian/Ubuntu live/Alma/Rocky/Windows — needs this.

ISO installers can't rely on the qemu-guest-agent for IP discovery and Windows has no agent during install at all. Cofoundry runs them on a dedicated NAT bridge (`vmbr1`, `10.0.0.0/24`) and allocates a per-build static DHCP reservation at build time (see `src/build/netslot.ts`). Up to 50 builds can run in parallel on a single node.

**Add to `/etc/network/interfaces`:**

```
auto vmbr1
iface vmbr1 inet static
    address 10.0.0.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up   echo 1 > /proc/sys/net/ipv4/ip_forward
    post-up   iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE
```

**Apply without rebooting:**

```sh
ifup vmbr1
```

**Install dnsmasq:**

```sh
apt-get install -y dnsmasq
```

**Create `/etc/dnsmasq.d/vmbr1-nat.conf`:**

```
interface=vmbr1
bind-interfaces
dhcp-range=10.0.0.200,10.0.0.250,12h
dhcp-option=3,10.0.0.1
dhcp-option=6,8.8.8.8
dhcp-option=option:router,10.0.0.1
```

```sh
systemctl restart dnsmasq
mkdir -p /var/lib/cofoundry
```

Per-build reservations get written to `/etc/dnsmasq.d/cofoundry-slot-NN.conf` during the build and cleaned up afterward — no manual entries needed.

### 6. Weekly cleanup cron

Prevents ISOs, dump files, and orphaned VMs from accumulating over time.
Everything the old inline shell script did now lives in `cf prune`, so the
cron is just one line. From a workstation that can reach the node:

```
0 3 * * 0 cd /path/to/cofoundry && bun run cf prune --days 30
```

Or on the node itself if you have the repo checked out there. CI also runs
`cf prune --days 7` after every build, so the cron is only needed if you
build locally.

Run `cf prune --dry-run` first to see what would be removed.

---

## Part 2 — GitHub Actions (production)

### 1. Add an SSH key

GitHub Actions needs to SSH into the node. Generate a dedicated key pair **on your workstation**:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/cofoundry_ci -N ""
```

Authorize it on the node:

```sh
ssh-copy-id -i ~/.ssh/cofoundry_ci.pub root@<pve-host>
# or manually: cat ~/.ssh/cofoundry_ci.pub | ssh root@<pve-host> "cat >> ~/.ssh/authorized_keys"
```

> **Using Tailscale SSH?** You can skip this step. If `SSH_PRIVATE_KEY` is
> unset, the workflow's key-setup step is skipped and the runner authenticates
> to the node via Tailscale SSH (the `Connect to Tailscale` step runs first).
> Requires a tailnet ACL `ssh` rule with `action: "accept"` granting `tag:ci`
> access to the node as the user `SSH_TARGET` connects as (e.g. `root`).
> `action: "check"` rules won't work — they require interactive reauth.

### 2. Tailscale (optional)

If the node sits on a tailnet and you've closed its public SSH port, the
workflow can reach it over Tailscale. The `Connect to Tailscale` step uses
an OAuth client to spin up an ephemeral tagged node per job.

**a. ACL tags + SSH rule** (Tailscale admin → **Access Controls**):

```hujson
"tagOwners": {
  "tag:cofoundry": ["autogroup:owner"],
},
"ssh": [
  { "action": "accept", "src": ["tag:cofoundry"], "dst": ["tag:cofoundry"], "users": ["root"] },
],
```

Tag the PVE node `tag:cofoundry` (admin → **Machines** → node → Edit ACL
tags). Tagging detaches the node from your user — fine for a server, but
add a separate rule if you also want to SSH from your laptop via Tailscale
SSH. Must be `action: "accept"` — `"check"` requires interactive reauth and
won't work in CI.

**b. Create the OAuth client** (admin → **Settings → OAuth clients →
Generate**):

- Scopes: **Devices → Core → Write**
- Tags: `tag:cofoundry`
- Copy the client ID and secret (secret is shown once).

**c. Set repo secrets:**

| Secret | Value |
|---|---|
| `TS_OAUTH_CLIENT_ID` | OAuth client ID |
| `TS_OAUTH_SECRET` | OAuth client secret |

**d. Point `SSH_TARGET` / `PVE_HOST` at the tailnet address** — MagicDNS
name (`root@pve.tail-scale.ts.net`) or the 100.x IP. With Tailscale SSH
enabled on the node, you can also omit `SSH_PRIVATE_KEY` entirely; the
workflow skips the key-setup step and auth is brokered by the tailnet.

### 3. Set repo secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `PVE_HOST` | Proxmox hostname or IP |
| `PVE_NODE` | Proxmox node name (shown in the web UI sidebar) |
| `PVE_TOKEN_ID` | `root@pam!cofoundry` |
| `PVE_TOKEN_SECRET` | Token secret from Part 1 step 1 |
| `SSH_TARGET` | e.g. `root@pve.example.com` |
| `SSH_PRIVATE_KEY` | Contents of `~/.ssh/cofoundry_ci` (the private key file). Omit if using Tailscale SSH. |
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID (if node is on Tailscale) |
| `TS_OAUTH_SECRET` | Tailscale OAuth secret (if node is on Tailscale) |
| `R2_ACCOUNT_ID` | Cloudflare account ID (used to derive the R2 endpoint) |
| `R2_ENDPOINT` | `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | R2 bucket name, e.g. `cofoundry-templates` |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |

Also set this as a repo **variable** (Settings → Variables → Actions):

| Variable | Value |
|---|---|
| `CF_PUBLIC_URL_TMPL` | Full public URL template, e.g. `https://templates.example.com/templates/{{name}}-{{arch}}/{{sha256}}.vma.zst` |

> **Default upload layout (CI).** The workflow auto-builds the upload commands from the R2 secrets above, producing:
>
> ```
> s3://<R2_BUCKET>/templates/<recipe>-<arch>/<sha256>.vma.zst   (artifact)
> s3://<R2_BUCKET>/templates/<recipe>-<arch>/<sha256>.json      (sidecar)
> ```
>
> The public URL is fully user-defined — set `CF_PUBLIC_URL_TMPL` as a repo
> variable (required; no default). For the default layout that's
> `<your-cdn>/templates/{{name}}-{{arch}}/{{sha256}}.vma.zst`.
>
> **Custom layout.** Override the upload commands by setting matching repo
> **variables** (Settings → Variables → Actions, *not* Secrets):
>
> | Variable | Purpose |
> |---|---|
> | `CF_UPLOAD_CMD` | Shell command that uploads the artifact. |
> | `CF_SIDECAR_UPLOAD_CMD` | Shell command that uploads the sidecar JSON. |
> | `CF_PUBLIC_URL_TMPL` | Public URL recorded in the sidecar + registry. |
>
> Placeholders: `{{file}}`, `{{name}}`, `{{arch}}`, `{{sha256}}`, `{{group}}`, `{{filename}}`.
>
> **The three variables are independent.** The post-processor substitutes
> placeholders into each one separately — it does *not* derive the public URL
> from the upload command (or vice versa). If you change the path layout in
> `CF_UPLOAD_CMD`, you must update `CF_SIDECAR_UPLOAD_CMD` and
> `CF_PUBLIC_URL_TMPL` to match; otherwise the sidecar's `url` field will
> point at a 404 and `cf publish --r2` (which walks `templates/` in the
> bucket) won't find anything to publish. Local runs read these from `.env`
> (see `docs/usage.md`).

---

## Part 2.5 — Cloudflare R2 bucket

### 1. Create the bucket

In the Cloudflare dashboard: **R2 → Create bucket**, name it (e.g. `cofoundry-templates`), default region.

### 2. Bind a custom domain

**R2 → Bucket → Settings → Custom Domains → Connect Domain.** Use a subdomain you control, e.g. `templates.example.com`. Plug that host into your `CF_PUBLIC_URL_TMPL` repo variable. Final artifact URLs look like:

```
https://templates.example.com/templates/<name>-<arch>/<sha256>.vma.zst
https://templates.example.com/registry.json
```

### 3. Create an R2 API token

**R2 → Manage R2 API Tokens → Create API token.** Scope: object read/write on the bucket. Save the access key id + secret as `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`. The S3 endpoint shown on that page is your `R2_ENDPOINT`.

### 4. Configure a lifecycle rule (safety net)

**R2 → Bucket → Settings → Object Lifecycle Rules → Add rule:** prefix `templates/`, delete after 60 days. This catches orphans whose recipe was deleted. The build pipeline also runs `cf prune --r2 --keep 5` for tight per-recipe windows.

### 5. Path scheme

- Artifacts: `s3://<bucket>/templates/<name>-<arch>/<sha256>.vma.zst` — content-addressed, immutable.
- Registry: `s3://<bucket>/registry.json` — short TTL (60s), one canonical pointer file. `git log registry.json` is the audit log; rollback = `git revert` the commit, CI re-mirrors.

---

## Part 3 — Local development (optional)

Only needed if you want to run `cf` commands manually from your machine.

### 1. Install dependencies

- [Bun](https://bun.sh) 1.x
- `rsync` and `ssh` (pre-installed on macOS/Linux)

### 2. Clone and install

```sh
git clone <repo-url> cofoundry
cd cofoundry
bun install
```

### 3. Set up passwordless SSH

```sh
ssh-copy-id root@<pve-host>
ssh root@<pve-host> hostname   # verify: no password prompt
```

### 4. Configure `.env`

```sh
cp .env.example .env
```

Fill in at minimum:

| Variable | Value |
|---|---|
| `PVE_HOST` | Proxmox hostname or IP |
| `PVE_NODE` | Proxmox node name |
| `PVE_TOKEN_ID` | `root@pam!cofoundry` |
| `PVE_TOKEN_SECRET` | Token secret from Part 1 step 1 |
| `SSH_TARGET` | e.g. `root@pve.example.com` |

### 5. Verify

```sh
cf list
```

You should see all available recipes.
