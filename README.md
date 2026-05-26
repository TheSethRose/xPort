<p align="center">
  <img src="extension/icons/icon128.png" alt="XPort logo" width="96" />
</p>

<h1 align="center">XPort</h1>

<p align="center">
  <strong>Passively capture tweets as you browse X/Twitter</strong>
</p>

<p align="center">
  <a href="#installation">Installation</a> &middot;
  <a href="#how-it-works">How It Works</a> &middot;
  <a href="#is-this-safe-to-use">Stealth</a> &middot;
  <a href="#output-format">Output Format</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="LICENSE">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/browser-Chrome-green" alt="Chrome" />
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="MIT License" />
  <a href="https://codecov.io/gh/TheSethRose/xPort"><img src="https://codecov.io/gh/TheSethRose/xPort/graph/badge.svg" alt="codecov" /></a>
</p>

---

XPort is a Chrome extension, local daemon, and hosted ingestion API for capturing tweets you see on X/Twitter and storing them as structured data in PostgreSQL. The browser-side capture stays passive: it only reads GraphQL responses X already sent to your browser. The local daemon forwards captured batches to the hosted XPort API and does not write tweet JSONL locally.

## Features

- **Passive browser capture** — the extension only reads GraphQL responses your browser already receives
- **Structured output** — each tweet stored as normalized PostgreSQL columns plus the raw captured JSON object
- **PostgreSQL storage** — captured batches go through the hosted XPort API for durable SQL storage
- **XPort skill CLI** — query stored captures and trigger explicit media enrichment through `skill/xport`
- **Article support** — long-form X articles are captured with full text, inline image references, and Draft.js block structure
- **Media storage** — stores captured media metadata in `tweet_media` and auto-saves captured photos through the daemon
- **On-demand video transcription** — explicitly transcribe a stored video from the popup, debug dashboard, API, or CLI. **Note:** media saving/transcription makes daemon-side requests to Twitter CDN hosts.
- **Pause / resume** — click the extension icon to toggle capture on the fly
- **Live counter** — badge on the extension icon shows tweets captured this session
- **Multi-tab aware** — multiple X tabs feed into the same service worker with shared deduplication
- **Debug logging** — optional toggle to write timestamped service worker logs to a date-rotated file
- **Debug dashboard** — internal extension page with live capture events, transport health, and a parser sandbox for testing GraphQL response parsing
- **Cross-platform** — works on macOS, Linux, and Windows

## How It Works

```
        X/Twitter GraphQL responses
                    │
                    ▼
     ┌────────────────────────────┐
     │     content-main.js        │  MAIN world
     │    patches fetch & XHR     │
     └──────────────┬─────────────┘
                    │ CustomEvent (random name)
                    ▼
     ┌────────────────────────────┐
     │     content-bridge.js      │  ISOLATED world
     │   relays to service worker │
     └──────────────┬─────────────┘
                    │ chrome.runtime.sendMessage
                    ▼
     ┌────────────────────────────┐
     │     background.js          │  Service worker
     │   parse, dedup, batch      │
     └──────────┬─────────┬───────┘
                │         │
          HTTP  │         │ native messaging
     (all data) │         │ (token bootstrap only)
                │         │
                ▼         ▼
     ┌──────────────┐  ┌──────────────┐
     │ xport_daemon  │  │ xport_host.py │
     │ (HTTP)       │  │ (stdio)      │
     └──────┬───────┘  └──────────────┘
            │
            └──────────────► XPort API (`POST /api/ingest/tweets`)
            │                    │
            │                    ▼
            │              PostgreSQL (`tweets`, `tweet_media`, `ingest_batches`)
```

1. A MAIN world content script patches `fetch` and `XMLHttpRequest.open()` to observe GraphQL responses as they arrive
2. Payloads are relayed via a random-named `CustomEvent` to an ISOLATED world bridge, which forwards them to the service worker
3. The service worker parses, normalizes, deduplicates, and batches tweets in daemon POSTs of up to 50. If a later response adds media for a tweet previously captured as text-only, that media-bearing copy is allowed through once so Postgres can upsert the `tweet_media` rows.
4. Batches are sent to the **HTTP daemon** (`xport_daemon.py`), a standalone process on `127.0.0.1:17381` managed by launchd (macOS), systemd (Linux), or Scheduled Task (Windows)
5. At startup, the extension retrieves the daemon's auth token via **native messaging** (`xport_host.py` over Chrome native messaging). This is a one-time bootstrap — all data flows through HTTP
6. The daemon forwards tweet batches to the hosted API configured with `XPORT_API_URL` and `XPORT_INGEST_TOKEN`. After a successful ingest, it auto-queues captured `pbs.twimg.com` photos for storage in `tweet_media`. If the API is not configured or rejects a batch, the extension keeps parsed tweets buffered and shows the ingest error.

### Supported capture endpoints

The parser has known instruction paths for:

`HomeTimeline`, `HomeLatestTimeline`, `UserTweets`, `UserTweetsAndReplies`, `UserMedia`, `UserLikes`, `UserArticlesTweets`, `UserHighlightsTweets`, `TweetDetail`, `SearchTimeline`, `ListLatestTweetsTimeline`, `Bookmarks`, `Likes`, `CommunityTweetsTimeline`, `BookmarkFolderTimeline`

`TweetResultByRestId` is also handled as a single-tweet response. Unknown endpoints fall back to a recursive search for `instructions[]` arrays, while known non-tweet GraphQL endpoints are ignored in the service worker.

## Is This Safe to Use?

X is [rolling out stricter detection for automation and bots](https://x.com/nikitabier/status/2022496540275937525). The key line: *"If a human is not tapping on the screen, the account and all associated accounts will likely be suspended."*

**XPort is not a bot.** It doesn't post, like, follow, scroll, or make browser-side X API calls on your behalf. It sits in the background and reads the responses X already sent to your browser while *you* browse normally. Photo saving and video transcription are daemon-side media CDN requests against URLs already captured from those responses.

The risk of automation enforcement applies to tools that *act* as you (auto-liking, auto-following, automated scrolling, headless browsers). XPort does none of that. It's the equivalent of keeping DevTools open and saving the Network tab — just automated into structured PostgreSQL records.

### Stealth Measures

Even though passive interception is inherently low-risk, XPort avoids leaving unnecessary traces:

- **No extra browser-side X requests** — the extension only reads responses the browser already received
- **Native-looking API patches** — `fetch` and `XMLHttpRequest.prototype.open` are patched with `toString()` overrides that return `[native code]`, passing the most common runtime integrity checks
- **No expando properties** — XHR URL tracking uses a `WeakMap` instead of attaching properties to the XHR instance, which would be trivially detectable
- **Random event channel** — the MAIN↔ISOLATED world bridge uses a `CustomEvent` with a per-page-load random name; the `<meta>` beacon that communicates the name is removed immediately after the bridge reads it
- **Zero DOM footprint** — no injected UI, no page modifications; everything lives in the popup and service worker
- **Zero console output in page context** — all logging happens in the service worker and parser, which run outside the page's JavaScript environment
- **Minimal permissions** — only `storage` and `nativeMessaging`; no `webRequest`, no host permissions beyond `x.com` / `twitter.com` / `127.0.0.1`
- **Jittered flush timing** — batches are flushed on a randomized interval to avoid a clockwork-regular pattern

These measures don't make detection impossible — a determined page script could still compare prototype references or probe for patched behavior — but they avoid the low-hanging signals that fingerprinting scripts typically check. More importantly, there's nothing to detect server-side because XPort generates zero network activity of its own.

## Installation

Most users only need the local setup:

1. Load the extension from `extension/`.
2. Run the native-host installer.
3. Open X and browse normally.

Tweet capture requires a hosted XPort API backed by PostgreSQL. The local directory is only for optional debug logs, discovery dumps, and temporary on-demand enrichment work.

### Requirements

- Google Chrome
- Python 3
- macOS, Linux, or Windows
- Optional: `XPORT_TRANSCRIBE_COMMAND` for local video transcription. The intended model is `nvidia/parakeet-tdt-0.6b-v3`; XPort calls your configured local command and stores stdout as the transcript. On macOS/Linux, if `parakeet-mlx` and `ffmpeg` are installed and no command is configured, the installer uses `native-host/xport_transcribe_parakeet.sh`.

### Chrome quick start

Clone the repo:

```bash
git clone https://github.com/TheSethRose/xPort.git
cd xPort
```

If you already have the repo, start from your existing checkout.

Load the extension:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this repo's `extension/` directory
5. Copy the extension ID shown on the extension card

Install the native host and local daemon:

**macOS / Linux**

```bash
cd native-host
export XPORT_API_URL="https://your-xport-api.example.com"
export XPORT_INGEST_TOKEN="your-shared-token"
./install.sh <chrome-extension-id>
```

**Windows PowerShell**

```powershell
cd native-host
$env:XPORT_API_URL = "https://your-xport-api.example.com"
$env:XPORT_INGEST_TOKEN = "your-shared-token"
.\install.ps1 -ExtensionId <chrome-extension-id>
```

Verify the daemon:

```bash
curl http://127.0.0.1:17381/status
```

Expected response:

```json
{"ok":true,"version":"0.23.1"}
```

Open [x.com](https://x.com) and browse normally. Click the XPort extension icon to see live/paused/offline status, session and all-time tweet counts, recent captured tweets, pause/resume controls, and links into the tweet and debug dashboard tabs.

### What the installer does

The installer creates:

- A native messaging host for token bootstrap (`xport_host.py`)
- A local HTTP daemon on `127.0.0.1:17381` (`xport_daemon.py`)
- A secret token at `~/.xport/secret`
- A default media/debug directory at `~/Downloads/xport`

The daemon is installed as:

- macOS: launchd service
- Linux: systemd user service
- Windows: Scheduled Task

The browser extension only uses native messaging to fetch the daemon token. Tweet batches, logs, path checks, and explicit media enrichment jobs all go through the local HTTP daemon. Tweet batches are forwarded to the configured XPort API; they are not written to local JSONL files.

### Updating an existing install

After pulling new code:

1. Re-run the installer (`install.sh` on macOS/Linux, `install.ps1` on Windows)
2. Reload XPort in your browser extension manager
3. Hard-reload open X tabs (`Cmd+Shift+R` / `Ctrl+Shift+R`)

The content scripts are injected when the page loads, so open X tabs keep old scripts until hard-reloaded.

### Setup paths

Tweet capture will fail closed until `XPORT_API_URL` and `XPORT_INGEST_TOKEN` are configured.

| Optional feature | Setup |
|---|---|
| Custom media/debug directory | Set `XPORT_OUTPUT_DIR` before running the installer |
| Debug logging | Use the debug dashboard toggle, or set `XPORT_LOG_LEVEL=debug` and re-run the installer |
| Image saving | Automatic for captured `pbs.twimg.com` photos after successful Postgres ingest; set `XPORT_AUTO_STORE_IMAGES=false` before running the installer to disable |
| Video transcription | Install `parakeet-mlx` plus `ffmpeg`, or configure `XPORT_TRANSCRIBE_COMMAND`, re-run the installer, then use the popup/debug dashboard/CLI transcribe action |
| PostgreSQL capture | Set `XPORT_API_URL` and `XPORT_INGEST_TOKEN`, then re-run the installer |
| XPort skill CLI | Use `skill/xport` after captures exist in the hosted API or PostgreSQL |

Detailed configuration is below.

### Troubleshooting

If the extension shows "Not connected" or a red `!` badge, check the daemon first:

```bash
curl http://127.0.0.1:17381/status
cat ~/.xport/daemon-stderr.log
```

Common daemon errors:

- `FATAL: ~/.xport/secret not found`: run the installer
- `FATAL: Cannot bind to 127.0.0.1:17381`: another daemon is already running
- Import errors: check `python3 --version`

If token bootstrap fails, check native host errors:

```bash
cat ~/.xport/host-error.log
```

If Chrome still points to an old native host path, re-run the installer. On macOS, the native messaging manifest should point to `~/.xport/xport_host_wrapper.sh`.

Useful restart commands:

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

## Configuration

### Media / debug directory

The easiest way to change where local artifacts are saved is through the extension popup: click the XPort icon and enter your preferred path in the **Media / debug directory** field. Tweet data is stored in PostgreSQL, not in this directory.

Alternatively, set the `XPORT_OUTPUT_DIR` environment variable before running the installer or restarting the daemon:

```bash
export XPORT_OUTPUT_DIR="$HOME/Documents/xport-data"
```

| Setting | Default | Description |
|---|---|---|
| Popup "Media / debug directory" | *(empty — uses default)* | Overrides the artifact path per-session |
| `XPORT_OUTPUT_DIR` env var | `~/Downloads/xport` | Fallback for debug logs, dumps, media, and videos |
| Debug Dashboard | — | Accessible via popup link; opens to the tweet-first Captured Tweets workspace with searchable long-list filters, including transcription status, a detail drawer with transcript metadata/text, export actions, live events, parser tools, transport diagnostics, and settings |

> **macOS note:** On macOS, the HTTP daemon (installed via `install.sh`) runs outside browser TCC sandboxes and can write to protected paths like `~/Documents` and iCloud Drive after a one-time macOS permission prompt.

### PostgreSQL capture

The local daemon forwards tweet batches to the hosted XPort API:

```bash
export XPORT_API_URL="https://your-xport-api.example.com"
export XPORT_INGEST_TOKEN="your-shared-token"
cd native-host
./install.sh <your-extension-id>
```

On Windows, set the same environment variables in PowerShell and run `install.ps1`. Re-run the installer after changing the URL or token. If either value is missing, `/tweets` returns an error and the extension keeps the batch buffered.

The hosted API uses:

| Env var | Description |
|---|---|
| `HOST` | Bind host, defaults to `0.0.0.0` |
| `PORT` | HTTP port, defaults to `8080` |
| `MAX_BODY_SIZE` | Maximum request body size in bytes, defaults to 10 MB |
| `DATABASE_URL` | PostgreSQL connection string |
| `INGEST_TOKEN` or `XPORT_INGEST_TOKEN` | Bearer token required by hosted API read/write endpoints |

API endpoints:

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` | None | DB-backed health check |
| `POST /api/ingest/tweets` | Bearer token | Inserts/upserts tweets, media metadata, and an ingest batch |
| `GET /api/tweets` | Bearer token | Lists captured tweets with server-side search, filters, sort, paging, and optional metadata via `q`, `author`, `since`, `until`, `endpoint`, `media`, `transcription`, `has_quoted`, `has_reply`, `sort`, `limit`, `offset`, `include_raw`, `include_media`, `include_total`, `include_facets`, and `include_metrics`. Sort values include `newest`, `oldest`, `captured_newest`, `captured_oldest`, `views`, `likes`, `retweets`, `replies`, `quotes`, `bookmarks`, `engagement`, `author`, `source`, `status`, and `media`. `limit` is bounded to 1-500. |
| `GET /api/tweets/<tweet_id>` | Bearer token | Returns one captured tweet, optionally with `include_raw=true` and `include_media=true` |
| `GET /api/tweets/<tweet_id>/media` | Bearer token | Lists media metadata for one tweet |
| `GET /api/media/<media_id>` | Bearer token | Returns one media metadata row |
| `GET /api/media/<media_id>/content?data_url=true` | Bearer token | Returns a data URL only when image bytes have been stored |
| `POST /api/media/<media_id>/transcription` | Bearer token | Updates queued/transcribing/done/skipped/error transcript status |
| `POST /api/media/<media_id>/asset` | Bearer token | Stores fetched image bytes and content hash |
| `GET /api/stats` | Bearer token | Summarizes stored tweet coverage |

### XPort skill CLI

The `/skill` folder contains a Hermes/agentskills-compatible skill and CLI for querying stored captures and triggering explicit enrichment:

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

The skill is named `xport` in `skill/SKILL.md`. Search/get/stats commands use only stored XPort captures. `transcribe` is an explicit daemon-side enrichment carve-out and fetches only the stored media URL for the selected media row.

Command behavior:

| Command | Purpose |
|---|---|
| `search [query]` | Search captured tweet text and raw JSON |
| `recent` | List recent captured tweets |
| `get <tweet_id>` | Fetch one stored tweet |
| `media <tweet_id>` | List media metadata for one tweet |
| `transcribe <media_id>` | Queue explicit daemon-side transcription for one stored video media row |
| `media-content <media_id> --data-url` | Return a data URL for already-stored image bytes |
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

## Output Format

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
  "is_subscriber_only": false,          // true for subscriber-only tweets
  "is_article": true,                   // present only for long-form articles
  "article": {                          // present only for long-form articles
    "title": "Article Title",
    "text": "Rendered plain text with ![img](media/<id>/file.png) refs",
    "blocks": [],                       // raw Draft.js content_state blocks
    "media": [{                         // article image references
      "id": "...",
      "url": "https://pbs.twimg.com/...",  // original CDN URL
      "filename": "image.png",
      "local_path": "media/<tweet_id>/image.png",
      "width": 1200,
      "height": 800
    }]
  },
  "source_endpoint": "HomeTimeline",    // which GraphQL endpoint
  "captured_at": "2024-01-01T00:00:00.000Z"
}
```

For regular tweets, `is_article` and `article` are absent. For articles, `text` contains a markdown-style rendering of the article with inline image references pointing to `media/<tweet_id>/`.

### Media metadata and enrichment

Top-level media metadata is copied into `tweet_media` on ingest. Captured photos are queued for daemon-side storage after the tweet batch is accepted by Postgres. If a duplicate tweet later arrives with media after an earlier text-only capture, the service worker lets that media-enriched copy through once. Base64 is returned only on request via `media-content --data-url`.

Video transcripts are stored on the matching `tweet_media` row. The daemon enforces one active transcription, a 75MB fetched-video cap, and temporary-file cleanup after success or failure.

## Project Structure

```
XPort/
├── extension/                 # Load this directory in Chrome, not the repo root
│   ├── manifest.json          # Chrome MV3 extension manifest
│   ├── background.js          # Service worker — parsing, dedup, transport
│   ├── content-main.js        # MAIN world — patches fetch/XHR, emits events
│   ├── content-bridge.js      # ISOLATED world — relays events to service worker
│   ├── popup.html/js/css      # Extension popup UI
│   ├── debug.html/js/css      # Debug dashboard (captured tweets, live events, persisted display settings, transport health, parser sandbox)
│   ├── icons/                 # Extension icons
│   └── lib/                   # Shared utilities
├── api/
│   └── xport_api.py            # Hosted PostgreSQL ingestion API
├── skill/
│   ├── SKILL.md                 # Hermes/agentskills usage guide
│   └── xport                    # Read-only XPort API/PostgreSQL CLI
├── tests/
│   ├── fixtures/                 # Sanitized parser/e2e fixture packs
│   ├── e2e/                      # Chromium + extension + daemon pipeline test
│   ├── *.test.mjs                # Node tests for parser, manifest, staging, dedup
│   └── test_*.py                 # Python tests for API, daemon, host, core, skill CLI
├── Dockerfile                  # Coolify/API container
├── requirements.txt            # API runtime dependencies
└── native-host/
    ├── xport_core.py              # Shared daemon helper logic
    ├── xport_host.py              # Native messaging host — token bootstrap only (Python, stdio)
    ├── xport_daemon.py            # HTTP daemon
    ├── com.xport.daemon.plist     # launchd plist template (macOS)
    ├── com.xport.daemon.service   # systemd unit template (Linux)
    ├── com.xport.host.json        # Native host manifest template (Chrome)
    ├── install.sh                # Installer for macOS / Linux
    ├── install.ps1               # Installer for Windows
    ├── xport_host.bat             # Windows native host wrapper
    └── xport_daemon.bat           # Windows daemon wrapper
```

## Development

After modifying extension files (`extension/background.js`, `extension/lib/`, `extension/content-*.js`, `extension/popup.*`), reload the extension in Chrome (`chrome://extensions`) and hard-reload any open X tabs.

**Popup and dashboard:** The popup is the lightweight control center: capture status, current-session count, stored Postgres all-time count, recent session tweets, pause/resume, and direct links to dashboard tabs. The dashboard opens to the tweet-first Tweets tab with stored Postgres tweets loaded one 100-row page at a time, related current-session capture statuses, server-side search/filter/sort including date and metric sort options, searchable long-list filters including transcription status, dataset-level author/source/endpoint options from API facets, typed server-backed author/source/endpoint option search, removable active filter chips, page-scoped header selection, lazy `Select all N matching` bulk selection across paginated results, export actions, and a detail drawer for related events, transcript metadata/text, and raw/parsed JSON. Live Events is focused on the current-session capture stream. Parser, Debug, and Settings tabs keep parser testing, transport health, debug logging, discovery mode, and display preferences out of the main tweet workspace. Stored tweets and capture events have auto-refresh and auto-scroll controls; open filter dropdowns pause only visual refresh updates while data continues fetching in the background. Enable debug logging to write timestamped service worker logs to `debug-YYYY-MM-DD.log`, or discovery mode to log endpoint response shapes to the console.

**Dev mode:** When loaded unpacked (developer mode), the extension prefers `chrome.storage.session` for `seenIds` and `mediaSeenIds` dedup caches, and falls back to `chrome.storage.local` if session storage APIs are unavailable. When session storage is available, reloading the extension automatically clears the cache — no need to manually clear storage between test runs.

**Durability:** Parsed tweet batches persist in production `chrome.storage.local` until the daemon accepts them. Raw staged GraphQL payloads use `chrome.storage.session` when available, so they are meant to survive MV3 service worker suspension, not browser restart.

After modifying Python host files (`xport_core.py`, `xport_host.py`, `xport_daemon.py`), the native host picks up changes on next browser restart. To restart the HTTP daemon immediately:

**macOS (launchd):**
```bash
launchctl kickstart -k gui/$(id -u)/com.xport.daemon   # restart
launchctl bootout gui/$(id -u)/com.xport.daemon        # stop
launchctl print gui/$(id -u)/com.xport.daemon          # status
tail -f ~/.xport/daemon-stderr.log                     # logs
```

**Linux (systemd):**
```bash
systemctl --user restart com.xport.daemon   # restart
systemctl --user stop com.xport.daemon      # stop
systemctl --user status com.xport.daemon    # status
journalctl --user -u com.xport.daemon -f    # logs
```

**Windows (Scheduled Task, PowerShell):**
```powershell
Stop-ScheduledTask -TaskName XPortDaemon; Start-ScheduledTask -TaskName XPortDaemon  # restart
Stop-ScheduledTask -TaskName XPortDaemon                                            # stop
Get-ScheduledTask -TaskName XPortDaemon                                             # status
Get-Content ~\.xport\daemon-stderr.log -Tail 50 -Wait                               # logs
```

## Testing

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

CI runs the Python and Node suites on every push and pull request to `main` with coverage uploaded to [Codecov](https://codecov.io/gh/TheSethRose/xPort). The E2E workflow separately runs the Chromium + extension + daemon + ingest API test.

Parser fixture packs live under `tests/fixtures/`. Raw captures stay local in
`tests/fixtures/private-raw/` (gitignored), while committed anonymized packs
live in `tests/fixtures/sanitized/`. The anonymization methodology and review
checklist are documented in `tests/fixtures/FIXTURES.md`.

## License

[MIT](LICENSE) — use it however you like.
