# sbx kits

Provisioning for running a coding agent in a [Docker Sandbox](https://docs.docker.com/ai/sandboxes/)
(`sbx`) against this repo. sbx has no auto-detection for repo-local kits, so a kit
is just a committed directory you reference explicitly with `--kit`.

## `dev/` — Cofoundry dev environment

Installs [Bun](https://bun.sh) and the tools `cf` shells out to (ssh, rsync, git),
then warms the dependency cache. Cofoundry is a Bun + TypeScript CLI — there's no
local web server, database, or browser; `cf` drives Packer *remotely* on a Proxmox
node over SSH and the Proxmox API.

```sh
sbx run --kit .sbx/dev claude
```

The first run installs Bun and pulls dependencies (slow, once). To make later
starts instant, snapshot the provisioned sandbox into a template:

```sh
sbx template save cofoundry-dev
sbx run -t cofoundry-dev --kit .sbx/dev claude   # Bun install is baked in; startup only re-syncs bun.lock
```

Inside the sandbox (see the kit's `agentContext`, or `.sbx/dev/spec.yaml`):

```sh
bun run cf list                       # list recipes (no node needed)
bun test                              # test suite
bun run typecheck                     # tsc --noEmit
bun run prettier --write src/ tests/  # format before committing
```

Read-only commands (`cf list`) work standalone. Anything that talks to the node
(`cf build`, `cf bootstrap`, `cf prune`) needs a populated `.env` **and** network +
SSH reach to the Proxmox node — see the tailscale kit below.

## `tailscale/` — join the sandbox to your tailnet

Installs Tailscale and joins the sandbox to your tailnet so `cf` can reach the
Proxmox node (SSH + Proxmox API) when it sits behind the tailnet. It composes with
the dev kit — `--kit` refs layer:

```sh
sbx run --kit .sbx/tailscale --kit .sbx/dev claude
```

Then point `SSH_TARGET` / `PVE_HOST` in `.env` at the node's `100.x` tailnet IP.
With Tailscale SSH enabled on the node, `cf`'s SSH into it is brokered by the
tailnet — no SSH key needs to live in the sandbox.

> **Order matters.** Kit `startup` commands run sequentially in `--kit` order, and
> the dev kit's `bun install` can block on a cold dependency pull. List
> `.sbx/tailscale` **first** so the tailnet comes up promptly instead of waiting
> behind it. (With a saved `cofoundry-dev` template, `bun install` is fast and
> order barely matters.)

Like Bun, the first run installs Tailscale (slow, once). Snapshot it into a template
so later starts skip the install:

```sh
sbx template save cofoundry-dev
sbx run -t cofoundry-dev --kit .sbx/tailscale --kit .sbx/dev claude
```

### Supplying the auth key (never committed)

The kit is generic and secret-free. On startup it resolves an auth key in this order:

1. `TS_AUTHKEY` in the environment;
2. a gitignored `.sbx/tailscale.env` in the workspace (`cp .sbx/tailscale.env.example
   .sbx/tailscale.env` and paste a key — see that file for the recommended key type);
3. neither → the node isn't logged in; run `sudo tailscale up --accept-routes --ssh`
   inside the sandbox and open the printed URL in your host browser.

**Optional — fetch the key from 1Password automatically (private, not in this repo).**
Because the repo is public, the `op` lookup lives in your dotfiles, mirroring the
notify-kit wrapper (`_sbx_build_kit`). A minimal version: at launch, read the key on
the host and write a throwaway mixin that only sets the env var, then add it as an
extra `--kit`:

```sh
sbx-ts() {
  local d="${TMPDIR:-/tmp}/sbx-ts-kit"; mkdir -p "$d"
  cat > "$d/spec.yaml" <<EOF
schemaVersion: "1"
kind: mixin
name: tailscale-authkey
environment:
  variables:
    TS_AUTHKEY: "$(op read 'op://Private/tailscale-sbx/authkey')"
EOF
  sbx run --kit .sbx/tailscale --kit .sbx/dev --kit "$d" "$@"
}
```

The committed `.sbx/tailscale` kit consumes `$TS_AUTHKEY` either way, so this stays
entirely on your machine.

### Networking mode & egress

**TUN mode (the normal case).** The sandbox usually doesn't create `/dev/net/tun` at
boot, but it *does* grant `NET_ADMIN` and ship the kernel tun driver — so the kit
creates the device node and functionally probes it, then runs `tailscaled` in TUN
mode. Traffic to tailnet IPs routes transparently through the `tailscale0` interface
(`ip route get <100.x>` → `dev tailscale0`), so `cf`'s SSH and API calls reach the
node by IP with no proxy. Only if the tun driver genuinely can't produce an interface
does it fall back to **userspace-networking**, where outbound access is via a local
proxy (`socks5h://localhost:1055` / `http://localhost:1055`).

**Use IPs, not names.** MagicDNS is disabled (`--accept-dns=false`) because the
sandbox's `/etc/resolv.conf` is read-only and tailscaled can't manage it. Reach the
node by its `100.x` tailnet IP; set `PVE_HOST` and `SSH_TARGET` accordingly.

**DERP relay, not direct.** `sbx` blocks raw UDP egress, so WireGuard can't form a
direct peer tunnel — traffic relays over DERP (HTTPS/443). Still end-to-end encrypted;
adds ~tens of ms. Fine for API/control traffic and SSH, slower for bulk transfers.
Confirm with `tailscale ping <ip>` (shows `via DERP(region)`). This is why the kit's
egress allowlist covers Tailscale's control plane and DERP relays (`*.tailscale.com`)
— it keeps the handshake on 443. A very locked-down `sbx policy` may still need
widening; check `tailscale status` first.

## Boundaries

- **Secrets** (`PVE_TOKEN_SECRET`, R2/`AWS_*` keys, etc.) live in the gitignored
  `.env`, mounted into the sandbox — never in these kits. The tailnet auth key
  follows the same rule: it comes from the environment or the gitignored
  `.sbx/tailscale.env`, never committed.
- **Notifications** are handled by a separate, global kit (in dotfiles) that the
  `sbx` wrapper injects automatically; this kit is project provisioning only.
  Multiple `--kit` refs compose, so they layer cleanly.
