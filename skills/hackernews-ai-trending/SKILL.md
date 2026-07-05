---
name: hackernews-ai-trending
description: Fetch AI-related trending stories from Hacker News via the Algolia HN Search API. Use when the user asks for HN AI news, Hacker News trending, latest AI discussions on HN, or when the user mentions news.ycombinator.com. Retrieves recent stories with titles, URLs, points, and comment counts, filterable by keyword and time window.
---

# Hacker News AI Trending

Fetch trending stories from Hacker News (news.ycombinator.com) filtered by keyword and time. Uses Algolia's public HN Search API — no authentication, 10,000 requests/hour quota, JSON responses.

**Verified 2026-07-04**: The `search_by_date` endpoint works. **Do NOT use `/search`** for numeric filtering — it returns HTTP 400 with `invalid numeric attribute(points)`. Only `search_by_date` accepts `numericFilters=created_at_i>...`.

## Quick Start

### Recent AI stories (last 24 hours)

```bash
# macOS
TIMESTAMP=$(date -v-1d +%s)
# Linux
# TIMESTAMP=$(date -d "1 day ago" +%s)

curl -s "https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&numericFilters=created_at_i%3E${TIMESTAMP}&hitsPerPage=20"
```

**Response** (verified structure):
```json
{
  "hits": [
    {
      "objectID": "48782457",
      "title": "Show HN: I replaced my $500/mo legal SaaS with an AI-generated toolkit",
      "url": "https://example.com/...",
      "author": "some_user",
      "points": 42,
      "num_comments": 15,
      "created_at": "2026-07-04T03:39:58Z",
      "created_at_i": 1783136398,
      "story_text": null
    }
  ],
  "nbHits": 162,
  "page": 0,
  "nbPages": 9,
  "hitsPerPage": 20
}
```

### Filter by minimum points (client-side)

The API does NOT accept `numericFilters=points>N` — it must be filtered locally after retrieval:

```bash
TIMESTAMP=$(date -v-1d +%s)
curl -s "https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&numericFilters=created_at_i%3E${TIMESTAMP}&hitsPerPage=100" \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
hot = [h for h in data['hits'] if h.get('points', 0) >= 20]
hot.sort(key=lambda h: h.get('points', 0), reverse=True)
for h in hot[:10]:
    print(f\"[{h['points']:>4} pts, {h['num_comments']:>3} comments] {h['title']}\")
    print(f\"     {h.get('url') or 'https://news.ycombinator.com/item?id=' + h['objectID']}\")
"
```

## Query Parameters

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `query` | Full-text search | `AI`, `LLM+OR+GPT`, `%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD` (Chinese) |
| `tags` | Content type filter | `story`, `comment`, `show_hn`, `ask_hn`, `front_page`, `author_USERNAME` |
| `numericFilters` | Time filter (URL-encoded `>` = `%3E`) | `created_at_i%3E1783000000` |
| `hitsPerPage` | Page size, max 1000 | `20`, `100` |
| `page` | 0-based page index | `0`, `1` |

**Multiple filters**: comma-separated, AND logic. Example: `numericFilters=created_at_i%3E1783000000,num_comments%3E10`.

## Common Workflows

### Broad AI keyword sweep

```bash
TIMESTAMP=$(date -v-1d +%s)
QUERY="AI+OR+LLM+OR+GPT+OR+%22machine+learning%22"
curl -s "https://hn.algolia.com/api/v1/search_by_date?query=${QUERY}&tags=story&numericFilters=created_at_i%3E${TIMESTAMP}&hitsPerPage=50"
```

### Show HN launches (past week)

```bash
WEEK_AGO=$(date -v-7d +%s)
curl -s "https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&numericFilters=created_at_i%3E${WEEK_AGO}&hitsPerPage=50"
```

### Ask HN discussions on a topic

```bash
curl -s "https://hn.algolia.com/api/v1/search_by_date?query=LLM+deployment&tags=ask_hn&hitsPerPage=20"
```

## Limitations

- **`points` numeric filter unsupported** — filter client-side after retrieval.
- **Relevance scoring**: `search_by_date` sorts by time (newest first). If you need relevance ordering, use `/search` — but you can't combine relevance ordering with time filtering.
- **Chinese keywords**: URL-encode using `python3 -c "import urllib.parse; print(urllib.parse.quote('人工智能'))"`.
- **Empty `query`**: returns all matching stories in time window (useful for "everything today").
- **Rate limit**: 10,000 req/h — extremely generous, shouldn't hit in normal use.

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| HTTP 400 `invalid numeric attribute(points)` | Used `numericFilters=points>N` | Switch to client-side filter |
| Empty `hits: []` | No matches or too-narrow filter | Broaden query or extend time window |
| `nbHits: 0` on common query | Wrong endpoint (using `/search` for time-filtered) | Use `/search_by_date` |
| Malformed JSON | Network truncation | Retry once |

## References

- Base URL: `https://hn.algolia.com/api/v1/`
- Endpoints:
  - `/search` — relevance-ordered, no time filter support
  - `/search_by_date` — time-ordered, supports `created_at_i` filter
- Algolia HN Search docs: https://hn.algolia.com/api
- No authentication required.
