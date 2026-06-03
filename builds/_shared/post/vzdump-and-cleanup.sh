#!/usr/bin/env bash
# vzdump-and-cleanup.sh — Packer shell-local post-processor.
#
# When SSH_TARGET=local (packer runs on the PVE node itself): vzdump and file
# operations run directly. CF_OUT_DIR must be a local path on the node.
#
# When SSH_TARGET=<user@host>: vzdump runs over SSH, artifact is scp'd locally.
#
# Required env:
#   SSH_TARGET           "local" or e.g. root@pve.example.com
#   PVE_DUMP_DIR         e.g. /var/lib/vz/dump
#   CF_OUT_DIR           output dir (local on node when SSH_TARGET=local)
#
# Set by HCL environment_vars:
#   CF_BUILT_VMID / CF_RECIPE_NAME / CF_RECIPE_DISPLAY
#
# Optional: CF_UPLOAD_CMD, CF_PUBLIC_URL_TMPL, CF_KEEP_VM
#   CF_UPLOAD_CMD / CF_PUBLIC_URL_TMPL support {{file}}, {{name}}, {{arch}}, {{sha256}}, {{group}}, {{filename}}.

set -euo pipefail

: "${SSH_TARGET:?}"
: "${PVE_DUMP_DIR:?}"
: "${CF_OUT_DIR:?}"
: "${CF_RECIPE_NAME:?}"
: "${CF_RECIPE_DISPLAY:?}"
: "${CF_BUILT_VMID:?}"
: "${CF_ARCH:?}"
: "${CF_GROUP:?}"

LOCAL_FILE="$CF_OUT_DIR/${CF_RECIPE_NAME}-${CF_ARCH}.vma.zst"
LOCAL_MODE=0
[ "$SSH_TARGET" = "local" ] && LOCAL_MODE=1

_pve() {
  if [ "$LOCAL_MODE" = "1" ]; then
    bash -c "$*"
  else
    ssh "$SSH_TARGET" "$*"
  fi
}

cleanup() {
  if [ "${CF_KEEP_VM:-}" != "1" ]; then
    echo "==> cleanup: destroying VM $CF_BUILT_VMID"
    _pve "qm stop '$CF_BUILT_VMID' --skiplock 1 2>/dev/null || true; \
          qm destroy '$CF_BUILT_VMID' --purge 1 --destroy-unreferenced-disks 1 2>/dev/null || true" || true
  fi
  [ "$LOCAL_MODE" = "0" ] && rm -f "$LOCAL_FILE" || true
}
trap cleanup EXIT

mkdir -p "$CF_OUT_DIR"

# Bake ciuser=root into the template config so clones with --sshkeys /
# --cipassword apply them to root instead of falling through to the distro's
# default cloud-init user (debian/ubuntu/cloud-user/…), which doesn't actually
# exist in these images. Linux only — Windows uses cloudbase-init, not ciuser.
OSTYPE_LINE=$(_pve "qm config '$CF_BUILT_VMID' 2>/dev/null | grep -E '^ostype:' || true")
case "$OSTYPE_LINE" in
  *l24*|*l26*)
    echo "==> setting ciuser=root on VMID $CF_BUILT_VMID"
    _pve "qm set '$CF_BUILT_VMID' --ciuser root >/dev/null"
    ;;
esac

echo "==> vzdump VMID $CF_BUILT_VMID"
_pve "vzdump $CF_BUILT_VMID --compress zstd --mode stop --dumpdir $PVE_DUMP_DIR"

echo "==> locating artifact"
REMOTE_ARTIFACT=$(_pve "ls -t $PVE_DUMP_DIR/vzdump-qemu-${CF_BUILT_VMID}-*.vma.zst | head -1")
[ -n "$REMOTE_ARTIFACT" ] || { echo "no artifact found"; exit 1; }

if [ "$LOCAL_MODE" = "1" ]; then
  echo "==> moving $REMOTE_ARTIFACT -> $LOCAL_FILE"
  mv "$REMOTE_ARTIFACT" "$LOCAL_FILE"
else
  echo "==> downloading $REMOTE_ARTIFACT -> $LOCAL_FILE"
  scp "$SSH_TARGET:$REMOTE_ARTIFACT" "$LOCAL_FILE"
  echo "==> removing remote dump"
  ssh "$SSH_TARGET" "rm -f '$REMOTE_ARTIFACT'"
fi

echo "==> destroying VM $CF_BUILT_VMID"
if [ "${CF_KEEP_VM:-}" = "1" ]; then
  echo "==> CF_KEEP_VM=1: skipping destroy"
else
  _pve "qm stop '$CF_BUILT_VMID' --skiplock 1 2>/dev/null || true; \
        qm destroy '$CF_BUILT_VMID' --purge 1 --destroy-unreferenced-disks 1" || true
fi

echo "==> hashing"
SHA256=$(sha256sum "$LOCAL_FILE" | awk '{print $1}')
SIZE=$(wc -c <"$LOCAL_FILE" | tr -d ' ')
UPLOAD_FILENAME="${CF_RECIPE_NAME}-${CF_ARCH}-${SHA256}.vma.zst"

PUBLIC_URL=""
if [ -n "${CF_PUBLIC_URL_TMPL:-}" ]; then
  PUBLIC_URL="${CF_PUBLIC_URL_TMPL//\{\{name\}\}/$CF_RECIPE_NAME}"
  PUBLIC_URL="${PUBLIC_URL//\{\{arch\}\}/$CF_ARCH}"
  PUBLIC_URL="${PUBLIC_URL//\{\{sha256\}\}/$SHA256}"
  PUBLIC_URL="${PUBLIC_URL//\{\{group\}\}/$CF_GROUP}"
  PUBLIC_URL="${PUBLIC_URL//\{\{filename\}\}/$UPLOAD_FILENAME}"
fi

if [ -n "${CF_UPLOAD_CMD:-}" ]; then
  echo "==> uploading"
  CMD="${CF_UPLOAD_CMD//\{\{file\}\}/$LOCAL_FILE}"
  CMD="${CMD//\{\{name\}\}/$CF_RECIPE_NAME}"
  CMD="${CMD//\{\{arch\}\}/$CF_ARCH}"
  CMD="${CMD//\{\{sha256\}\}/$SHA256}"
  CMD="${CMD//\{\{group\}\}/$CF_GROUP}"
  CMD="${CMD//\{\{filename\}\}/$UPLOAD_FILENAME}"
  bash -c "$CMD"
fi

echo "==> writing sidecar"
SIDECAR="$CF_OUT_DIR/${CF_RECIPE_NAME}-${CF_ARCH}.json"
# Write to .tmp then rename so a partial/crashed write can't leave a sidecar
# whose sha256 disagrees with the artifact next to it.
cat >"$SIDECAR.tmp" <<JSON
{
  "name": "${CF_RECIPE_NAME}-${CF_ARCH}",
  "display": "$CF_RECIPE_DISPLAY",
  "arch": "$CF_ARCH",
  "group": "$CF_GROUP",
  "sha256": "$SHA256",
  "size": $SIZE,
  "suggested_vmid": ${CF_BUILT_VMID},
  "url": "$PUBLIC_URL",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
mv "$SIDECAR.tmp" "$SIDECAR"

if [ -n "${CF_SIDECAR_UPLOAD_CMD:-}" ]; then
  echo "==> uploading sidecar"
  SCMD="${CF_SIDECAR_UPLOAD_CMD//\{\{file\}\}/$SIDECAR}"
  SCMD="${SCMD//\{\{name\}\}/$CF_RECIPE_NAME}"
  SCMD="${SCMD//\{\{arch\}\}/$CF_ARCH}"
  SCMD="${SCMD//\{\{sha256\}\}/$SHA256}"
  SCMD="${SCMD//\{\{group\}\}/$CF_GROUP}"
  SCMD="${SCMD//\{\{filename\}\}/${CF_RECIPE_NAME}-${CF_ARCH}-${SHA256}.json}"
  bash -c "$SCMD"
fi

trap - EXIT
echo "==> done: $SIDECAR"
