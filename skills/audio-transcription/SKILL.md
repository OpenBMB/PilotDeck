---
name: audio-transcription
description: Transcribe a project-local audio recording, generate subtitles, analyze a recording, or produce meeting notes from audio using local FunASR.
---

# Audio Transcription

Use this Skill only when the user explicitly asks to transcribe audio, create subtitles, analyze a recording, or make meeting notes from a recording. Do not invoke ASR merely because an audio attachment is present.

PilotDeck provides this Skill itself; there is no Skill file to install. First check whether `mcp__funasr__transcribe_audio` is available. If its local runtime or models are missing, run the exact `npm --prefix "..." run install:asr` command shown by the attachment or MCP diagnostic. It points at the PilotDeck source checkout or installed app directory:

```bash
npm --prefix "<PilotDeck directory>" run install:asr
```

The installer downloads the platform-specific official FunASR llama.cpp runtime and the local models. It does not require Docker, Python, or a cloud API. After it completes, retry `mcp__funasr__transcribe_audio` in the same session.

For platform, cache, download-source, and network troubleshooting details, read `../../docs/funasr-installation.md` relative to this Skill directory.

## Workflow

1. Identify the registered audio attachment path in the session message.
2. Pass that project-local host path directly as `audio_path`; do not convert it to a container path. The tool rejects paths outside the current project, including symlinks that escape it.
3. Call `mcp__funasr__transcribe_audio` with `language: "auto"`. This is the only language value supported by the local SenseVoice CLI.
4. Preserve timestamped segments for subtitles, verbatim transcripts, or auditable meeting records.
5. Only after transcription, summarize, translate, or extract action items as requested.

## Constraints

- Do not use `read_file` to decode audio.
- Do not send the audio to a cloud service or substitute a different ASR provider without the user's direction.
- The tool is intentionally limited to a real local file inside the active project.
