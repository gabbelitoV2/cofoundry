# Phase 3 verification

Phase 3b/3c/3d retunes the recipes; none of it can be verified from a dev
laptop. Run these checks on the Proxmox node before merging.

## Disk size before/after (record in PR)

Build at least `debian-12` and `windows-server-2022` and note the
`vzdump-*.vma.zst` size. After this branch lands, `discard = true` lets
sparse zero regions stay compressed; the artifact should shrink.

| Recipe              | Pre-3b size | Post-3b size |
| ------------------- | ----------- | ------------ |
| debian-12           | _fill in_   | _fill in_    |
| windows-server-2022 | _fill in_   | _fill in_    |

## Per-recipe boot smoke

```sh
bun run cf build <recipe>
# wait for completion, then on the PVE node:
qm clone <template-vmid> 9999 --full && qm start 9999 && qm terminal 9999
```

For each recipe, confirm:

- Build completes without bootloop (the bigger risk for Windows — DriverPath
  letter or vioscsi dir name).
- Cloned VM boots and reaches login.
- Linux: `lsblk` shows `/dev/sda*` (not vda), `systemctl status qemu-guest-agent`
  is active, `qm terminal` produces output (serial console works).
- Windows: Device Manager shows "Red Hat VirtIO SCSI controller" and "Red Hat
  VirtIO Ethernet Adapter"; VirtIO tools service running.

## Known risks

- **windows-server-2025 driver path**: virtio-win-0.1.248 may not ship a
  `2k25` directory. The recipe currently uses `2k22` as a fallback per
  Microsoft's compat guidance. Verify the directory exists in the mounted
  ISO; if 2k25 is present, change `E:\vioscsi\2k22\amd64` →
  `E:\vioscsi\2k25\amd64` in `builds/windows-server-2025/autounattend.xml`
  (same for NetKVM).
- **CD drive letter (E:)**: Packer attaches the virtio ISO via
  `additional_iso_files` (sata) and the answerfiles CD via the second
  `additional_iso_files` (ide). Windows typically assigns the SATA CD-ROM
  first (D:) and the IDE CD second (E:) — but the plan and autounattend
  reference `E:\vioscsi`. If installation can't find a disk to install on,
  the driver path is wrong; try `D:\vioscsi\...` instead.
- **Linux LVM on /dev/sda**: Debian preseed now installs to `/dev/sda` and
  grub goes to `/dev/sda`. If `grub-install` fails, check that the boot disk
  is the first SCSI disk (`scsi0`); the build VM should not have extra
  attached disks.
- **Serial console**: kernel cmdline is `console=tty0 console=ttyS0,115200`
  — last `console=` wins for the kernel's primary console, so logs go to
  the serial port. noVNC still works because `console=tty0` is listed first.
