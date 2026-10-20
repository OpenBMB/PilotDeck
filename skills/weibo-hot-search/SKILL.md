---
name: weibo-hot-search
description: Fetch Weibo (微博) real-time hot search list with search volumes and category tags. Use when the user asks about Weibo trending, 微博热搜, current hot topics on Chinese social media, or public opinion monitoring. Uses `weibo.com/ajax/statuses/hot_band` (requires Referer header) as primary source, tophub.today HTML as fallback.
---

# Weibo Hot Search Fetcher

Fetch Weibo's real-time hot search list (`微博热搜`) — 50 trending topics with search volumes and category tags. **Weibo aggressively blocks unauthenticated access**; the only reliable public path is `weibo.com/ajax/statuses/hot_band` **with a `Referer: https://weibo.com/` header**.

**Verified 2026-07-04**:
- ✅ Primary: `weibo.com/ajax/statuses/hot_band` + Referer → HTTP 200, 50 items with rich metadata
- ✅ Fallback: `tophub.today/n/KqndgxeLl9` → HTTP 200, ~58 items (aggregator, HTML)
- ❌ `m.weibo.cn/api/container/getIndex?containerid=...realtimehot` → HTTP 432 (rate-limited)
- ❌ `weibo.com/ajax/side/hotSearch` → HTTP 403 (login required)
- ❌ Public RSSHub instances → connection timeout

## Quick Start

### Primary: weibo.com hot_band API

```bash
curl -s \
  -H "Referer: https://weibo.com/" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  "https://weibo.com/ajax/statuses/hot_band"
```

**Response** (JSON, verified structure):
```json
{
  "ok": 1,
  "data": {
    "band_list": [
      {
        "word": "肖申克的救赎重映",
        "raw_hot": 1234567,
        "num": 1234567,
        "word_scheme": "#肖申克的救赎重映#",
        "category": "娱乐",
        "label_name": "热",
        "note": "扩展说明",
        "rank": 1,
        "onboard_time": 1730000000
      }
    ]
  }
}
```

`band_list` is ordered by rank. Fields:
- `word` — headline text
- `num` / `raw_hot` — search volume (integer)
- `category` — 娱乐 / 社会 / 时政 / 体育 / 财经 / etc.
- `label_name` — 热 / 新 / 沸 / 爆 (heat tier tag; empty for lower ranks)
- `word_scheme` — as it appears with `#` markup
- `rank` — 1-based position
- `onboard_time` — Unix timestamp when it entered the list

### Parse in Python

```python
import subprocess, json

raw = subprocess.check_output([
    'curl', '-s',
    '-H', 'Referer: https://weibo.com/',
    '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'https://weibo.com/ajax/statuses/hot_band'
])
data = json.loads(raw)
if data.get('ok') != 1:
    raise SystemExit(f"Weibo API returned ok={data.get('ok')}")

for item in data['data']['band_list'][:20]:
    label = f"[{item['label_name']}]" if item.get('label_name') else "    "
    print(f"{item['rank']:>2}. {label} {item['word']}  ({item.get('category', '?')})  {item.get('num', 0):,}")
```

## Fallback: tophub.today

When the primary endpoint fails (blocked, rate-limited), tophub.today mirrors 微博热搜:

```bash
curl -s -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  "https://tophub.today/n/KqndgxeLl9" -o tophub.html
```

Extract items with regex or BeautifulSoup — each row is a `<tr>` in the main table.

```python
import re
html = open('tophub.html').read()
rows = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL)
for row in rows[:20]:
    m_title = re.search(r'<td[^>]*>\s*<a[^>]*>(.*?)</a>', row, re.DOTALL)
    m_hot = re.search(r'<td[^>]*class="[^"]*al[^"]*"[^>]*>(.*?)</td>', row, re.DOTALL)
    if m_title:
        title = re.sub(r'<[^>]+>', '', m_title.group(1)).strip()
        hot = re.sub(r'<[^>]+>', '', m_hot.group(1)).strip() if m_hot else ''
        print(f"{title}\t{hot}")
```

## Common Workflows

### Auto-fallback wrapper

```python
import subprocess, json

def fetch_weibo_hot():
    # 1. try primary
    try:
        raw = subprocess.check_output([
            'curl', '-s', '--max-time', '10',
            '-H', 'Referer: https://weibo.com/',
            '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'https://weibo.com/ajax/statuses/hot_band'
        ])
        data = json.loads(raw)
        if data.get('ok') == 1 and data.get('data', {}).get('band_list'):
            return [
                {
                    'rank': it['rank'],
                    'title': it['word'],
                    'hot': it.get('num', 0),
                    'category': it.get('category'),
                    'label': it.get('label_name'),
                    'source': 'weibo'
                }
                for it in data['data']['band_list']
            ]
    except Exception as e:
        print(f'Primary failed: {e}')

    # 2. fallback tophub
    import re
    html = subprocess.check_output([
        'curl', '-s', '--max-time', '10',
        '-H', 'User-Agent: Mozilla/5.0',
        'https://tophub.today/n/KqndgxeLl9'
    ]).decode('utf-8', errors='ignore')
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL)
    items = []
    for i, row in enumerate(rows, 1):
        m = re.search(r'<a[^>]*>(.*?)</a>', row, re.DOTALL)
        if m:
            items.append({
                'rank': i,
                'title': re.sub(r'<[^>]+>', '', m.group(1)).strip(),
                'source': 'tophub'
            })
    return items[:50]

for item in fetch_weibo_hot()[:15]:
    print(item)
```

## Limitations

- **Referer is mandatory** — without `Referer: https://weibo.com/`, the endpoint returns HTTP 403.
- **Rate limits are aggressive** — call ≤1 req/min per IP; higher frequency triggers 432/403 for hours.
- **No historical data** — returns current top ~50 only. For history, log periodically to a database.
- **Some entries have `word_scheme` mismatch** — hashtag markup may include emoji or special chars.
- **`raw_hot` and `num` can differ** — `raw_hot` is un-cleaned; use `num` for display.
- **Cloud/data-center IPs may still fail** even with Referer — tophub fallback covers this.
- **Content moderation**: hot search list is heavily censored. Don't rely on it as a complete signal.

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| HTTP 403 `Forbidden` | Missing Referer header | Add `Referer: https://weibo.com/` |
| HTTP 432 empty body | IP rate-limited | Wait 30-60 min or fall back to tophub |
| `ok: 0` in response | Weibo internal error | Retry once, then fall back |
| Timeout | Cloud IP flagged | Use residential IP or fall back |
| tophub 200 but empty rows | Site layout changed | Adjust regex; check HTML manually |

## References

- Primary: `https://weibo.com/ajax/statuses/hot_band` (GET, requires Referer)
- Fallback: `https://tophub.today/n/KqndgxeLl9` (GET, HTML aggregator)
- Do NOT use: `m.weibo.cn/api/container/getIndex` (returns 432 for anonymous)
- Do NOT use: `weibo.com/ajax/side/hotSearch` (returns 403 without login cookie)
- No authentication tokens involved — Referer + browser UA is enough.
