#!/usr/bin/env bash
# bootstrap-base.sh — one-time per-distro setup.
#
# Creates a "<distro>-base" PVE template VM from an upstream cloud qcow2.
# Offline builds clone this base and export it without booting a guest.
# Re-run when the upstream image gains a major version.
#
# Usage:
#   ./scripts/bootstrap-base.sh <ssh-host> <vmid> <name> <storage> <bridge> <qcow2-url>
#
# Example:
#   ./scripts/bootstrap-base.sh root@pve.example.com 9000 debian-12-base local vmbr0 \
#     https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2

set -euo pipefail

SSH_TARGET="${1:?ssh target required}"
VMID="${2:?vmid required}"
NAME="${3:?name required}"
STORAGE="${4:?storage required}"
BRIDGE="${5:?bridge required}"
QCOW_URL="${6:?qcow2 url required}"

CACHE_DIR="/var/lib/cofoundry/cache"
FILE="$(basename "$QCOW_URL")"

ssh "$SSH_TARGET" bash <<EOF
set -euo pipefail
mkdir -p "$CACHE_DIR"
cd "$CACHE_DIR"

if [ ! -f "$FILE" ]; then
  echo "Downloading $QCOW_URL ..."
  curl -fL --retry 3 -o "$FILE" "$QCOW_URL"
fi

if qm status "$VMID" >/dev/null 2>&1; then
  echo "VMID $VMID already exists — destroying before re-bootstrap ..."
  qm stop "$VMID" --skiplock 1 2>/dev/null || true
  qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1
fi

echo "Creating VM $VMID ($NAME) ..."
qm create "$VMID" \
  --name "$NAME" \
  --cores 2 \
  --memory 1024 \
  --machine q35 \
  --bios seabios \
  --net0 "virtio,bridge=$BRIDGE" \
  --serial0 socket --vga serial0 \
  --agent enabled=1 \
  --ostype l26

echo "Importing disk ..."
qm set "$VMID" --virtio0 "$STORAGE:0,import-from=$CACHE_DIR/$FILE,discard=on"
qm set "$VMID" --boot order=virtio0
qm set "$VMID" --scsi1 "$STORAGE:cloudinit"
qm set "$VMID" --ipconfig0 "ip=dhcp"

echo "Installing SSH host-key generator ..."
ROOT_VOLUME="\$(qm config "$VMID" | sed -nE '/^(scsi0|virtio0): /{s/^(scsi0|virtio0): ([^,]+).*/\2/p; q;}')"
DISK_PATH="\$(pvesm path "\$ROOT_VOLUME")"
LOOP="\$(losetup --find --partscan --show "\$DISK_PATH")"
MOUNT_DIR="\$(mktemp -d)"
cleanup_mount() {
  umount "\$MOUNT_DIR/dev/pts" 2>/dev/null || true
  umount "\$MOUNT_DIR/proc" 2>/dev/null || true
  umount "\$MOUNT_DIR/sys" 2>/dev/null || true
  umount "\$MOUNT_DIR/dev" 2>/dev/null || true
  umount "\$MOUNT_DIR" 2>/dev/null || true
  rmdir "\$MOUNT_DIR" 2>/dev/null || true
  losetup -d "\$LOOP" 2>/dev/null || true
}
trap cleanup_mount EXIT
ROOT_PART="\$(blkid -o export "\${LOOP}"p* | awk '
  /^DEVNAME=/ { dev=substr(\$0, 9) }
  /^TYPE=(ext4|xfs)$/ { print dev; exit }
')"
[ -n "\$ROOT_PART" ] || { echo "could not find ext4/xfs root partition in \$DISK_PATH"; exit 1; }
mount "\$ROOT_PART" "\$MOUNT_DIR"
mount --bind /dev "\$MOUNT_DIR/dev"
mount -t devpts devpts "\$MOUNT_DIR/dev/pts"
mount -t proc proc "\$MOUNT_DIR/proc"
mount -t sysfs sysfs "\$MOUNT_DIR/sys"
cat > "\$MOUNT_DIR/usr/sbin/policy-rc.d" <<'POLICY'
#!/bin/sh
exit 101
POLICY
chmod +x "\$MOUNT_DIR/usr/sbin/policy-rc.d"
if [ -e "\$MOUNT_DIR/etc/resolv.conf" ] || [ -L "\$MOUNT_DIR/etc/resolv.conf" ]; then
  rm -f "\$MOUNT_DIR/etc/resolv.conf"
fi
cp /etc/resolv.conf "\$MOUNT_DIR/etc/resolv.conf"
if [ -x "\$MOUNT_DIR/usr/bin/apt-get" ]; then
  chroot "\$MOUNT_DIR" apt-get update
  chroot "\$MOUNT_DIR" env DEBIAN_FRONTEND=noninteractive apt-get -y install \
    qemu-guest-agent \
    openssh-server \
    cloud-init \
    cloud-initramfs-growroot
elif [ -x "\$MOUNT_DIR/usr/bin/dnf" ]; then
  chroot "\$MOUNT_DIR" dnf -y install \
    qemu-guest-agent \
    openssh-server \
    cloud-init \
    cloud-utils-growpart
else
  echo "unsupported image: neither apt-get nor dnf found"
  exit 1
fi
rm -f "\$MOUNT_DIR/usr/sbin/policy-rc.d"
chroot "\$MOUNT_DIR" systemctl enable qemu-guest-agent || true
if [ -e "\$MOUNT_DIR/lib/systemd/system/ssh.service" ] || [ -e "\$MOUNT_DIR/usr/lib/systemd/system/ssh.service" ]; then
  chroot "\$MOUNT_DIR" systemctl enable ssh || true
fi
if [ -e "\$MOUNT_DIR/lib/systemd/system/sshd.service" ] || [ -e "\$MOUNT_DIR/usr/lib/systemd/system/sshd.service" ]; then
  chroot "\$MOUNT_DIR" systemctl enable sshd || true
fi
chroot "\$MOUNT_DIR" systemctl disable systemd-networkd-wait-online.service || true
ln -sf /dev/null "\$MOUNT_DIR/etc/systemd/system/systemd-networkd-wait-online.service"
mkdir -p "\$MOUNT_DIR/etc/cloud/cloud.cfg.d"
cat > "\$MOUNT_DIR/etc/cloud/cloud.cfg.d/99-pve.cfg" <<'CLOUD'
datasource_list: [ConfigDrive, NoCloud]
CLOUD
mkdir -p "\$MOUNT_DIR/etc/systemd/system/ssh.service.d"
cat > "\$MOUNT_DIR/etc/systemd/system/ssh.service.d/10-generate-host-keys.conf" <<'UNIT'
[Service]
ExecStartPre=
ExecStartPre=/usr/bin/ssh-keygen -A
ExecStartPre=/usr/sbin/sshd -t
UNIT
mkdir -p "\$MOUNT_DIR/etc/systemd/system/sshd.service.d"
cat > "\$MOUNT_DIR/etc/systemd/system/sshd.service.d/10-generate-host-keys.conf" <<'UNIT'
[Service]
ExecStartPre=
ExecStartPre=/usr/bin/ssh-keygen -A
ExecStartPre=/usr/sbin/sshd -t
UNIT
chroot "\$MOUNT_DIR" cloud-init clean --logs || true
rm -f "\$MOUNT_DIR/etc/ssh/ssh_host_*"
truncate -s 0 "\$MOUNT_DIR/etc/machine-id"
rm -f "\$MOUNT_DIR/var/lib/dbus/machine-id"
ln -s /etc/machine-id "\$MOUNT_DIR/var/lib/dbus/machine-id"
find "\$MOUNT_DIR/var/log" -type f -exec truncate -s 0 {} + || true
cleanup_mount
trap - EXIT

echo "Converting to template ..."
qm template "$VMID"

echo "Base template $NAME ($VMID) ready."
EOF
