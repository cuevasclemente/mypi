---
name: server-expansion-drive-recovery
description: Recover The-Sceptre server after an expansion hard drive disconnect/reconnect, restoring Drive1+Drive2 ext4 mounts and the mergerfs /mnt/expansion pool safely.
---

# Server Expansion Drive Recovery

Use this when one of the two large expansion hard drives was unplugged, power-cycled, or reattached and the server needs to incorporate both drives again.

## Topology
- Host: `The-Sceptre`.
- Physical expansion drives:
  - `Drive1`: ext4 UUID `f4a0b66a-cb13-4527-bd9b-9c75e26832bb`, mounted at `/mnt/drive1` by `mnt-drive1.mount`.
  - `Drive2`: ext4 UUID `caa59364-c3c3-4fe8-9d79-b9835e5e4588`, mounted at `/mnt/drive2` by `mnt-drive2.mount`.
- Pool: mergerfs at `/mnt/expansion`, systemd unit `mnt-expansion.mount`, with branches `/mnt/drive1:/mnt/drive2`.
- Common containers with bind mounts into `/mnt/expansion`: `nextcloud-aio-nextcloud`, `openwebui`, `opencloud`.

## Safety rules
- Do **not** format, repartition, `fsck -y`, or delete anything as part of normal reconnect recovery.
- Prefer UUIDs over `/dev/sdX`; device letters change after reconnects.
- If a filesystem will not mount cleanly, stop and ask before attempting repair.
- Expect short downtime for apps using `/mnt/expansion` while the pool is remounted.

## Diagnose
1. Confirm physical disks and mount state:
   ```bash
   lsblk -e7 -o NAME,PATH,TYPE,SIZE,FSTYPE,LABEL,UUID,MOUNTPOINTS,MODEL,SERIAL,STATE
   findmnt /mnt/drive1 -o TARGET,SOURCE,FSTYPE,OPTIONS,UUID,LABEL || true
   findmnt /mnt/drive2 -o TARGET,SOURCE,FSTYPE,OPTIONS,UUID,LABEL || true
   findmnt /mnt/expansion -o TARGET,SOURCE,FSTYPE,OPTIONS || true
   systemctl status mnt-drive1.mount mnt-drive2.mount mnt-expansion.mount --no-pager -l
   ```
2. Look for the stale-disconnect pattern:
   - `lsblk` shows the disconnected drive's UUID present again, e.g. `Drive2` as `/dev/sdb2`.
   - `findmnt /mnt/drive2` still points at an old missing device such as `/dev/sda2`.
   - Options may include `shutdown`, and `ls /mnt/drive2` may return `Input/output error`.
   - `/mnt/expansion` is mounted but one branch is stale.
3. Identify containers that should be restarted after remount:
   ```bash
   docker inspect $(docker ps -q) \
     --format '{{.Name}} {{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}' \
     | grep '/mnt/expansion' || true
   ```

## Recovery procedure
Run these commands after confirming the real drive UUID is visible in `lsblk`.

```bash
# Stop mergerfs first so the stale branch is no longer busy.
sudo -n systemctl stop mnt-expansion.mount

# Stop the stale drive mount. If systemd cannot unmount it, use lazy unmount only for the stale mountpoint.
sudo -n systemctl stop mnt-drive2.mount || sudo -n umount -l /mnt/drive2

# Mount the drive again through the UUID-backed systemd unit.
sudo -n systemctl start mnt-drive2.mount

# Recreate the mergerfs pool with both branches.
sudo -n systemctl start mnt-expansion.mount
```

If `Drive1` was the disconnected drive, substitute `mnt-drive1.mount` and `/mnt/drive1` in the same pattern.

## Restart app processes with old bind mounts
Containers with bind mounts into a FUSE mount can retain stale mount references. Restart the affected containers after `/mnt/expansion` is back:

```bash
docker restart nextcloud-aio-nextcloud openwebui opencloud
```

Wait for health checks to settle:

```bash
for c in nextcloud-aio-nextcloud openwebui opencloud; do
  docker inspect --format '{{.Name}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c"
done
```

Nextcloud may take several minutes and can briefly show `unhealthy` while app updates or maintenance tasks finish.

## Validation
```bash
findmnt /mnt/drive1 -o TARGET,SOURCE,FSTYPE,OPTIONS,UUID,LABEL
findmnt /mnt/drive2 -o TARGET,SOURCE,FSTYPE,OPTIONS,UUID,LABEL
findmnt /mnt/expansion -o TARGET,SOURCE,FSTYPE,OPTIONS

df -hT /mnt/drive1 /mnt/drive2 /mnt/expansion
ls /mnt/drive1 >/dev/null && echo drive1-list-ok
ls /mnt/drive2 >/dev/null && echo drive2-list-ok
ls /mnt/expansion >/dev/null && echo expansion-list-ok

systemctl is-active mnt-drive1.mount mnt-drive2.mount mnt-expansion.mount docker.service
```

Expected good state:
- `Drive1` mounted from UUID `f4a0b66a-cb13-4527-bd9b-9c75e26832bb` at `/mnt/drive1`.
- `Drive2` mounted from UUID `caa59364-c3c3-4fe8-9d79-b9835e5e4588` at `/mnt/drive2`.
- `/mnt/expansion` reports combined capacity from both drives.
- Expansion-bound containers return `healthy` or their normal expected status.

## Notes from 2026-05-13 incident
- `Drive2` came back as `/dev/sdb2`, but `/mnt/drive2` remained mounted on stale `/dev/sda2` with ext4 option `shutdown`.
- Restarting `mnt-expansion.mount`, remounting `mnt-drive2.mount`, then restarting `nextcloud-aio-nextcloud`, `openwebui`, and `opencloud` restored the pool.
