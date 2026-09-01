---
name: persistent-ssh-agent-fish-systemd
description: >-
  Configure and troubleshoot Clemente's preferred persistent SSH-agent setup on Linux/fish/systemd: user-level socket-activated ssh-agent, AddKeysToAgent, SSH_AUTH_SOCK, and secret-safe diagnostics.
---

# Persistent SSH Agent for Fish + systemd

Use this skill when setting up or troubleshooting Clemente's preferred SSH-agent pattern on Linux hosts: one user-level, systemd socket-activated `ssh-agent` shared across fish shell sessions, with `AddKeysToAgent yes` for automatic key loading on first use.

## Safety boundaries

- Never read, print, copy, or modify private SSH key contents.
- Do not dump secret-bearing shell files. Inspect only targeted non-secret lines where needed.
- It is OK to inspect `~/.ssh/config` directives, public host aliases, fish config snippets, systemd unit metadata, and `ssh-add -l` fingerprints when useful.
- Avoid changing remote host configs until the target host and user account are confirmed.

## Target pattern

Fish config should export the socket path for every shell:

```fish
# SSH: point at the systemd-managed, socket-activated agent
# (enable once with: systemctl --user enable --now ssh-agent.socket)
# Keys load on first use thanks to `AddKeysToAgent yes` in ~/.ssh/config
set -gx SSH_AUTH_SOCK $XDG_RUNTIME_DIR/ssh-agent.socket
```

SSH config should include:

```sshconfig
Host *
    AddKeysToAgent yes
```

The user service should be enabled and active/socket-listening:

```sh
systemctl --user enable --now ssh-agent.socket
systemctl --user is-enabled ssh-agent.socket
systemctl --user is-active ssh-agent.socket
```

## Workflow

1. **Inventory local reference setup**
   - Locate fish config snippets that set `SSH_AUTH_SOCK`.
   - Confirm `~/.ssh/config` has `AddKeysToAgent yes` under an appropriate `Host *` or target host block.
   - Confirm `ssh-agent.socket` exists and is enabled/active for the user.

2. **Connect to the target host safely**
   - Confirm the SSH alias/hostname/IP and user.
   - If the alias times out, inspect local SSH config host entries and DNS/hosts metadata without reading keys.
   - Do not assume the remote host is reachable; report network blockers separately from configuration work.

3. **Inventory remote state**
   - Check remote shell and fish availability.
   - Check whether `~/.config/fish/config.fish` or `conf.d/*.fish` already sets `SSH_AUTH_SOCK`, `ssh-agent`, or `ssh-add`.
   - Check whether remote `~/.ssh/config` already has `AddKeysToAgent yes`.
   - Check `systemctl --user status/cat ssh-agent.socket ssh-agent.service` where available.

4. **Apply minimal changes**
   - Prefer a dedicated fish conf.d file, e.g. `~/.config/fish/conf.d/ssh-agent.fish`, rather than rewriting a large config.
   - Ensure `~/.ssh/config` exists with mode `600` and append or merge `AddKeysToAgent yes` carefully.
   - Enable/start the user socket with `systemctl --user enable --now ssh-agent.socket`.
   - If no systemd user manager exists, stop and ask whether to use an alternative agent manager.

5. **Validate**
   - Start a fresh fish shell and print only `SSH_AUTH_SOCK` path/existence, not secrets.
   - Confirm the socket path is `$XDG_RUNTIME_DIR/ssh-agent.socket` and that the socket exists.
   - Use `ssh-add -l` only to list fingerprints or confirm no identities; never show private key material.
   - Test one harmless SSH connection with `BatchMode=yes` if an appropriate host is known.

## Common pitfalls

- Starting a new `ssh-agent` in every shell instead of using the systemd socket.
- Setting `SSH_AUTH_SOCK` in bash/zsh but not fish.
- Forgetting `AddKeysToAgent yes`, which makes the socket exist but keys not persist after first manual use.
- Remote host alias/DNS timeout being mistaken for an agent setup failure.
- User services failing because linger/systemd user manager is unavailable on a headless host.
