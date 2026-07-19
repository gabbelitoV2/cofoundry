#!/usr/bin/env bash
# cf-cluster-templates.sh
#
# Post-build helper for a Proxmox CLUSTER: turn the freshly-built cofoundry
# artifact into a clonable template on EVERY node, each with its own VMID
# (cluster VMIDs are globally unique, so nodes cannot share one id).
#
# Wire in as the build node's CF_UPLOAD_CMD in .env:
#   CF_UPLOAD_CMD=bash $PVE_DUMP_DIR/cofoundry-work/scripts/cf-cluster-templates.sh {{file}}
#
# Reads from the environment (set by the recipe's post-processor):
#   CF_RECIPE_BASE_VMID or CF_BUILT_VMID (required), CF_RECIPE_NAME, CF_ARCH
#
# CF_BUILT_VMID is the slot-derived build id (recipe base * 100 + slot index)
# for parallel builds; CF_RECIPE_BASE_VMID is the recipe base cf exports for
# the per-node template numbering. Plain builds set only CF_BUILT_VMID = base.
#
# Per-node VMID = node_id * OFFSET + BASE_VMID   (OFFSET default 10000)
#   base 4001 -> node1=14001, node2=24001, node3=34001
#
# LOCAL/cluster convenience — not part of the upstream recipes.

# Intentionally no `-e`: we want the per-node loop to keep going on a single
# node's failure (logged as `[fail] $IP`) rather than aborting the whole run.
set -uo pipefail

ARTIFACT="${1:?usage: cf-cluster-templates.sh <artifact-path>}"
# cf exports the recipe BASE directly. CF_BUILT_VMID is the slot-derived build
# id (recipe base * 100 + slot index) for parallel builds; the per-node template
# numbering needs the base, so prefer CF_RECIPE_BASE_VMID. A plain (non-slot)
# build doesn't set it — CF_BUILT_VMID is then the base itself.
BASE_VMID="${CF_RECIPE_BASE_VMID:-${CF_BUILT_VMID:?CF_BUILT_VMID or CF_RECIPE_BASE_VMID not set}}"
DUMP_DIR="${PVE_DUMP_DIR:-/var/lib/vz/dump}"

# --- knobs (edit to taste) -------------------------------------------------
# Preferred per-node disk storage. Nodes that don't have it (e.g. a ZFS node
# with local-zfs instead of local-lvm) auto-pick their best images-capable
# storage: local over shared, then most free space.
STORAGE="${CF_TEMPLATE_STORAGE:-local-lvm}"
OFFSET="${CF_TEMPLATE_VMID_OFFSET:-10000}"     # per-node VMID spacing
# ---------------------------------------------------------------------------

# Adjacent nodes collide if BASE_VMID >= OFFSET (e.g. node1+14001 == node2+4001).
if [ "$BASE_VMID" -ge "$OFFSET" ]; then
  echo "cf-cluster-templates: derived base VMID ($BASE_VMID) must be < CF_TEMPLATE_VMID_OFFSET ($OFFSET)" >&2
  exit 1
fi

BN="$(basename "$ARTIFACT")"
SSHOPT=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=8)

# Local IPv4s — used to skip scp-to-self (the artifact is already on this node).
LOCAL_IPS=" $(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')"

# node_id + ip for every online member, from the cluster state file
mapfile -t NODES < <(
  grep -oE '"id": [0-9]+, "online": 1, "ip": "[0-9.]+"' /etc/pve/.members 2>/dev/null \
    | sed -E 's/.*"id": ([0-9]+).*"ip": "([0-9.]+)".*/\1 \2/'
)
[ "${#NODES[@]}" -gt 0 ] || { echo "cf-cluster-templates: no online cluster nodes found"; exit 0; }

echo "==> $BN -> clonable template on ${#NODES[@]} node(s) (preferred storage=$STORAGE)"

for line in "${NODES[@]}"; do
  read -r ID IP <<<"$line"
  [ -n "$ID" ] && [ -n "$IP" ] || continue
  VMID=$(( ID * OFFSET + BASE_VMID ))
  STAMP="$(date +%Y_%m_%d-%H_%M_%S)"
  echo "==> node $ID ($IP) -> template $VMID"

  # Skip scp when the target IP is on this host — the artifact is already there.
  if [[ "$LOCAL_IPS" == *" $IP "* ]]; then
    cp -f "$ARTIFACT" "$DUMP_DIR/$BN"
  elif ! scp -q "${SSHOPT[@]}" "$ARTIFACT" "root@$IP:$DUMP_DIR/$BN"; then
    echo "    [skip] could not copy artifact to $IP"
    continue
  fi

  # Replace only a template we own at this id; never clobber a real VM.
  # Same restore script for local + remote — pipe to bash directly for local
  # to skip the ssh roundtrip.
  RESTORE_SCRIPT=$(cat <<EOF
set -e
SOURCE="$DUMP_DIR/$BN"
VZ="$DUMP_DIR/vzdump-qemu-$VMID-$STAMP.vma.zst"
cleanup() {
  rm -f "\$SOURCE" "\$VZ"
}
trap cleanup EXIT
# Pick this node's storage, in order: the preferred one, then the standard
# Proxmox-installer storages (local-lvm, local-zfs), then as a last resort the
# best active images-capable storage (local over shared, VM-native types over
# dir, most free first).
STG=\$(pvesh get /nodes/\$(hostname)/storage --content images --output-format json 2>/dev/null | python3 -c "
import json, sys
rows = [s for s in json.load(sys.stdin) if s.get('active')]
names = [s['storage'] for s in rows]
for pref in ('$STORAGE', 'local-lvm', 'local-zfs'):
    if pref in names:
        print(pref)
        break
else:
    local = [s for s in rows if not s.get('shared')]
    rows = local if local else rows
    vm_native = ('lvmthin', 'zfspool', 'btrfs', 'rbd', 'lvm')
    rows.sort(key=lambda s: (0 if s.get('type') in vm_native else 1, -s.get('avail', 0)))
    print(rows[0]['storage'] if rows else '')
")
if [ -z "\$STG" ]; then
  echo "    [fail] no active images-capable storage on \$(hostname)"
  exit 1
fi
if qm status $VMID >/dev/null 2>&1; then
  if ! qm config $VMID 2>/dev/null | grep -q '^template:'; then
    echo "    [skip] VMID $VMID is a real (non-template) VM — leaving it alone"
    exit 0
  fi
  qm stop $VMID --skiplock 1 >/dev/null 2>&1 || true
  qm destroy $VMID --purge 1 --destroy-unreferenced-disks 1 >/dev/null 2>&1 || true
fi
# qmrestore only accepts vzdump-style filenames, so rename before restoring
mv "\$SOURCE" "\$VZ"
qmrestore "\$VZ" $VMID --storage "\$STG" --unique 1 >/dev/null
rm -f "\$VZ"
# cofoundry artifacts are already templates after restore; only convert if not
qm config $VMID 2>/dev/null | grep -q '^template:' || qm template $VMID >/dev/null
trap - EXIT
echo "    [ok] template $VMID on \$STG"
EOF
  )
  if [[ "$LOCAL_IPS" == *" $IP "* ]]; then
    bash -c "$RESTORE_SCRIPT" || echo "    [fail] $IP"
  else
    ssh "${SSHOPT[@]}" "root@$IP" bash -s <<<"$RESTORE_SCRIPT" || echo "    [fail] $IP"
  fi
done

echo "==> cluster template distribution complete"
