---
name: linux-live-usb-chroot-recovery
description: Recover and repair Arch/CachyOS-like Linux installs from a live USB using chroot or cachy-chroot, including safe root/Btrfs/LUKS mounting, chroot DNS/resolv.conf repair, read-only or immutable filesystem diagnosis, package/network validation, and non-destructive config backup practices.
---

# Linux Live USB Chroot Recovery

Use this skill when a user is booted into a Linux live USB and needs to repair an installed Linux system from a chroot, especially Arch/CachyOS systems where package updates, networking, or `/etc/resolv.conf` fail inside the target root.

## Setup

- A live USB with root privileges.
- The installed system disk visible to the live environment.
- For Arch-like systems: `arch-install-scripts` / `arch-chroot`.
- For CachyOS: `cachy-chroot` is preferred when available.
- Optional tools depending on layout: `btrfs-progs`, `cryptsetup`, `lsattr`/`chattr`, `findmnt`.

Never read or print secret files while repairing. When changing system configuration, prefer backing up or moving files over permanent deletion.

## Fast triage

1. Confirm the live USB has working network:

   ```bash
   ping -c 3 1.1.1.1
   ping -c 3 archlinux.org
   ```

   - IP works, domain fails: DNS is broken in the live USB too.
   - Both work: proceed to chroot repair.

2. Identify target partitions:

   ```bash
   lsblk -f
   findmnt -R /mnt
   ```

3. If the target is encrypted, unlock it first with the user present for passphrases:

   ```bash
   sudo cryptsetup open /dev/YOUR_LUKS_PARTITION cryptroot
   ```

## CachyOS preferred workflow

For CachyOS installed systems, use `cachy-chroot` from the live CachyOS environment:

```bash
sudo su
pacman -Sy cachy-chroot
cachy-chroot
```

What `cachy-chroot` does well:

- lists discovered partitions;
- supports Btrfs subvolume selection and the CachyOS Btrfs preset;
- mounts additional partitions from the installed system's `/etc/fstab`;
- supports LUKS mapping and cleanup;
- runs `arch-chroot` and cleans up mounts after exit.

When using CachyOS with the standard Btrfs layout, answer **yes** to the CachyOS Btrfs preset prompt. If the live ISO has a newer/different version, verify options with:

```bash
cachy-chroot --help
```

In the source session, current `cachy-chroot` source exposed options such as `--skip-root-check`, `--show-btrfs-dot-snapshots`, `--no-auto-mount`, and `--no-systemd-chroot`; no official `--network` option was verified in the current source, so do not assume one exists without checking `--help`.

## Manual Arch-style chroot workflow

If not using `cachy-chroot`, mount the installed root at `/mnt` and bind runtime filesystems:

```bash
sudo mount -o remount,rw /mnt
sudo mount --rbind /dev /mnt/dev
sudo mount --make-rslave /mnt/dev
sudo mount -t proc /proc /mnt/proc
sudo mount --rbind /sys /mnt/sys
sudo mount --make-rslave /mnt/sys
sudo mount --rbind /run /mnt/run
sudo mount --make-rslave /mnt/run
sudo arch-chroot /mnt
```

The `/run` bind is important because `/etc/resolv.conf` often points into `/run/systemd/resolve/...` or another runtime resolver path.

## Fix DNS inside the chroot

Inside the chroot, test IP vs hostname:

```bash
ping -c 3 1.1.1.1
ping -c 3 cachyos.org
ls -l /etc/resolv.conf
readlink -f /etc/resolv.conf
```

If IP ping works but hostname ping fails, DNS is the likely issue.

### If `/etc/resolv.conf` points into `/run`

Example:

```text
/etc/resolv.conf -> ../run/systemd/resolve/stub-resolv.conf
```

Then bind-mounting `/run` from the live system into the target may be sufficient. Exit and remount if needed:

```bash
exit
sudo mount --rbind /run /mnt/run
sudo mount --make-rslave /mnt/run
sudo arch-chroot /mnt
```

### Temporary static DNS repair

If the resolver symlink is broken or package work must proceed immediately, make a recoverable backup and write a static resolver file:

```bash
mount -o remount,rw /
mv /etc/resolv.conf /etc/resolv.conf.bak.$(date +%s)
printf 'nameserver 1.1.1.1\nnameserver 9.9.9.9\n' > /etc/resolv.conf
ping -c 3 cachyos.org
```

If `/etc/resolv.conf` is a broken symlink and `mv` is inappropriate, `unlink /etc/resolv.conf` can remove the symlink itself; explain that it removes only the link, not the target. Avoid broad `rm` commands.

## If `/etc/resolv.conf` cannot be edited, chmodded, moved, or unlinked

Diagnose before forcing changes.

### Read-only target mount

```bash
findmnt -no SOURCE,TARGET,FSTYPE,OPTIONS /
findmnt -no SOURCE,TARGET,FSTYPE,OPTIONS /mnt
```

If the relevant mount is `ro`:

```bash
mount -o remount,rw /
# or from the live environment:
sudo mount -o remount,rw /mnt
```

### Immutable file or directory

```bash
lsattr -d /etc /etc/resolv.conf
# or outside chroot:
sudo lsattr -d /mnt/etc /mnt/etc/resolv.conf
```

If an `i` flag appears:

```bash
chattr -i /etc/resolv.conf
chattr -i /etc
```

Then retry the backup-and-replace step.

### Wrong Btrfs subvolume mounted

CachyOS commonly uses Btrfs. If the top-level volume or wrong subvolume is mounted, repairs may appear strange or ineffective.

```bash
findmnt -R /mnt
sudo btrfs subvolume list /mnt
```

For a standard Arch/CachyOS-style layout, remount the root subvolume explicitly, adjusting device names:

```bash
sudo umount -R /mnt
sudo mount -o subvol=@,rw /dev/YOUR_ROOT_PARTITION /mnt
```

Then redo `/dev`, `/proc`, `/sys`, and `/run` mounts or use `cachy-chroot`.

## Post-repair validation

Inside chroot:

```bash
ping -c 3 1.1.1.1
ping -c 3 cachyos.org
pacman -Syu
```

After package/network work, restore the desired permanent resolver setup, for example with `systemd-resolved` or NetworkManager as appropriate for the installed system. Do not leave a temporary resolver file undocumented if the system expects a symlink managed by another service.

## Pitfalls

- DNS failures in chroot are often broken `/etc/resolv.conf` symlinks, not network interface failures.
- Bind-mounting `/run` can be the difference between a valid and broken resolver symlink.
- `chmod` cannot fix read-only mounts or immutable attributes.
- On Btrfs, mounting the wrong subvolume can make edits target the wrong filesystem view.
- Avoid destructive deletion in recovery sessions; use timestamped backups or symlink `unlink` only when the target is understood.

## Source-session techniques

- The source session involved CachyOS installed system plus CachyOS live USB.
- The user could not edit, chmod, or remove `/etc/resolv.conf`; the workflow separated read-only mount, immutable flag, broken symlink, and wrong-subvolume causes.
- The session verified `cachy-chroot` documentation/source before describing capabilities and warned not to assume unsupported flags.
