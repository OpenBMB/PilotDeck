---
name: zhihu-answer-fetch
description: Fetch Zhihu (知乎) column articles with full body and single answers with truncated body via public JSON APIs. Use when the user asks to read a Zhihu article, fetch a 知乎 column, extract Zhihu answer content, or when the user mentions zhuanlan.zhihu.com or www.zhihu.com/question/*/answer/* URLs. Column articles return complete HTML content; single answers are truncated to ~2K chars without login.
---

# Zhihu Answer & Column Fetcher

Fetch Zhihu content via the `/api/v4/` JSON endpoints. Two modes:

1. **Column articles** (`zhuanlan.zhihu.com/p/*` or `/api/v4/columns/{id}/items`) — returns **full body** (8000+ chars) with no login.
2. **Single answers** (`/api/v4/answers/{id}?include=content`) — returns **truncated body** (~2000 chars, marked `content_need_truncated: true`).

**Verified 2026-07-04**: Both endpoints return valid JSON with a browser-like User-Agent. Full-answer body requires SESSDATA cookie — beyond this skill's scope.

**Do NOT** curl `zhuanlan.zhihu.com/p/{id}` or `www.zhihu.com/question/*/answer/*` HTML pages directly — they return a JS challenge (`zh-zse-ck`) that cannot be bypassed with plain curl.

## Quick Start

### Fetch a column's articles (full body)

```bash
COLUMN_ID="googledevelopers"   # from URL like https://zhuanlan.zhihu.com/googledevelopers
curl -s -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  "https://www.zhihu.com/api/v4/columns/${COLUMN_ID}/items?limit=10"
```

**Response** (JSON, verified):
```json
{
  "paging": { "is_end": false, "totals": 106, "next": "..." },
  "data": [
    {
      "id": 12345,
      "title": "Article title",
      "content": "<p>Full HTML article body — 8000+ chars typical</p>...",
      "excerpt": "First 200 chars summary",
      "author": { "name": "..." },
      "voteup_count": 42,
      "comment_count": 15,
      "url": "https://zhuanlan.zhihu.com/p/12345",
      "created": 1734567890
    }
  ]
}
```

### Fetch a single answer (truncated)

```bash
ANSWER_ID="2051400538"   # from URL like /question/xxx/answer/2051400538
curl -s -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  "https://www.zhihu.com/api/v4/answers/${ANSWER_ID}?include=content,excerpt,voteup_count,comment_count"
```

**Response** (JSON, verified):
```json
{
  "id": 2051400538,
  "content": "<p>Answer body — TRUNCATED to ~2000 chars</p>...",
  "content_need_truncated": true,
  "force_login_when_click_read_more": true,
  "excerpt": "First ~200 chars",
  "voteup_count": 2,
  "comment_count": 5,
  "author": { "name": "..." },
  "question": { "title": "The question title" }
}
```

If `content_need_truncated: true`, only the first ~2K chars are available anonymously. To get the full body, users must provide their own SESSDATA cookie (out of scope here).

### Parse in Python

```python
import json, subprocess, re, html

# Column articles → full text
raw = subprocess.check_output([
    'curl', '-s',
    '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'https://www.zhihu.com/api/v4/columns/googledevelopers/items?limit=5'
])
data = json.loads(raw)
for item in data.get('data', []):
    body_text = re.sub(r'<[^>]+>', '', item.get('content', ''))
    body_text = html.unescape(body_text).strip()
    print(f"[👍{item.get('voteup_count', 0):>4}] {item['title']}")
    print(f"     {item['url']}")
    print(f"     {body_text[:200]}...\n")
```

## Extract IDs from Zhihu URLs

| URL Pattern | ID Location |
|-------------|-------------|
| `https://zhuanlan.zhihu.com/{column_id}` | Column ID = last path segment (e.g., `googledevelopers`) |
| `https://zhuanlan.zhihu.com/p/{article_id}` | Article ID (numeric) — but **not directly fetchable via API without SESSDATA**. Use the column API to enumerate articles. |
| `https://www.zhihu.com/question/{q_id}/answer/{a_id}` | Answer ID = `{a_id}` (numeric) |
| `https://www.zhihu.com/answer/{a_id}` | Answer ID = `{a_id}` |

## Common Workflows

### Track a column's latest posts

```bash
curl -s -H "User-Agent: Mozilla/5.0" \
  "https://www.zhihu.com/api/v4/columns/googledevelopers/items?limit=5" \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
for item in data['data']:
    print(f'{item[\"title\"]}\t{item[\"url\"]}')
"
```

### Get an answer summary

```bash
curl -s -H "User-Agent: Mozilla/5.0" \
  "https://www.zhihu.com/api/v4/answers/${ANSWER_ID}?include=content,excerpt,voteup_count,comment_count" \
  | python3 -c "
import json, sys, re, html
d = json.load(sys.stdin)
print(f'Question: {d[\"question\"][\"title\"]}')
print(f'By {d[\"author\"][\"name\"]} | 👍{d[\"voteup_count\"]}')
print()
body = re.sub(r'<[^>]+>', '', d.get('content', ''))
print(html.unescape(body)[:1500] + ('...' if d.get('content_need_truncated') else ''))
"
```

## Limitations

- **Single-answer body is truncated to ~2000 chars** anonymously. Full body needs SESSDATA cookie (users can inject via env var, but the flow is out of scope here).
- **HTML page scraping doesn't work**: `curl zhuanlan.zhihu.com/p/{id}` returns 628 bytes of JS challenge. Only the JSON APIs are usable.
- **Rate limit**: ~20 req/session before HTTP 40362 error. Insert `sleep 3-5` between calls.
- **User-Agent required**: no UA → 40352 error / access denied.
- **Search endpoint requires WBI signing** — not covered here.
- **`/api/v4/articles/{id}`** requires `x-zse-96` signature — do not attempt with plain curl.

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| HTTP 404 with `error.code: 40352` | Wrong column/answer ID | Verify URL |
| HTTP 403 / 40362 error | Rate-limited by IP | Wait 5-10 min, add sleep between calls |
| `zh-zse-ck` HTML challenge | You called `zhuanlan.zhihu.com/p/*` HTML | Switch to `/api/v4/columns/{id}/items` |
| `content_need_truncated: true` | Anonymous answer fetch | Accept truncation or provide SESSDATA |
| `error.code: 10003` | You called `/api/v4/articles/{id}` (needs signing) | Use column endpoint instead |

## References

- Column API: `https://www.zhihu.com/api/v4/columns/{column_id}/items?limit=N`
- Answer API: `https://www.zhihu.com/api/v4/answers/{answer_id}?include=content,excerpt,voteup_count,comment_count`
- Required header: `User-Agent: Mozilla/5.0 ...` (any browser UA works)
- Anonymous access; full-answer body needs SESSDATA cookie.
