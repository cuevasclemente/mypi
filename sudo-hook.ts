/**
 * Sudo Password Hook Extension
 *
 * Intercepts sudo commands from both the agent's bash tool and user !commands.
 * Prompts for the sudo password once per session and caches it in memory only.
 * The password is piped via stdin (echo ... | sudo -S) so it never leaves the
 * local process — it's not written to disk, environment variables, or sent over
 * any network.
 *
 * Usage:
 *   pi -e .pi/extensions/sudo-hook.ts
 *
 * Or place in ~/.pi/agent/extensions/sudo-hook.ts for global use.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key } from "@earendil-works/pi-tui";

/** Escape single quotes in a string for use in a single-quoted shell string. */
function shellEscape(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

/** Pipe the password into sudo via stdin using printf for safety. */
const SUDO_PIPELINE = (password: string, command: string) =>
  `printf '%s\\n' '${shellEscape(password)}' | sudo -S ${command}`;

export default function (pi: ExtensionAPI) {
  // Cached password — lives only in this closure's memory, never persisted
  let sudoPassword: string | null = null;

  /**
   * Prompt the user for their sudo password via a custom overlay component
   * that masks input. Returns the password or null if cancelled.
   */
  async function promptForPassword(ctx: ExtensionContext): Promise<string | null> {
    if (!ctx.hasUI) return null;

    // Use a custom overlay component to get masked input
    const result = await ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        let buffer = "";

        // Compute the display string (masked with • characters)
        const displayText = () => {
          const masked = "•".repeat(buffer.length);
          const prompt = theme.bold("Sudo password required");
          const hint = theme.fg("dim", "(Enter to confirm, Escape to cancel)");
          return `${prompt}\n\n${masked}${theme.fg("accent", "▌")}\n\n${hint}`;
        };

        const component = {
          render(_width: number) {
            return displayText().split("\n");
          },
          invalidate() {
            // No cached state to clear
          },
          handleInput(data: string): void {
            if (matchesKey(data, Key.enter)) {
              done(buffer || null);
              return;
            }
            if (matchesKey(data, Key.escape)) {
              done(null);
              return;
            }
            if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
              if (buffer.length > 0) {
                buffer = buffer.slice(0, -1);
              }
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.ctrl("c"))) {
              done(null);
              return;
            }
            // Only accept printable characters (single UTF-8 characters)
            if (typeof data === "string" && data.length === 1) {
              const code = data.charCodeAt(0);
              // Accept printable ASCII (32-126) and any non-control Unicode
              if (code >= 32 && code !== 127) {
                buffer += data;
                tui.requestRender();
              }
            }
          },
        };
        return component;
      },
      { overlay: true },
    );

    return result ?? null;
  }

  /**
   * Check if a command contains sudo and, if so, inject the password.
   * Returns the (possibly modified) command.
   */
  async function handleSudoCommand(
    command: string,
    ctx: ExtensionContext,
  ): Promise<{ command: string; blocked: boolean; reason?: string }> {
    // Quick check — only proceed if the command uses sudo
    if (!/\bsudo\b/.test(command)) {
      return { command, blocked: false };
    }

    if (!ctx.hasUI) {
      return {
        command,
        blocked: true,
        reason: "sudo requires interactive authentication (no UI available)",
      };
    }

    // Prompt for password if not yet cached
    if (!sudoPassword) {
      const pw = await promptForPassword(ctx);
      if (!pw || pw.length === 0) {
        return {
          command,
          blocked: true,
          reason: "sudo command blocked: no password provided",
        };
      }
      sudoPassword = pw;
    }

    // Pipe the password into sudo via stdin
    return {
      command: SUDO_PIPELINE(sudoPassword, command),
      blocked: false,
    };
  }

  // ── Agent bash tool interception ────────────────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const result = await handleSudoCommand(event.input.command as string, ctx);

    if (result.blocked) {
      return { block: true, reason: result.reason };
    }

    // Mutate the command to include the password pipeline
    if (result.command !== event.input.command) {
      event.input.command = result.command;
    }

    return undefined;
  });

  // ── User !command interception ──────────────────────────────────────────
  pi.on("user_bash", async (event, ctx) => {
    const result = await handleSudoCommand(event.command, ctx);

    if (result.blocked) {
      ctx.ui.notify(result.reason ?? "sudo blocked", "error");
      return {
        result: {
          output: result.reason ?? "sudo blocked",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }

    if (result.command !== event.command) {
      // For user_bash, we need to return operations that run our modified command.
      // pi's local bash backend won't see our command change via the event alone.
      // We provide a wrapped operations object that prepends the sudo pipeline.
      const local = createLocalBashOperations();

      return {
        operations: {
          exec(cmd, cwd, options) {
            // Replace the command with the sudo-piped version
            const sudoCmd = SUDO_PIPELINE(sudoPassword!, cmd);
            return local.exec(sudoCmd, cwd, options);
          },
        },
      };
    }

    return undefined;
  });

  // ── Commands ────────────────────────────────────────────────────────────
  pi.registerCommand("sudo-clear", {
    description: "Forget the cached sudo password",
    handler: async (_args, ctx) => {
      if (sudoPassword) {
        sudoPassword = null;
        ctx.ui.notify("Sudo password cleared from memory", "info");
      } else {
        ctx.ui.notify("No sudo password cached", "info");
      }
    },
  });

  pi.registerCommand("sudo-reset", {
    description: "Reset and re-prompt for sudo password on next use",
    handler: async (_args, ctx) => {
      sudoPassword = null;
      ctx.ui.notify("Sudo password cleared. Will re-prompt on next sudo use.", "info");
    },
  });

  // ── Session shutdown — clear password from memory ─────────────────────
  pi.on("session_shutdown", async () => {
    sudoPassword = null;
  });
}
