/**
 * Elicitation channel — abstraction over how a synchronous user prompt is
 * delivered (CLI / TUI / Feishu / in-memory test). Owned by the host
 * (Gateway / Adapter), wired into the ToolRuntime via
 * `PilotDeckToolRuntimeContext.elicitation`.
 *
 * Behaviour parity with the legacy upstream elicitation handler:
 *   E1 a single round-trip per invocation; channel returns one Result.
 *   E2 user can decline; channel returns `cancelled: true`.
 *   E3 free-form notes per question are optional.
 *   E4 multi-select answers are emitted as `Array<string>` in answers.
 *
 * Coordination with the cron PR (§1.3.1, §5.1):
 *   Gateway protocol naming for this surface is `elicitation_request` /
 *   `elicitation_answer` (no overlap with `cron_*`).
 */
export type PilotDeckElicitationOption = {
  label: string;
  description: string;
  preview?: string;
};

export type PilotDeckElicitationQuestion = {
  question: string;
  header: string;
  options: PilotDeckElicitationOption[];
  multiSelect?: boolean;
};

export type PilotDeckElicitationField = {
  id: string;
  label: string;
  description?: string;
  placeholder?: string;
  kind: "text" | "secret" | "multiline";
  required?: boolean;
};

export type PilotDeckElicitationRequest = {
  /** Stable identifier of the underlying tool call. */
  toolCallId: string;
  toolName: string;
  /** Format hint forwarded to the channel. `html` = render previews as HTML. */
  previewFormat?: "html" | "markdown";
  /** Multiple-choice questions, used by `ask_user_question`. */
  questions: PilotDeckElicitationQuestion[];
  /** Free-form input fields, used when a running tool needs stdin/credentials. */
  fields?: PilotDeckElicitationField[];
  /** Free-form metadata forwarded verbatim (e.g. `source: "remember"`). */
  metadata?: Record<string, unknown>;
  /** Cancellation signal: channels MUST honor abort. */
  signal?: AbortSignal;
};

export type PilotDeckElicitationAnswer =
  | {
      type: "answered";
      answers: Record<string, string | string[]>;
      inputs?: Record<string, string>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
    }
  | { type: "cancelled"; reason?: string };

export type PilotDeckElicitationChannel = {
  /** Send a question batch to the user and await one answer batch. */
  askUser(request: PilotDeckElicitationRequest): Promise<PilotDeckElicitationAnswer>;
};

/**
 * Test/in-memory channel: pre-canned answers keyed by question text.
 * Throws if a question is asked that does not have an answer registered.
 */
export class InMemoryElicitationChannel implements PilotDeckElicitationChannel {
  private readonly answers: Map<string, string | string[]>;
  private readonly cancelOnAsk: boolean;

  constructor(
    answers: Record<string, string | string[]> = {},
    options: { cancelOnAsk?: boolean } = {},
  ) {
    this.answers = new Map(Object.entries(answers));
    this.cancelOnAsk = options.cancelOnAsk ?? false;
  }

  async askUser(request: PilotDeckElicitationRequest): Promise<PilotDeckElicitationAnswer> {
    if (this.cancelOnAsk) {
      return { type: "cancelled", reason: "in-memory cancel" };
    }
    const answers: Record<string, string | string[]> = {};
    for (const q of request.questions) {
      if (!this.answers.has(q.question)) {
        throw new Error(`InMemoryElicitationChannel: no canned answer for "${q.question}"`);
      }
      answers[q.question] = this.answers.get(q.question)!;
    }
    const inputs: Record<string, string> = {};
    for (const field of request.fields ?? []) {
      if (!this.answers.has(field.id)) {
        throw new Error(`InMemoryElicitationChannel: no canned input for "${field.id}"`);
      }
      const value = this.answers.get(field.id)!;
      inputs[field.id] = Array.isArray(value) ? value.join(", ") : value;
    }
    return { type: "answered", answers, ...(Object.keys(inputs).length > 0 ? { inputs } : {}) };
  }
}
