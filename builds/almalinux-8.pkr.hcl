# display: AlmaLinux 8
# build_vmid: 9109

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
  default = "vmbr0"
}

variable "iso_cache_dir" {
  type    = string
  default = "/var/lib/cofoundry/iso-cache"
}

variable "packer_ssh_private_key_file" {
  type      = string
  sensitive = true
}

locals {
  build_vmid     = 9109
  recipe_name    = "almalinux-8"
  recipe_display = "AlmaLinux 8"
}

source "proxmox-iso" "almalinux-8" {
  proxmox_url              = var.proxmox_api_url
  username                 = var.proxmox_username
  token                    = var.proxmox_token
  node                     = var.proxmox_node
  insecure_skip_tls_verify = true

  vm_id                = local.build_vmid
  vm_name              = "packer-${local.recipe_name}"
  template_description = "${local.recipe_display} Packer Template -- ${formatdate("YYYY-MM-DD", timestamp())}"

  bios    = "seabios"
  machine = "q35"
  os      = "l26"

  cpu_type = "host"
  cores    = 2
  sockets  = 1
  memory   = 2048

  qemu_agent              = true
  cloud_init              = true
  cloud_init_storage_pool = var.proxmox_storage_pool
  scsi_controller         = "virtio-scsi-pci"

  disks {
    disk_size    = "10G"
    format       = "qcow2"
    storage_pool = var.proxmox_storage_pool
    type         = "virtio"
    disk_image   = true
    io_thread    = true
  }

  boot_iso {
    type             = "ide"
    iso_url          = "https://repo.almalinux.org/almalinux/8/cloud/x86_64/images/AlmaLinux-8-GenericCloud-latest.x86_64.qcow2"
    iso_checksum     = "file:https://repo.almalinux.org/almalinux/8/cloud/x86_64/images/CHECKSUM"
    iso_storage_pool = var.proxmox_iso_storage_pool
    iso_target_path  = "${var.iso_cache_dir}/AlmaLinux-8-GenericCloud-latest.x86_64.qcow2"
    unmount          = true
  }

  additional_iso_files {
    device   = "ide2"
    unmount  = true
    cd_files = [
      "${path.root}/${local.recipe_name}/cloud-init/meta-data",
      "${path.root}/${local.recipe_name}/cloud-init/user-data",
    ]
    cd_label = "cidata"
  }

  network_adapters {
    bridge = var.proxmox_bridge
    model  = "virtio"
  }

  boot_wait    = "5s"
  boot_command = []

  communicator           = "ssh"
  ssh_username           = "almalinux"
  ssh_private_key_file   = var.packer_ssh_private_key_file
  ssh_handshake_attempts = 10
  ssh_pty                = true
  ssh_timeout            = "15m"
}

build {
  sources = ["source.proxmox-iso.almalinux-8"]

  provisioner "shell" {
    inline = [
      "sudo cloud-init status --wait || true",
      "sudo dnf -y clean all",
    ]
  }

  provisioner "file" {
    source      = "${path.root}/_shared/cloud-init-cleanup.sh"
    destination = "/tmp/cloud-init-cleanup.sh"
  }

  provisioner "shell" {
    inline = ["sudo bash /tmp/cloud-init-cleanup.sh"]
  }

  provisioner "file" {
    source      = "${path.root}/_shared/cloud-init/99-pve.cfg"
    destination = "/tmp/99-pve.cfg"
  }

  provisioner "shell" {
    inline = ["sudo cp /tmp/99-pve.cfg /etc/cloud/cloud.cfg.d/99-pve.cfg"]
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
