---
name: ai-papers-trending
description: Fetch trending and highly-cited AI/ML research papers via OpenAlex and Semantic Scholar APIs. Use when the user asks for trending AI papers, top-cited machine learning research, SOTA benchmark leaders, or when Papers with Code is mentioned. Papers with Code was decommissioned in 2025; this skill uses OpenAlex (concept-filtered by AI) as primary and Semantic Scholar bulk API as fallback.
---

# AI Papers Trending

Fetch trending or highly-cited AI/ML research papers. Papers with Code (paperswithcode.com) was **shut down and redirected to Hugging Face** in 2025. This skill uses two working alternatives:

- **Primary**: OpenAlex — open scholarly database, no auth, filter by AI concept + year, sort by citations.
- **Fallback**: Semantic Scholar bulk API — larger recall, no auth, sort client-side.

**Verified 2026-07-04**: OpenAlex `api.openalex.org/works` returns AI papers in ~90ms. `paperswithcode.com/api/v1/` HTTP 302 redirects to `huggingface.co/papers/trending` (dead API).

## Quick Start

### Top-cited AI papers of 2025

```bash
curl -s "https://api.openalex.org/works?filter=concepts.id:C154945302,publication_year:2025&sort=cited_by_count:desc&per_page=10"
```

`C154945302` is OpenAlex's concept ID for "Artificial intelligence". Change to:
- `C119857082` — Machine learning
- `C204321447` — Natural language processing
- `C47798520` — Computer vision
- `C50644808` — Deep learning

**Response** (JSON, verified structure):
```json
{
  "meta": {
    "count": 1340000,
    "db_response_time_ms": 91,
    "page": 1,
    "per_page": 10
  },
  "results": [
    {
      "id": "https://openalex.org/W...",
      "doi": "https://doi.org/10.xxxx/xxxxx",
      "title": "Some LLM paper title",
      "publication_date": "2025-06-15",
      "cited_by_count": 342,
      "authorships": [{ "author": { "display_name": "..." } }],
      "concepts": [{ "display_name": "Artificial intelligence", "score": 0.99 }],
      "abstract_inverted_index": { "The": [0], "paper": [1], "...": [2] },
      "primary_location": { "landing_page_url": "..." }
    }
  ]
}
```

### Reconstruct abstract from inverted index

OpenAlex stores abstracts as inverted indexes (word → positions) for anti-scraping. Rebuild:

```python
import json, subprocess

raw = subprocess.check_output([
    'curl', '-s',
    'https://api.openalex.org/works?filter=concepts.id:C154945302,publication_year:2025&sort=cited_by_count:desc&per_page=5'
])
data = json.loads(raw)
for w in data['results']:
    idx = w.get('abstract_inverted_index') or {}
    words = sorted(((pos, word) for word, positions in idx.items() for pos in positions))
    abstract = ' '.join(w for _, w in words)
    print(f"[⭐{w['cited_by_count']:>4}] {w['title']}")
    print(f"     {abstract[:200]}...")
    print(f"     {w.get('doi') or w.get('id')}")
    print()
```

## Query Parameters

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `filter=concepts.id:X` | Concept filter | `concepts.id:C154945302` (AI) |
| `filter=publication_year:X` | Year filter | `publication_year:2025` |
| `filter=type:article` | Publication type | `type:article` (excludes datasets, etc.) |
| `sort=cited_by_count:desc` | Order by citations | `cited_by_count:desc` |
| `sort=publication_date:desc` | Order by date | `publication_date:desc` |
| `per_page` | Page size (max 200) | `10`, `50` |
| `page` | 1-based page | `1`, `2` |
| `search=` | Full-text search | `search=large+language+model` |

**Combine filters with commas** (AND logic): `filter=concepts.id:C154945302,publication_year:2025`.

## Fallback: Semantic Scholar

If OpenAlex is unreachable or you need Computer Science–wide sweep:

```bash
curl -s "https://api.semanticscholar.org/graph/v1/paper/search/bulk?query=large+language+model&fieldsOfStudy=Computer+Science&fields=title,year,citationCount,url,abstract,authors&limit=100"
```

**Note**: `search/bulk` returns up to 1000 results per page but **does NOT sort by citations** — sort client-side. The regular `/paper/search` endpoint often returns HTTP 429 (rate limited).

```python
import json, subprocess
raw = subprocess.check_output([
    'curl', '-s',
    'https://api.semanticscholar.org/graph/v1/paper/search/bulk?query=large+language+model&fieldsOfStudy=Computer+Science&fields=title,year,citationCount,url&limit=100'
])
data = json.loads(raw)
papers = sorted(data.get('data', []), key=lambda p: p.get('citationCount') or 0, reverse=True)
for p in papers[:10]:
    print(f"[⭐{p.get('citationCount', 0):>4}] {p['title']} ({p.get('year', '?')})")
```

## Common Workflows

### Recent breakthrough papers (last 6 months, high citations)

```bash
curl -s "https://api.openalex.org/works?filter=concepts.id:C154945302,from_publication_date:2026-01-01&sort=cited_by_count:desc&per_page=10"
```

### Trending topic sweep

```bash
# LLM + Agent + RAG (union of concepts)
curl -s "https://api.openalex.org/works?filter=concepts.id:C154945302,publication_year:2025,default.search:agent+llm+rag&sort=cited_by_count:desc&per_page=15"
```

## Limitations

- **Papers with Code is dead** — do not use `paperswithcode.com/api/v1/*`; it 302 redirects to HF.
- **Hugging Face Papers API works but requires Bearer Token** (free registration). Not covered here; add if the primary sources are insufficient.
- **Citation counts lag by weeks** — brand-new papers won't rank high on `cited_by_count` even if hot on Twitter.
- **OpenAlex abstracts are inverted-indexed** — must be reconstructed as shown above.
- **Semantic Scholar `/search/bulk` doesn't sort** — always sort client-side.
- **No user-agent required** for either API, but consider adding `mailto=you@example.com` to OpenAlex requests for higher rate limits ("polite pool"): `?mailto=you@example.com&filter=...`.

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| HTTP 302 to `huggingface.co/papers/trending` | You called `paperswithcode.com` | Migrate to OpenAlex |
| HTTP 429 (Semantic Scholar) | Standard endpoint rate-limited | Use `/search/bulk` instead |
| Empty `results: []` | Concept ID wrong or filter too narrow | Verify concept ID at https://api.openalex.org/concepts?search=... |
| Abstract missing | Some old papers lack it | Skip the abstract field |

## References

- OpenAlex API docs: https://docs.openalex.org/
- OpenAlex works endpoint: `https://api.openalex.org/works` (GET)
- Semantic Scholar API: https://api.semanticscholar.org/api-docs/
- Semantic Scholar bulk endpoint: `https://api.semanticscholar.org/graph/v1/paper/search/bulk` (GET)
- No authentication required for either API.
- Papers with Code (deprecated): https://paperswithcode.com/ → returns 302
