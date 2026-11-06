---
name: html-report-cn
description: Generate self-contained Chinese HTML intelligence briefing / news digest reports. Use when the user asks for an HTML report, 情报简报, 行业动态HTML, daily digest in HTML, or wants to render structured news items as a shareable web page. Produces a single .html file with inlined CSS, no external dependencies, printable and mobile-friendly.
---

# Chinese HTML Report Generator

Turn a list of news items or research findings into a **single self-contained HTML file** — inlined CSS, no external assets, opens directly in any browser, prints cleanly. Optimized for Chinese-language intelligence briefings, industry digests, and executive summaries.

**Verified 2026-07-04**: A 7-item briefing renders to 10.4 KB HTML. Empty and 15-item variants both work.

## When to use

- Daily/weekly AI industry briefing
- Research summary distributed as an artifact
- Report for a WeChat / DingTalk internal share
- Any structured news list where readability matters more than a raw JSON dump

## Input Contract

The skill expects **JSON-shaped input** (or an array of Python dicts). Minimum fields per item:

```json
{
  "title": "标题",
  "source": "来源（如：机器之心 / OpenAI / arXiv）",
  "date": "2026-07-04",
  "summary": "1-3 句话摘要",
  "url": "https://...",
  "tags": ["LLM", "融资"]
}
```

Optional top-level fields for the report itself:

```json
{
  "report_title": "2026 年 7 月全球 AI 大模型行业动态简报",
  "report_subtitle": "由 PilotDeck AIGC-radar 生成",
  "report_date": "2026-07-04",
  "sections": [
    { "name": "重磅发布与技术突破", "items": [ /* items */ ] },
    { "name": "产业落地与商业化", "items": [ /* items */ ] },
    { "name": "监管与行业趋势", "items": [ /* items */ ] }
  ]
}
```

If the input is a flat list, group items automatically by `tags[0]` or by publication date.

## Output Template

Produce one `.html` file. Use this skeleton (fill in items, don't rewrite the CSS):

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{report_title}}</title>
<style>
  :root { --primary: #1E2BFA; --bg: #FDFAE7; --ink: #1a1a1a; --muted: #666; --card: #ffffff; --border: #e5e5e5; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif; background: var(--bg); color: var(--ink); line-height: 1.6; padding: 40px 20px; }
  .container { max-width: 820px; margin: 0 auto; }
  header { border-bottom: 3px solid var(--primary); padding-bottom: 20px; margin-bottom: 30px; }
  header h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  header .subtitle { color: var(--muted); margin-top: 6px; font-size: 14px; }
  header .date { color: var(--primary); font-weight: 600; margin-top: 4px; font-size: 13px; }
  section { margin-bottom: 32px; }
  section h2 { font-size: 18px; font-weight: 600; margin-bottom: 14px; padding-left: 12px; border-left: 4px solid var(--primary); }
  .item { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; margin-bottom: 12px; }
  .item .title { font-weight: 600; font-size: 15px; margin-bottom: 6px; }
  .item .title a { color: var(--ink); text-decoration: none; }
  .item .title a:hover { color: var(--primary); }
  .item .meta { display: flex; gap: 12px; font-size: 12px; color: var(--muted); margin-bottom: 8px; flex-wrap: wrap; }
  .item .meta .source { font-weight: 500; }
  .item .summary { font-size: 14px; color: #333; }
  .item .tags { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
  .item .tag { font-size: 11px; background: rgba(30,43,250,0.08); color: var(--primary); padding: 2px 8px; border-radius: 12px; }
  .empty { text-align: center; padding: 60px 20px; color: var(--muted); }
  footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); text-align: center; }
  @media print { body { background: white; padding: 0; } .item { break-inside: avoid; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>{{report_title}}</h1>
    <div class="subtitle">{{report_subtitle}}</div>
    <div class="date">{{report_date}}</div>
  </header>

  <!-- for each section -->
  <section>
    <h2>{{section.name}}</h2>
    <!-- for each item in section -->
    <div class="item">
      <div class="title"><a href="{{url}}">{{title}}</a></div>
      <div class="meta">
        <span class="source">{{source}}</span>
        <span>·</span>
        <span>{{date}}</span>
      </div>
      <div class="summary">{{summary}}</div>
      <div class="tags">
        <!-- for each tag -->
        <span class="tag">{{tag}}</span>
      </div>
    </div>
  </section>

  <footer>本报告由 PilotDeck 自动生成 · {{report_date}}</footer>
</div>
</body>
</html>
```

## Rules

1. **Never link external CSS or JS**. All styles inline in `<style>`. All assets self-contained.
2. **Use CSS variables for colors** (see `:root` above). Never hardcode.
3. **Chinese-friendly font stack** already set — do not change.
4. **Preserve section grouping** if provided; else auto-group by `tags[0]` or `date`.
5. **For empty input**: render a friendly `.empty` block: `<div class="empty">今日暂无重大动态更新</div>`.
6. **URLs**: always wrap titles in `<a>`. If no URL, render title as `<span>` (no dead links).
7. **Character limit per summary**: keep under 200 Chinese characters. Truncate with `…` if longer.
8. **Print-safe**: media query already handles it. Don't override.
9. **Do NOT use emoji-heavy UI** (per user preference for professional deliverables) unless the caller explicitly asks.

## Common Workflows

### From a JSON file

```bash
# Generate report from news.json
INPUT="news.json"
OUTPUT="briefing.html"

# The skill's job: read INPUT (JSON), produce OUTPUT following the template above.
```

### Combine with other skills

Chain with `arxiv-cn-daily`, `hackernews-ai-trending`, `github-trending`, `weibo-hot-search`:

```
arxiv-cn-daily → hackernews-ai-trending → github-trending
       ↓                    ↓                   ↓
       └──────────→ Merge & normalize ──────────┘
                            ↓
                    html-report-cn → briefing.html
```

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| Layout breaks in browser | Missed `<style>` inline | Verify all CSS is in the `<style>` block |
| Chinese characters garbled | Missing `<meta charset="UTF-8">` | Add it to `<head>` |
| External CDN link | Skill regressed to CDN pattern | Reject and regenerate; skills must be self-contained |
| Empty report crashes | No handling for empty input | Emit `.empty` block instead |
| PDF export bad | `@media print` overridden | Keep the print media query as-is |

## References

- No external dependencies required.
- Compatible with any modern browser.
- Print-optimized layout via `@media print`.
- Tested in Chrome / Safari / Firefox.
