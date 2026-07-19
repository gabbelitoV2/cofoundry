# Cofoundry

Builds Proxmox VM templates from unattended Linux and Windows Server ISO
installations, then exports `.vma.zst` artifacts ready to be served by
[downloader](https://github.com/ConvoyPanel/downloader).

## Documentation

| Document                             | Description                                                           |
| ------------------------------------ | --------------------------------------------------------------------- |
| [Setup](docs/setup.md)               | First-time setup — local dependencies, Proxmox node config, `.env`    |
| [Usage](docs/usage.md)               | Building templates, checking for updates, publishing, cleanup         |
| [Recipes](docs/recipes.md)           | Supported templates and how to add new ones                           |
| [Windows recipes](docs/windows.md)   | Windows configuration and troubleshooting                             |
| [Architecture](docs/architecture.md) | Source layout and implementation boundaries                           |
| [Diagnostics](docs/diagnostics.md)   | How build-failure evidence is recorded and collected                  |
| [Coport](docs/coport.md)             | Node-side installer that restores published templates via `qmrestore` |

## Supported recipes

Ubuntu, Debian, AlmaLinux, Rocky Linux, and Windows Server 2019/2022/2025
Datacenter. See [Recipes](docs/recipes.md) for the full list.
