import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WIDGET_ID = "ssh-clipboard-images";
const KITTEN_TIMEOUT_MS = 10_000;
const SSH_CLIPBOARD_SHORTCUT = process.env.PI_SSH_CLIPBOARD_IMAGE_SHORTCUT || "ctrl+alt+v";

export const SSH_CLIPBOARD_IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 10 * 1024 * 1024,
  maxQueuedImages: 4,
  maxAggregateBytes: 20 * 1024 * 1024,
});

export interface SshClipboardImageLimits {
  maxImageBytes: number;
  maxQueuedImages: number;
  maxAggregateBytes: number;
}

export interface CapturedClipboardImage {
  bytes: Buffer;
  tempPath: string;
  tempDir: string;
}

interface PendingImage {
  content: ImageContent;
  byteLength: number;
  tempDir: string;
}

export interface KittenResult {
  error?: unknown;
  status: number | null;
}

export type RunKitten = (outputPath: string) => KittenResult;

type CaptureImage = (
  maxImageBytes: number,
  removeTempPath: (tempPath: string) => void,
) => CapturedClipboardImage | null;

export interface SshClipboardImagesDependencies {
  captureImage?: CaptureImage;
  isRemoteSession?: () => boolean;
  removeTempFile?: (tempPath: string) => void;
  runKitten?: RunKitten;
  shortcut?: string;
  limits?: Partial<SshClipboardImageLimits>;
}

function isRemoteSession(env = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function removeTempPath(tempPath: string): void {
  fs.rmSync(tempPath, { force: true, recursive: true });
}

function safelyRemoveTempPath(
  tempPath: string,
  remove: (tempPath: string) => void,
): void {
  try {
    remove(tempPath);
  } catch {
    // Cleanup must never break input handling or shutdown.
  }
}

function readBoundedFile(filePath: string, maxBytes: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) return null;

    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, bytes, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== size) return null;

    const extra = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, extra, 0, 1, offset) !== 0) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The caller still owns cleanup of the path.
      }
    }
  }
}

function runKitten(outputPath: string): KittenResult {
  // kitty's clipboard kitten speaks the OSC 5522 clipboard protocol, so this
  // reads the local terminal clipboard even when this code runs on an SSH host.
  return spawnSync("kitten", ["clipboard", "--get-clipboard", outputPath], {
    timeout: KITTEN_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function readLocalClipboardImageViaKitten(
  maxImageBytes: number,
  cleanup: (tempPath: string) => void,
  invokeKitten: RunKitten = runKitten,
): CapturedClipboardImage | null {
  let tempDir: string | undefined;
  let keepDirectory = false;
  try {
    // The private directory protects kitten's output from other local users even
    // while kitten is writing it. chmod is explicit rather than relying on umask.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-ssh-clipboard-${randomUUID()}-`));
    fs.chmodSync(tempDir, 0o700);
    if ((fs.statSync(tempDir).mode & 0o777) !== 0o700) return null;
    const tempPath = path.join(tempDir, "clipboard.png");

    // A .png output path asks kitty to copy any raster image and convert it to PNG.
    const result = invokeKitten(tempPath);
    if (result.error || result.status !== 0) return null;

    // Reassert both modes after the child returns; neither the child's output
    // mode nor changes made while it ran are trusted.
    fs.chmodSync(tempDir, 0o700);
    if ((fs.statSync(tempDir).mode & 0o777) !== 0o700) return null;

    // Kitten owns creation of the output, so do not trust its type or mode.
    // Failure is handled closed: an image we cannot make private is not attached.
    const outputStat = fs.lstatSync(tempPath);
    if (!outputStat.isFile() || outputStat.isSymbolicLink()) return null;
    fs.chmodSync(tempPath, 0o600);
    if ((fs.statSync(tempPath).mode & 0o777) !== 0o600) return null;
    const bytes = readBoundedFile(tempPath, maxImageBytes);
    if (!bytes) return null;

    keepDirectory = true;
    return { bytes, tempPath, tempDir };
  } catch {
    return null;
  } finally {
    if (tempDir && !keepDirectory) safelyRemoveTempPath(tempDir, cleanup);
  }
}

function normalizedLimits(overrides: Partial<SshClipboardImageLimits> = {}): SshClipboardImageLimits {
  const limits = { ...SSH_CLIPBOARD_IMAGE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid SSH clipboard image limit: ${name}`);
    }
  }
  return limits;
}

function safelyNotify(ctx: any, message: string, level: "success" | "warning"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // UI failures must not affect attachment or cleanup state.
  }
}

export function createSshClipboardImagesExtension(
  dependencies: SshClipboardImagesDependencies = {},
): (pi: ExtensionAPI) => void {
  const captureImage = dependencies.captureImage ?? ((maxImageBytes, cleanup) =>
    readLocalClipboardImageViaKitten(maxImageBytes, cleanup, dependencies.runKitten ?? runKitten));
  const remoteSession = dependencies.isRemoteSession ?? isRemoteSession;
  const cleanup = dependencies.removeTempFile ?? removeTempPath;
  const shortcut = dependencies.shortcut ?? SSH_CLIPBOARD_SHORTCUT;
  const limits = normalizedLimits(dependencies.limits);

  return function sshClipboardImages(pi: ExtensionAPI): void {
    // This state belongs to one loaded extension instance. Pi creates a fresh
    // instance when replacing sessions, so pending images cannot cross sessions.
    const pendingImages: PendingImage[] = [];
    let pendingBytes = 0;

    const clearWidget = (ctx: any): void => {
      try {
        ctx.ui.setWidget(WIDGET_ID, undefined);
      } catch {
        // UI cleanup is best effort; file cleanup is handled independently.
      }
    };

    const updateWidget = (ctx: any): void => {
      try {
        if (pendingImages.length === 0) {
          ctx.ui.setWidget(WIDGET_ID, undefined);
          return;
        }

        const noun = pendingImages.length === 1 ? "image" : "images";
        ctx.ui.setWidget(
          WIDGET_ID,
          [`📎 ${pendingImages.length} SSH clipboard ${noun} will attach to your next message`],
          { placement: "aboveEditor" },
        );
      } catch {
        // Queue ownership and cleanup cannot depend on the UI being available.
      }
    };

    const cleanupImages = (images: PendingImage[]): void => {
      for (const image of images) safelyRemoveTempPath(image.tempDir, cleanup);
    };

    const drainPendingImages = (): PendingImage[] => {
      const images = pendingImages.splice(0, pendingImages.length);
      pendingBytes = 0;
      return images;
    };

    const queueClipboardImage = (ctx: any): void => {
      let captured: CapturedClipboardImage | null;
      try {
        captured = captureImage(limits.maxImageBytes, (tempPath) =>
          safelyRemoveTempPath(tempPath, cleanup),
        );
      } catch {
        safelyNotify(ctx, "Unable to receive a clipboard image via kitty.", "warning");
        return;
      }

      if (!captured) {
        safelyNotify(
          ctx,
          "No clipboard image received via kitty. Use Kitty as your SSH terminal and ensure `kitten` is installed/available on this host.",
          "warning",
        );
        return;
      }

      const byteLength = captured.bytes.byteLength;
      if (byteLength === 0 || byteLength > limits.maxImageBytes) {
        safelyRemoveTempPath(captured.tempDir, cleanup);
        safelyNotify(ctx, "Clipboard image exceeds the per-image size limit.", "warning");
        return;
      }
      if (pendingImages.length >= limits.maxQueuedImages) {
        safelyRemoveTempPath(captured.tempDir, cleanup);
        safelyNotify(ctx, "SSH clipboard image queue is full.", "warning");
        return;
      }
      if (byteLength > limits.maxAggregateBytes - pendingBytes) {
        safelyRemoveTempPath(captured.tempDir, cleanup);
        safelyNotify(ctx, "SSH clipboard images exceed the aggregate size limit.", "warning");
        return;
      }

      try {
        pendingImages.push({
          tempDir: captured.tempDir,
          byteLength,
          content: {
            type: "image",
            mimeType: "image/png",
            data: captured.bytes.toString("base64"),
          },
        });
        pendingBytes += byteLength;
      } catch {
        safelyRemoveTempPath(captured.tempDir, cleanup);
        safelyNotify(ctx, "Unable to queue the clipboard image.", "warning");
        return;
      }

      updateWidget(ctx);
      safelyNotify(ctx, "Queued SSH clipboard image for your next message.", "success");
    };

    // Only add the SSH/Mosh helper shortcut for remote sessions. Ctrl+V is Pi's
    // built-in app.clipboard.pasteImage binding, so the default intentionally uses
    // a non-built-in shortcut. Hosts may override it with the existing env var.
    if (remoteSession()) {
      pi.registerShortcut(shortcut, {
        description: "Attach local SSH clipboard image via kitty",
        handler: async (ctx) => queueClipboardImage(ctx),
      });
    }

    pi.registerCommand("paste-image", {
      description: "Attach a local clipboard image to the next message via kitty/SSH",
      handler: async (_args, ctx) => queueClipboardImage(ctx),
    });

    pi.on("input", async (event, ctx) => {
      // Extension-generated input is internal plumbing, not the user's next
      // message. Preserve it exactly and retain the queue for user/RPC input.
      if (event.source === "extension" || pendingImages.length === 0) {
        return { action: "continue" as const };
      }

      const images = drainPendingImages();
      updateWidget(ctx);
      try {
        return {
          action: "transform" as const,
          text: event.text,
          images: [...(event.images ?? []), ...images.map((image) => image.content)],
        };
      } catch {
        safelyNotify(ctx, "Unable to attach the queued SSH clipboard image.", "warning");
        return { action: "continue" as const };
      } finally {
        // The attachment is already in memory; the remote temp files are no
        // longer needed whether transformation succeeds or fails.
        cleanupImages(images);
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      // Clear ownership first so cleanup failures cannot leave attachable state.
      const images = drainPendingImages();
      cleanupImages(images);
      clearWidget(ctx);
    });
  };
}

export default createSshClipboardImagesExtension();
