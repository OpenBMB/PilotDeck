# Video generation

Video generation is optional and disabled by default. Configure **Settings > Multimodal > Video**, backed by `tools.videoGeneration`: `enabled`, `apiKey`, `baseUrl`, `model`, and optional `extraParams` JSON defaults. The configured service must implement the compatible Videos API routes; listing a model alone does not provide those routes. Disabling the feature removes `generate_video` and `save_generated_video` from new model requests while existing attachments remain available.

## Generation and durable recovery

- The provider adapter submits multipart POST `{baseUrl}/videos`, polls GET `{baseUrl}/videos/{id}` and downloads GET `{baseUrl}/videos/{id}/content`. The model name is configurable; model-specific `extra_params` overrides merge over host defaults.
- `generate_video` requires `prompt` and `purpose` (`deliverable` or `intermediate`). Optional duration defaults to five seconds; size, inference steps and seed depend on provider support. The tool normally waits for completion and does not automatically wake an agent in a later turn.
- The host records each job as soon as its remote ID arrives, including session, turn, and tool call ownership. The ledger under `PILOT_HOME/generated-videos/jobs` stores neither credentials nor generation prompts. Recovery polls the accepted job; it never resubmits a generation POST.
- Closing a page, stopping Agent waiting or restarting Gateway does not cancel the remote job. The Web host recovers unfinished jobs. A tracking window lasts twenty minutes, then pauses with the ID retained; Resume retrieval continues after the required endpoint/key is available.
- If the submission response is lost before a remote ID is received, report failure without resubmitting or guessing an unknown job. Read credentials from current settings only when the effective address matches the accepted job's original service. Authentication/address changes pause retrieval rather than forwarding credentials to a different service.
- Process leases coordinate multiple backends; a completed job keeps one local video ID. Recovery updates the original card but does not restart interrupted Agent work. Subsequent conversation context includes recovered video status/IDs so saving does not regenerate content.

## Attachments, exports and presentation

Videos stream into durable session attachments under `PILOT_HOME/generated-videos`, capped at 512 MiB each. Generation creates no project file by default. An explicit `output_path` or `save_generated_video` exports an existing video ID to an allowed workspace `.mp4` path without overwriting an existing file.

A deliverable is the user's requested video: show a generation placeholder, then its player, retaining an expandable execution record. An intermediate is an asset for another task. Both purposes show independent animated feedback while generation is active, outside process disclosures. A completed intermediate smoothly closes that surface and keeps its player in on-demand tool details; a completed deliverable stays visible. Tracking, reconnecting, downloading and paused durable jobs retain their independent status/recovery surface even after the Agent turn stops. Failed calls and unfinished historical calls use normal tool presentation. Playback supports seeking/fullscreen/download; retain download access when the browser cannot decode a video.

Session ownership is enforced. Trusted runtime relationships explicitly copy parent/child attachments. Forks inherit attachments referenced by retained history and rebind metadata; recovered child jobs remain scoped to their originating task/turn. Copies survive deletion of source attachments. Only final deliverable generation emits the standard IM file event; intermediate results and save-only calls do not duplicate delivery.

Project files and conversation attachments use the shared video preview. Video extensions are not opened as editable text. Authenticated media URLs support HTTP Range/206 so playback does not buffer the whole file.

## Local HTTP endpoints

All paths below are mounted under `/api/video-generation` with existing authentication.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/jobs/:sessionId/call/:toolCallId?turnId=...` | Find the job within its session/originating turn |
| POST | `/jobs/:sessionId/:jobId/resume` | Resume a retained job |
| POST | `/test` | Explicit temporary provider probe; works while disabled and preserves saved opt-in |
| GET | `/:sessionId/:videoId?download=1` | Stream/download a session attachment with Range support |

The probe accepts `model`, `baseUrl`, `apiKey`, and optional `extraParams`. A masked key can reuse saved credentials only for the same normalized address. The host removes temporary probe media after use. Media responses use `Cache-Control: private, no-store`, and unknown session attachments return 404.

Implementation: [tools](../src/tool/builtin/videoGeneration.ts), [job ledger](../src/tool/builtin/videos/VideoJobManager.ts), [store](../src/tool/builtin/videos/VideoStore.ts), [provider adapter](../src/tool/builtin/videos/openaiVideos.ts), [HTTP routes](../ui/server/routes/video-generation.js), [client job tracking](../ui/src/components/chat/tools/useVideoJobs.ts).

Validation: [generation](../tests/tool/builtin/videoGeneration.spec.ts), [recovery](../tests/tool/builtin/videoRecovery.spec.ts), [fork ownership](../tests/web/fork-generated-videos.spec.ts), [parent/child delegation](../tests/gateway/parent-video-delegation.spec.ts), and the colocated UI/route cases. These use synthetic media and provider fixtures; real video-provider probes require explicit opt-in.
