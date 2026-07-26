import type { ObservationEvent } from "./protocol.js";

export type ObservationTrajectory = {
  schemaVersion: "o1";
  source: "observations.jsonl";
  eventCount: number;
  steps: Array<{
    step: number;
    type: string;
    timestamp: string;
    sessionId: string;
    turnId?: string;
    spanId?: string;
    sourceEventId: string;
    payload: Record<string, unknown>;
  }>;
};

export function buildObservationTrajectory(events: readonly ObservationEvent[]): ObservationTrajectory {
  return {
    schemaVersion: "o1",
    source: "observations.jsonl",
    eventCount: events.length,
    steps: events.map((event) => ({
      step: event.sequence,
      type: event.type,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.spanId ? { spanId: event.spanId } : {}),
      sourceEventId: event.eventId,
      payload: event.payload,
    })),
  };
}
