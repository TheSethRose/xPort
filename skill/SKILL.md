---
name: xport
description: Use when an agent needs to search, inspect, summarize, or retrieve tweets already captured by XPort in PostgreSQL or the hosted XPort API
---

# XPort

## Overview

Use `xport` to read tweets and media metadata that XPort already captured through the browser extension and stored in PostgreSQL. Search/get/recent/stats are read-only stored-data access. `transcribe` is an explicit daemon-side enrichment action for one stored video media row.

## When to Use

- Find posts the user has seen or captured through XPort.
- Retrieve a tweet by ID for exact text, metrics, media, article data, transcript status, or raw JSON.
- List stored media metadata and trigger explicit transcription when the user asks for it.
- Summarize recent captured timeline data by author, endpoint, date window, or keyword.
- Work from stored XPort data inside Hermes without browser access.

Do not use this for live X/Twitter reads, posting, liking, following, profile lookup, or filling gaps from X/Twitter. The only allowed new X/Twitter CDN request is an explicit user-requested media enrichment action against a URL already stored in `tweet_media`.

## Setup

From the XPort repo:

```bash
skill/xport search "postgres" --api-url "$XPORT_API_URL" --token "$XPORT_API_TOKEN"
```

Environment fallbacks:

| Variable | Purpose |
| --- | --- |
| `XPORT_API_URL` | Hosted XPort API base URL |
| `XPORT_API_TOKEN` | Bearer token for read endpoints |
| `XPORT_INGEST_TOKEN` or `INGEST_TOKEN` | Token fallback when no read-specific token exists |
| `DATABASE_URL` | Direct PostgreSQL reads when no API URL is supplied |

Direct database mode needs `psycopg` available in the Python environment. API mode uses only Python stdlib.

## Quick Reference

| Task | Command |
| --- | --- |
| Search stored tweets | `skill/xport search "query" --limit 20` |
| Recent stored tweets | `skill/xport recent --author seth --since 2026-05-01T00:00:00Z` |
| Agent-ready daily digest data | `skill/xport digest --since 2026-05-24T00:00:00Z` |
| Fetch one tweet | `skill/xport get 1234567890 --include-raw` |
| Fetch one tweet with media | `skill/xport get 1234567890 --include-media` |
| List media for a tweet | `skill/xport media 1234567890` |
| Transcribe one stored video | `skill/xport transcribe 1234567890:0` |
| Return stored image as data URL | `skill/xport media-content 1234567890:1 --data-url` |
| Database stats | `skill/xport stats` |
| JSONL for pipelines | `skill/xport search "query" --jsonl` |

Useful filters: `--author`, `--since`, `--until`, `--endpoint`, `--limit`, `--offset`, `--include-raw`, `--include-media`.

## Agent Pattern

1. Use `stats` to check coverage when the request is broad.
2. Use `digest --since <UTC-midnight>` for daily topic summaries. It returns `tweet_count`, filter metadata, top authors, source endpoints, and the captured tweet rows so the agent can write the narrative summary.
3. Use `search` or `recent` with tight filters.
4. Use `get --include-media` when media/transcript context matters.
5. Use `get --include-raw` only when normalized fields are not enough.
6. Cite that results are from stored XPort captures, not live X/Twitter.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Treating missing results as proof the tweet does not exist | Say it was not found in stored XPort data |
| Using live X/Twitter tools to fill gaps | Ask for explicit permission and keep it outside this skill |
| Transcribing automatically while browsing | Only run `transcribe` for a user-selected stored media row |
| Dumping raw JSON by default | Use normalized output first; add `--include-raw` for field-level work |
| Printing tokens in command output | Never echo token values; pass them through env or `--token` |
