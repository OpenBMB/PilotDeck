# PilotDeck China Productivity Skills

Thirteen ready-to-use Agent Skills for [PilotDeck](https://github.com/OpenBMB/PilotDeck) that fill the gap in Chinese-internet + AI-productivity workflows. Every SKILL.md is written in the [Anthropic Skill format](https://github.com/anthropics/skills) and drops directly into `~/.qoderwork/skills/` (or any compatible runtime).

**All 13 skills were tested against live public APIs on 2026-07-04 — 65 curl test cases across 3 rounds. Test evidence is in [tests/](../pilotdeck-research/tests/) (65 raw response files).**

---

## The 13 Skills

| Skill | What it does | Data source | Auth needed |
|-------|--------------|-------------|-------------|
| **wechat-mp-fetch** | Fetch WeChat Public Account article body from a `mp.weixin.qq.com/s/*` URL | `mp.weixin.qq.com` (SSR) | ❌ (needs MicroMessenger UA) |
| **zhihu-answer-fetch** | Fetch Zhihu column articles (full body) or single answers (~2K truncated) | `www.zhihu.com/api/v4/*` | ❌ |
| **bilibili-video-info** | Fetch B站 video metadata, tags, and danmaku via public APIs | `api.bilibili.com`, `comment.bilibili.com` | ❌ (subtitles need SESSDATA) |
| **douban-media-lookup** | Search & fetch Douban movie / book metadata (rating, cast, ISBN, summary) | `api.douban.com/v2/*` (POST + apikey) | ⚠️ Leaked apikey |
| **juejin-article-search** | Search Juejin technical articles + fetch full body | `api.juejin.cn/search_api/v1/search` + SSR page | ❌ |
| **weibo-hot-search** | Fetch Weibo real-time hot search (50 items with volume + tags) | `weibo.com/ajax/statuses/hot_band` (Referer required) | ❌ (Referer required) |
| **github-trending** | Approximate GitHub trending via Search API (created:>date + sort=stars) | `api.github.com/search/repositories` | Optional GITHUB_TOKEN |
| **arxiv-cn-daily** | Fetch latest AI/ML papers by category and date | `export.arxiv.org/api/query` (Atom XML) | ❌ |
| **hackernews-ai-trending** | Fetch AI stories from HN via Algolia (must use `search_by_date`) | `hn.algolia.com/api/v1/search_by_date` | ❌ |
| **ai-papers-trending** | Trending & highly-cited AI research (Papers with Code alternative) | `api.openalex.org` + Semantic Scholar bulk fallback | ❌ |
| **html-report-cn** | Generate self-contained Chinese HTML briefings from structured news | Pure prompt + template | ❌ |
| **podcast-scriptwriter** | Turn news into 3-min two-host Chinese podcast script with tone annotations | Pure prompt | ❌ |
| **voxcpm-tts** | Synthesize speech via OpenBMB VoxCPM (30 langs, 9 dialects, voice cloning) | `pip install voxcpm` + HuggingFace weights | ❌ (open-source model) |

**Zero-installation for 12/13 skills** — they only need `curl` + `python3` (system-provided). Only **voxcpm-tts** requires `pip install voxcpm` and a GPU for optimal use.

---

## Install

```bash
# Clone or unzip this pack, then:
cd pilotdeck-skills-pack
./install.sh
```

The installer:
1. Copies each `<skill>/` directory to `~/.qoderwork/skills/`
2. Backs up any existing installation (`.bak-YYYYMMDD-HHMMSS` suffix)
3. Sanity-checks reachability of the 10 primary data-source domains
4. Reminds you about optional `voxcpm` install if voxcpm-tts is included

Custom target directory:

```bash
PILOTDECK_SKILLS_DIR=/path/to/skills ./install.sh
```

---

## Uninstall

```bash
rm -rf ~/.qoderwork/skills/{wechat-mp-fetch,zhihu-answer-fetch,bilibili-video-info,douban-media-lookup,juejin-article-search,weibo-hot-search,github-trending,arxiv-cn-daily,hackernews-ai-trending,ai-papers-trending,html-report-cn,podcast-scriptwriter,voxcpm-tts}
```

Or restore from the timestamped backups the installer creates.

---

## Combining Skills — Reference Workflow: AIGC Radar

A daily AI-industry briefing pipeline using six of these skills:

```
                     ┌─ arxiv-cn-daily
Cron (08:00 daily) ─┼─ hackernews-ai-trending
                     ├─ github-trending
                     ├─ ai-papers-trending
                     └─ weibo-hot-search
                              │
                              ▼
              ┌──────────────────────────┐
              │   Merge & normalize      │
              │  (dedup, tag, timestamp) │
              └──────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
           html-report-cn      podcast-scriptwriter
                    │                   │
                    ▼                   ▼
            briefing.html          voxcpm-tts
                                        │
                                        ▼
                             episode-2026-07-04.wav
```

Same pipeline works for tech-community-focused, product-launch-focused, or research-focused briefings — swap the input skills.

---

## Test Evidence

Every skill in this pack was tested three times against live APIs. Full test records:

- **[TestReport.md](../PilotDeck_Skills_TestReport.md)** — 65 test cases, per-skill judgment (GO / GO_WITH_CAUTION / NO_GO), root-cause analysis
- **[Dependencies.md](../PilotDeck_Skills_Dependencies.md)** — component matrix, reachability by region, plugin.json template, environment self-check script
- **[tests/round{1,2,3}/](../pilotdeck-research/tests/)** — raw curl responses (65 files)

**Final verdict**: 8 GO / 5 GO_WITH_CAUTION / 0 NO_GO.

The 5 GO_WITH_CAUTION items each have a limitation clearly documented in their SKILL.md:
- `zhihu-answer-fetch` — single-answer body truncated ~2K chars anonymously
- `douban-media-lookup` — leaked apikey may rotate; fallback to book web scrape
- `arxiv-cn-daily` — no data on weekends; 3-second rate limit
- `hackernews-ai-trending` — must use `search_by_date` endpoint (not `search`)
- `voxcpm-tts` — needs GPU + HF network access; edge-tts is fallback

---

## Compliance & Ethics

- **All data sources are public**. No login-only data, no reverse-engineered signing (except a well-documented WBI reference for advanced Bilibili search — not enabled in the default flow).
- **Intentionally excluded: Xiaohongshu (小红书)**. Rednote's anti-scraping is prohibitively aggressive (monthly signature rotation, TLS fingerprinting, aggressive rate limits) and there is a public 2025 court judgment awarding ¥4.9M in damages against a scraper. No stable public path exists.
- **Douban apikey caveat**: The apikey used by `douban-media-lookup` is leaked from Douban's own frozen v2 API. It works today but may be revoked at any time. The skill treats revocation as a first-class failure mode with fallback.
- **Rate limits are honored** in every skill's example code (arXiv 3s, Zhihu 3-5s, WeChat 3s, Douban 1-2s).
- **No user tracking** — skills are pure functions with no telemetry.

---

## License

MIT — do whatever you want, but attribution is appreciated.

---

## Credits

- Inspired by the [PilotDeck](https://github.com/OpenBMB/PilotDeck) ecosystem challenge.
- SKILL.md format follows [Anthropic Skills](https://github.com/anthropics/skills).
- Root-cause analysis techniques borrowed from cloud-service SRE playbooks.

Contributions & bug reports welcome — especially fresh Douban apikeys 😉
