#!/usr/bin/env bash
# inject-placeholders.sh — pre-build CI helper.
#
# Generates ephemeral credentials, substitutes __PACKER_*__ tokens in recipe
# files, and writes a Packer vars file so the build step can pass the
# generated secrets to packer build.
#
# Usage: bash scripts/inject-placeholders.sh <recipe-name>
# Output: path to the generated .pkrvars.hcl file (printed to stdout)

set -euo pipefail

RECIPE="${1:?usage: inject-placeholders.sh <recipe-name>}"
RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"
VARS_FILE="${RUNNER_TEMP}/packer-vars-${RECIPE}.pkrvars.hcl"

# Wipe any vars file from a previous run
: >"$VARS_FILE"

RECIPE_DIR="builds/${RECIPE}"

# ── Linux: ephemeral SSH keypair ────────────────────────────────────────────
PRESEED="${RECIPE_DIR}/http/preseed.cfg"
if [ -f "$PRESEED" ]; then
  KEY_FILE="${RUNNER_TEMP}/packer_key_${RECIPE}"
  rm -f "$KEY_FILE" "${KEY_FILE}.pub"
  ssh-keygen -t ed25519 -N "" -C "packer-${RECIPE}-${GITHUB_RUN_ID:-local}" \
    -f "$KEY_FILE" >/dev/null
  chmod 600 "$KEY_FILE"
  PUB_KEY="$(cat "${KEY_FILE}.pub")"

  # Replace placeholder OR any previously injected key (handles re-runs without git clean)
  PRESEED_WORK="${RUNNER_TEMP}/preseed-${RECIPE}.cfg"
  sed -E "s|__PACKER_SSH_PUBLIC_KEY__|${PUB_KEY}|g; \
          s|ssh-ed25519 AAAA[^ ]+ packer-${RECIPE}-[^ '\"]*|${PUB_KEY}|g" \
    "$PRESEED" >"$PRESEED_WORK"
  cp "$PRESEED_WORK" "$PRESEED"

  printf 'packer_ssh_private_key_file = "%s"\n' "$KEY_FILE" >>"$VARS_FILE"
fi

# ── Linux cloud images: ephemeral SSH keypair ──────────────────────────────
USER_DATA="${RECIPE_DIR}/cloud-init/user-data"
if [ -f "$USER_DATA" ]; then
  KEY_FILE="${RUNNER_TEMP}/packer_key_${RECIPE}"
  rm -f "$KEY_FILE" "${KEY_FILE}.pub"
  ssh-keygen -t ed25519 -N "" -C "packer-${RECIPE}-${GITHUB_RUN_ID:-local}" \
    -f "$KEY_FILE" >/dev/null
  chmod 600 "$KEY_FILE"
  PUB_KEY="$(cat "${KEY_FILE}.pub")"

  USER_DATA_WORK="${RUNNER_TEMP}/user-data-${RECIPE}.cfg"
  sed -E "s|__PACKER_SSH_PUBLIC_KEY__|${PUB_KEY}|g; \
          s|ssh-ed25519 AAAA[^ ]+ packer-${RECIPE}-[^ '\"]*|${PUB_KEY}|g" \
    "$USER_DATA" >"$USER_DATA_WORK"
  cp "$USER_DATA_WORK" "$USER_DATA"

  printf 'packer_ssh_private_key_file = "%s"\n' "$KEY_FILE" >>"$VARS_FILE"
fi

# ── Windows: ephemeral admin password ───────────────────────────────────────
AUTOUNATTEND="${RECIPE_DIR}/autounattend.xml"
if [ -f "$AUTOUNATTEND" ]; then
  WIN_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=\n' | head -c 24)"

  AUTOUNATTEND_WORK="${RUNNER_TEMP}/autounattend-${RECIPE}.xml"
  sed "s|__PACKER_ADMIN_PASSWORD__|${WIN_PASSWORD}|g" "$AUTOUNATTEND" >"$AUTOUNATTEND_WORK"
  cp "$AUTOUNATTEND_WORK" "$AUTOUNATTEND"

  printf 'winrm_password = "%s"\n' "$WIN_PASSWORD" >>"$VARS_FILE"
fi

echo "$VARS_FILE"
