# Recipes

## Supported recipes

### Linux (cloud image)

These boot a cloud image directly — no ISO install. Packer clones a base template, injects SSH keys, runs the bootstrap script, then exports with `vzdump`.

| Recipe | Build VMID |
|---|---:|
| `debian-11` | 9105 |
| `debian-12` | 9100 |
| `debian-13` | 9101 |
| `ubuntu-22.04` | 9106 |
| `ubuntu-24.04` | 9102 |
| `ubuntu-25.10` | 9107 |
| `ubuntu-26.04` | 9108 |
| `almalinux-8` | 9109 |
| `almalinux-9` | 9110 |
| `almalinux-10` | 9103 |
| `rocky-linux-8` | 9111 |
| `rocky-linux-9` | 9112 |
| `rocky-linux-10` | 9104 |

### Windows Server (ISO install)

Unattended install from a Microsoft evaluation ISO. Packer boots the ISO, `autounattend.xml` drives the install silently, then `TemplatePrep.ps1` installs VirtIO guest tools and Cloudbase-Init, cleans the component store, zeros free space, runs sysprep, and exports with `vzdump`.

| Recipe | Build VMID | Disk |
|---|---:|---:|
| `windows-server-2019` | 9201 | 15G |
| `windows-server-2022` | 9202 | 15G |
| `windows-server-2025` | 9205 | 15G |

---

## Adding a recipe

### Linux cloud image

1. Create `builds/<name>.pkr.hcl` — copy an existing one (e.g. `ubuntu-24.04.pkr.hcl`) and update:
   - `iso_url` — direct link to the `.qcow2` or `.img` cloud image
   - `iso_target_path` — filename to cache it as under `${var.iso_cache_dir}`
   - `build_vmid` — pick an unused ID in the 91xx range
   - `display`, `recipe_name` locals

2. Run:
   ```sh
   cf build <name>
   ```

### Debian netinstall (preseed)

1. Copy `builds/debian-12.pkr.hcl` and adapt for the new version.
2. Create `builds/<name>/http/preseed.cfg` — include `__PACKER_SSH_PUBLIC_KEY__` where SSH key injection should go.
3. Complete the [preseed NAT setup](setup.md#6-nat-for-debian-netinstall-builds) if not done already.
4. Run:
   ```sh
   cf build <name>
   ```

### Windows Server

1. Create `builds/windows-server-<version>.pkr.hcl` — copy `windows-server-2022.pkr.hcl` and update:
   - `iso_url` — Microsoft Eval Center link for the version
   - `iso_target_path` — cache filename
   - `build_vmid` — pick an unused ID in the 92xx range
   - `os` — Proxmox OS type: `win10` (2019), `win2k22` (2022), `win11` (2025)
   - `tpm_config` — required for 2025, remove for 2019
   - `cpu_type = "host"` — required for 2025 (installer checks SSE4.1/4.2)

2. Create `builds/windows-server-<version>/autounattend.xml` — copy from an existing version, change the `<Value>` in `<InstallFrom><MetaData>` to match the edition string (e.g. `Windows Server 2022 SERVERDATACENTERCORE`).

3. Create `builds/windows-server-<version>/scripts/TemplatePrep.ps1` — identical copy from any existing Windows version.

4. Run:
   ```sh
   cf build windows-server-<version>
   ```

> **Note:** Microsoft eval pages occasionally return a registration HTML page instead of ISO bytes. If the build fails with a bad ISO checksum, get the direct fwlink URL from the Microsoft Eval Center and set it as `iso_url`.
