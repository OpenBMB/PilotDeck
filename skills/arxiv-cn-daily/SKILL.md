---
name: arxiv-cn-daily
description: Fetch latest AI/ML papers from arXiv by category and date. Use when the user asks for arXiv papers, latest AI research, cs.AI cs.CL cs.LG cs.CV papers, arxiv daily digest, or paper monitoring. Uses arXiv's public Atom XML API — no authentication, but weekend skipDays and 3-second rate limit apply.
---

# arXiv Daily Fetcher

Query arXiv (arxiv.org) for the latest AI/ML papers by category, date range, and keyword. Returns Atom XML with paper title, abstract, authors, and PDF link.

**Verified 2026-07-04**: `export.arxiv.org/api/query` works reliably for 15+ years. RSS returns empty on Sat/Sun (arXiv doesn't publish weekends — this is normal, not a failure).

## Quick Start

### Latest cs.AI papers

```bash
curl -s "https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=10"
```

**Response** (Atom XML, verified):
```xml
<feed xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults>187812</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2607.02514v1</id>
    <title>Distributed Attacks in Persistent-State AI Control</title>
    <summary>As AI coding agents become more autonomous...</summary>
    <published>2026-07-02T17:59:56Z</published>
    <updated>2026-07-02T17:59:56Z</updated>
    <author><name>Josh Hills</name></author>
    <category term="cs.AI"/>
    <link href="https://arxiv.org/abs/2607.02514v1" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/2607.02514v1" rel="related" type="application/pdf"/>
  </entry>
</feed>
```

### Multi-category (AI + NLP + LLM + CV)

```bash
curl -s "https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG+OR+cat:cs.CV&sortBy=submittedDate&sortOrder=descending&max_results=20"
```

### Parse in Python

```python
import xml.etree.ElementTree as ET
import subprocess

xml = subprocess.check_output([
    'curl', '-s',
    'https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=10'
])

ns = {'atom': 'http://www.w3.org/2005/Atom'}
root = ET.fromstring(xml)
for entry in root.findall('atom:entry', ns):
    title = entry.find('atom:title', ns).text.strip().replace('\n', ' ')
    published = entry.find('atom:published', ns).text
    authors = [a.find('atom:name', ns).text for a in entry.findall('atom:author', ns)]
    summary = entry.find('atom:summary', ns).text.strip()
    pdf = next((l.get('href') for l in entry.findall('atom:link', ns) if l.get('type') == 'application/pdf'), None)
    print(f"[{published[:10]}] {title}")
    print(f"  Authors: {', '.join(authors[:3])}{' et al.' if len(authors) > 3 else ''}")
    print(f"  PDF: {pdf}")
    print(f"  Abstract: {summary[:200]}...")
    print()
```

## Query Syntax

| Prefix | Meaning | Example |
|--------|---------|---------|
| `cat:` | Category | `cat:cs.AI` |
| `ti:` | Title | `ti:transformer` |
| `au:` | Author | `au:LeCun` |
| `abs:` | Abstract | `abs:attention` |
| `all:` | Any field | `all:agent` |

**Boolean**: `AND`, `OR`, `ANDNOT`. Wrap in URL — spaces become `+`.

**Date range** (submitted): `submittedDate:[YYYYMMDDTTTT+TO+YYYYMMDDTTTT]` (TTTT = 24h GMT time to minute precision).

**Common AI categories**:
- `cs.AI` — Artificial Intelligence
- `cs.CL` — Computation and Language (NLP)
- `cs.LG` — Machine Learning
- `cs.CV` — Computer Vision
- `cs.NE` — Neural and Evolutionary Computing
- `stat.ML` — Machine Learning (Statistics)

## Common Workflows

### Papers submitted in the last 3 days

```bash
NOW=$(date -u +%Y%m%d0000)
THREE_DAYS_AGO=$(date -v-3d -u +%Y%m%d0000 2>/dev/null || date -u -d "3 days ago" +%Y%m%d0000)
curl -s "https://export.arxiv.org/api/query?search_query=cat:cs.AI+AND+submittedDate:%5B${THREE_DAYS_AGO}+TO+${NOW}%5D&sortBy=submittedDate&sortOrder=descending&max_results=30"
```

### Author-focused query

```bash
curl -s "https://export.arxiv.org/api/query?search_query=au:%22Yann+LeCun%22&sortBy=submittedDate&sortOrder=descending&max_results=10"
```

### Keyword within an area

```bash
curl -s "https://export.arxiv.org/api/query?search_query=cat:cs.CL+AND+all:%22large+language+model%22&sortBy=submittedDate&sortOrder=descending&max_results=20"
```

## Limitations

- **3-second rate limit** — arXiv's official policy. Enforce `sleep 3` between calls.
- **Weekend skipDays** — arXiv publishes Mon–Fri only. RSS on Sat/Sun returns empty `<channel>` (this is normal).
- **`max_results` ceiling: 2000** per call; total pagination limit: 30,000 results.
- **No server-side rate limit protection**: `max_results=500` returns 1.2 MB uncomplaining. Keep values ≤50 for latency.
- **Delay of a few hours**: newest submissions may take 30 min – 6 h to be searchable via API.
- **Atom XML, not JSON** — parse with `xml.etree.ElementTree` or `feedparser`.

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| Empty `<feed>` (no entries) on weekend | arXiv skipDays | Retry Monday, or use API (not RSS) |
| Empty `<feed>` on invalid category | Invalid `cat:` term | Verify category slug |
| HTTP timeout | High traffic / network | Retry with backoff |
| Duplicated results across pages | `sortOrder` mismatch | Ensure consistent `sortBy` + `sortOrder` |
| Feed cut off mid-entry | Response too large | Reduce `max_results` |

## References

- API docs: https://info.arxiv.org/help/api/user-manual.html
- RSS docs: https://info.arxiv.org/help/rss.html
- Category taxonomy: https://arxiv.org/category_taxonomy
- Base URL: `https://export.arxiv.org/api/query` (GET only)
- No authentication required.
