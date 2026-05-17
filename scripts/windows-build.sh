#!/usr/bin/env bash
# windows-build.sh - build a sysprepped Windows template source VM on Proxmox.

set -euo pipefail

SSH_TARGET="${1:?ssh target required}"
VMID="${2:?vmid required}"
NAME="${3:?vm name required}"
STORAGE="${4:?storage required}"
ISO_STORAGE="${5:?iso storage required}"
BRIDGE="${6:?bridge required}"
WINDOWS_ISO_URL="${7:?windows iso url required}"
VIRTIO_ISO_URL="${8:?virtio iso url required}"
DISK_SIZE="${9:?disk size required}"
WINDOWS_EDITION="${10:?windows edition required}"
DISK_SIZE_GIB="${DISK_SIZE%G}"

ASSET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../windows" && pwd)"
REMOTE_DIR="/var/lib/cofoundry/windows/$NAME"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

sed "s#__WINDOWS_EDITION__#$WINDOWS_EDITION#g" "$ASSET_DIR/Autounattend.xml" >"$TMP_DIR/Autounattend.xml"
cp "$ASSET_DIR/TemplatePrep.ps1" "$TMP_DIR/TemplatePrep.ps1"

if [ ! -f "$TMP_DIR/CloudbaseInitSetup_Stable_x64.msi" ]; then
  echo "Downloading Cloudbase-Init installer ..."
  curl -fL --retry 3 \
    -o "$TMP_DIR/CloudbaseInitSetup_Stable_x64.msi" \
    "https://cloudbase.it/downloads/CloudbaseInitSetup_Stable_x64.msi"
fi

ssh "$SSH_TARGET" "mkdir -p '$REMOTE_DIR'"
scp "$TMP_DIR/Autounattend.xml" "$TMP_DIR/TemplatePrep.ps1" "$TMP_DIR/CloudbaseInitSetup_Stable_x64.msi" "$SSH_TARGET:$REMOTE_DIR/"

ssh "$SSH_TARGET" \
  "VMID='$VMID' NAME='$NAME' STORAGE='$STORAGE' ISO_STORAGE='$ISO_STORAGE' BRIDGE='$BRIDGE' WINDOWS_ISO_URL='$WINDOWS_ISO_URL' VIRTIO_ISO_URL='$VIRTIO_ISO_URL' DISK_SIZE_GIB='$DISK_SIZE_GIB' REMOTE_DIR='$REMOTE_DIR' TB_WINDOWS_TIMEOUT_SECONDS='${TB_WINDOWS_TIMEOUT_SECONDS:-14400}' bash -s" <<'EOF'
set -euo pipefail
export LANG=C
export LC_ALL=C

cleanup() {
  echo "Destroying Windows VM $VMID and cleaning up remote files ..."
  qm unlock "$VMID" 2>/dev/null || true
  qm stop "$VMID" --skiplock 1 2>/dev/null || true
  qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 2>/dev/null || true
  rm -rf "$REMOTE_DIR"
}

WINDOWS_ISO="${NAME}-windows.iso"
VIRTIO_ISO="virtio-win.iso"
ANSWER_ISO="${NAME}-answer.iso"

iso_path() {
  local volume="$ISO_STORAGE:iso/$1"
  pvesm path "$volume" 2>/dev/null || {
    if [ "$ISO_STORAGE" = "local" ]; then
      echo "/var/lib/vz/template/iso/$1"
    else
      echo "could not resolve ISO storage path for $volume" >&2
      exit 1
    fi
  }
}

WINDOWS_ISO_PATH="$(iso_path "$WINDOWS_ISO")"
VIRTIO_ISO_PATH="$(iso_path "$VIRTIO_ISO")"
ANSWER_ISO_PATH="$(iso_path "$ANSWER_ISO")"

mkdir -p "$(dirname "$WINDOWS_ISO_PATH")" "$(dirname "$VIRTIO_ISO_PATH")" "$(dirname "$ANSWER_ISO_PATH")"

iso_maker() {
  if command -v xorriso >/dev/null 2>&1; then
    echo "xorriso -as mkisofs"
  elif command -v genisoimage >/dev/null 2>&1; then
    echo "genisoimage"
  elif command -v mkisofs >/dev/null 2>&1; then
    echo "mkisofs"
  else
    echo "missing xorriso/genisoimage/mkisofs on Proxmox node" >&2
    exit 1
  fi
}

download_iso() {
  local url="$1"
  local dest="$2"
  local label="$3"
  if [ ! -f "$dest" ]; then
    echo "Downloading $label ..."
    curl -fL --retry 3 -o "$dest" "$url"
  fi
  if ! file "$dest" | grep -Eiq 'iso 9660|udf'; then
    rm -f "$dest"
    echo "$label did not download as an ISO. Use a direct ISO URL or mirror URL in the recipe." >&2
    exit 1
  fi
}

download_iso "$WINDOWS_ISO_URL" "$WINDOWS_ISO_PATH" "Windows Server ISO"
download_iso "$VIRTIO_ISO_URL" "$VIRTIO_ISO_PATH" "VirtIO ISO"

echo "Creating answer ISO ..."
ISO_MAKER="$(iso_maker)"
$ISO_MAKER -quiet -J -r -V cidata -o "$ANSWER_ISO_PATH" "$REMOTE_DIR"

wait_destroyed() {
  local vmid="$1"
  for _ in $(seq 1 30); do
    qm status "$vmid" >/dev/null 2>&1 || return 0
    sleep 1
  done
  echo "Timed out waiting for VMID $vmid to be fully destroyed" >&2
  return 1
}

if qm status "$VMID" >/dev/null 2>&1; then
  echo "VMID $VMID already exists - destroying before Windows build ..."
  qm unlock "$VMID" 2>/dev/null || true
  qm stop "$VMID" --skiplock 1 2>/dev/null || true
  qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1 --skiplock 1
  wait_destroyed "$VMID"
fi

echo "Creating Windows build VM $VMID ($NAME) ..."
qm create "$VMID" \
  --name "$NAME" \
  --cores 4 \
  --memory 4096 \
  --cpu host \
  --machine q35 \
  --bios ovmf \
  --efidisk0 "$STORAGE:1,efitype=4m,pre-enrolled-keys=1" \
  --tpmstate0 "$STORAGE:1,version=v2.0" \
  --net0 "virtio,bridge=$BRIDGE" \
  --agent enabled=1 \
  --ostype win11

qm set "$VMID" --sata0 "$STORAGE:$DISK_SIZE_GIB,discard=on,ssd=1"
qm set "$VMID" --ide0 "$ISO_STORAGE:iso/$ANSWER_ISO,media=cdrom"
qm set "$VMID" --ide1 "$ISO_STORAGE:iso/$VIRTIO_ISO,media=cdrom"
qm set "$VMID" --ide2 "$ISO_STORAGE:iso/$WINDOWS_ISO,media=cdrom"
qm set "$VMID" --ide3 "$STORAGE:cloudinit"
qm set "$VMID" --boot order=ide2\;sata0
trap cleanup EXIT

echo "Starting Windows unattended install. This can take 1-3 hours."
qm start "$VMID"

# "Press any key to boot from CD or DVD" prompt: fire Return as fast as
# qm sendkey's own overhead allows (~5/s) for 60s to cover the full OVMF +
# EFI bootloader startup window without any gap for the prompt to time out.
for _ in $(seq 1 300); do
  qm sendkey "$VMID" ret 2>/dev/null || true
done

deadline=$((SECONDS + TB_WINDOWS_TIMEOUT_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
  status="$(qm status "$VMID" | awk '{print $2}')"
  if [ "$status" = "stopped" ]; then
    echo "Windows VM stopped after sysprep."
    qm set "$VMID" --delete ide0 || true
    qm set "$VMID" --delete ide1 || true
    qm set "$VMID" --delete ide2 || true
    qm set "$VMID" --boot order=sata0
    trap - EXIT  # success — leave the VM for vzdump-and-upload.sh
    exit 0
  fi
  sleep 30
done

echo "Timed out waiting for Windows sysprep shutdown after ${TB_WINDOWS_TIMEOUT_SECONDS}s" >&2
exit 1
EOF
