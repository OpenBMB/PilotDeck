---
name: juejin-article-search
description: Search technical articles on Juejin (掘金) and fetch full article content. Use when the user asks to search Juejin, find Chinese tech articles, look up 掘金 posts, or when the user mentions juejin.cn URLs. Covers keyword search across Chinese developer content and full-text extraction from SSR-rendered article pages.
---

# Juejin Article Search

Fetch technical articles from Juejin (掘金, juejin.cn) — one of China's most popular Chinese-language developer communities. Two capabilities: keyword search via public API, and full-text extraction from article pages.

**Verified 2026-07-04**: Both endpoints work without authentication, cookies, or User-Agent restrictions. Search API returns 20 results per call regardless of `limit` parameter.

## Quick Start

### Search articles by keyword

```bash
curl -s -H "Content-Type: application/json" \
  -X POST "https://api.juejin.cn/search_api/v1/search" \
  -d '{"key_word":"AI Agent","id_type":0,"cursor":"0","limit":10,"search_type":2,"sort_type":0,"version":1}'
```

**Request body fields**:
| Field | Value | Meaning |
|-------|-------|---------|
| `key_word` | string | Search keyword (Chinese OK, no encoding needed) |
| `id_type` | `0` | Fixed |
| `cursor` | `"0"` | Pagination offset (string) |
| `limit` | `10` | **Ignored — always returns 20**. Trim client-side. |
| `search_type` | `2` = article, `0` = mixed | Filter by content type |
| `sort_type` | `0` = comprehensive, `1` = newest, `2` = hottest | Ordering |
| `version` | `1` | Fixed |

**Response** (verified structure):
```json
{
  "err_no": 0,
  "err_msg": "success",
  "data": [
    {
      "result_model": {
        "article_info": {
          "article_id": "7296016269278150692",
          "title": "React Hooks 深入解析",
          "brief_content": "React Hooks 的引入使得...",
          "view_count": 12345,
          "digg_count": 678
        },
        "author_user_info": { "user_name": "..." },
        "category": { "category_name": "前端" },
        "tags": [ { "tag_name": "React" } ]
      }
    }
  ]
}
```

Extract `article_id` from each hit; use it in the fetch step below to get full content.

### Fetch full article content

The search API returns titles and 200-char summaries but **not full body**. To get full text, curl the article page — Juejin uses server-side rendering (Nuxt.js), so the entire article HTML is present in the response.

```bash
ARTICLE_ID="7296016269278150692"  # from search results
curl -s "https://juejin.cn/post/${ARTICLE_ID}" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  -o article.html
```

The full body sits inside `<article ...>...</article>` (with `class="markdown-body"`). Extract with:

```python
import re, sys, html
raw = open('article.html').read()
m = re.search(r'<article\b[^>]*>(.*?)</article>', raw, re.DOTALL)
if m:
    body_html = m.group(1)
    text = re.sub(r'<[^>]+>', '', body_html)
    text = html.unescape(text)
    text = re.sub(r'\s+', ' ', text).strip()
    print(text)
```

## Common Workflows

### Discover recent articles on a topic

```bash
curl -s -H "Content-Type: application/json" \
  -X POST "https://api.juejin.cn/search_api/v1/search" \
  -d '{"key_word":"云原生","id_type":0,"cursor":"0","limit":5,"search_type":2,"sort_type":1,"version":1}' \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
for hit in data.get('data', [])[:5]:
    info = hit['result_model']['article_info']
    print(f\"[{info['digg_count']:>4}👍] {info['title']}\")
    print(f\"     https://juejin.cn/post/{info['article_id']}\")
"
```

### Search + fetch full article in one shot

Combine the two calls: search → pick first hit → fetch full body.

## Limitations

- **`limit` parameter ignored**: server always returns 20 hits per page. Slice locally if you need fewer.
- **Article detail API broken from external clients**: `POST /content_api/v1/article/detail` returns `err_no: 2` without a valid session cookie. Use the SSR page approach above — it's simpler and reliable.
- **Rate limiting**: no explicit limit observed; keep to ≤1 req/sec to stay polite.
- **XSS-safe**: search API safely handles `<script>` payloads (no injection risk).

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| `err_no: 2, err_msg: "参数错误"` | Missing/wrong POST body field | Re-check the JSON body has all 7 required fields |
| Empty `data: []` | No results for keyword | Try broader keyword or `search_type: 0` |
| Article page 404 | Article deleted or wrong ID | Report to caller; do not retry |
| Chinese text garbled | Missing `-H "Content-Type: application/json"` | Add the header |

## References

- Search API endpoint: `https://api.juejin.cn/search_api/v1/search` (POST, JSON body)
- Article page: `https://juejin.cn/post/{article_id}` (GET, SSR HTML)
- No authentication required for either.
