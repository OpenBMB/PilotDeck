import type { FormDialogSchema } from "./FormDialogSchema.js";

/**
 * Gateway-owned generic user-dialog boundary for tools that need a single
 * human response. Unlike elicitation, this is not tied to the batched
 * multiple-choice `ask_user_question` schema.
 */
export type PilotDeckUserInputRequest = {
  toolCallId: string;
  toolName: string;
  prompt: string;
  placeholder?: string;
  allowEmpty?: boolean;
  signal?: AbortSignal;
};

export type PilotDeckUserInputAnswer =
  | { type: "answered"; value: string }
  | { type: "cancelled"; reason?: string };

export type PilotDeckUserDialogChoice = {
  value: string;
  label?: string;
  description?: string;
};

export type PilotDeckUserSelectRequest = {
  toolCallId: string;
  toolName: string;
  prompt: string;
  choices: PilotDeckUserDialogChoice[];
  defaultValue?: string;
  signal?: AbortSignal;
};

export type PilotDeckUserSelectAnswer =
  | { type: "answered"; value: string }
  | { type: "cancelled"; reason?: string };

export type PilotDeckUserConfirmationRequest = {
  toolCallId: string;
  toolName: string;
  prompt: string;
  confirmLabel?: string;
  cancelLabel?: string;
  defaultValue?: boolean;
  signal?: AbortSignal;
};

export type PilotDeckUserConfirmationAnswer =
  | { type: "answered"; value: boolean }
  | { type: "cancelled"; reason?: string };

export type PilotDeckUserFormRequest = {
  toolCallId: string;
  toolName: string;
  prompt: string;
  schema: FormDialogSchema;
  signal?: AbortSignal;
};

export type PilotDeckUserFormAnswer =
  | { type: "answered"; value: Record<string, unknown> }
  | { type: "cancelled"; reason?: string };

export type PilotDeckUserDialogChannel = {
  requestInput(request: PilotDeckUserInputRequest): Promise<PilotDeckUserInputAnswer>;
  requestSelect(request: PilotDeckUserSelectRequest): Promise<PilotDeckUserSelectAnswer>;
  requestConfirm(request: PilotDeckUserConfirmationRequest): Promise<PilotDeckUserConfirmationAnswer>;
  requestForm(request: PilotDeckUserFormRequest): Promise<PilotDeckUserFormAnswer>;
};
