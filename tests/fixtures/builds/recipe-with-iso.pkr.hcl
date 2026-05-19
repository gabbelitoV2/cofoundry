# display: Recipe With ISO
# build_vmid: 9101

variable "iso_cache_dir" {
  type    = string
  default = "/var/lib/cofoundry/iso-cache"
}

source "proxmox-iso" "withiso" {
  boot_iso {
    iso_url          = "https://example.com/foo-1.2.3-amd64.iso"
    iso_checksum     = "sha256:deadbeef"
    iso_target_path  = "${var.iso_cache_dir}/foo-1.2.3-amd64.iso"
    unmount          = true
  }

  additional_iso_files {
    iso_url         = "https://example.com/virtio-win.iso"
    iso_target_path = "${var.iso_cache_dir}/virtio-win.iso"
  }
}
