#!/usr/bin/env bash
# cf-cluster-templates.sh
#
# Post-build helper for a Proxmox CLUSTER: turn the freshly-built cofoundry
# artifact into a clonable template on EVERY node, each with its own VMID
# (cluster VMIDs are globally unique, so nodes cannot share one id).
#
# Wire in as the build node's CF_UPLOAD_CMD in .env:
#   CF_UPLOAD_CMD=bash /var/lib/vz/dump/cofoundry-work/scripts/cf-cluster-templates.sh {{file}}
#
# Reads from the environment (set by the recipe's post-processor):
#   CF_BUILT_VMID (required), CF_RECIPE_NAME, CF_ARCH
#
# Per-node VMID = node_id * OFFSET + CF_BUILT_VMID   (OFFSET default 10000)
#   build_vmid 4001 -> node1=14001, node2=24001, node3=34001
#
# LOCAL/cluster convenience — not part of the upstream recipes.

set -uo pipefail

ARTIFACT="${1:?usage: cf-cluster-templates.sh <artifact-path>}"
BASE_VMID="${CF_BUILT_VMID:?CF_BUILT_VMID not set}"

# --- knobs (edit to taste) -------------------------------------------------
STORAGE="${CF_TEMPLATE_STORAGE:-local}"        # per-node disk storage for the template
OFFSET="${CF_TEMPLATE_VMID_OFFSET:-10000}"     # per-node VMID spacing
# ---------------------------------------------------------------------------

BN="$(basename "$ARTIFACT")"
SSHOPT=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=8)

# node_id + ip for every online member, from the cluster state file
mapfile -t NODES < <(
  grep -oE '"id": [0-9]+, "online": 1, "ip": "[0-9.]+"' /etc/pve/.members 2>/dev/null \
    | sed -E 's/.*"id": ([0-9]+).*"ip": "([0-9.]+)".*/\1 \2/'
)
[ "${#NODES[@]}" -gt 0 ] || { echo "cf-cluster-templates: no online cluster nodes found"; exit 0; }

echo "==> $BN -> clonable template on ${#NODES[@]} node(s) (storage=$STORAGE)"

for line in "${NODES[@]}"; do
  read -r ID IP <<<"$line"
  [ -n "$ID" ] && [ -n "$IP" ] || continue
  VMID=$(( ID * OFFSET + BASE_VMID ))
  STAMP="$(date +%Y_%m_%d-%H_%M_%S)"
  echo "==> node $ID ($IP) -> template $VMID"

  if ! scp -q "${SSHOPT[@]}" "$ARTIFACT" "root@$IP:/var/lib/vz/dump/$BN"; then
    echo "    [skip] could not copy artifact to $IP"
    continue
  fi

  # Replace only a template we own at this id; never clobber a real VM.
  ssh "${SSHOPT[@]}" "root@$IP" bash -s <<EOF || echo "    [fail] $IP"
set -e
if qm status $VMID >/dev/null 2>&1; then
  if ! qm config $VMID 2>/dev/null | grep -q '^template:'; then
    echo "    [skip] VMID $VMID is a real (non-template) VM — leaving it alone"
    exit 0
  fi
  qm stop $VMID --skiplock 1 >/dev/null 2>&1 || true
  qm destroy $VMID --purge 1 --destroy-unreferenced-disks 1 >/dev/null 2>&1 || true
fi
# qmrestore only accepts vzdump-style filenames, so rename before restoring
VZ="/var/lib/vz/dump/vzdump-qemu-$VMID-$STAMP.vma.zst"
mv "/var/lib/vz/dump/$BN" "\$VZ"
qmrestore "\$VZ" $VMID --storage $STORAGE --unique 1 >/dev/null
rm -f "\$VZ"
# cofoundry artifacts are already templates after restore; only convert if not
qm config $VMID 2>/dev/null | grep -q '^template:' || qm template $VMID >/dev/null
echo "    [ok] template $VMID on $STORAGE"
EOF
done

echo "==> cluster template distribution complete"
