---
name: wechat-mp-fetch
description: Fetch full text and metadata from WeChat public account articles (mp.weixin.qq.com). Use when the user provides a WeChat article URL, asks to read a 公众号 article, extract text from a WeChat post, or archive a mp.weixin.qq.com link. Requires a WeChat-family User-Agent — other UAs return degraded pages.
---

# WeChat Public Account Article Fetcher

Given a `mp.weixin.qq.com/s/*` URL, fetch the article's title, author, publish date, and full body text. Uses server-side-rendered HTML — no login, no cookies, no signing required, but the User-Agent header is critical.

**Verified 2026-07-04**: A single curl with the MicroMessenger UA reliably returns the full article HTML (~3 MB with all inline scripts/styles). The article body is present in a `<div id="js_content">` element.

**Critical**: Do NOT use `Googlebot`, `curl/x.y`, or a generic UA — those return a stripped-down 42-line variant page without the article body.

## Quick Start

### Fetch an article

```bash
URL="https://mp.weixin.qq.com/s/xxxxxxxxxxxxxxxxxxxxxx"
curl -s -H "User-Agent: Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.134 Mobile Safari/537.36 MicroMessenger/8.0.50.2701(0x28003253) Process/toolsmp WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64" \
  "$URL" -o article.html
```

### Extract title + body

```python
import re, html, sys

raw = open('article.html').read()

# Title
m = re.search(r'<h1[^>]*class="[^"]*rich_media_title[^"]*"[^>]*>(.*?)</h1>', raw, re.DOTALL)
title = html.unescape(re.sub(r'<[^>]+>', '', m.group(1)).strip()) if m else '(no title found)'

# Author (公众号名 / 署名)
m = re.search(r'<a[^>]+id="js_name"[^>]*>(.*?)</a>', raw, re.DOTALL)
author = html.unescape(re.sub(r'<[^>]+>', '', m.group(1)).strip()) if m else ''

# Publish date (yyyy-mm-dd)
m = re.search(r'<em[^>]+id="publish_time"[^>]*>(.*?)</em>', raw, re.DOTALL)
publish = m.group(1).strip() if m else ''

# Body
m = re.search(r'<div\b[^>]*id="js_content"[^>]*>(.*?)</div>\s*<script', raw, re.DOTALL)
if m:
    body_html = m.group(1)
    # Preserve paragraph breaks
    body_html = re.sub(r'</p\s*>', '\n\n', body_html, flags=re.IGNORECASE)
    body_html = re.sub(r'<br\s*/?>', '\n', body_html, flags=re.IGNORECASE)
    body = re.sub(r'<[^>]+>', '', body_html)
    body = html.unescape(body).strip()
    body = re.sub(r'\n{3,}', '\n\n', body)
else:
    body = '(article not found — check ret code below)'

print(f"Title:   {title}")
print(f"Author:  {author}")
print(f"Date:    {publish}")
print(f"---")
print(body)
```

## Return Codes (WeChat's `ret`)

Scan the HTML for `var ret = '...'` to detect status:

| `ret` | Meaning |
|-------|---------|
| absent | Article renders normally |
| `-2` | Article deleted, unpublished, or invalid ID |
| `1` | Rate-limited / risk control triggered |

Detect with:

```python
m = re.search(r"var\s+ret\s*=\s*['\"]([^'\"]+)['\"]", raw)
if m and m.group(1) != '0':
    print(f"[error] WeChat returned ret={m.group(1)}")
```

## Common Workflows

### Batch archive a list of URLs

```bash
while read URL; do
  echo "Fetching: $URL"
  curl -s -H "User-Agent: Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.134 Mobile Safari/537.36 MicroMessenger/8.0.50.2701(0x28003253)" \
    "$URL" -o "$(echo "$URL" | md5sum | cut -c1-12).html"
  sleep 3   # be polite
done < urls.txt
```

### One-liner Chinese title extraction

```bash
curl -s -H "User-Agent: Mozilla/5.0 ... MicroMessenger/8.0.50.2701(0x28003253)" "$URL" \
  | grep -oE '<h1[^>]*rich_media_title[^>]*>[^<]+</h1>' \
  | sed 's/<[^>]*>//g' | xargs
```

## Limitations

- **URL required** — this skill does not search or discover articles. Pair with a search source (WeChat search on Sogou, or third-party RSS aggregators like WeWe-RSS) for discovery.
- **UA-locked**: MicroMessenger UA is the only reliable choice. A regular desktop Chrome UA works most of the time but may occasionally get the stripped page.
- **Deleted articles return `ret=-2`** with an error page — no way to recover the content.
- **Rate-limit risk**: high-frequency scraping from the same IP triggers CAPTCHA/risk control. Keep to ≤1 req/3sec per IP.
- **Images embedded as `data-src`**, not `src` — WeChat lazy-loads. If you need images, extract `data-src` instead of `src`.
- **Anti-copy dynamic content**: some articles inject invisible interfering characters via JS. The static HTML extract is still readable but may contain noise.

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| Page ~40 lines, no `js_content` | Wrong UA (Googlebot, curl default, etc.) | Use MicroMessenger UA |
| `ret='-2'` in HTML | Article deleted / invalid ID | Report to caller; do not retry |
| `ret='1'` or CAPTCHA page | IP rate-limited | Wait 10 min, use different IP, or lower frequency |
| Body has invisible garbage chars | Anti-copy interference | Post-process: strip `\u200B`, `\u200C`, `\u200D`, `\uFEFF` |
| Title/body extraction returns None | HTML structure changed | Inspect saved HTML, adjust regex — WeChat rarely changes markup but it happens |

## References

- Article URL format: `https://mp.weixin.qq.com/s/{share_id}` or `?__biz=X&mid=Y&idx=Z&sn=W`
- Body element: `<div id="js_content">`
- Title element: `<h1 class="rich_media_title">`
- No API endpoint — this is HTML scraping of the SSR page.
- Discovery/search is not covered here (search Sogou WeChat or self-host WeWe-RSS separately).
