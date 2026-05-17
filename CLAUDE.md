# Claude Notes

See [AGENTS.md](AGENTS.md) for agent-facing guidance on disk sizing, Windows Server 2025 requirements, and preseed key injection behavior.

## Project overview

This repo builds Proxmox VM templates via Packer and exports them as vzdump `.vma.zst` artifacts. Packer runs **on the Proxmox node** (not locally) — `src/build.ts` rsyncs the repo to the node and invokes packer over SSH.

## Key files

- `src/cli.ts` — CLI entry point (`tb build`, `tb list`, etc.)
- `src/build.ts` — rsync + remote packer orchestration
- `src/config.ts` — recipe metadata parsing (reads HCL comment headers)
- `builds/<name>.pkr.hcl` — one file per recipe
- `builds/_shared/post/vzdump-and-cleanup.sh` — post-processor: vzdump, move artifact, write sidecar JSON
- `scripts/inject-placeholders.sh` — generates ephemeral SSH keypair, injects into preseed
- `.env` — local secrets (never commit)
