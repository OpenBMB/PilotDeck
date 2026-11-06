---
name: bilibili-video-info
description: Fetch Bilibili (B站) video metadata, tags, and danmaku via public APIs. Use when the user provides a bilibili.com/video/BVxxx or /av* URL, asks to look up 哔哩哔哩 or B站 video info, extract danmaku, or gather video metadata for analysis. Core endpoints (view / tags / danmaku) require zero authentication; subtitle and search require additional cookie/signing (documented in references/).
---

# Bilibili Video Info Fetcher

Fetch metadata, tags, and danmaku (bullet comments) from Bilibili videos. Uses B站's public web-interface — no cookie, no WBI signing, no login for the core three endpoints.

**Verified 2026-07-04**: Given `BV1GJ411x7h7`, all three endpoints returned HTTP 200 with full data. Rickroll video: 100M+ views, 141K+ danmaku, 6 tags — all fetched anonymously.

## Quick Start

### 1. Fetch video metadata

```bash
BVID="BV1GJ411x7h7"
curl -s -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  "https://api.bilibili.com/x/web-interface/view?bvid=${BVID}"
```

**Response** (JSON, verified):
```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "bvid": "BV1GJ411x7h7",
    "aid": 80433022,
    "cid": 137649199,
    "title": "【官方 MV】Never Gonna Give You Up - Rick Astley",
    "desc": "...",
    "duration": 213,
    "pic": "https://i0.hdslb.com/...",
    "owner": { "mid": 12345, "name": "索尼音乐中国" },
    "stat": {
      "view": 100620631,
      "danmaku": 141784,
      "reply": 45678,
      "like": 2765879,
      "coin": 123456,
      "favorite": 67890
    },
    "pages": [{ "cid": 137649199, "part": "..." }],
    "dimension": { "width": 1920, "height": 1080, "rotate": 0 }
  }
}
```

Save `cid` — it's needed for danmaku and subtitles.

### 2. Fetch video tags

```bash
curl -s -H "User-Agent: Mozilla/5.0" \
  "https://api.bilibili.com/x/tag/archive/tags?bvid=${BVID}"
```

**Response**:
```json
{
  "code": 0,
  "data": [
    { "tag_id": 1, "tag_name": "Never Gonna Give You Up", "count": { "use": 12345 } },
    { "tag_id": 2, "tag_name": "Rick Astley", "count": { "use": 6789 } }
  ]
}
```

### 3. Fetch danmaku (bullet comments)

Uses `cid` from step 1. Returns deflate-compressed XML.

```bash
CID="137649199"
curl -s --compressed -H "User-Agent: Mozilla/5.0" \
  "https://comment.bilibili.com/${CID}.xml" -o danmaku.xml
```

**Response** (XML, verified):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<i>
  <chatserver>chat.bilibili.com</chatserver>
  <chatid>137649199</chatid>
  <maxlimit>1000</maxlimit>
  <d p="12.5,1,25,16777215,1697000000,0,userhash,dmid,1">弹幕文本</d>
  ...
</i>
```

`p` attribute format: `time,mode,fontsize,color,timestamp,pool,userhash,dmid,weight`.

### End-to-end Python example

```python
import subprocess, json, xml.etree.ElementTree as ET

BVID = 'BV1GJ411x7h7'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

# 1. metadata
raw = subprocess.check_output([
    'curl', '-s', '-H', f'User-Agent: {UA}',
    f'https://api.bilibili.com/x/web-interface/view?bvid={BVID}'
])
meta = json.loads(raw)
if meta['code'] != 0:
    raise SystemExit(f"error: {meta.get('message')}")
d = meta['data']
cid = d['cid']
print(f"Title:  {d['title']}")
print(f"UP主:   {d['owner']['name']}")
print(f"Views:  {d['stat']['view']:,}")
print(f"Duration: {d['duration']}s")

# 2. tags
raw = subprocess.check_output([
    'curl', '-s', '-H', f'User-Agent: {UA}',
    f'https://api.bilibili.com/x/tag/archive/tags?bvid={BVID}'
])
tags = json.loads(raw)['data']
print(f"Tags:   {', '.join(t['tag_name'] for t in tags)}")

# 3. danmaku
raw = subprocess.check_output([
    'curl', '-s', '--compressed', '-H', f'User-Agent: {UA}',
    f'https://comment.bilibili.com/{cid}.xml'
])
root = ET.fromstring(raw)
danmaku = [d.text for d in root.findall('d') if d.text]
print(f"Danmaku sample: {danmaku[:5]}")
```

## Extracting IDs from Bilibili URLs

| URL Pattern | Extract |
|-------------|---------|
| `https://www.bilibili.com/video/BV1GJ411x7h7` | `bvid` = `BV1GJ411x7h7` |
| `https://www.bilibili.com/video/av80433022` | `aid` = `80433022` — pass as `?aid=` instead of `?bvid=` |
| Short link `b23.tv/xxx` | Follow redirect first: `curl -s -o /dev/null -w '%{url_effective}' -L URL` |

## Advanced: Subtitles & Search

- **Subtitles** require SESSDATA cookie. See `references/subtitles.md`.
- **Search** requires WBI signature (dynamic keys, changes daily). See `references/search-wbi.md`.
- **Historical danmaku** (older than 6 months) require SESSDATA. See `references/history-danmaku.md`.

## Limitations

- **412 Precondition Failed** on some cloud/data-center IPs — B站 rate-limits non-residential ranges. Use residential proxy or run from a home network for high volume.
- **Danmaku returns max 1000-3000 items** per XML endpoint (heat-limited by B站). For full history use segmented Protobuf endpoint (`/x/v2/dm/web/seg.so`).
- **User-Agent required** — no UA returns HTTP 412.
- **BV/AV interconvertible**: don't call both — pick one.
- **Old videos may 404**: some ancient content is archive-only.
- **The core three endpoints are safe to call** at ~1 req/sec; higher-volume workloads need residential IPs.

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| HTTP 412 | Cloud IP flagged / no UA | Add UA, use residential IP |
| `code: -404` | BV number invalid or video deleted | Verify BVID |
| Empty `data.subtitle.subtitles` | Auto-subs not generated / no SESSDATA | Try SESSDATA cookie or accept no subs |
| Danmaku XML has 0 `<d>` entries | New video (< few hours) or blocked | Wait or check video state |
| Search returns 400 | Missing WBI signature | See references/search-wbi.md |

## References

- View API: `https://api.bilibili.com/x/web-interface/view?bvid={bvid}` (GET, no auth)
- Tags API: `https://api.bilibili.com/x/tag/archive/tags?bvid={bvid}` (GET, no auth)
- Danmaku XML: `https://comment.bilibili.com/{cid}.xml` (GET, no auth, deflate)
- Danmaku Protobuf: `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid={cid}&segment_index=1` (GET, per 6-min segment)
- Subtitle player: `https://api.bilibili.com/x/player/wbi/v2?aid={aid}&cid={cid}` (needs SESSDATA)
- API doc collection: https://github.com/pskdje/bilibili-API-collect
- Alternative Python library: `pip install bilibili-api-python` (auto-handles WBI + auth)
