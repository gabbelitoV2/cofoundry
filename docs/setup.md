# Setup

Everything you need to do once before running your first build.

In production, GitHub Actions runs the pipeline automatically — you only need to configure the Proxmox node and set the repo secrets. The local workstation section is only needed if you want to run builds manually from your machine.

---

## Part 1 — Proxmox node

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

### 3. Create the ISO cache directory

```sh
mkdir -p /var/lib/cofoundry/iso-cache
```

The first build for each recipe downloads its ISO here automatically. Subsequent builds skip the download.

### 4. NAT bridge for Windows builds

> Skip if you only plan to build Linux recipes.

Windows VMs don't have the QEMU guest agent during builds, so Packer can't discover their IP. The fix is a dedicated NAT bridge (`vmbr1`) with a static DHCP reservation so the build VM always gets the same IP.

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
dhcp-range=10.0.0.100,10.0.0.200,12h
dhcp-option=3,10.0.0.1
dhcp-option=6,8.8.8.8
dhcp-option=option:router,10.0.0.1
dhcp-host=02:50:4b:52:57:00,10.0.0.100
```

```sh
systemctl restart dnsmasq
```

### 5. NAT for Debian netinstall builds

> Only needed for `debian-*` preseed recipes (ISO install). Not needed for cloud-image recipes like `ubuntu-24.04`.

The Debian installer needs a static IP to reach apt mirrors. The build VM gets `10.0.0.50` — a private address that only needs to be reachable from the node, not the internet.

> If you completed §4, the vmbr1 MASQUERADE rule already covers `10.0.0.0/24` (which includes `10.0.0.50`) and IP forwarding is already enabled. Skip everything below and just set the env vars.

**Enable IP forwarding:**

```sh
echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
sysctl -p
```

**Persist the NAT rule via the network interfaces file:**

Create `/etc/network/interfaces.d/masquerade-build.conf`:

```
iface vmbr0 inet manual
    post-up   iptables -t nat -A POSTROUTING -s 10.0.0.50 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s 10.0.0.50 -j MASQUERADE
```

Apply for the current session without rebooting:

```sh
iptables -t nat -A POSTROUTING -s 10.0.0.50 -j MASQUERADE
```

**Find your node's vmbr0 IP** — you'll need it as the gateway:

```sh
ip -4 addr show vmbr0
# look for: inet <node-ip>/xx — that IP is your CF_BUILD_GW
```

Add to `.env` (local dev) or repo secrets (GitHub Actions):

```
CF_BUILD_IP=10.0.0.50
CF_BUILD_GW=<node-vmbr0-ip>
```

### 6. tmpfs size (Windows builds only)

Packer's working directory lives in `/tmp/cofoundry/` on a RAM-backed tmpfs. Windows Server 2025 produces a ~5.7 GB artifact that needs to fit there.

```sh
df -h /tmp
```

If it's under 8 GB, increase it. Add to `/etc/fstab`:

```
tmpfs /tmp tmpfs defaults,size=16G 0 0
```

```sh
mount -o remount /tmp
```

### 7. Weekly cleanup cron

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

### 2. Set repo secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `PVE_HOST` | Proxmox hostname or IP |
| `PVE_NODE` | Proxmox node name (shown in the web UI sidebar) |
| `PVE_TOKEN_ID` | `root@pam!cofoundry` |
| `PVE_TOKEN_SECRET` | Token secret from Part 1 step 1 |
| `SSH_TARGET` | e.g. `root@pve.example.com` |
| `SSH_PRIVATE_KEY` | Contents of `~/.ssh/cofoundry_ci` (the private key file) |
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID (if node is on Tailscale) |
| `TS_OAUTH_SECRET` | Tailscale OAuth secret (if node is on Tailscale) |
| `CF_BUILD_IP` | `10.0.0.50` (if building Debian preseed recipes — see Part 1 §5) |
| `CF_BUILD_GW` | Your node's vmbr0 IP (if building Debian preseed recipes) |
| `CF_UPLOAD_CMD` | CDN upload command, e.g. `aws s3 cp {{file}} s3://...` (if using CDN) |
| `CF_PUBLIC_URL_TMPL` | Public URL template for the manifest (if using CDN) |

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
