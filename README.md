# Cofoundry

Builds Proxmox VM templates via Packer and exports them as `.vma.zst` artifacts, ready to be served by [downloader](https://github.com/ConvoyPanel/downloader). Supports Linux cloud images and unattended Windows Server installs.

## Documentation

| Document | Description |
|---|---|
| [Setup](docs/setup.md) | First-time setup — local dependencies, Proxmox node config, `.env` |
| [Usage](docs/usage.md) | Building templates, checking for updates, publishing, cleanup |
| [Recipes](docs/recipes.md) | Supported templates and how to add new ones |

## Supported recipes

Linux cloud-image recipes (Ubuntu, Debian, AlmaLinux, Rocky Linux) and Windows Server ISO recipes (2019, 2022, 2025 Datacenter Core). See [Recipes](docs/recipes.md) for the full list.
