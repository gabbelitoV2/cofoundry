#!/usr/bin/env bash
# Run inside the build VM right before shutdown. Strips identity so every clone
# of the resulting template gets fresh keys, machine-id, and cloud-init state.
set -euxo pipefail

cloud-init clean --logs || true
rm -f /etc/machine-id
touch /etc/machine-id
if [ -d /var/lib/dbus ]; then
  rm -f /var/lib/dbus/machine-id
  ln -s /etc/machine-id /var/lib/dbus/machine-id
fi
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /var/log/wtmp /var/log/btmp /var/log/lastlog || true
find /var/log -type f -exec truncate -s 0 {} + || true
history -c || true

# Remove provisioner temp files so they don't appear in the exported image.
rm -f /tmp/cloud-init-cleanup.sh /tmp/99-pve.cfg

sync
fstrim -av || true
