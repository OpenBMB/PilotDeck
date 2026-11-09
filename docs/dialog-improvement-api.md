# Chat composer API

HTTP base path: `/api`. Use JSON except for multipart uploads, ISO 8601 UTC timestamps, bytes for sizes and opaque server-issued cursors. Shared errors use `{ error: { code, message, details?, requestId? } }`; shared authentication middleware retains its existing response shape.

## Files, commands and skills

| Method | Path | Request and limits |
| --- | --- | --- |
| GET | `/api/projects/files` | projectKey required; query up to 256 characters; cursor; limit default 100, range 1–500; includeDirs default true |
| POST | `/api/commands/list` | projectKey, optional query/cursor/limit; default limit 50, maximum 200 |
| POST | `/api/skills/list` | optional projectKey/query/scope/cursor/limit; scope default all; default limit 10, maximum 50 |

A page contains items and optional nextCursor. Cursors bind to their filters; changing query/scope invalidates a previous cursor. Invalid or expired cursors return 400 INVALID_CURSOR. Match ranges contain field/start/end, use half-open UTF-16 code-unit offsets, and are sorted without overlaps.

Files return `{ projectKey, items, nextCursor? }`. Entries contain id, name, relativePath, kind (`file|directory`), size, mtimeMs and optional matches for name/relativePath. IDs remain stable for an entity's lifetime. Paths are relative, use `/`, and cannot escape the real project root through traversal or symlinks. Without query, sort visible entries lexically by relativePath; with query, match name/path case-insensitively. Missing projects return 404 PROJECT_NOT_FOUND, forbidden paths 403 PROJECT_PATH_FORBIDDEN and scan limits 422 FILE_INDEX_LIMIT.

Commands return pinned, builtIn and custom arrays plus optional nextCursor. Items contain name, optional description/argumentHint/matches, namespace and type. Deduplicate by built-in > project command/skill > user command/skill, retain server-defined pinned order and otherwise sort by name. This endpoint alone supplies slash-command candidates; do not merge a second skills list into it.

Skills return name, optional displayName/description, scope, normalized command, optional readonly and matches. Allowed scopes are builtin/user/project/plugin/all. Commands start with `/`. Results do not include SKILL.md bodies.

## Uploads

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/uploads` | Create a project-scoped manifest |
| POST | `/api/uploads/:uploadId/content` | Stream matching multipart file parts |
| GET | `/api/uploads/:uploadId` | Read progress and attachment metadata |
| DELETE | `/api/uploads/:uploadId` | Cancel a created/uploading task |
| GET | `/api/uploads/:uploadId/events` | Subscribe to progress over SSE |

Creation takes `{ projectKey, files }` and returns HTTP 201 with the task, contentUrl and eventsUrl. Manifest entries contain clientFileId, name, relativePath, nonnegative integer size, optional mimeType and optional sha256. Client IDs are unique within the upload. relativePath uses `/`, has no leading separator or empty/`.`/`..` segments, and preserves selected folder hierarchy; a single file uses its filename. Sum sizes into totalBytes. Verify a supplied hash before completion.

Idempotency-Key reuses the same task for the same project/key until expiration. Multipart fields must be exactly `files[<clientFileId>]`, each declared entry once, with no omissions or extras. Stream to temporary storage; base64 request bodies are unsupported.

```ts
type UploadStatus = 'created' | 'uploading' | 'completed' | 'failed' | 'cancelled' | 'expired';
type UploadedAttachment = {
  attachmentId: string; name: string; relativePath?: string;
  mimeType?: string; bytes: number; sha256: string;
};
type UploadResponse = {
  uploadId: string; status: UploadStatus; totalBytes: number; uploadedBytes: number;
  expiresAt: string; attachments?: UploadedAttachment[]; errorCode?: string; errorMessage?: string;
};
```

The first byte moves created to uploading; valid complete content moves uploading to completed, and failure moves it to failed. Created/uploading may be cancelled; completed tasks expire. uploadedBytes is monotonic and equals totalBytes on completion. Successful content upload returns 200 plus UploadResponse. Disconnect marks the task failed with UPLOAD_STREAM_INTERRUPTED. Cancel returns 204; completed uploads return UPLOAD_ALREADY_COMPLETED.

SSE sends a current snapshot first, then upload_started/upload_progress/upload_completed/upload_failed. Data contains uploadId, status, uploadedBytes, totalBytes, percent (0–100), optional attachments and optional errors. A terminal event closes the stream. Subscribe before posting content to avoid losing progress.

## Model catalog and selection

`GET /api/models` accepts optional query, provider and includeAuto. projectKey is compatibility input only; the catalog is global and must not scan a project. It returns defaultSelection, items and router `{ enabled, autoAvailable }`.

Each item contains id, provider, model, displayName, available and capabilities. reasoning/speed capabilities have type range or enum, with min/max/step or values and optional default. Missing capabilities mean unsupported parameters.

- Reasoning and speed use normalized 0–1 values. Explicit supportsThinking=false suppresses reasoning; otherwise protocol defaults apply.
- Official OpenAI/Anthropic models and supported explicitly enabled adapters may expose speed as enum 0 (standard), 1 (fast). Google does not expose speed.
- Custom compatible providers require speedMapping=openai_service_tier or anthropic_speed respectively. Values below 0.5 omit the speed field; higher values map to OpenAI service_tier=priority or Anthropic speed=fast with the required fast-mode-2026-02-01 beta header.
- When routing supports Auto, a virtual router/auto selection may be returned.

The Web composer stores one browser/site-wide complete model/parameter preference across projects, sessions, refresh and tabs. Start from defaultSelection until the user chooses. Keep an unavailable explicit selection for repair rather than silently changing it. Legacy drafts do not seed this global preference. Invalidate the shared catalog cache on configuration reload or WebSocket reconnection.

The following session endpoints remain for older clients; the Web composer does not use them to save its global choice:

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/sessions/model?sessionKey=...&projectKey=...` | Return saved selection and effective selection/source |
| PUT | `/api/sessions/model` | Persist `{ sessionKey, projectKey, selection }` in session metadata |
| DELETE | `/api/sessions/model?sessionKey=...&projectKey=...` | Clear saved selection; return 204 |

A selection is `{ mode: 'auto' }` or `{ mode: 'model', provider, model, reasoning?, speed? }`. Validate configured availability and capabilities. Auto requires an enabled Router. Absent saved selection falls back to routing, then the system default. Responses include sessionKey, projectKey, optional saved and effective `{ provider, model, source, reasoning?, speed? }`, where source is session/router/default. Persistence applies to subsequent turns and restored sessions.

## Permissions and submission

Permission modes are default (normal tool approval), bypassPermissions (Full Access), and plan (execution mode only). basePermissionMode represents the underlying default/Full Access choice. In plan mode use that base permission without escalating it. Outside plan, explicit mode wins, then basePermissionMode, then the system preference. Validate caller capabilities and policy before running a model. Record the effective mode in turn metadata; temporary overrides do not persist to the next turn.

Permission requests use permission_request events and permission_decide RPC. Text IM channels queue requests FIFO and apply each 1/2/0 answer only to the displayed request. Keep the queue locked until prompt delivery succeeds. If permission_decide returns delivered=false, discard the stale request and prompt the next one without retrying the same ID. Turn cleanup waits for the current acknowledgement delivery.

Gateway WebSocket method `submit_turn` accepts:

```ts
type SessionModelSelection = { mode: 'auto' } | {
  mode: 'model'; provider: string; model: string; reasoning?: number; speed?: number;
};
type SubmitTurnRequest = {
  sessionKey: string; channelKey: string; message: string; projectKey?: string;
  attachments?: WebChannelAttachment[];
  uploadedAttachments?: Array<{ uploadId: string; attachmentIds?: string[] }>;
  mode?: 'default' | 'plan' | 'bypassPermissions';
  basePermissionMode?: 'default' | 'plan' | 'bypassPermissions';
  modelOverride?: Exclude<SessionModelSelection, { mode: 'auto' }>;
  modelSelection?: SessionModelSelection; runId?: string;
};
```

Web always sends an explicit modelSelection snapshot and records it with the accepted input. Legacy modelOverride affects only the current turn; the two fields are mutually exclusive. Priority is explicit selection/override > saved legacy session model > Router Auto > system default. Later preference changes cannot affect running or queued requests. Require valid model parameters, a usable Router for Auto, completed/unexpired uploaded attachments belonging to the same project, and valid permission combinations; reject invalid submissions before any model call.

The event stream may include model_selection_changed with provider, model, source, optional reasoning/speed parameters and runId. Existing turn_started, permission_request, assistant_text_delta, assistant_thinking_delta, tool_call_started, tool_call_finished, turn_completed and error events remain supported.

Local callers may pass `submitTurn(input, { signal })` to cancel that specific submission. The signal is not part of the serialized request. Disconnect and iterator cancellation belong to the originating request, including preparation before `input_accepted`; a rejected duplicate cannot cancel another request with the same public `runId`. For stream cleanup, `abort_turn` may include `requestId`, which is resolved only within the sending WebSocket connection. Without `requestId`, the existing `{ sessionKey, runId?, reason? }` Stop API remains supported; a supplied stale `runId` is ignored.

A session remains reserved until execution drains, independently of how quickly its consumer reads events. Hard timeouts include preparation and retire the timed-out session before releasing the reservation. Cancellation before execution emits an aborted completion without accepting input. A failed `response` addressed to a stream terminates that stream with its structured error code and details.

## Error and compatibility reference

| Code | HTTP equivalent | Meaning |
| --- | --- | --- |
| INVALID_CURSOR | 400 | Invalid or mismatched page cursor |
| PROJECT_NOT_FOUND / UPLOAD_NOT_FOUND | 404 | Unknown project/upload |
| PROJECT_PATH_FORBIDDEN | 403 | Path escape or cross-project access |
| FILE_INDEX_LIMIT | 422 | Scan resource limit |
| UPLOAD_NOT_COMPLETED / UPLOAD_ALREADY_COMPLETED | 409 | Upload state conflicts |
| UPLOAD_LIMIT_EXCEEDED | 413 | File/count/total limit |
| UPLOAD_MANIFEST_MISMATCH / UPLOAD_STREAM_INTERRUPTED | 400 | Invalid parts or interrupted stream |
| ATTACHMENT_EXPIRED | 410 | Expired upload/attachment |
| INVALID_PERMISSION_MODE / INVALID_MODEL_OVERRIDE | 400 | Invalid permission/model choice |
| UNSUPPORTED_MODEL_PARAMETER | 422 | Unsupported or out-of-range parameter |
| ROUTER_AUTO_UNAVAILABLE | 409 | Auto unavailable |
| CAPABILITY_UNAVAILABLE | 501 | Missing Gateway RPC capability |

Handshake capabilities advertise project_files_list, commands_list, model_catalog_list, session_model_get, session_model_set and session_model_clear. Missing RPC support returns CAPABILITY_UNAVAILABLE instead of silently rewriting a request. New submit fields remain optional for older callers.

Implementation: [Gateway](../src/gateway/README.md), [browser protocol](../src/web/client/protocol.ts), [Web server routes](../ui/server/routes). Keep private prompts, file contents, credentials and temporary absolute paths out of logs and durable attachment metadata.
