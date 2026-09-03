---
name: audio-transcription
description: Transcribe a Web-uploaded WAV, MP3, M4A, or FLAC recording through the configured Trans-Speech service.
---

# Audio Transcription

Use this Skill only when the user explicitly asks to transcribe audio, create subtitles, analyze a recording, or make meeting notes from a recording. Do not invoke ASR merely because an audio attachment is present.

PilotDeck provides this Skill and the `trans_speech` tool. The tool reads the registered Web-uploaded file locally and sends it to the configured Trans-Speech service as multipart data; do not convert the path to a container path.

## Workflow

1. Identify the registered audio attachment path in the session message.
2. Confirm it is WAV, MP3, M4A, or FLAC. Tell the user that other audio formats are unsupported; do not use another ASR provider.
3. Call `trans_speech` with `{"action":"start","audio_path":"<exact registered path>"}`. The tool accepts only Web-uploaded files within the active project, including the current and legacy upload directories.
4. Preserve timestamped segments for subtitles, verbatim transcripts, or auditable meeting records.
5. Only after transcription, summarize, translate, or extract action items as requested.

## Constraints

- Do not use `read_file` to decode audio.
- Do not substitute a different ASR provider.
- Do not invoke transcription merely because an audio attachment is present.
- The tool is intentionally limited to a real Web-uploaded file inside the active project.
