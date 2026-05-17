#!/usr/bin/env bash
# offline-build.sh - create a build VM from a prepared base template without booting it.

set -euo pipefail

SSH_TARGET="${1:?ssh target required}"
BASE_VMID="${2:?base vmid required}"
BUILD_VMID="${3:?build vmid required}"
NAME="${4:?vm name required}"

ssh "$SSH_TARGET" bash <<EOF
set -euo pipefail

cleanup() {
  echo "Destroying build VM $BUILD_VMID ..."
  qm unlock "$BUILD_VMID" 2>/dev/null || true
  qm stop "$BUILD_VMID" --skiplock 1 2>/dev/null || true
  qm destroy "$BUILD_VMID" --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 2>/dev/null || true
}

wait_destroyed() {
  local vmid="$1"
  for _ in $(seq 1 30); do
    qm status "$vmid" >/dev/null 2>&1 || return 0
    sleep 1
  done
  echo "Timed out waiting for VMID $vmid to be fully destroyed" >&2
  return 1
}

if qm status "$BUILD_VMID" >/dev/null 2>&1; then
  echo "VMID $BUILD_VMID already exists - destroying before offline build ..."
  qm unlock "$BUILD_VMID" 2>/dev/null || true
  qm stop "$BUILD_VMID" --skiplock 1 2>/dev/null || true
  qm destroy "$BUILD_VMID" --purge 1 --destroy-unreferenced-disks 1 --skiplock 1
  wait_destroyed "$BUILD_VMID"
fi

trap cleanup EXIT

echo "Cloning base template $BASE_VMID -> $BUILD_VMID ($NAME) ..."
qm clone "$BASE_VMID" "$BUILD_VMID" --name "$NAME" --full 1
qm set "$BUILD_VMID" --description "cofoundry offline artifact source"

trap - EXIT  # success — leave the VM for vzdump-and-upload.sh
EOF
