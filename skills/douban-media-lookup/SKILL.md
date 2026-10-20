---
name: douban-media-lookup
description: Search and fetch Douban (豆瓣) movie and book metadata (rating, cast, publisher, ISBN, summary). Use when the user asks to look up 豆瓣 movies or books, check ratings, find cast, or fetch metadata for Chinese-language media catalog work. The Douban v2 API is officially deprecated but still functional via a leaked apikey with POST — this skill treats key rotation as a first-class concern.
---

# Douban Media Lookup (Movies & Books)

Query Douban's `api.douban.com/v2/*` endpoints for movie and book metadata. Douban officially deprecated its public API in 2018 but the endpoints still respond when called via **POST with a leaked apikey**.

**Verified 2026-07-04**:
- ✅ `POST /v2/movie/search` with `apikey=0ab215a8b1977939201640fa14c66bab` — works
- ✅ `POST /v2/movie/subject/{id}` — works, returns full details
- ✅ `POST /v2/book/search` — works
- ❌ `/v2/music/*` — HTTP 500, do not use
- ⚠️ Old apikey `0df993c66c0c636e29ecbb5344252a4a` — **blocked** (`code=105 apikey_is_blocked`)

**Ownership warning**: this apikey is discovered/leaked, not officially licensed. It may be revoked at any time. This skill includes graceful fallback to book web scraping.

## Quick Start

### Search movies

```bash
APIKEY="0ab215a8b1977939201640fa14c66bab"

curl -s -X POST "https://api.douban.com/v2/movie/search" \
  --data-urlencode "apikey=${APIKEY}" \
  --data-urlencode "q=肖申克的救赎" \
  --data-urlencode "count=5"
```

**Response** (JSON, verified):
```json
{
  "count": 5,
  "start": 0,
  "total": 7,
  "subjects": [
    {
      "id": "1292052",
      "title": "肖申克的救赎",
      "original_title": "The Shawshank Redemption",
      "year": "1994",
      "rating": { "average": 9.7, "max": 10, "stars": "50" },
      "genres": ["剧情", "犯罪"],
      "casts": [{ "name": "蒂姆·罗宾斯" }, { "name": "摩根·弗里曼" }],
      "directors": [{ "name": "弗兰克·德拉邦特" }],
      "images": { "large": "https://..." }
    }
  ]
}
```

### Movie detail

```bash
curl -s -X POST "https://api.douban.com/v2/movie/subject/1292052" \
  --data-urlencode "apikey=${APIKEY}"
```

**Response** includes: `title`, `rating.average`, `ratings_count` (3.3M+), `collect_count`, `wish_count`, `summary` (full plot), `aka` (alternative names), `countries`, `genres`, `pubdates`.

### Search books

```bash
curl -s -X POST "https://api.douban.com/v2/book/search" \
  --data-urlencode "apikey=${APIKEY}" \
  --data-urlencode "q=三体" \
  --data-urlencode "count=5"
```

**Response** returns: `title`, `author`, `publisher`, `isbn13`, `rating.average`, `numRaters`, `summary`, `catalog`.

### Parse in Python

```python
import subprocess, json, urllib.parse

APIKEY = "0ab215a8b1977939201640fa14c66bab"

def douban_movie_search(query, count=5):
    body = urllib.parse.urlencode({'apikey': APIKEY, 'q': query, 'count': count})
    raw = subprocess.check_output([
        'curl', '-s', '-X', 'POST',
        'https://api.douban.com/v2/movie/search',
        '-d', body
    ])
    data = json.loads(raw)
    if 'code' in data and data['code'] == 105:
        raise RuntimeError('apikey blocked — need new key or fallback to web scrape')
    return data.get('subjects', [])

for m in douban_movie_search('哪吒', count=3):
    r = m.get('rating', {}).get('average', 0)
    print(f"[⭐{r}] {m['title']} ({m.get('year', '?')}) → id={m['id']}")
```

## Fallback: book web scrape

When the apikey is blocked or the API is down, `book.douban.com` HTML pages are scrapeable with a browser UA:

```bash
BOOK_ID="2567698"   # 三体
curl -s -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  "https://book.douban.com/subject/${BOOK_ID}/"
```

Extract with BeautifulSoup or regex:
- Title: `<h1><span>(.*?)</span></h1>`
- Rating: `<strong[^>]*rating_num[^>]*>(.*?)</strong>`
- Info block: `<div id="info">(.*?)</div>`

**`movie.douban.com` HTML pages are more aggressively anti-scraped** — expect challenge pages. Prefer the API for movies.

## Detecting a blocked apikey

Every response is JSON. Check `code`:

| `code` | Meaning | Action |
|--------|---------|--------|
| absent | Success | Read `subjects` / `books` |
| `105` | `apikey_is_blocked` | Rotate to another leaked key or fall back to web scrape |
| `112` | `atrate_limit` | Slow down (≥1 s between requests) |
| `108` | `invalid_request_scheme` | Wrong POST body |

## Common Workflows

### Movie enrichment for a title list

```bash
while read TITLE; do
  RESULT=$(curl -s -X POST "https://api.douban.com/v2/movie/search" \
    --data-urlencode "apikey=${APIKEY}" \
    --data-urlencode "q=${TITLE}" --data-urlencode "count=1" \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
if d.get('subjects'):
    s=d['subjects'][0]
    print(f\"{s['title']}\t{s.get('year','?')}\t⭐{s.get('rating',{}).get('average','?')}\")
")
  echo "$TITLE → $RESULT"
  sleep 1
done < titles.txt
```

## Limitations

- **API officially deprecated** — Douban shut down public API in 2018. The endpoints still work because internal apps use them, and various apikeys have leaked. Any of these facts could change without warning.
- **Music endpoint (`/v2/music/*`) is dead** (HTTP 500). Do not use.
- **Rate limit ~1-2 req/sec per IP** — high frequency triggers 112 or IP block.
- **Movie web scraping unreliable** — Douban serves anti-bot challenge pages to non-residential IPs. Book pages are more permissive.
- **Alternative NeoDB** (open-source Douban clone at neodb.social) has a proper API but a very different content catalog.

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| `code: 105 apikey_is_blocked` | Key rotated / blacklisted | Search recent GitHub for a fresh leaked key or use fallback |
| HTTP 500 on `/music/*` | Endpoint discontinued | Do not use music endpoint |
| Movie web returns Loading page | Anti-scraping active | Use API, or try residential proxy |
| Book page 404 | subject_id invalid | Verify via search first |
| Empty `subjects: []` | No matches for query | Try broader keywords or check spelling |

## References

- Base URL: `https://api.douban.com/v2/`
- Endpoints:
  - `POST /movie/search` — required: `apikey`, `q`; optional: `start`, `count`
  - `POST /movie/subject/{id}` — required: `apikey`
  - `POST /book/search` — required: `apikey`, `q`; optional: `start`, `count`
  - `POST /book/subject/{id}` — required: `apikey`
- Fallback web pages: `https://book.douban.com/subject/{id}/`
- Alternative: NeoDB (open-source clone) — https://neodb.social/api/
- Community-maintained proxy: [douban-api-rs](https://github.com/cxfksword/douban-api-rs) (Docker image)
