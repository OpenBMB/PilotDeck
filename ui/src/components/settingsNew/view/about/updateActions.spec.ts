import { describe, expect, it, vi } from "vitest";
import {
  launchDesktopInstaller,
  readWebUpdateTerminalStatus,
} from "./updateActions";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("readWebUpdateTerminalStatus", () => {
  it("parses an error message split across arbitrary stream chunks", async () => {
    const bytes = new TextEncoder().encode(
      `${JSON.stringify({
        stage: "progress",
        message: "正在更新",
        status: "running",
      })}\n${JSON.stringify({
        stage: "error",
        message: "Update failed",
        status: "error",
      })}\n`,
    );
    const stream = streamFromChunks([
      bytes.slice(0, 7),
      bytes.slice(7, 31),
      bytes.slice(31, bytes.length - 2),
      bytes.slice(bytes.length - 2),
    ]);

    await expect(readWebUpdateTerminalStatus(stream)).resolves.toBe("error");
  });

  it("requires an explicit successful terminal message", async () => {
    const bytes = new TextEncoder().encode(
      `${JSON.stringify({
        stage: "progress",
        message: "Still working",
        status: "running",
      })}\n`,
    );

    await expect(
      readWebUpdateTerminalStatus(streamFromChunks([bytes])),
    ).rejects.toThrow("without a terminal status");
  });

  it.each(["success", "up-to-date"] as const)(
    "accepts the %s terminal status",
    async (status) => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ stage: "complete", status }),
      );

      await expect(
        readWebUpdateTerminalStatus(streamFromChunks([bytes])),
      ).resolves.toBe(status);
    },
  );
});

describe("launchDesktopInstaller", () => {
  it("only launches the downloaded installer", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });

    await launchDesktopInstaller("/tmp/PilotDeck-installer.exe", request);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/update/desktop/install", {
      method: "POST",
      body: JSON.stringify({ filePath: "/tmp/PilotDeck-installer.exe" }),
    });
  });
});
