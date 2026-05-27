#!/bin/bash
set -euo pipefail

DISK="/var/lib/vz/images/2002/vm-2002-disk-1.qcow2"
NBD="/dev/nbd2"
MOUNT="/tmp/wp2"
LOG="$MOUNT/\$Windows.~BT/Sources/Panther/setupact.log"

cleanup() {
  umount "$MOUNT" 2>/dev/null || true
  qemu-nbd --disconnect "$NBD" 2>/dev/null || true
}
trap cleanup EXIT

modprobe nbd max_part=8 2>/dev/null || true

echo "Waiting for disk to exist..."
while [ ! -f "$DISK" ]; do sleep 5; done
echo "Disk found."

qemu-nbd --read-only --connect="$NBD" "$DISK"
sleep 2
partprobe "$NBD" 2>/dev/null || true
sleep 2

echo "Waiting for partition..."
while [ ! -b "${NBD}p3" ]; do
  partprobe "$NBD" 2>/dev/null || true
  sleep 2
done

mkdir -p "$MOUNT"
mount -t ntfs3 -o ro "${NBD}p3" "$MOUNT" 2>/dev/null || mount -t ntfs -o ro "${NBD}p3" "$MOUNT"
echo "Mounted. Waiting for Panther log..."

while [ ! -f "$LOG" ]; do sleep 5; done
echo "Log found. Waiting for WIM extraction to complete..."

while ! grep -q "Operation completed successfully: Apply WIM" "$LOG" 2>/dev/null; do sleep 5; done

echo ""
echo "=== WIM extraction complete. CompactOS lines ==="
grep -i "compact" "$LOG"
