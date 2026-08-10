export const TRANSCRIPTION_TASK_DIRECTORY = "录音整理任务";
export const TRANSCRIPTION_AUDIO_DIRECTORY = "原始音频";
export const TRANSCRIPTION_TASK_INFO_FILE = "任务信息.json";
export const TRANSCRIPTION_PROCESSING_RECORD_FILE = "处理记录.json";
export const TRANSCRIPTION_TRANSCRIPT_FILE = "逐字稿.md";
export const TRANSCRIPTION_POLISHED_TRANSCRIPT_FILE = "逐字整理稿.md";
export const TRANSCRIPTION_MINUTES_FILE = "会议纪要.md";

export const SUPPORTED_AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".flac"]);
export const MAX_TRANSCRIPTION_FILE_BYTES = 20 * 1024 * 1024;

export type TranscriptionTaskStatus =
  | "created"
  | "transcribing"
  | "transcribed"
  | "polishing"
  | "generating_minutes"
  | "pending_review"
  | "partial"
  | "failed"
  | "cancelled";

export type TranscriptionTaskStep = "transcribe" | "polish" | "minutes";

export type TranscriptionTaskArtifacts = {
  originalAudio: string;
  transcript?: string;
  polishedTranscript?: string;
  minutes?: string;
};

export type TranscriptionTaskParameters = {
  language: string;
  asrProfile: string;
  diarize: boolean;
  polish: boolean;
  minutes: boolean;
  actions: boolean;
};

export type TranscriptionTaskFailure = {
  step: TranscriptionTaskStep;
  code: string;
  message: string;
  at: string;
};

export type TranscriptionTaskInfo = {
  id: string;
  status: TranscriptionTaskStatus;
  createdAt: string;
  updatedAt: string;
  source: {
    originalFileName: string;
    sha256: string;
    bytes: number;
    sourceCreatedAt: string;
    durationSeconds?: number;
  };
  parameters: TranscriptionTaskParameters;
  artifacts: TranscriptionTaskArtifacts;
  completedSteps: TranscriptionTaskStep[];
  failure?: TranscriptionTaskFailure;
  cancelledAt?: string;
};

export type TranscriptionProcessingRecord = {
  taskId: string;
  events: Array<{
    at: string;
    status: TranscriptionTaskStatus;
    message: string;
    step?: TranscriptionTaskStep;
  }>;
};

export type TransSpeechSegment = {
  start?: number;
  end?: number;
  text: string;
  language?: string;
  speaker?: string | number;
};

export type TransSpeechTranscription = {
  text: string;
  transcriptMarkdown?: string;
  language?: string;
  durationSeconds?: number;
  segments: TransSpeechSegment[];
};

export type TransSpeechEnhancement = {
  text: string;
  minutes?: string;
  actions: string[];
};

export type TranscriptionTaskResult = {
  task: TranscriptionTaskInfo;
  taskDirectory: string;
  duplicateTaskId?: string;
};
