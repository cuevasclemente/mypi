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

interface PendingImage {
  content: ImageContent;
  path: string;
}

const pendingImages: PendingImage[] = [];

function isRemoteSession(env = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function removeTempFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Ignore cleanup errors.
  }
}

function readLocalClipboardImageViaKitten(): PendingImage | null {
  const filePath = path.join(os.tmpdir(), `pi-ssh-clipboard-${randomUUID()}.png`);
  try {
    // kitty's clipboard kitten speaks the OSC 5522 clipboard protocol, so this
    // reads the *local terminal* clipboard even when this code runs on an SSH host.
    // A .png output path asks kitty to copy any raster image and convert it to PNG.
    const result = spawnSync("kitten", ["clipboard", "--get-clipboard", filePath], {
      timeout: KITTEN_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error || result.status !== 0) {
      removeTempFile(filePath);
      return null;
    }
    const bytes = fs.readFileSync(filePath);
    if (bytes.length === 0) {
      removeTempFile(filePath);
      return null;
    }

    return {
      path: filePath,
      content: {
        type: "image",
        mimeType: "image/png",
        data: bytes.toString("base64"),
      },
    };
  } catch {
    removeTempFile(filePath);
    return null;
  }
}

function updateWidget(ctx: any): void {
  if (pendingImages.length === 0) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }

  const noun = pendingImages.length === 1 ? "image" : "images";
  const paths = pendingImages.map((img, i) => `  ${i + 1}. ${img.path}`);
  ctx.ui.setWidget(WIDGET_ID, [
    `📎 ${pendingImages.length} SSH clipboard ${noun} will attach to your next message`,
    ...paths,
  ], { placement: "aboveEditor" });
}

function queueClipboardImage(ctx: any): void {
  const image = readLocalClipboardImageViaKitten();
  if (!image) {
    ctx.ui.notify(
      "No clipboard image received via kitty. Use Kitty as your SSH terminal and ensure `kitten` is installed/available on this host.",
      "warning",
    );
    return;
  }

  pendingImages.push(image);
  updateWidget(ctx);
  ctx.ui.notify(`Attached clipboard image for next message: ${image.path}`, "success");
}

export default function sshClipboardImages(pi: ExtensionAPI) {
  // Only add the SSH/Mosh helper shortcut for remote sessions. Ctrl+V is Pi's
  // built-in app.clipboard.pasteImage binding, so the default here intentionally
  // uses a non-built-in shortcut to avoid startup conflict warnings. Override
  // with PI_SSH_CLIPBOARD_IMAGE_SHORTCUT if a host needs a different binding.
  if (isRemoteSession()) {
    pi.registerShortcut(SSH_CLIPBOARD_SHORTCUT, {
      description: "Attach local SSH clipboard image via kitty",
      handler: async (ctx) => queueClipboardImage(ctx),
    });
  }

  pi.registerCommand("paste-image", {
    description: "Attach a local clipboard image to the next message via kitty/SSH",
    handler: async (_args, ctx) => queueClipboardImage(ctx),
  });

  pi.on("input", async (event, ctx) => {
    if (pendingImages.length === 0) return { action: "continue" as const };

    const images = pendingImages.splice(0, pendingImages.length);
    updateWidget(ctx);

    const pathNote = images
      .map((img) => `[Attached clipboard image saved on remote host: ${img.path}]`)
      .join("\n");
    const nextText = event.text.trim()
      ? `${event.text}\n\n${pathNote}`
      : pathNote;

    return {
      action: "transform" as const,
      text: nextText,
      images: [...(event.images ?? []), ...images.map((img) => img.content)],
    };
  });
}
