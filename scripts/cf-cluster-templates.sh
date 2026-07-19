#!/usr/bin/env bash
# cf-cluster-templates.sh
#
# Post-build helper for a Proxmox CLUSTER: turn the freshly-built cofoundry
# artifact into a clonable template on EVERY node, each with its own VMID
# (cluster VMIDs are globally unique, so nodes cannot share one id).
#
# Wire in as the build node's CF_UPLOAD_CMD in .env. Pass {{sha256}} so every
# node's copy is verified before its existing template is replaced:
#   CF_UPLOAD_CMD=bash $PVE_DUMP_DIR/cofoundry-work/scripts/cf-cluster-templates.sh {{file}} {{sha256}}
#
# Reads from the environment (set by the recipe's post-processor):
#   CF_RECIPE_BASE_VMID or CF_BUILT_VMID (required), CF_RECIPE_NAME, CF_ARCH
#   CF_ARTIFACT_SHA256 (optional alternative to the second argument)
#
# CF_BUILT_VMID is the slot-derived build id (recipe base * 100 + slot index)
# for parallel builds; CF_RECIPE_BASE_VMID is the recipe base cf exports for
# the per-node template numbering. Plain builds set only CF_BUILT_VMID = base.
#
# Per-node VMID = node_id * OFFSET + BASE_VMID   (OFFSET default 10000)
#   base 4001 -> node1=14001, node2=24001, node3=34001
#
# Exits non-zero when any online node failed to end up with a verified
# template; offline nodes are reported but do not fail the run (deliberate
# node downtime should not fail every build).
#
# LOCAL/cluster convenience — not part of the upstream recipes.

# Intentionally no `-e`: we want the per-node loop to keep going on a single
# node's failure (logged as `[fail]`) rather than aborting the whole run.
set -uo pipefail

ARTIFACT="${1:?usage: cf-cluster-templates.sh <artifact-path> [sha256]}"
EXPECTED_SHA256="${2:-${CF_ARTIFACT_SHA256:-}}"
# cf exports the recipe BASE directly. CF_BUILT_VMID is the slot-derived build
# id (recipe base * 100 + slot index) for parallel builds; the per-node template
# numbering needs the base, so prefer CF_RECIPE_BASE_VMID. A plain (non-slot)
# build doesn't set it — CF_BUILT_VMID is then the base itself.
BASE_VMID="${CF_RECIPE_BASE_VMID:-${CF_BUILT_VMID:?CF_BUILT_VMID or CF_RECIPE_BASE_VMID not set}}"
DUMP_DIR="${PVE_DUMP_DIR:-/var/lib/vz/dump}"
# Overridable for tests; on a real node this is the pmxcfs cluster state file.
MEMBERS_FILE="${CF_MEMBERS_FILE:-/etc/pve/.members}"

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

if [ -n "$EXPECTED_SHA256" ]; then
  if ! [[ "$EXPECTED_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "cf-cluster-templates: expected sha256 '$EXPECTED_SHA256' is not a 64-char hex digest" >&2
    exit 1
  fi
else
  # No sha256 supplied (e.g. a CF_UPLOAD_CMD without {{sha256}}): verification is
  # still the default. Derive the expected hash from the local source artifact so
  # every node's copy is checked before its existing template is replaced.
  # Passing {{sha256}} (cf's recorded hash) additionally guards against a source
  # artifact that was already corrupt before this ran.
  EXPECTED_SHA256="$(sha256sum "$ARTIFACT" 2>/dev/null | awk '{print $1}')"
  if ! [[ "$EXPECTED_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "cf-cluster-templates: [fail] cannot read local artifact '$ARTIFACT' to compute a verification hash" >&2
    exit 1
  fi
  echo "cf-cluster-templates: [info] no sha256 given — verifying transfers against the local artifact's own hash (pass {{sha256}} to verify against cf's recorded hash instead)" >&2
fi

BN="$(basename "$ARTIFACT")"
SSHOPT=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=8)

# Local IPv4s — used to skip scp-to-self (the artifact is already on this node).
LOCAL_IPS=" $(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')"

is_local_ip() {
  [[ "$LOCAL_IPS" == *" $1 "* ]]
}

# Copy the artifact into the target node's dump dir (cp for this host, scp
# for remote nodes).
copy_to_node() {
  local ip="$1"
  if is_local_ip "$ip"; then
    # -ef: already the same file (artifact lives in the dump dir) — no copy.
    [ "$ARTIFACT" -ef "$DUMP_DIR/$BN" ] || cp -f "$ARTIFACT" "$DUMP_DIR/$BN"
  else
    scp -q "${SSHOPT[@]}" "$ARTIFACT" "root@$ip:$DUMP_DIR/$BN"
  fi
}

checksum_matches() {
  local ip="$1" actual
  if is_local_ip "$ip"; then
    actual="$(sha256sum "$DUMP_DIR/$BN" 2>/dev/null | awk '{print $1}')"
  else
    actual="$(ssh "${SSHOPT[@]}" "root@$ip" "sha256sum '$DUMP_DIR/$BN'" 2>/dev/null | awk '{print $1}')"
  fi
  [ "$actual" = "$EXPECTED_SHA256" ]
}

# Drop a corrupt copy from the target node — but never the source artifact
# itself (the local-node "copy" can be the artifact already in place).
remove_copy() {
  local ip="$1"
  if is_local_ip "$ip"; then
    [ "$ARTIFACT" -ef "$DUMP_DIR/$BN" ] || rm -f "$DUMP_DIR/$BN"
  else
    ssh "${SSHOPT[@]}" "root@$ip" "rm -f '$DUMP_DIR/$BN'" || true
  fi
}

# node_id + ip for every online member, from the cluster state file
mapfile -t NODES < <(
  grep -oE '"id": [0-9]+, "online": 1, "ip": "[0-9.]+"' "$MEMBERS_FILE" 2>/dev/null \
    | sed -E 's/.*"id": ([0-9]+).*"ip": "([0-9.]+)".*/\1 \2/'
)
# Offline members carry no "ip" field — collect name + id for the summary.
mapfile -t OFFLINE_NODES < <(
  grep -oE '"[^"]+": \{ "id": [0-9]+, "online": 0' "$MEMBERS_FILE" 2>/dev/null \
    | sed -E 's/^"([^"]+)": \{ "id": ([0-9]+).*/\1 (id \2)/'
)
if [ "${#NODES[@]}" -eq 0 ]; then
  echo "cf-cluster-templates: no online cluster nodes found in $MEMBERS_FILE" >&2
  exit 1
fi
for node in "${OFFLINE_NODES[@]}"; do
  echo "==> [offline] $node — skipping, will not receive this template" >&2
done

echo "==> $BN -> clonable template on ${#NODES[@]} node(s) (preferred storage=$STORAGE)"

OK_COUNT=0
FAILED_NODES=()

for line in "${NODES[@]}"; do
  read -r ID IP <<<"$line"
  [ -n "$ID" ] && [ -n "$IP" ] || continue
  VMID=$(( ID * OFFSET + BASE_VMID ))
  STAMP="$(date +%Y_%m_%d-%H_%M_%S)"
  echo "==> node $ID ($IP) -> template $VMID"

  if ! copy_to_node "$IP"; then
    echo "    [fail] could not copy artifact to $IP"
    FAILED_NODES+=("node $ID ($IP): copy failed")
    continue
  fi

  # Verify the transfer BEFORE touching the node's existing template: a
  # corrupt copy must never destroy a working template. Verification is always
  # on (EXPECTED_SHA256 is either supplied or derived above). One re-copy on
  # mismatch, then give up on the node.
  if ! checksum_matches "$IP"; then
    echo "    [warn] checksum mismatch on $IP — retrying copy"
    if ! copy_to_node "$IP" || ! checksum_matches "$IP"; then
      echo "    [fail] checksum mismatch on $IP after retry — existing template left untouched"
      remove_copy "$IP"
      FAILED_NODES+=("node $ID ($IP): checksum mismatch")
      continue
    fi
  fi

  # Replace only a template we own at this id; never clobber a real VM.
  # Same restore script for local + remote — pipe to bash directly for local
  # to skip the ssh roundtrip.
  RESTORE_SCRIPT=$(cat <<EOF
set -e
SOURCE="$DUMP_DIR/$BN"
VZ="$DUMP_DIR/vzdump-qemu-$VMID-$STAMP.vma.zst"
DESTROYED=0
cleanup() {
  # Failure path: qmrestore did not finish. Keep the verified copy for a manual
  # retry — undo only the vzdump-style rename — and tell the operator the state
  # of this node so a half-finished replacement is never silent. If we already
  # destroyed the node's previous template, this node now has no template at
  # \$VMID until the retry lands. The success path removes the copy below.
  if [ -e "\$VZ" ]; then
    mv -f "\$VZ" "\$SOURCE"
    if [ "\$DESTROYED" = 1 ]; then
      echo "    [fail] qmrestore did not complete on \$(hostname) — the previous template at $VMID was already destroyed, so this node now has NO template at $VMID; the verified artifact is kept at \$SOURCE for a manual retry (qmrestore it, or re-run the build)" >&2
    else
      echo "    [fail] qmrestore did not complete on \$(hostname) — no template was created at $VMID; the verified artifact is kept at \$SOURCE for a manual retry (qmrestore it, or re-run the build)" >&2
    fi
  fi
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
  DESTROYED=1
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
  if is_local_ip "$IP"; then
    RESTORE_OK=0
    bash -c "$RESTORE_SCRIPT" && RESTORE_OK=1
  else
    RESTORE_OK=0
    ssh "${SSHOPT[@]}" "root@$IP" bash -s <<<"$RESTORE_SCRIPT" && RESTORE_OK=1
  fi
  if [ "$RESTORE_OK" = "1" ]; then
    OK_COUNT=$(( OK_COUNT + 1 ))
  else
    echo "    [fail] $IP"
    FAILED_NODES+=("node $ID ($IP): restore failed")
  fi
done

echo "==> cluster template distribution: $OK_COUNT/${#NODES[@]} node(s) ok, ${#FAILED_NODES[@]} failed, ${#OFFLINE_NODES[@]} offline"
if [ "${#FAILED_NODES[@]}" -gt 0 ]; then
  for failed in "${FAILED_NODES[@]}"; do
    echo "    [failed] $failed" >&2
  done
  exit 1
fi
