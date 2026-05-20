# display: Windows Server 2022 Datacenter Core
# build_vmid: 9202

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

locals {
  build_vmid     = 9202
  recipe_name    = "windows-server-2022"
  recipe_display = "Windows Server 2022 Datacenter Core"
}

source "proxmox-iso" "windows-server-2022" {
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
  os      = "win2k22"

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
    disk_size    = "15G"
    format       = "qcow2"
    storage_pool = var.proxmox_storage_pool
    type         = "scsi"
    discard      = true
    io_thread    = true
  }

  network_adapters {
    bridge      = var.proxmox_bridge
    model       = "virtio"
    mac_address = "02:50:4B:52:57:00"
  }

  boot_iso {
    type             = "ide"
    iso_url          = "https://software-download.microsoft.com/download/sg/20348.169.210806-2348.fe_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso"
    iso_checksum     = "none"
    iso_storage_pool = var.proxmox_iso_storage_pool
    iso_target_path  = "/var/lib/vz/template/iso/packer-windows-server-2022-eval.iso"
    unmount          = true
  }

  # VirtIO drivers ISO (provides virtio-win-guest-tools.exe for TemplatePrep.ps1)
  additional_iso_files {
    type             = "sata"
    iso_url          = "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.248-1/virtio-win.iso"
    iso_checksum     = "none"
    iso_storage_pool = var.proxmox_iso_storage_pool
    iso_target_path  = "/var/lib/vz/template/iso/packer-virtio-win-0.1.248.iso"
    unmount          = true
  }

  # Packer creates an ISO from these local files and attaches it as a CD-ROM.
  # inject-placeholders.sh replaces __PACKER_ADMIN_PASSWORD__ in autounattend.xml before the build.
  additional_iso_files {
    type             = "ide"
    iso_storage_pool = var.proxmox_iso_storage_pool
    cd_files = [
      "${path.root}/windows-server-2022/autounattend.xml",
      "${path.root}/windows-server-2022/scripts/TemplatePrep.ps1",
      "${path.root}/_shared/CloudbaseInitSetup_x64.msi",
    ]
    cd_label = "ANSWERFILES"
    unmount  = true
  }

  boot_wait    = "3s"
  boot_command = ["<enter><wait><enter><wait><enter><wait><enter><wait><enter><wait><enter>"]

  communicator   = "winrm"
  winrm_host     = "10.0.0.100"
  winrm_username = "Administrator"
  winrm_password = var.winrm_password
  winrm_use_ssl  = false
  winrm_insecure = true
  winrm_timeout  = "4h"
  winrm_port     = 5985
}

build {
  sources = ["source.proxmox-iso.windows-server-2022"]

  # TemplatePrep.ps1 installs VirtIO tools, Cloudbase-Init, runs Windows Update,
  # and finally syspreps + shuts down. Packer detects WinRM drop on shutdown.
  provisioner "powershell" {
    script           = "${path.root}/windows-server-2022/scripts/TemplatePrep.ps1"
    valid_exit_codes = [0]
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
