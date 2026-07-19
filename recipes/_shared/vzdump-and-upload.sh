#!/usr/bin/env bash
# vzdump-and-upload.sh - offline build post-processor body.
#
# Runs on the build host. Given a VMID of a freshly prepared PVE VM, SSHes to
# the node to run vzdump, downloads the
# artifact, optionally uploads it to a CDN, and writes a sidecar JSON for the
# manifest publisher to consume.
#
# Required env (all set by tb / .env):
#   SSH_TARGET           e.g. root@pve.example.com
#   PVE_DUMP_DIR         e.g. /var/lib/vz/dump
#   CF_OUT_DIR           local dir to drop artifact + sidecar (e.g. ./out)
#   CF_RECIPE_NAME       e.g. debian-12
#   CF_RECIPE_DISPLAY    e.g. "Debian 12 (Bookworm)"
#   CF_BUILT_VMID        VMID of the temporary artifact source VM
#
# Optional:
#   CF_UPLOAD_CMD        shell command with {{file}} and {{recipe}} placeholders
#                        (legacy alias: {{name}}).
#   CF_PUBLIC_URL_TMPL   URL template with {{recipe}} placeholder, recorded in
#                        the sidecar (legacy alias: {{name}}).
#   CF_KEEP_VM           if set to 1, leave the temporary VM on Proxmox.

set -euo pipefail

: "${SSH_TARGET:?}"
: "${PVE_DUMP_DIR:?}"
: "${CF_OUT_DIR:?}"
: "${CF_RECIPE_NAME:?}"
: "${CF_RECIPE_DISPLAY:?}"
: "${CF_BUILT_VMID:?}"

LOCAL_FILE="$CF_OUT_DIR/${CF_RECIPE_NAME}.vma.zst"
REMOTE_ARTIFACT=""
REMOTE_LOG=""

cleanup() {
  if [ -n "$REMOTE_ARTIFACT" ]; then
    ssh "$SSH_TARGET" "rm -f '$REMOTE_ARTIFACT' '$REMOTE_LOG'" 2>/dev/null || true
  fi
  if [ "${CF_KEEP_VM:-}" != "1" ]; then
    echo "==> cleanup: destroying VM $CF_BUILT_VMID"
    ssh "$SSH_TARGET" \
      "qm stop '$CF_BUILT_VMID' --skiplock 1 2>/dev/null || true; \
       qm destroy '$CF_BUILT_VMID' --purge 1 --destroy-unreferenced-disks 1 2>/dev/null || true" \
      2>/dev/null || true
  fi
  rm -f "$LOCAL_FILE"
}
trap cleanup EXIT

mkdir -p "$CF_OUT_DIR"

echo "==> vzdump VMID $CF_BUILT_VMID on node"
ssh "$SSH_TARGET" \
  "vzdump $CF_BUILT_VMID --compress zstd --mode stop --dumpdir $PVE_DUMP_DIR"

echo "==> locating artifact"
REMOTE_ARTIFACT=$(ssh "$SSH_TARGET" \
  "ls -t $PVE_DUMP_DIR/vzdump-qemu-${CF_BUILT_VMID}-*.vma.zst | head -1")
[ -n "$REMOTE_ARTIFACT" ] || { echo "no artifact found"; exit 1; }
REMOTE_LOG="${REMOTE_ARTIFACT%.vma.zst}.log"

echo "==> downloading $REMOTE_ARTIFACT -> $LOCAL_FILE"
scp "$SSH_TARGET:$REMOTE_ARTIFACT" "$LOCAL_FILE"
echo "==> removing remote dump intermediates"
ssh "$SSH_TARGET" "rm -f '$REMOTE_ARTIFACT' '$REMOTE_LOG'"

if [ "${CF_KEEP_VM:-}" = "1" ]; then
  echo "==> keeping temporary VM $CF_BUILT_VMID"
else
  echo "==> destroying temporary VM"
  ssh "$SSH_TARGET" "qm destroy $CF_BUILT_VMID --purge 1 --destroy-unreferenced-disks 1" || true
fi

echo "==> hashing"
SHA256=$(shasum -a 256 "$LOCAL_FILE" | awk '{print $1}')
SIZE=$(wc -c <"$LOCAL_FILE" | tr -d ' ')

PUBLIC_URL=""
if [ -n "${CF_PUBLIC_URL_TMPL:-}" ]; then
  PUBLIC_URL="${CF_PUBLIC_URL_TMPL//\{\{recipe\}\}/$CF_RECIPE_NAME}"
  PUBLIC_URL="${PUBLIC_URL//\{\{name\}\}/$CF_RECIPE_NAME}"
fi

if [ -n "${CF_UPLOAD_CMD:-}" ]; then
  echo "==> uploading to CDN"
  CMD="${CF_UPLOAD_CMD//\{\{file\}\}/$LOCAL_FILE}"
  CMD="${CMD//\{\{recipe\}\}/$CF_RECIPE_NAME}"
  CMD="${CMD//\{\{name\}\}/$CF_RECIPE_NAME}"
  bash -c "$CMD"
fi

echo "==> writing sidecar"
SIDECAR="$CF_OUT_DIR/${CF_RECIPE_NAME}.json"
cat >"$SIDECAR" <<JSON
{
  "name": "$CF_RECIPE_NAME",
  "display": "$CF_RECIPE_DISPLAY",
  "sha256": "$SHA256",
  "size": $SIZE,
  "url": "$PUBLIC_URL",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

trap - EXIT  # success — artifact and sidecar are complete
echo "==> done: $SIDECAR"
