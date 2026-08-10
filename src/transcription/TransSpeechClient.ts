import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { TransSpeechEnhancement, TransSpeechSegment, TransSpeechTranscription } from "./types.js";

export type TransSpeechClientOptions = {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export type TransSpeechClientErrorKind = "aborted" | "timeout" | "unavailable" | "invalid_request" | "service_unavailable" | "invalid_response";

export class TransSpeechClientError extends Error {
  constructor(
    readonly kind: TransSpeechClientErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "TransSpeechClientError";
  }
}

export class TransSpeechClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TransSpeechClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(signal?: AbortSignal): Promise<void> {
    const response = await this.request(`${this.baseUrl}/health`, { method: "GET" }, signal);
    const payload = await this.readJson(response, "Trans-Speech health check failed.");
    if (!isRecord(payload) || payload.status !== "ok") {
      throw new TransSpeechClientError("service_unavailable", "Trans-Speech service is not ready.");
    }
  }

  async transcribe(
    input: { audioPath: string; language: string; asrProfile: string; diarize: boolean; numSpeakers?: number },
    signal?: AbortSignal,
  ): Promise<TransSpeechTranscription> {
    const audio = await readFile(input.audioPath, { signal });
    const form = new FormData();
    form.set("file", new Blob([audio]), basename(input.audioPath));
    form.set("language", input.language);
    form.set("asr_profile", input.asrProfile);
    form.set("diarize", String(input.diarize));
    if (input.numSpeakers !== undefined) form.set("num_speakers", String(input.numSpeakers));

    const response = await this.request(`${this.baseUrl}/v1/transcribe`, { method: "POST", body: form }, signal);
    const payload = await this.readJson(response, "Trans-Speech transcription failed.");
    return parseTranscription(payload);
  }

  async enhance(
    input: { text: string; polish?: boolean; minutes?: boolean; actions?: boolean },
    signal?: AbortSignal,
  ): Promise<TransSpeechEnhancement> {
    const response = await this.request(`${this.baseUrl}/v1/enhance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, signal);
    const payload = await this.readJson(response, "Trans-Speech enhancement failed.");
    return parseEnhancement(payload);
  }

  private async request(url: string, init: RequestInit, parentSignal?: AbortSignal): Promise<Response> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("Trans-Speech request timed out.")), this.timeoutMs);
    const controller = new AbortController();
    const cleanup = forwardAbort(parentSignal, controller);
    const cleanupTimeout = forwardAbort(timeout.signal, controller);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch {
      if (parentSignal?.aborted) throw new TransSpeechClientError("aborted", "Recording task was cancelled.");
      if (timeout.signal.aborted) throw new TransSpeechClientError("timeout", "Trans-Speech request timed out.");
      throw new TransSpeechClientError("unavailable", "Unable to reach Trans-Speech.");
    } finally {
      clearTimeout(timer);
      cleanup?.();
      cleanupTimeout?.();
    }
  }

  private async readJson(response: Response, fallback: string): Promise<unknown> {
    if (!response.ok) throw this.httpError(response.status, fallback);
    try {
      return await response.json();
    } catch {
      throw new TransSpeechClientError("invalid_response", `${fallback} Response was not valid JSON.`);
    }
  }

  private httpError(status: number, fallback: string): TransSpeechClientError {
    if (status === 400) return new TransSpeechClientError("invalid_request", `${fallback} Trans-Speech rejected the request.`);
    if (status === 503) return new TransSpeechClientError("service_unavailable", "Trans-Speech service is not ready.");
    return new TransSpeechClientError("unavailable", `${fallback} HTTP ${status}.`);
  }
}

function parseTranscription(payload: unknown): TransSpeechTranscription {
  if (!isRecord(payload) || typeof payload.text !== "string") {
    throw new TransSpeechClientError("invalid_response", "Trans-Speech transcription response did not contain text.");
  }
  const segments = Array.isArray(payload.segments) ? payload.segments.flatMap(parseSegment) : [];
  return {
    text: payload.text,
    ...(typeof payload.transcript_md === "string" ? { transcriptMarkdown: payload.transcript_md } : {}),
    ...(typeof payload.language === "string" ? { language: payload.language } : {}),
    ...(typeof payload.duration === "number" && Number.isFinite(payload.duration) ? { durationSeconds: payload.duration } : {}),
    segments,
  };
}

function parseEnhancement(payload: unknown): TransSpeechEnhancement {
  if (!isRecord(payload) || typeof payload.text !== "string") {
    throw new TransSpeechClientError("invalid_response", "Trans-Speech enhancement response did not contain text.");
  }
  return {
    text: payload.text,
    ...(typeof payload.minutes === "string" ? { minutes: payload.minutes } : {}),
    actions: Array.isArray(payload.actions) ? payload.actions.filter((item): item is string => typeof item === "string") : [],
  };
}

function parseSegment(value: unknown): TransSpeechSegment[] {
  if (!isRecord(value) || typeof value.text !== "string") return [];
  return [{
    text: value.text,
    ...(typeof value.start === "number" && Number.isFinite(value.start) ? { start: value.start } : {}),
    ...(typeof value.end === "number" && Number.isFinite(value.end) ? { end: value.end } : {}),
    ...(typeof value.language === "string" ? { language: value.language } : {}),
    ...(typeof value.speaker === "string" || typeof value.speaker === "number" ? { speaker: value.speaker } : {}),
  }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (!source) return undefined;
  const forward = () => target.abort(source.reason);
  if (source.aborted) {
    forward();
    return undefined;
  }
  source.addEventListener("abort", forward, { once: true });
  return () => source.removeEventListener("abort", forward);
}
