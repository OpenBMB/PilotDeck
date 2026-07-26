export const OBSERVATION_SCHEMA_VERSION = "1.0";

export type ObservationProfile = "diagnostic";
export type ObservationPriority = "critical" | "important" | "coalescible" | "metrics";
export type ObservationClassification = "public" | "internal" | "restricted";

export type PromptInjectionObservation = {
  id: string;
  source: string;
  position: "system:end" | "after:last-message";
  contentHash: string;
  bytes: number;
  reasonCode: string;
};

export type ObservationSecurity = {
  classification: ObservationClassification;
  contentAvailable: boolean;
  redactions: string[];
};

export type ObservationEventDraft = {
  type: string;
  sessionId: string;
  turnId?: string;
  runId?: string;
  spanId?: string;
  parentSpanId?: string;
  payload?: Record<string, unknown>;
  priority?: ObservationPriority;
  security?: Partial<ObservationSecurity>;
};

export type ObservationEvent = {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  eventId: string;
  sequence: number;
  timestamp: string;
  campaignId?: string;
  variant?: string;
  runId?: string;
  sessionId: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  producer: {
    component: string;
    version: string;
  };
  type: string;
  priority: ObservationPriority;
  payload: Record<string, unknown>;
  security: ObservationSecurity;
};

export type ObservationRecorderStats = {
  acceptedEvents: number;
  droppedEvents: number;
  droppedByPriority: Partial<Record<ObservationPriority, number>>;
  queueHighWatermark: number;
  bytesWritten: number;
  writeBatches: number;
  writeErrors: string[];
};

export type ObservationBundlePaths = {
  directory: string;
  observations: string;
  trajectory: string;
  integrity: string;
};

export interface ObservationRecorder {
  readonly paths: ObservationBundlePaths;
  emit(draft: ObservationEventDraft): ObservationEvent | undefined;
  flush(): Promise<ObservationRecorderStats>;
  finalize(): Promise<ObservationRecorderStats>;
  snapshotStats(): ObservationRecorderStats;
}
