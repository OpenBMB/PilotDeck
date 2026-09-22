---
name: voxcpm-tts
description: Synthesize speech from text using OpenBMB VoxCPM — a tokenizer-free TTS with zero-shot voice cloning, 30 languages, 9 Chinese dialects, and natural-language voice-style control. Use when the user asks for TTS, 语音合成, voice cloning, podcast audio generation, multilingual narration, or when pairing with the podcast-scriptwriter skill. Requires `pip install voxcpm` and 5-8 GB GPU (or slow CPU/MPS fallback).
---

# VoxCPM Text-to-Speech

Synthesize speech from Chinese/English/multilingual text using OpenBMB's [VoxCPM](https://github.com/OpenBMB/VoxCPM). Two model tiers, three input modes, thirty languages, nine Chinese dialects. Apache-2.0 licensed.

**Verified 2026-07-04**: `voxcpm 2.0.3` on PyPI, dependency graph resolves cleanly (torch ≥ 2.5, transformers ≥ 4.36, gradio 6.x). PyPI reachable. Model weights host on Hugging Face (`openbmb/VoxCPM2`, `openbmb/VoxCPM-0.5B`).

**This environment (QoderWork sandbox) has no GPU and cannot reach huggingface.co directly** — audio generation is not exercised here. Deploy on a machine with CUDA / Apple Silicon / a HF mirror to actually synthesize.

## Prerequisites

| Component | Requirement |
|-----------|-------------|
| Python | ≥ 3.10, < 3.13 (officially tested) |
| PyTorch | ≥ 2.5.0 |
| CUDA | ≥ 12.0 (recommended); MPS or CPU also work (slower) |
| GPU VRAM | 5 GB for VoxCPM-0.5B, 8 GB for VoxCPM2 (2B) |
| Disk | ~2 GB per model (weights auto-download from HF) |
| Network | Access to `huggingface.co` (or set `HF_ENDPOINT` to a mirror) |

Install:
```bash
pip install voxcpm
```

For China deployments where HF is slow, use ModelScope mirror:
```bash
export HF_ENDPOINT=https://hf-mirror.com
# or use ModelScope directly:
pip install modelscope
```

## Quick Start

### CLI (simplest)

```bash
# Basic synthesis to WAV
voxcpm design --text "你好，欢迎收听三分钟 AI 快报。" --output greeting.wav

# With voice-style natural-language description
voxcpm design --text "(年轻女声，温柔甜美) 今天天气真好，我们来聊聊 AI。" --output warm.wav

# English
voxcpm design --text "Welcome to today's AI briefing." --output en.wav

# Batch
voxcpm batch --input-file lines.txt --output-dir out/
```

### Python SDK (programmatic)

```python
from voxcpm import VoxCPM
import soundfile as sf

model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)

wav = model.generate(
    text="你好，这是一段测试语音。",
    cfg_value=2.0,           # classifier-free guidance strength (higher = more expressive)
    inference_timesteps=10,  # diffusion steps (more = better quality, slower)
    seed=42                  # reproducibility
)
sf.write("demo.wav", wav, model.tts_model.sample_rate)  # 24 kHz output
```

### Streaming synthesis (for long text)

```python
for chunk in model.generate_streaming(text="很长的一段文本..."):
    # chunk is np.ndarray of PCM samples
    process(chunk)
```

## Input Modes

### 1. Design (natural-language voice control)

Wrap voice description in `()` at the start of the text:

```
"(年轻女声，语气甜美，稍快语速) 今天要给大家介绍一款有意思的 AI 工具。"
"(中年男声，稳重、专业) 欢迎收听本期节目。"
"(带四川口音的女生，轻松) 这个咋回事嘛！"
```

Available cues (composable):
- **Voice type**: 男声 / 女声 / 童声 / 老年男声 / 中年女声 ...
- **Tone**: 温柔 / 严肃 / 兴奋 / 平静 / 忧郁 / 慵懒 ...
- **Pace**: 快语速 / 慢语速 / 稍快 / 稍慢
- **Style**: 播音腔 / 口语化 / 说书人 / 儿童剧 / 广告腔
- **Dialect**: 四川话 / 粤语 / 吴语 / 东北话 / 河南话 / 陕西话 / 山东话 / 天津话 / 闽南话

### 2. Voice cloning (zero-shot)

Provide a 3-30 second reference audio + its transcript:

```python
wav = model.generate(
    text="要合成的新文本。",
    prompt_wav_path="reference.wav",
    prompt_text="参考音频对应的原文（准确抄写）"
)
```

The generated voice matches the reference speaker.

### 3. Combined (clone + style tweak)

```python
wav = model.generate(
    text="(稍快，兴奋) 要合成的新文本。",
    reference_wav_path="reference.wav"  # softer form of clone; keeps timbre but style overrides
)
```

## Common Workflows

### End-to-end: script → audio

Pair with `podcast-scriptwriter`. Given a script:

```
A（轻松）：欢迎收听《三分钟 AI 快报》。
B（认真）：本周动作不小。
```

```python
import re
from voxcpm import VoxCPM
import soundfile as sf, numpy as np

model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
voices = {
    'A': "reference_female.wav",   # or use "(年轻女声，语气理性犀利)" as prefix
    'B': "reference_male.wav",
}

segments = []
for line in open('script.txt', encoding='utf-8'):
    m = re.match(r'^([AB])（([^）]+)）：(.+)$', line.strip())
    if not m: continue
    speaker, tone, text = m.groups()
    styled = f"({tone}) {text}"
    wav = model.generate(text=styled, prompt_wav_path=voices[speaker], cfg_value=2.0, inference_timesteps=10)
    segments.append(wav)
    segments.append(np.zeros(int(0.4 * model.tts_model.sample_rate)))  # 0.4s pause

full = np.concatenate(segments)
sf.write('episode.wav', full, model.tts_model.sample_rate)
```

### Multi-language podcast

Feed the same script translated to en/ja/ko/fr; VoxCPM auto-detects language per line. Keep the same reference audio to preserve host identity across languages.

### High-throughput vLLM serving

For volume, use the OpenAI-compatible vLLM Omni server:

```bash
vllm serve openbmb/VoxCPM2 --omni --port 8000
```

Then hit `/v1/audio/speech` like OpenAI TTS.

## Fallback: edge-tts (no GPU)

If VoxCPM is impossible in the environment (no GPU, HF blocked, tight time), fall back to Microsoft Edge TTS (free, no API key, 400+ voices):

```bash
pip install edge-tts
edge-tts --voice zh-CN-XiaoxiaoNeural --text "你好世界" --write-media hello.mp3
```

Trade-offs: no voice cloning, fixed voice pool, network-dependent, not open-source. Acceptable stop-gap.

## Limitations

- **GPU strongly recommended** — CPU works but ~10-50× slower.
- **First-run downloads ~2 GB** from HF; use `HF_ENDPOINT` for a mirror if slow.
- **CUDA 12+ requires recent driver** — older drivers may need CUDA 11 build; check `torch.cuda.is_available()`.
- **Long text (> 2 min)**: use `generate_streaming` and stitch chunks; pure `generate` may hit VRAM ceiling.
- **English-only clone**: works but sample quality slightly lower than Chinese-native.
- **Dialects require prefix format** — `(粤语) 早晨。` not `粤语：早晨。`.
- **No word-level timing output** — for karaoke use whisper-like STT alignment on the produced WAV.
- **Sample rate is fixed at 24 kHz** — resample downstream if needed.
- **Python 3.13+ untested** — pin to 3.10-3.12.

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| `torch.cuda.OutOfMemoryError` | Model too big for GPU | Switch to `openbmb/VoxCPM-0.5B`, or use CPU |
| Model download stalls | HF connectivity | Set `HF_ENDPOINT=https://hf-mirror.com` |
| Robotic / metallic voice | `cfg_value` too high | Try 1.5-2.5; sweet spot is 2.0 |
| Voice clone doesn't match | Reference too short/noisy | Use 5-15 s clean sample; enable `load_denoiser=True` |
| Language auto-detected wrong | Text mixed | Split by language, generate per-segment |
| CLI `voxcpm: command not found` | Not in venv PATH | `pip install voxcpm` in the active env; or `python -m voxcpm ...` |

## References

- Repo: https://github.com/OpenBMB/VoxCPM  ⭐ 32.4k
- Docs: https://voxcpm.readthedocs.io/
- HF model: https://huggingface.co/openbmb/VoxCPM2 (2B) or https://huggingface.co/openbmb/VoxCPM-0.5B (small)
- Demo: https://openbmb.github.io/VoxCPM-demopage/
- License: Apache-2.0
- Fallback: Microsoft Edge TTS (`pip install edge-tts`) — no API key, no clone
