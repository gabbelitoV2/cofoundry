# display: Windows Server 2022 Datacenter
# group: windows-server
# build_vmid: 2001
# iso_url: https://software-download.microsoft.com/download/sg/20348.169.210806-2348.fe_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso
# iso_target_path: /var/lib/vz/template/iso/packer-windows-server-2022-eval.iso

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

variable "build_vmid" {
  type    = number
  default = 2001
}

locals {
  build_vmid     = var.build_vmid
  recipe_name    = "windows-server-2022"
  recipe_display = "Windows Server 2022 Datacenter"

  ps_execute = "powershell -executionpolicy bypass \"& { $ErrorActionPreference='Stop'; $_p='{{.Path}}'; $_dl=[DateTime]::Now.AddSeconds(120); while (-not (Test-Path $_p) -and [DateTime]::Now -lt $_dl) { Start-Sleep 2 }; . {{.Vars}}; & $_p; exit $LastExitCode }\""
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
  os      = "win11"

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

  cloud_init              = true
  cloud_init_storage_pool = var.proxmox_storage_pool

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
    mac_address = var.build_mac
  }

  boot_iso {
    type         = "ide"
    iso_file     = "${var.proxmox_iso_storage_pool}:iso/packer-windows-server-2022-eval.iso"
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
      "${path.root}/windows-server-2022/autounattend.xml",
      "${path.root}/_shared/CloudbaseInitSetup_x64.msi",
    ]
    cd_label = "ANSWERFILES"
    unmount  = true
  }

  # The OVMF "Press any key to boot from CD or DVD" prompt is a short (~5s)
  # window whose start drifts with POST speed — on a busy node it can land well
  # after a short keypress burst, leaving the VM at "no bootable device" until
  # winrm_timeout (45m) expires. Blanket ~60s with a press every 2s so a slow
  # POST can't fall outside the window; stray <enter>s during WinPE load are
  # harmless (autounattend drives Setup non-interactively).
  boot_wait    = "2s"
  boot_command = ["<enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2>"]

  communicator   = "winrm"
  winrm_host     = var.build_ip
  winrm_username = "Administrator"
  winrm_password = var.winrm_password
  winrm_use_ssl  = false
  winrm_insecure = true
  # A healthy install reaches WinRM in ~15 min. Keep this tight so a failed
  # install (setup error dialog leaves the VM "running" with WinRM never coming
  # up) fails the attempt in ~45 min instead of hanging the full timeout —
  # cf retries the build (CF_BUILD_ATTEMPTS) to ride out intermittent flakes.
  winrm_timeout  = "45m"
  winrm_port     = 5985
}

build {
  sources = ["source.proxmox-iso.windows-server-2022"]

  provisioner "powershell" {
    execute_command = local.ps_execute
    script          = "${path.root}/_shared/windows/Install.ps1"
  }

  provisioner "windows-restart" {
    restart_timeout = "30m"
  }

  provisioner "powershell" {
    pause_before    = "30s"
    execute_command = local.ps_execute
    script          = "${path.root}/_shared/windows/WU.ps1"
  }
  provisioner "windows-restart" {
    restart_timeout = "90m"
    restart_command = "powershell -Command \"if (Test-Path 'C:/Windows/Temp/tb-wu-reboot.flag') { Remove-Item 'C:/Windows/Temp/tb-wu-reboot.flag' -Force; shutdown /r /f /t 5 /c 'packer wu reboot' } else { exit 0 }\""
  }

  provisioner "powershell" {
    pause_before    = "30s"
    execute_command = local.ps_execute
    script          = "${path.root}/_shared/windows/WU.ps1"
  }
  provisioner "windows-restart" {
    restart_timeout = "90m"
    restart_command = "powershell -Command \"if (Test-Path 'C:/Windows/Temp/tb-wu-reboot.flag') { Remove-Item 'C:/Windows/Temp/tb-wu-reboot.flag' -Force; shutdown /r /f /t 5 /c 'packer wu reboot' } else { exit 0 }\""
  }

  provisioner "powershell" {
    pause_before    = "30s"
    execute_command = local.ps_execute
    script          = "${path.root}/_shared/windows/PreFinalize.ps1"
  }
  provisioner "windows-restart" {
    restart_timeout = "15m"
  }

  provisioner "powershell" {
    pause_before    = "30s"
    execute_command = local.ps_execute
    script          = "${path.root}/_shared/windows/Finalize.ps1"
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
