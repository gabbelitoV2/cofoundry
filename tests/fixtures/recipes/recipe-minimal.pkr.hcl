# display: Minimal Recipe
# build_vmid: 9999

packer {
  required_plugins {
    proxmox = {
      version = "~> 1"
      source  = "github.com/hashicorp/proxmox"
    }
  }
}

source "proxmox-iso" "minimal" {
  vm_name = "minimal-template"
  cores   = 2
  memory  = 4096
}
