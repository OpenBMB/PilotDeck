# FunASR Local Runtime Installation

PilotDeck transcribes audio through an included Node stdio MCP that invokes the official FunASR llama.cpp SenseVoice CLI locally. It does not use Docker, Python, a container image, or a cloud ASR API.

## Supported Platforms

| Platform | Architecture | Runtime asset |
| --- | --- | --- |
| macOS | ARM64 | `funasr-llamacpp-macos-arm64.tar.gz` |
| Linux | ARM64 | `funasr-llamacpp-linux-arm64.tar.gz` |
| Linux | x64 | `funasr-llamacpp-linux-x64.tar.gz` |
| Windows | x64 | `funasr-llamacpp-windows-x64.zip` |

macOS x64 and Windows ARM64 are deliberately rejected until FunASR ships matching upstream assets.

## Install or Verify

Run this from the PilotDeck source checkout or installed app directory:

```bash
npm run install:asr
```

The command downloads the fixed `runtime-llamacpp-v0.2.0` archive and installs SenseVoiceSmall q8 plus FSMN-VAD. Model downloads try ModelScope first and Hugging Face second. Downloads use a temporary `.part` file and are renamed into place only after a complete response, so it is safe to rerun after a network interruption.

The cache is user-local:

```text
$PILOT_HOME/funasr/
  runtime/v0.2.0/<platform-arch>/
  models/sensevoice-small-q8.gguf
  models/fsmn-vad.gguf
```

When `PILOT_HOME` is unset, PilotDeck uses `~/.pilotdeck` (or the platform-equivalent user home).

## Failure Diagnostics

The installer prints the failed stage and source URL. A runtime failure distinguishes download, unpacking, and missing executable errors. A model failure reports the independent ModelScope and Hugging Face causes, which usually identifies DNS, TLS, proxy, rate-limit, or blocked-source problems. Downloads honor `PILOTDECK_PROXY`/`HTTPS_PROXY` first, then `proxy.url` and `proxy.noProxy` in `$PILOT_HOME/pilotdeck.yaml`.

No half-downloaded runtime or model is used. Re-run `npm run install:asr` after correcting network or proxy settings. Existing complete cache entries are reused.

## Runtime Use

The MCP tool is `mcp__funasr__transcribe_audio`:

```json
{
  "audio_path": "/projects/demo/meeting.wav",
  "language": "auto"
}
```

The audio path must resolve to a real regular file inside the current PilotDeck project. Project-relative paths are accepted. URLs, missing files, project-external paths, and symlinks that resolve outside the project are rejected. The tool returns transcript text and second-based timestamp segments.

The built-in plugin is enabled unless configured otherwise:

```yaml
extension:
  builtinPluginsEnabled:
    funasr: true
```

## Real End-to-End Test

The repository includes an opt-in real end-to-end test for the complete
`audio attachment -> transcription -> meeting note -> local knowledge base`
flow. It uses the checked-in Chinese `meeting.wav` fixture and a scripted
Agent only for the summary/write orchestration; transcription always uses the
actual local Runtime and models.

Install into an isolated cache, then point the test at that cache:

```bash
PILOT_HOME=/tmp/pilotdeck-funasr-e2e npm run install:asr
PILOTDECK_RUN_FUNASR_E2E=1 \
PILOTDECK_FUNASR_E2E_PILOT_HOME=/tmp/pilotdeck-funasr-e2e \
npx tsx --test tests/cli/funasr-meeting-e2e.spec.ts
```

The test is skipped by default so normal CI runs do not download model files.
