# XPort

Passively capture tweets as you browse X/Twitter.

XPort is a Chrome extension, local daemon, and hosted ingestion API for capturing tweets you see on X/Twitter and storing them as structured data in PostgreSQL. Browser-side capture stays passive: it only reads GraphQL responses X already sent to your browser. The local daemon forwards captured batches to the hosted XPort API and does not write tweet JSONL locally.

- Platform: macOS, Linux, Windows
- Browser: Chrome
- License: [MIT](LICENSE)

## Overview

XPort is built for passive personal capture and analysis. Load the extension from `extension/`, run the native host installer, configure the hosted API credentials, then browse X normally. Captured tweets are parsed in the extension service worker, sent to a local daemon, forwarded to the hosted API, and stored in PostgreSQL.

The local output directory is only for optional debug logs, discovery dumps, media assets, and temporary on-demand enrichment work. Tweet data lives in PostgreSQL.

## Features

- Passive browser capture: reads GraphQL responses your browser already receives.
- Structured PostgreSQL storage: normalized columns plus the raw captured tweet JSON object.
- Hosted API ingestion: captured batches go through `POST /api/ingest/tweets`.
- XPort skill CLI: query stored captures and trigger explicit media enrichment through `skill/xport`.
- Article support: captures long-form X articles with full text, inline image references, and Draft.js block structure.
- Media metadata: stores captured media rows in `tweet_media`.
- Automatic photo storage: daemon-side storage for captured `pbs.twimg.com` photo URLs after successful ingest.
- On-demand video transcription: explicitly transcribe stored video media from the popup, dashboard, API, or CLI.
- Pause and resume: use the extension popup to toggle capture.
- Live counters: see current-session and stored all-time tweet counts.
- Multi-tab aware: multiple X tabs feed one service worker with shared deduplication.
- Debug logging and dashboard: optional service worker logs, live events, transport health, parser tools, settings, and stored tweet browsing.
- Cross-platform local daemon: macOS launchd, Linux systemd user service, or Windows Scheduled Task.

## How It Works

```text
X/Twitter GraphQL responses
  |
  v
content-main.js
  MAIN world fetch and XHR observer
  |
  | random CustomEvent
  v
content-bridge.js
  ISOLATED world relay
  |
  | chrome.runtime.sendMessage
  v
background.js
  service worker parser, dedup, batcher
  |
  | HTTP data path
  v
xport_daemon.py on 127.0.0.1:17381
  |
  | POST /api/ingest/tweets
  v
XPort API
  |
  v
PostgreSQL tables: tweets, tweet_media, ingest_batches
```

Native messaging is used only once at startup to fetch the daemon auth token from `xport_host.py`. Tweet batches, logs, path checks, and enrichment jobs all go through the local HTTP daemon.

Capture flow:

1. `content-main.js` patches `fetch` and `XMLHttpRequest.open()` in the MAIN world to observe GraphQL responses as they arrive.
2. Payloads are relayed through a random-named `CustomEvent` to `content-bridge.js`.
3. `content-bridge.js` forwards payloads to `background.js`.
4. `background.js` parses, normalizes, deduplicates new-capture counters, and batches tweets in daemon POSTs of up to 50.
5. Duplicate captures are still sent as Postgres upserts, so revisiting a tweet updates the stored row without creating another tweet.
6. `xport_daemon.py` forwards batches to the hosted API configured with `XPORT_API_URL` and `XPORT_INGEST_TOKEN`.
7. After successful ingest, captured `pbs.twimg.com` photos are queued for daemon-side storage.
8. If the API is missing or rejects a batch, the extension keeps parsed tweets buffered and shows the ingest error.

### Supported Capture Endpoints

Known parser endpoints:

`HomeTimeline`, `HomeLatestTimeline`, `UserTweets`, `UserTweetsAndReplies`, `UserMedia`, `UserLikes`, `UserArticlesTweets`, `UserHighlightsTweets`, `TweetDetail`, `SearchTimeline`, `ListLatestTweetsTimeline`, `Bookmarks`, `Likes`, `CommunityTweetsTimeline`, `BookmarkFolderTimeline`, `TweetResultByRestId`

Unknown endpoints fall back to a recursive search for `instructions` arrays. Known non-tweet GraphQL endpoints are ignored in the service worker.

## Safety

X is [rolling out stricter detection for automation and bots](https://x.com/nikitabier/status/2022496540275937525). XPort is not a bot: it does not post, like, follow, scroll, or make browser-side X API calls on your behalf. It reads responses X already sent to your browser while you browse normally.

Photo saving and video transcription are daemon-side media CDN requests against URLs already captured from those responses. Those are the only X/Twitter network requests XPort makes, and they happen outside the browser after allowlist validation.

XPort avoids common fingerprinting signals:

- No extra browser-side X requests.
- Native-looking API patches: patched `fetch.toString()` returns `function fetch() { [native code] }`, `fetch.name` stays `fetch`, and patched `XMLHttpRequest.prototype.open` keeps its original native string.
- No expando properties on XHR objects; URL tracking uses `WeakMap`.
- Random event channel between MAIN and ISOLATED worlds.
- No persistent page DOM footprint; the transient configuration meta tag is removed by the bridge.
- No console logging from page context.
- Minimal extension permissions: `storage`, `nativeMessaging`, scoped hosts, and no `webRequest`, `tabs`, `scripting`, or web-accessible debug dashboard.
- Jittered flush timing.

These measures do not make detection impossible. They do keep XPort browser-passive and avoid the obvious client-side signals associated with automation tooling.

## Installation

Most users only need the local setup:

1. Load the Chrome extension from `extension/`.
2. Run the native-host installer.
3. Open X and browse normally.

Tweet capture requires a hosted XPort API backed by PostgreSQL. Capture fails closed until `XPORT_API_URL` and `XPORT_INGEST_TOKEN` are configured.

### Chrome Quick Start

Clone the repo:

```bash
git clone https://github.com/TheSethRose/xPort.git
cd xPort
```

If you already have the repo, start from your existing checkout.

Load the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this repo's `extension/` directory.
5. Copy the extension ID shown on the extension card.

Install the native host and local daemon.

macOS or Linux:

```bash
cd native-host
export XPORT_API_URL="https://your-xport-api.example.com"
export XPORT_INGEST_TOKEN="your-shared-token"
./install.sh CHROME_EXTENSION_ID
```

Windows PowerShell:

```powershell
cd native-host
$env:XPORT_API_URL = "https://your-xport-api.example.com"
$env:XPORT_INGEST_TOKEN = "your-shared-token"
.\install.ps1 -ExtensionId CHROME_EXTENSION_ID
```

Verify the daemon:

```bash
curl http://127.0.0.1:17381/status
```

Expected response:

```json
{"ok":true,"version":"0.23.1"}
```

Open [x.com](https://x.com) and browse normally. Click the XPort extension icon to see live, paused, or offline status; session and all-time tweet counts; recent captured tweets; pause/resume controls; and dashboard links.

### What The Installer Does

The installer creates:

- A native messaging host for token bootstrap: `xport_host.py`.
- A local HTTP daemon on `127.0.0.1:17381`: `xport_daemon.py`.
- A secret token at `~/.xport/secret`.
- A default media/debug directory at `~/Downloads/xport`.

The daemon is installed as:

- macOS: launchd service.
- Linux: systemd user service.
- Windows: Scheduled Task.

### Updating An Existing Install

After pulling new code:

1. Re-run the installer: `install.sh` on macOS/Linux or `install.ps1` on Windows.
2. Reload XPort in the Chrome extension manager.
3. Hard-reload open X tabs: `Cmd+Shift+R` or `Ctrl+Shift+R`.

Content scripts are injected when the page loads, so open X tabs keep old scripts until hard-reloaded.

## Requirements

- Google Chrome.
- Python 3.
- macOS, Linux, or Windows.
- Hosted XPort API backed by PostgreSQL.
- `XPORT_API_URL` and `XPORT_INGEST_TOKEN`.
- Optional for local video transcription: `XPORT_TRANSCRIBE_COMMAND`.
- Optional macOS/Linux transcription helper: `parakeet-mlx` and `ffmpeg`. If both are installed and no transcription command is configured, the installer uses `native-host/xport_transcribe_parakeet.sh`.

The intended transcription model is `nvidia/parakeet-tdt-0.6b-v3`. XPort calls your configured local command and stores stdout as the transcript.

## Configuration

### Setup Paths

| Optional feature | Setup |
|---|---|
| Custom media/debug directory | Set `XPORT_OUTPUT_DIR` before running the installer |
| Debug logging | Use the dashboard toggle, or set `XPORT_LOG_LEVEL=debug` and re-run the installer |
| Image saving | Automatic for captured `pbs.twimg.com` photos after successful Postgres ingest; set `XPORT_AUTO_STORE_IMAGES=false` before running the installer to disable |
| Video transcription | Install `parakeet-mlx` plus `ffmpeg`, or configure `XPORT_TRANSCRIBE_COMMAND`, re-run the installer, then use the popup, dashboard, API, or CLI transcribe action |
| PostgreSQL capture | Set `XPORT_API_URL` and `XPORT_INGEST_TOKEN`, then re-run the installer |
| XPort skill CLI | Use `skill/xport` after captures exist in the hosted API or PostgreSQL |

### Media And Debug Directory

The easiest way to change where local artifacts are saved is through the extension popup. Click the XPort icon and enter your preferred path in the Media / debug directory field. Tweet data is stored in PostgreSQL, not in this directory.

Alternatively, set `XPORT_OUTPUT_DIR` before running the installer or restarting the daemon:

```bash
export XPORT_OUTPUT_DIR="$HOME/Documents/xport-data"
```

| Setting | Default | Description |
|---|---|---|
| Popup Media / debug directory | Empty, uses default | Overrides the artifact path per session |
| `XPORT_OUTPUT_DIR` | `~/Downloads/xport` | Fallback for debug logs, dumps, media, and videos |
| Dashboard | N/A | Opens to stored tweets with searchable filters, transcription status, transcript detail, export actions, live events, parser tools, transport diagnostics, and settings |

On macOS, the HTTP daemon installed by `install.sh` runs outside browser TCC sandboxes and can write to protected user folders after the required macOS permission prompt.

### PostgreSQL Capture

The local daemon forwards tweet batches to the hosted XPort API:

```bash
export XPORT_API_URL="https://your-xport-api.example.com"
export XPORT_INGEST_TOKEN="your-shared-token"
cd native-host
./install.sh CHROME_EXTENSION_ID
```

On Windows, set the same environment variables in PowerShell and run `install.ps1`. Re-run the installer after changing the URL or token. If either value is missing, `/tweets` returns an error and the extension keeps the batch buffered.

Hosted API environment:

| Env var | Description |
|---|---|
| `HOST` | Bind host, defaults to `0.0.0.0` |
| `PORT` | HTTP port, defaults to `8080` |
| `MAX_BODY_SIZE` | Maximum request body size in bytes, defaults to 10 MB |
| `DATABASE_URL` | PostgreSQL connection string |
| `INGEST_TOKEN` or `XPORT_INGEST_TOKEN` | Bearer token required by hosted API read/write endpoints |

Hosted API endpoints:

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` | None | DB-backed health check |
| `POST /api/ingest/tweets` | Bearer token | Inserts or upserts tweets, media metadata, and an ingest batch |
| `GET /api/tweets` | Bearer token | Lists captured tweets with server-side search, filters, sort, paging, and optional metadata |
| `GET /api/tweets/{tweet_id}` | Bearer token | Returns one captured tweet, optionally with raw JSON and media |
| `GET /api/tweets/{tweet_id}/media` | Bearer token | Lists media metadata for one tweet |
| `GET /api/media/{media_id}` | Bearer token | Returns one media metadata row |
| `GET /api/media/{media_id}/content?data_url=true` | Bearer token | Returns a data URL only when image bytes have been stored |
| `POST /api/media/{media_id}/transcription` | Bearer token | Updates queued, transcribing, done, skipped, or error transcript status |
| `POST /api/media/{media_id}/asset` | Bearer token | Stores fetched image bytes and content hash |
| `GET /api/stats` | Bearer token | Summarizes stored tweet coverage |

`GET /api/tweets` supports `q`, `author`, `since`, `until`, `endpoint`, `media`, `transcription`, `has_quoted`, `has_reply`, `sort`, `limit`, `offset`, `include_raw`, `include_media`, `include_total`, `include_facets`, and `include_metrics`. Sort values include `newest`, `oldest`, `captured_newest`, `captured_oldest`, `views`, `likes`, `retweets`, `replies`, `quotes`, `bookmarks`, `engagement`, `author`, `source`, `status`, and `media`. `limit` is bounded to 1-500.

### Media Environment Variables

| Env var | Default | Description |
|---|---|---|
| `XPORT_AUTO_STORE_IMAGES` | `true` | Automatically stores captured photo assets after successful ingest |
| `XPORT_TRANSCRIBE_COMMAND` | Empty | Local command used for explicit transcription |
| `XPORT_TRANSCRIBE_MODEL` | `nvidia/parakeet-tdt-0.6b-v3` | Model name recorded with transcripts |
| `XPORT_TRANSCRIBE_MAX_FILE_MB` | `75` | Maximum fetched video size for transcription |
| `XPORT_TRANSCRIBE_REQUEST_TIMEOUT_SECONDS` | `60` | Transcription request timeout |
| `XPORT_IMAGE_FETCH_MAX_FILE_MB` | `XPORT_MAX_FILE_MB` or `50` | Maximum fetched image size |

## XPort Skill CLI

The `skill/` folder contains a Hermes/agentskills-compatible skill and CLI for querying stored captures and triggering explicit enrichment.

```bash
skill/xport search "postgres" --api-url "$XPORT_API_URL" --token "$XPORT_API_TOKEN"
skill/xport recent --author handle --since 2026-05-01T00:00:00Z
skill/xport get 1234567890 --include-raw --include-media
skill/xport media 1234567890
skill/xport transcribe 1234567890:0
skill/xport media-content 1234567890:1 --data-url
skill/xport stats
skill/xport search "postgres" --jsonl
```

Commands:

| Command | Purpose |
|---|---|
| `search [query]` | Search captured tweet text and raw JSON |
| `recent` | List recent captured tweets |
| `get TWEET_ID` | Fetch one stored tweet |
| `media TWEET_ID` | List media metadata for one tweet |
| `transcribe MEDIA_ID` | Queue explicit daemon-side transcription for one stored video media row |
| `media-content MEDIA_ID --data-url` | Return a data URL for already-stored image bytes |
| `stats` | Summarize stored tweet coverage |

Useful filters: `--author`, `--since`, `--until`, `--endpoint`, `--limit`, `--offset`, `--include-raw`, `--include-media`, and `--jsonl`.

Environment fallbacks:

| Variable | Purpose |
|---|---|
| `XPORT_API_URL` | Hosted XPort API base URL |
| `XPORT_API_TOKEN` | Bearer token for read endpoints |
| `XPORT_INGEST_TOKEN` or `INGEST_TOKEN` | Token fallback when no read-specific token exists |
| `DATABASE_URL` | Direct PostgreSQL reads when no API URL is supplied |

The CLI reads from the hosted API when `--api-url` or `XPORT_API_URL` is set. API mode uses only Python stdlib. If no API URL is supplied, it reads PostgreSQL directly through `--database-url` or `DATABASE_URL`; direct database mode requires `psycopg`.

## Data Format

The hosted API stores normalized PostgreSQL columns plus the raw captured tweet JSON. The raw object is self-contained:

```jsonc
{
  "id": "1234567890",
  "url": "https://x.com/handle/status/1234567890",
  "created_at": "2024-01-01T00:00:00.000Z",
  "author": {
    "id": "987654321",
    "username": "handle",
    "display_name": "Display Name",
    "verified": false,
    "is_blue_verified": true,
    "follower_count": 1234
  },
  "text": "Full tweet text...",
  "lang": "en",
  "metrics": {
    "likes": 10,
    "retweets": 5,
    "replies": 2,
    "views": 1000,
    "bookmarks": 1,
    "quotes": 0
  },
  "media": [],
  "urls": [],
  "hashtags": [],
  "mentions": [],
  "in_reply_to": null,
  "quoted_tweet_id": null,
  "conversation_id": "1234567890",
  "is_retweet": false,
  "retweeted_tweet_id": null,
  "is_subscriber_only": false,
  "is_article": true,
  "article": {
    "title": "Article Title",
    "text": "Rendered plain text with image references",
    "blocks": [],
    "media": [
      {
        "id": "media-id",
        "url": "https://pbs.twimg.com/example",
        "filename": "image.png",
        "local_path": "media/1234567890/image.png",
        "width": 1200,
        "height": 800
      }
    ]
  },
  "source_endpoint": "HomeTimeline",
  "captured_at": "2024-01-01T00:00:00.000Z"
}
```

For regular tweets, `is_article` and `article` are absent. For articles, `text` contains a Markdown-style rendering of the article with inline image references pointing to `media/TWEET_ID/`.

Top-level media metadata is copied into `tweet_media` on ingest. Captured photos are queued for daemon-side storage after the tweet batch is accepted by Postgres. Base64 image data is returned only on request through `media-content --data-url`.

Video transcripts are stored on the matching `tweet_media` row. The daemon enforces one active transcription, a 75 MB fetched-video cap, and temporary-file cleanup after success or failure.

## Project Structure

```text
XPort/
|-- extension/                 # Load this directory in Chrome
|   |-- manifest.json          # Chrome MV3 extension manifest
|   |-- background.js          # Service worker parser, dedup, transport
|   |-- content-main.js        # MAIN world fetch/XHR observer
|   |-- content-bridge.js      # ISOLATED world relay
|   |-- popup.html/js/css      # Extension popup UI
|   |-- debug.html/js/css      # Dashboard
|   |-- icons/                 # Extension icons
|   `-- lib/                   # Shared utilities
|-- api/
|   `-- xport_api.py           # Hosted PostgreSQL ingestion API
|-- skill/
|   |-- SKILL.md               # Hermes/agentskills usage guide
|   `-- xport                  # XPort API/PostgreSQL CLI
|-- tests/
|   |-- fixtures/              # Sanitized parser/e2e fixture packs
|   |-- e2e/                   # Chromium + extension + daemon pipeline test
|   |-- *.test.mjs             # Node tests
|   `-- test_*.py              # Python tests
|-- Dockerfile                 # API container
|-- requirements.txt           # API runtime dependencies
`-- native-host/
    |-- xport_core.py          # Shared daemon helper logic
    |-- xport_host.py          # Native messaging host
    |-- xport_daemon.py        # HTTP daemon
    |-- install.sh             # macOS/Linux installer
    `-- install.ps1            # Windows installer
```

## Troubleshooting

If the extension shows Not connected or a red `!` badge, check the daemon first:

```bash
curl http://127.0.0.1:17381/status
cat ~/.xport/daemon-stderr.log
```

Common daemon errors:

- `FATAL: ~/.xport/secret not found`: run the installer.
- `FATAL: Cannot bind to 127.0.0.1:17381`: another daemon is already running.
- Import errors: check `python3 --version`.

If token bootstrap fails, check native host errors:

```bash
cat ~/.xport/host-error.log
```

If Chrome still points to an old native host path, re-run the installer. On macOS, the native messaging manifest should point to `~/.xport/xport_host_wrapper.sh`.

Restart commands:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.xport.daemon

# Linux
systemctl --user restart com.xport.daemon
```

```powershell
# Windows PowerShell
Stop-ScheduledTask -TaskName XPortDaemon; Start-ScheduledTask -TaskName XPortDaemon
```

## Development

After modifying extension files, reload the extension in Chrome at `chrome://extensions` and hard-reload any open X tabs.

Popup and dashboard behavior:

- Popup: capture health, current-session count, stored Postgres all-time count, recent session tweets, pause/resume, and dashboard links.
- Dashboard: opens tweet-first to stored Postgres tweets, loaded 100 rows per page.
- Search, filters, sort, facets, date filters, metric sorts, and long-list options stay server-side.
- Open filter dropdowns pause visible control rebuilds while background refresh may still fetch data.
- Live Events is current-session only.
- Parser, Debug, and Settings tabs keep secondary tools out of the main tweet workspace.

Dev mode:

- Loaded-unpacked installs prefer `chrome.storage.session` for `seenIds` and `mediaSeenIds`.
- Production uses `chrome.storage.local`.
- Raw staged GraphQL payloads use session storage when available so MV3 service worker suspension can replay them.

Daemon restarts after Python changes:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.xport.daemon
launchctl bootout gui/$(id -u)/com.xport.daemon
launchctl print gui/$(id -u)/com.xport.daemon
tail -f ~/.xport/daemon-stderr.log

# Linux
systemctl --user restart com.xport.daemon
systemctl --user stop com.xport.daemon
systemctl --user status com.xport.daemon
journalctl --user -u com.xport.daemon -f
```

```powershell
# Windows PowerShell
Stop-ScheduledTask -TaskName XPortDaemon; Start-ScheduledTask -TaskName XPortDaemon
Stop-ScheduledTask -TaskName XPortDaemon
Get-ScheduledTask -TaskName XPortDaemon
Get-Content ~\.xport\daemon-stderr.log -Tail 50 -Wait
```

## Testing

Full local check:

```bash
uv run --with pytest --with 'psycopg[binary]==3.2.13' pytest tests/ -v
node --test tests/*.test.mjs
```

Focused checks:

```bash
node --test tests/parser-golden.test.mjs
uv run --with pytest pytest tests/test_xport_skill_cli.py -v
cd tests/e2e && npm ci && npm test
```

CI runs the Python and Node suites on every push and pull request to `main`. The E2E workflow separately runs the Chromium extension, daemon, and ingest API test.

Parser fixture packs live under `tests/fixtures/`. Raw captures stay local in `tests/fixtures/private-raw/`, which is gitignored. Committed anonymized packs live in `tests/fixtures/sanitized/`. The anonymization methodology and review checklist are documented in `tests/fixtures/FIXTURES.md`.

## Contributing

Keep XPort browser-passive. Do not add browser-side requests to `x.com`, `twitter.com`, `pbs.twimg.com`, or `video.twimg.com`. Load the extension from `extension/`, keep permissions minimal, and run the smallest relevant validation before submitting changes.

Parser changes should include sanitized fixtures when endpoint behavior changes and should at least pass:

```bash
node --test tests/parser-golden.test.mjs
```

For release work, follow the checklist in `AGENTS.md`.

## License

[MIT](LICENSE). Use it however you like.
