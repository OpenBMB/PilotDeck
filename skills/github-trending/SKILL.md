---
name: github-trending
description: Fetch trending GitHub repositories via the GitHub Search API. Use when the user asks for GitHub trending, hottest repos today/this week, popular Python/JavaScript/AI projects on GitHub, or newly-starred repositories. Uses api.github.com search endpoint (not the HTML trending page, which times out from many networks) with `created:>date + sort=stars` to approximate trending behavior.
---

# GitHub Trending

Fetch trending GitHub repositories filtered by language, time window, and topic. Uses the GitHub Search API instead of scraping `github.com/trending` (which frequently times out from mainland-China networks).

**Verified 2026-07-04**: `api.github.com/search/repositories` works reliably. GitHub's official trending algorithm is proprietary; this skill approximates it using `created:>date & sort=stars & order=desc`, which surfaces recently-created rapidly-starred repos.

## Quick Start

### Trending repos created in the last 24 hours

```bash
YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d "1 day ago" +%Y-%m-%d)
curl -s -H "Accept: application/vnd.github+json" \
  "https://api.github.com/search/repositories?q=created:>${YESTERDAY}&sort=stars&order=desc&per_page=15"
```

**Response** (JSON, verified structure):
```json
{
  "total_count": 247533,
  "incomplete_results": false,
  "items": [
    {
      "full_name": "someone/awesome-repo",
      "html_url": "https://github.com/someone/awesome-repo",
      "description": "AI agent framework for ...",
      "stargazers_count": 1234,
      "forks_count": 56,
      "language": "Python",
      "topics": ["ai", "agent", "llm"],
      "created_at": "2026-07-03T12:00:00Z",
      "updated_at": "2026-07-04T08:15:00Z",
      "owner": { "login": "someone", "avatar_url": "..." }
    }
  ]
}
```

### By language + weekly trend

```bash
WEEK_AGO=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d "7 days ago" +%Y-%m-%d)
curl -s -H "Accept: application/vnd.github+json" \
  "https://api.github.com/search/repositories?q=created:>${WEEK_AGO}+language:python&sort=stars&order=desc&per_page=10"
```

### Parse in Python

```python
import json, subprocess
from datetime import date, timedelta

d = (date.today() - timedelta(days=1)).isoformat()
raw = subprocess.check_output([
    'curl', '-s', '-H', 'Accept: application/vnd.github+json',
    f'https://api.github.com/search/repositories?q=created:>{d}&sort=stars&order=desc&per_page=10'
])
data = json.loads(raw)
for repo in data['items']:
    print(f"[⭐{repo['stargazers_count']:>5}] {repo['full_name']} ({repo.get('language') or '—'})")
    print(f"        {(repo.get('description') or '(no description)')[:100]}")
    print(f"        {repo['html_url']}")
```

## Query Syntax

Full syntax reference: https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories

| Qualifier | Purpose | Example |
|-----------|---------|---------|
| `created:>YYYY-MM-DD` | Created after date | `created:>2026-07-01` |
| `pushed:>YYYY-MM-DD` | Recently active | `pushed:>2026-06-27` |
| `language:X` | Filter by language | `language:rust`, `language:typescript` |
| `stars:>N` | Minimum stars | `stars:>1000` |
| `topic:X` | Tag filter | `topic:llm`, `topic:agent` |
| `size:>N` | Repo size (KB) | `size:>100` |
| `is:public` | Public only | `is:public` |

**Combining**: URL-encode spaces as `+`. Example: `q=language:python+topic:llm+stars:>500`.

**Sort**: `stars`, `forks`, `help-wanted-issues`, `updated`. **Order**: `desc` or `asc`.

## Common Workflows

### AI-focused daily trending

```bash
YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d "1 day ago" +%Y-%m-%d)
curl -s -H "Accept: application/vnd.github+json" \
  "https://api.github.com/search/repositories?q=created:>${YESTERDAY}+topic:ai+OR+topic:llm+OR+topic:agent&sort=stars&order=desc&per_page=15"
```

### Established repos with recent activity

```bash
LAST_WEEK=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d "7 days ago" +%Y-%m-%d)
curl -s -H "Accept: application/vnd.github+json" \
  "https://api.github.com/search/repositories?q=stars:>10000+pushed:>${LAST_WEEK}&sort=updated&order=desc&per_page=10"
```

## Rate Limits

- **Unauthenticated**: 10 req/min for Search API, 60 req/hour overall.
- **Authenticated** (add `-H "Authorization: Bearer ${GITHUB_TOKEN}"`): 30 req/min for Search, 5000 req/hour overall.
- Get a token at https://github.com/settings/tokens (`public_repo` scope is enough).

Recommended env var:

```bash
curl -s -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ${GITHUB_TOKEN:-}" \
  "https://api.github.com/search/repositories?q=..."
```

## Limitations

- **Not the official trending algorithm**: GitHub's trending page uses a proprietary formula (star velocity, referral traffic, etc.). This skill approximates via `created:>date + sort=stars`, which favors freshly-starred new repos — good for "what launched recently and is hot", less good for "what's climbing steadily".
- **HTML `github.com/trending` unreliable**: This skill deliberately avoids scraping it. On mainland-China networks the request often times out. If your network can reach it, HTML scraping is an alternative — but the API approach is universally available.
- **Search index lag**: newly-created repos may take a few minutes to appear.
- **`total_count` capped at 1000** returned items — pagination beyond page 34 (`per_page=30`) returns 422.

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| HTTP 403 `rate limit exceeded` | Anonymous quota hit | Add `Authorization: Bearer` header, or wait |
| HTTP 422 `validation failed` | Query syntax invalid | Check qualifier names and quoting |
| Empty `items: []` | Filter too narrow | Loosen date range or drop `language:` |
| Slow response | Complex query, large `per_page` | Reduce `per_page`, cache locally |

## References

- API docs: https://docs.github.com/en/rest/search
- Base URL: `https://api.github.com/search/repositories` (GET)
- Recommended header: `Accept: application/vnd.github+json`
- Optional auth: `Authorization: Bearer ${GITHUB_TOKEN}`
