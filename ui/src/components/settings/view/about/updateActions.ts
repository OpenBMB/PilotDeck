import { authenticatedFetch } from "../../../../utils/api";

export type WebUpdateTerminalStatus = "success" | "up-to-date" | "error";

type UpdateProgressMessage = {
  stage?: unknown;
  status?: unknown;
};

type RequestLike = (
  url: string,
  options?: {
    method?: string;
    body?: string;
  },
) => Promise<{ ok: boolean }>;

function readTerminalStatus(
  line: string,
): WebUpdateTerminalStatus | null {
  const parsed = JSON.parse(line) as UpdateProgressMessage;
  if (parsed.status === "error") return "error";
  if (
    parsed.stage === "complete" &&
    (parsed.status === "success" || parsed.status === "up-to-date")
  ) {
    return parsed.status;
  }
  return null;
}

export async function readWebUpdateTerminalStatus(
  body: ReadableStream<Uint8Array> | null,
): Promise<WebUpdateTerminalStatus> {
  if (!body) {
    throw new Error("Update response did not include a progress stream.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let terminalStatus: WebUpdateTerminalStatus | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      pending += decoder.decode(value, { stream: true });
    }
    if (done) {
      pending += decoder.decode();
    }

    const lines = pending.split(/\r?\n/);
    pending = done ? "" : (lines.pop() ?? "");

    for (const line of lines) {
      if (!line.trim()) continue;
      const status = readTerminalStatus(line);
      if (status === "error") {
        terminalStatus = "error";
      } else if (!terminalStatus && status) {
        terminalStatus = status;
      }
    }

    if (done) break;
  }

  if (pending.trim()) {
    const status = readTerminalStatus(pending);
    if (status === "error" || (!terminalStatus && status)) {
      terminalStatus = status;
    }
  }

  if (!terminalStatus) {
    throw new Error("Update stream ended without a terminal status.");
  }
  return terminalStatus;
}

export async function launchDesktopInstaller(
  filePath: string | null,
  request: RequestLike = authenticatedFetch,
): Promise<void> {
  const response = await request("/api/update/desktop/install", {
    method: "POST",
    body: JSON.stringify({ filePath }),
  });
  if (!response.ok) {
    throw new Error("Failed to launch desktop installer");
  }
}
