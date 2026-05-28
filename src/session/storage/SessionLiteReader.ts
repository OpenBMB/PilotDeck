import { open, stat } from "node:fs/promises";

export const SESSION_LITE_READ_BYTES = 65_536;

export type SessionLiteFile = {
  path: string;
  mtime: number;
  size: number;
  head: string;
  tail: string;
};

export async function readSessionLite(path: string): Promise<SessionLiteFile | null> {
  try {
    const fileStat = await stat(path);
    if (fileStat.size === 0) {
      return null;
    }

    const handle = await open(path, "r");
    try {
      const headBuffer = Buffer.allocUnsafe(Math.min(SESSION_LITE_READ_BYTES, fileStat.size));
      const headResult = await handle.read(headBuffer, 0, headBuffer.length, 0);
      const head = headBuffer.toString("utf8", 0, headResult.bytesRead);

      const tailOffset = Math.max(0, fileStat.size - SESSION_LITE_READ_BYTES);
      let tail = head;
      if (tailOffset > 0) {
        const tailBuffer = Buffer.allocUnsafe(Math.min(SESSION_LITE_READ_BYTES, fileStat.size - tailOffset));
        const tailResult = await handle.read(tailBuffer, 0, tailBuffer.length, tailOffset);
        tail = tailBuffer.toString("utf8", 0, tailResult.bytesRead);
      }

      return {
        path,
        mtime: fileStat.mtime.getTime(),
        size: fileStat.size,
        head,
        tail,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
