---
name: opencloud-upgrade-operations
description: Safely diagnose, plan, execute, validate, and roll back self-hosted OpenCloud upgrades, especially Docker/systemd deployments with PosixFS, OIDC, WebDAV app passwords, and GrapheneOS Seedvault clients. Covers official upgrade-path verification, secret-safe configuration migration, offline xattr/ACL-preserving critical-state backups, app-token failures, and controlled privileged handoff.
---

# OpenCloud Upgrade Operations

Use this skill when an OpenCloud deployment needs a version upgrade, an app-password/WebDAV failure appears version-related, or a client such as GrapheneOS Seedvault cannot authenticate.

## Setup

- Locate the canonical deployment repo, compose file, systemd unit, persistent config, metadata, IDM, NATS, and PosixFS user-data paths.
- Identify the running image/version and target release from live state, not memory.
- Check current official OpenCloud release notes and every intermediate migration guide. A source session upgraded from 6.2 toward 7.2, but those versions are examples, not a universal path.
- Use ExaSearch/current official docs for named releases and known bugs.
- Never read or print `.env`, private keys, OIDC secrets, app passwords, service-account secrets, or backup passphrases. Inspect names, paths, permissions, and presence only.
- Service stop/start, root-owned backups, and systemd changes require explicit approval through `sudo_exec`.

## Workflow

### 1. Diagnose before upgrading

1. Confirm the user-facing failure and affected interface: browser/OIDC, WebDAV, app-token UI/API, sync client, or Seedvault.
2. Collect non-secret runtime state:

```bash
systemctl status opencloud.service --no-pager --lines=80
docker compose ps
docker compose logs --tail=200 opencloud
ss -ltn | grep -E ':(9200|9300|9980)\b'
```

3. Probe public and local endpoints without credentials where possible. Separate reverse-proxy/SSO failures from OpenCloud backend failures.
4. Search official issues/releases for exact status codes and log signatures. In the source session, app-token metadata returned HTTP 425 and the app-token endpoint returned 500; an upstream fix made an upgrade preferable to bypassing authentication.
5. Do not promise that Seedvault supports a backend until current GrapheneOS documentation and the chosen transport are verified. For OpenCloud, WebDAV normally uses an OpenCloud app password rather than an OIDC browser login.

### 2. Build an explicit upgrade and rollback plan

Write a project-local plan containing:

- current and target versions/image digests;
- required intermediate versions and schema/config migrations;
- expected downtime;
- persistent-state inventory;
- backup destination and free-space check;
- stop/start commands;
- validation gates;
- exact rollback triggers and commands;
- deferred items and user decisions.

Treat config and data as distinct layers:

- deployment repo and working-tree diff;
- runtime configuration;
- metadata and extended attributes;
- IDM/NATS state;
- PosixFS user files;
- reverse-proxy and systemd integration.

If a full multi-terabyte duplicate is impractical, ask the user to choose between a complete backup and a bounded critical-state backup. Never silently omit user data.

### 3. Preflight while the old version is healthy

```bash
docker compose config --quiet
docker compose ps
systemctl is-active opencloud.service
df -h <data-mount> <backup-mount>
git -C <deployment-repo> status --short --branch
```

- Confirm the old stack is healthy enough to establish a baseline.
- Record container versions, health, listeners, and endpoint behavior.
- Pull the target image before downtime when safe.
- Save a binary-capable working-tree patch without exposing secret files:

```bash
git -C <repo> diff --binary -- opencloud > <repo>/pre-upgrade-working-tree.patch
sha256sum <repo>/pre-upgrade-working-tree.patch
```

### 4. Stop cleanly and prove quiescence

After explicit approval:

```bash
sudo systemctl disable --now opencloud.service
systemctl is-active opencloud.service
docker compose ps -a
ss -ltn | grep -E ':(9200|9300|9980)\b' || true
```

Do not copy mutable metadata while containers are still writing. Record whether the unit was previously enabled so rollback can restore the original state.

### 5. Back up critical state with metadata semantics preserved

For trees containing many small files/xattrs, prefer a tar archive over recursive `cp`:

```bash
sudo tar --xattrs --acls --numeric-owner -cpf <backup>/runtime-critical.tar \
  -C <runtime-data-root> storage/metadata idm nats nats-cli
```

Also preserve:

- deployment directory/configuration;
- compose and systemd definitions;
- working-tree patch;
- checksums and a manifest;
- user-data tree if the agreed backup scope includes it.

Validate archives before migration:

```bash
tar -tf <backup>/runtime-critical.tar >/dev/null
sha256sum <backup>/runtime-critical.tar > <backup>/SHA256SUMS
```

`tar --compare` may need root and can be slow. Approval timeouts are not command failures; report the paused state and ask again rather than changing scope.

### 6. Apply the documented version migration

- Edit only non-secret repo/config surfaces with minimal changes.
- Add new secret *variable names* or references, but let the user or existing secret broker supply values opaquely.
- Preserve ownership and permissions.
- Check release-specific requirements such as sharing service accounts, generated configuration changes, or renamed environment variables.
- Never copy sample secrets into production.

If using `opencloud init --diff`, isolate output from the mounted config directory and bound it:

```bash
timeout 60s docker run --rm --entrypoint /bin/sh \
  -v <config>:/etc/opencloud:ro <target-image> \
  -c 'opencloud init --diff' > /tmp/opencloud-init-diff.log 2>&1
```

Do not redirect generated output into a file inside a directory that the command recursively scans. The source session created multi-gigabyte runaway output through feedback. Monitor file size/process state, stop the container on abnormal growth, and move accidental artifacts to trash rather than permanently deleting them.

### 7. Start and validate in layers

After configuration validation and approval:

1. Start the stack/unit.
2. Check containers, health, listeners, and focused logs.
3. Test local backend reachability.
4. Test public TLS/reverse-proxy routing.
5. Test browser/OIDC login manually when credentials are required.
6. Generate a fresh app password manually; never ask for or display it in chat.
7. Test WebDAV with a user-controlled client or opaque credential handoff.
8. Configure Seedvault only after WebDAV/app-password validation succeeds.
9. Verify representative existing files and metadata, not merely HTTP 200.
10. Re-enable the systemd unit only after success criteria pass.

Do not treat a container `Up` state as proof that authentication, storage, or WebDAV works.

## Rollback

Rollback immediately when required migrations cannot be completed, metadata fails to load, authentication regresses, or validation reveals data inconsistency.

1. Stop the target version cleanly.
2. Restore the old deployment/config and critical-state archive with xattrs, ACLs, and numeric ownership.
3. Restore the old image/version pin.
4. Start the old stack.
5. Re-run the baseline health, browser, storage, and WebDAV checks.
6. Restore the systemd enabled/disabled state.
7. Preserve failed-upgrade logs and artifacts for diagnosis; do not erase evidence.

Never restore over a live stack.

## Reporting Checklist

Report:

- old/target versions and authoritative migration sources checked;
- agreed backup scope, path, checksums, and validation result;
- service state and downtime status;
- configuration migrations made without secret values;
- browser/OIDC, storage, app-password, WebDAV, and Seedvault results;
- rollback readiness and any remaining blocker;
- whether privileged approval is still pending.

## Source-Session Techniques

- A GrapheneOS backup request correctly became an OpenCloud app-token diagnosis before client configuration.
- An exact upstream app-token metadata bug justified a planned upgrade rather than an insecure Authentik/WebDAV bypass.
- The deployment was stopped cleanly and critical state was backed up to a separate drive with xattr/ACL preservation.
- Long privileged operations required repeatable approval handoff and explicit paused-state reporting.
- Redirecting `opencloud init --diff` output into a scanned/mounted config surface caused runaway multi-gigabyte output; future runs must isolate and bound output.
