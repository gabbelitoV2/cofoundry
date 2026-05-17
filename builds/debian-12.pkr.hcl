# display: Debian 12 (Bookworm)
# build_vmid: 9100

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

variable "build_ip" {
  type    = string
  default = ""
}

variable "build_gw" {
  type    = string
  default = ""
}

variable "build_dns" {
  type    = string
  default = "1.1.1.1"
}

variable "packer_ssh_private_key_file" {
  type      = string
  sensitive = true
}

locals {
  build_vmid     = 9100
  recipe_name    = "debian-12"
  recipe_display = "Debian 12 (Bookworm)"
}

source "proxmox-iso" "debian-12" {
  proxmox_url              = var.proxmox_api_url
  username                 = var.proxmox_username
  token                    = var.proxmox_token
  node                     = var.proxmox_node
  insecure_skip_tls_verify = true

  vm_id                = local.build_vmid
  vm_name              = "packer-${local.recipe_name}"
  template_description = "Debian 12 Packer Template -- ${formatdate("YYYY-MM-DD", timestamp())}"

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
    disk_size    = "5G"
    format       = "qcow2"
    storage_pool = var.proxmox_storage_pool
    type         = "virtio"
  }

  network_adapters {
    bridge = var.proxmox_bridge
    model  = "virtio"
  }

  boot_iso {
    type             = "ide"
    iso_url          = "https://cdimage.debian.org/cdimage/archive/12.13.0/amd64/iso-cd/debian-12.13.0-amd64-netinst.iso"
    iso_checksum     = "sha256:2b880ffabe36dbe04a662a3125e5ecae4db69d0acce257dd74615bbf165ad76e"
    iso_storage_pool = var.proxmox_iso_storage_pool
    iso_target_path  = "${var.iso_cache_dir}/debian-12.13.0-amd64-netinst.iso"
    unmount          = true
  }

  http_directory = "${path.root}/debian-12/http"

  boot_wait = "10s"
  boot_command = [
    "<esc><wait>",
    "install auto=true priority=critical <wait>",
    "netcfg/disable_autoconfig=true <wait>",
    "netcfg/get_ipaddress=${var.build_ip} <wait>",
    "netcfg/get_netmask=255.255.255.0 <wait>",
    "netcfg/get_gateway=${var.build_gw} <wait>",
    "netcfg/get_nameservers=${var.build_dns} <wait>",
    "netcfg/confirm_static=true <wait>",
    " preseed/url=http://{{ .HTTPIP }}:{{ .HTTPPort }}/preseed.cfg <wait>",
    "debian-installer=en_US.UTF-8 <wait>",
    "locale=en_US.UTF-8 <wait>",
    "kbd-chooser/method=us <wait>",
    "keyboard-configuration/xkb-keymap=us <wait>",
    "fb=false <wait>",
    "debconf/frontend=noninteractive <wait>",
    "console-setup/ask_detect=false <wait>",
    "console-keymaps-at/keymap=us <wait>",
    "grub-installer/bootdev=/dev/vda <wait>",
    "<enter><wait>",
  ]

  communicator           = "ssh"
  ssh_username           = "packer"
  ssh_private_key_file   = var.packer_ssh_private_key_file
  ssh_handshake_attempts = 10
  ssh_pty                = true
  ssh_timeout            = "35m"
}

build {
  sources = ["source.proxmox-iso.debian-12"]

  provisioner "shell" {
    inline = [
      "if command -v cloud-init >/dev/null 2>&1; then sudo cloud-init status --wait || true; fi",
      "sudo rm -f /etc/ssh/ssh_host_*",
      "sudo truncate -s 0 /etc/machine-id",
      "sudo apt -y autoremove --purge",
      "sudo apt -y clean",
      "sudo apt -y autoclean",
      "sudo cloud-init clean",
      "sudo rm -f /etc/cloud/cloud.cfg.d/subiquity-disable-cloudinit-networking.cfg",
      "sudo sync",
    ]
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
