# display: Windows Server 2025 Datacenter
# group: windows-server
# build_vmid: 2002
# iso_url: https://go.microsoft.com/fwlink/?linkid=2345730&clcid=0x409&culture=en-us&country=us
# iso_target_path: /var/lib/vz/template/iso/packer-windows-server-2025-eval.iso

packer {
  required_plugins {
    proxmox = {
      version = "~> 1"
      source  = "github.com/hashicorp/proxmox"
    }
  }
}

variable "proxmox_api_url" { type = string }

variable "proxmox_username" {
  type      = string
  sensitive = true
}

variable "proxmox_token" {
  type      = string
  sensitive = true
}

variable "proxmox_node" { type = string }

variable "proxmox_storage_pool" {
  type    = string
  default = "local"
}

variable "proxmox_iso_storage_pool" {
  type    = string
  default = "local"
}

variable "proxmox_bridge" {
  type    = string
  default = "vmbr1"
}

variable "winrm_password" {
  type      = string
  sensitive = true
}

variable "build_ip" { type = string }
variable "build_gw" { type = string }
variable "build_dns" { type = string }
variable "build_mac" { type = string }

locals {
  build_vmid     = 2002
  recipe_name    = "windows-server-2025"
  recipe_display = "Windows Server 2025 Datacenter"
}

source "proxmox-iso" "windows-server-2025" {
  proxmox_url              = var.proxmox_api_url
  username                 = var.proxmox_username
  token                    = var.proxmox_token
  node                     = var.proxmox_node
  insecure_skip_tls_verify = true

  vm_id                = local.build_vmid
  vm_name              = "packer-${local.recipe_name}"
  template_description = <<-EOT
    # Convoy Template

    This template was created for use with **Convoy**.

    Source repository: [ConvoyPanel/cofoundry](https://github.com/ConvoyPanel/cofoundry)

    Created at: `${timestamp()}`
  EOT

  bios    = "ovmf"
  machine = "q35"
  # 2025 shares the Windows 11 install kernel; win2k22 causes a bootloop
  os = "win11"

  # 2025 installer probes SSE4.1/4.2; kvm64 bootloops
  cpu_type = "host"
  cores    = 4
  sockets  = 1
  memory   = 8192

  efi_config {
    efi_storage_pool  = var.proxmox_storage_pool
    pre_enrolled_keys = true
    efi_type          = "4m"
  }

  scsi_controller = "virtio-scsi-single"

  tpm_config {
    tpm_storage_pool = var.proxmox_storage_pool
    tpm_version      = "v2.0"
  }

  disks {
    disk_size    = "32G"
    format       = "qcow2"
    storage_pool = var.proxmox_storage_pool
    type         = "scsi"
    discard      = true
    io_thread    = true
  }

  network_adapters {
    bridge      = var.proxmox_bridge
    model       = "virtio"
    mac_address = var.build_mac
  }

  boot_iso {
    type         = "ide"
    iso_file     = "${var.proxmox_iso_storage_pool}:iso/packer-windows-server-2025-eval.iso"
    iso_checksum = "none"
    unmount      = true
  }

  # VirtIO drivers ISO (provides virtio-win-guest-tools.exe for Install.ps1)
  additional_iso_files {
    type         = "ide"
    iso_file     = "${var.proxmox_iso_storage_pool}:iso/packer-virtio-win.iso"
    iso_checksum = "none"
    unmount      = true
  }

  # Packer creates an ISO from these local files and attaches it as a CD-ROM.
  # inject-placeholders.sh replaces __PACKER_ADMIN_PASSWORD__ in autounattend.xml before the build.
  additional_iso_files {
    type             = "ide"
    iso_storage_pool = var.proxmox_iso_storage_pool
    cd_files = [
      "${path.root}/windows-server-2025/autounattend.xml",
      "${path.root}/_shared/CloudbaseInitSetup_x64.msi",
    ]
    cd_label = "ANSWERFILES"
    unmount  = true
  }

  boot_wait    = "3s"
  boot_command = ["<enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2>"]

  communicator   = "winrm"
  winrm_host     = var.build_ip
  winrm_username = "Administrator"
  winrm_password = var.winrm_password
  winrm_use_ssl  = false
  winrm_insecure = true
  winrm_timeout  = "4h"
  winrm_port     = 5985
}

build {
  sources = ["source.proxmox-iso.windows-server-2025"]

  provisioner "powershell" {
    script = "${path.root}/_shared/windows/Install.ps1"
  }
  provisioner "windows-restart" {
    restart_timeout = "30m"
  }

  provisioner "powershell" {
    pause_before = "30s"
    script       = "${path.root}/_shared/windows/WU.ps1"
  }
  provisioner "windows-restart" {
    restart_timeout = "90m"
    restart_command = "powershell -Command \"if (Test-Path 'C:/Windows/Temp/tb-wu-reboot.flag') { Remove-Item 'C:/Windows/Temp/tb-wu-reboot.flag' -Force; shutdown /r /f /t 5 /c 'packer wu reboot' } else { exit 0 }\""
  }

  provisioner "powershell" {
    pause_before = "30s"
    script       = "${path.root}/_shared/windows/WU.ps1"
  }
  provisioner "windows-restart" {
    restart_timeout = "90m"
    restart_command = "powershell -Command \"if (Test-Path 'C:/Windows/Temp/tb-wu-reboot.flag') { Remove-Item 'C:/Windows/Temp/tb-wu-reboot.flag' -Force; shutdown /r /f /t 5 /c 'packer wu reboot' } else { exit 0 }\""
  }

  provisioner "powershell" {
    script = "${path.root}/_shared/windows/PreFinalize.ps1"
  }
  provisioner "windows-restart" {
    restart_timeout = "15m"
  }

  provisioner "powershell" {
    script = "${path.root}/_shared/windows/Finalize.ps1"
  }

  post-processor "shell-local" {
    environment_vars = [
      "CF_BUILT_VMID=${local.build_vmid}",
      "CF_RECIPE_NAME=${local.recipe_name}",
      "CF_RECIPE_DISPLAY=${local.recipe_display}",
    ]
    script = "${path.root}/_shared/post/vzdump-and-cleanup.sh"
  }
}
