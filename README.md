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
  <img src="https://img.shields.io/badge/browser-Chrome%20%7C%20Firefox-green" alt="Chrome and Firefox" />
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="MIT License" />
  <a href="https://codecov.io/gh/TheSethRose/xPort"><img src="https://codecov.io/gh/TheSethRose/xPort/graph/badge.svg" alt="codecov" /></a>
</p>

---

XPort is a browser extension, local daemon, and hosted ingestion API for capturing tweets you see on X/Twitter and storing them as structured data. The browser-side capture stays passive: it only reads GraphQL responses X already sent to your browser. The local daemon writes JSONL as a fallback and can forward captured batches to a hosted API backed by PostgreSQL.

## Features

- **Zero footprint** — no additional network requests; captures what your browser already receives
- **Structured output** — each tweet saved as a clean JSON object with author, metrics, media, and more
- **PostgreSQL sync** — optionally forward captured batches to the hosted XPort API for durable SQL storage
- **Read-only XPort skill** — query stored captures through `skill/xport` from the hosted API or PostgreSQL without touching X/Twitter
- **Article support** — long-form X articles are captured with full text, inline image references, and Draft.js block structure
- **Video download** — download videos from tweets using yt-dlp (or direct MP4 fallback) via the extension popup. Requires the HTTP daemon. **Note:** unlike passive capture, video downloads make additional network requests to X and are not stealth.
- **Image download** — opt-in toggle in the popup ("Download images automatically") fetches photos from `pbs.twimg.com` to `<output_dir>/media/<tweet_id>/<filename>` as you browse. Daemon-side; rate-limited; logs to `media-manifest.jsonl`. **Note:** also not stealth — adds requests to the Twitter CDN.
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
            ├──────────────► XPort API (`POST /api/ingest/tweets`)
            │                    │
            │                    ▼
            │              PostgreSQL (`tweets`, `ingest_batches`)
            ▼
       tweets-YYYY-MM-DD.jsonl
```

1. A MAIN world content script patches `fetch` and `XMLHttpRequest.open()` to observe GraphQL responses as they arrive
2. Payloads are relayed via a random-named `CustomEvent` to an ISOLATED world bridge, which forwards them to the service worker
3. The service worker parses, normalizes, deduplicates, and batches tweets
4. Batches are sent to disk via the **HTTP daemon** (`xport_daemon.py`), a standalone process on `127.0.0.1:17381` managed by launchd (macOS), systemd (Linux), or Scheduled Task (Windows). On macOS, it runs outside browser TCC sandboxes and can write to protected paths like `~/Documents` and iCloud Drive
5. At startup, the extension retrieves the daemon's auth token via **native messaging** (`xport_host.py` over Chrome/Firefox native messaging). This is a one-time bootstrap — all data flows through HTTP
6. When `XPORT_API_URL` and `XPORT_INGEST_TOKEN` are configured, the daemon forwards successful local batches to the hosted API while keeping JSONL as the local fallback

### Supported capture endpoints

The parser has known instruction paths for:

`HomeTimeline`, `HomeLatestTimeline`, `UserTweets`, `UserTweetsAndReplies`, `UserMedia`, `UserLikes`, `UserArticlesTweets`, `UserHighlightsTweets`, `TweetDetail`, `SearchTimeline`, `ListLatestTweetsTimeline`, `Bookmarks`, `Likes`, `CommunityTweetsTimeline`, `BookmarkFolderTimeline`

`TweetResultByRestId` is also handled as a single-tweet response. Unknown endpoints fall back to a recursive search for `instructions[]` arrays, while known non-tweet GraphQL endpoints are ignored in the service worker.

## Is This Safe to Use?

X is [rolling out stricter detection for automation and bots](https://x.com/nikitabier/status/2022496540275937525). The key line: *"If a human is not tapping on the screen, the account and all associated accounts will likely be suspended."*

**XPort is not a bot.** It doesn't post, like, follow, scroll, or make any API calls on your behalf. It sits in the background and reads the responses X already sent to your browser while *you* browse normally. From X's server-side perspective, your account looks identical to any other user — because you *are* a normal user. There is no extra traffic to detect.

The risk of automation enforcement applies to tools that *act* as you (auto-liking, auto-following, automated scrolling, headless browsers). XPort does none of that. It's the equivalent of keeping DevTools open and saving the Network tab — just automated into structured JSONL.

### Stealth Measures

Even though passive interception is inherently low-risk, XPort avoids leaving unnecessary traces:

- **No extra network requests** — only reads responses the browser already received; nothing to spot in a network log
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

By default, XPort writes JSONL files to `~/Downloads/xport`. Hosted PostgreSQL sync and the `skill/xport` CLI are optional.

### Requirements

- Google Chrome or Firefox 128+
- Python 3
- macOS, Linux, or Windows
- Optional: [`yt-dlp`](https://github.com/yt-dlp/yt-dlp#installation) for best-quality video downloads

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
./install.sh <chrome-extension-id> chrome
```

**Windows PowerShell**

```powershell
cd native-host
.\install.ps1 -ExtensionId <chrome-extension-id> -Browser chrome
```

Verify the daemon:

```bash
curl http://127.0.0.1:17381/status
```

Expected response:

```json
{"ok":true,"version":"0.23.1"}
```

Open [x.com](https://x.com) and browse normally. Click the XPort extension icon to see capture status, pause/resume capture, choose an output directory, or open the debug dashboard.

### Firefox setup

Firefox uses a different MV3 background format, so load a Firefox copy of the extension:

```bash
git clone https://github.com/TheSethRose/xPort.git
cd xPort
cp -R extension /tmp/xport-firefox-extension
cp /tmp/xport-firefox-extension/manifest.firefox.json /tmp/xport-firefox-extension/manifest.json
```

On Windows, make a copy of the `extension/` folder and replace that copy's `manifest.json` with the contents of `manifest.firefox.json`.

Then:

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select `/tmp/xport-firefox-extension/manifest.json`

Install the native host:

**macOS / Linux**

```bash
cd native-host
./install.sh firefox
```

**Windows PowerShell**

```powershell
cd native-host
.\install.ps1 -Browser firefox
```

Firefox uses the fixed extension ID from `manifest.firefox.json`: `xport@sethrose.dev`.

Thanks to [Vincent Koc](https://github.com/vincentkoc) for the Firefox support contribution.

### What the installer does

The installer creates:

- A native messaging host for token bootstrap (`xport_host.py`)
- A local HTTP daemon on `127.0.0.1:17381` (`xport_daemon.py`)
- A secret token at `~/.xport/secret`
- A default output directory at `~/Downloads/xport`

The daemon is installed as:

- macOS: launchd service
- Linux: systemd user service
- Windows: Scheduled Task

The browser extension only uses native messaging to fetch the daemon token. Tweet batches, logs, path checks, image downloads, and video downloads all go through the local HTTP daemon.

### Updating an existing install

After pulling new code:

1. Re-run the installer (`install.sh` on macOS/Linux, `install.ps1` on Windows)
2. Reload XPort in your browser extension manager
3. Hard-reload open X tabs (`Cmd+Shift+R` / `Ctrl+Shift+R`)

The content scripts are injected when the page loads, so open X tabs keep old scripts until hard-reloaded.

### Optional setup paths

Local JSONL capture works without these.

| Optional feature | Setup |
|---|---|
| Custom output directory | Set it in the popup, or set `XPORT_OUTPUT_DIR` before running the installer |
| Debug logging | Use the debug dashboard toggle, or set `XPORT_LOG_LEVEL=debug` and re-run the installer |
| Image download | Enable **Download images automatically** in the popup |
| Video download | Install `yt-dlp`, then use the popup's video download button |
| Hosted PostgreSQL sync | Set `XPORT_API_URL` and `XPORT_INGEST_TOKEN`, then re-run the installer |
| Read-only skill CLI | Use `skill/xport` after captures exist in the hosted API or PostgreSQL |

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

If Chrome or Firefox still points to an old native host path, re-run the installer. On macOS, the native messaging manifest should point to `~/.xport/xport_host_wrapper.sh`.

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

### Output directory

The easiest way to change where tweets are saved is through the extension popup: click the XPort icon and enter your preferred path in the **Output directory** field.

Alternatively, set the `XPORT_OUTPUT_DIR` environment variable before running the installer or restarting the daemon:

```bash
export XPORT_OUTPUT_DIR="$HOME/Documents/xport-data"
```

| Setting | Default | Description |
|---|---|---|
| Popup "Output directory" | *(empty — uses default)* | Overrides the output path per-session |
| `XPORT_OUTPUT_DIR` env var | `~/Downloads/xport` | Fallback when no popup setting is configured |
| Debug Dashboard | — | Accessible via popup link; shows live capture events, transport health, debug logging and discovery mode toggles, and parser sandbox |

> **macOS note:** On macOS, the HTTP daemon (installed via `install.sh`) runs outside browser TCC sandboxes and can write to protected paths like `~/Documents` and iCloud Drive after a one-time macOS permission prompt.

### Hosted API forwarding

The local daemon can forward batches to the hosted XPort API after writing them to JSONL:

```bash
export XPORT_API_URL="https://your-xport-api.example.com"
export XPORT_INGEST_TOKEN="your-shared-token"
cd native-host
./install.sh <your-extension-id> chrome
```

Use `firefox` instead of `chrome` for Firefox. On Windows, set the same environment variables in PowerShell and run `install.ps1`. The installer writes those values into the daemon config. Re-run it after changing the URL or token.

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
| `POST /api/ingest/tweets` | Bearer token | Inserts/upserts tweets and records an ingest batch |
| `GET /api/tweets` | Bearer token | Lists captured tweets with optional `q`, `author`, `since`, `until`, `endpoint`, `limit`, `offset`, and `include_raw` query params. `limit` is bounded to 1-500. |
| `GET /api/tweets/<tweet_id>` | Bearer token | Returns one captured tweet, optionally with `include_raw=true` |
| `GET /api/stats` | Bearer token | Summarizes stored tweet coverage |

### XPort skill CLI

The `/skill` folder contains a Hermes/agentskills-compatible skill and a read-only CLI for querying stored captures:

```bash
skill/xport search "postgres" --api-url "$XPORT_API_URL" --token "$XPORT_API_TOKEN"
skill/xport recent --author handle --since 2026-05-01T00:00:00Z
skill/xport get 1234567890 --include-raw
skill/xport stats
skill/xport search "postgres" --jsonl
```

The skill is named `xport` in `skill/SKILL.md`. Use it only for stored XPort captures. It must not call X/Twitter, scrape pages, hydrate profiles, fetch missing data, or create any new X/Twitter traffic.

Command behavior:

| Command | Purpose |
|---|---|
| `search [query]` | Search captured tweet text and raw JSON |
| `recent` | List recent captured tweets |
| `get <tweet_id>` | Fetch one stored tweet |
| `stats` | Summarize stored tweet coverage |

Useful filters: `--author`, `--since`, `--until`, `--endpoint`, `--limit`, `--offset`, `--include-raw`, and `--jsonl`.

Environment fallbacks:

| Variable | Purpose |
|---|---|
| `XPORT_API_URL` | Hosted XPort API base URL |
| `XPORT_API_TOKEN` | Bearer token for read endpoints |
| `XPORT_INGEST_TOKEN` or `INGEST_TOKEN` | Token fallback when no read-specific token exists |
| `DATABASE_URL` | Direct PostgreSQL reads when no API URL is supplied |

The CLI reads from the hosted API when `--api-url` or `XPORT_API_URL` is set. API mode uses only Python stdlib. If no API URL is supplied, it reads PostgreSQL directly through `--database-url` or `DATABASE_URL`; direct database mode requires `psycopg`.

## Output Format

Output is written to daily files (`tweets-YYYY-MM-DD.jsonl`). Each line is a self-contained JSON object:

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

### Media file convention

When the "Download images automatically" toggle is on, the daemon writes photos to:

```
<output_dir>/media/<tweet_id>/<basename(media.url)>
```

Top-level photo `media[]` entries do **not** carry a `local_path` field — the path is derived by convention so consumers can reconstruct it directly from `tweet.id` + the URL basename. Article media (`tweet.article.media[]`) does include `local_path` because that path is also embedded in the rendered article markdown (`![](media/<id>/file.png)`) so the article body works as a self-contained document. Download status (success / 404 / quota / oversize / blocked) is appended to `<output_dir>/media-manifest.jsonl`.

## Project Structure

```
XPort/
├── extension/                 # Load this directory in Chrome, not the repo root
│   ├── manifest.json          # Chrome MV3 extension manifest
│   ├── manifest.firefox.json  # Firefox MV3 extension manifest (generated — do not edit)
│   ├── background.js          # Service worker — parsing, dedup, transport
│   ├── content-main.js        # MAIN world — patches fetch/XHR, emits events
│   ├── content-bridge.js      # ISOLATED world — relays events to service worker
│   ├── popup.html/js/css      # Extension popup UI
│   ├── debug.html/js/css      # Debug dashboard (live events, transport health, parser sandbox)
│   ├── icons/                 # Extension icons
│   └── lib/                   # Shared utilities
├── api/
│   └── xport_api.py            # Hosted PostgreSQL ingestion API
├── skill/
│   ├── SKILL.md                 # Hermes/agentskills usage guide
│   └── xport                    # Read-only XPort API/PostgreSQL CLI
├── scripts/
│   └── build-firefox-manifest.js # Regenerates the Firefox manifest from Chrome manifest
├── tests/
│   ├── fixtures/                 # Sanitized parser/e2e fixture packs
│   ├── e2e/                      # Chromium + extension + daemon pipeline test
│   ├── *.test.mjs                # Node tests for parser, manifest, staging, dedup
│   └── test_*.py                 # Python tests for API, daemon, host, core, skill CLI
├── Dockerfile                  # Coolify/API container
├── requirements.txt            # API runtime dependencies
└── native-host/
    ├── xport_core.py              # Shared file I/O logic
    ├── xport_host.py              # Native messaging host — token bootstrap only (Python, stdio)
    ├── xport_daemon.py            # HTTP daemon
    ├── com.xport.daemon.plist     # launchd plist template (macOS)
    ├── com.xport.daemon.service   # systemd unit template (Linux)
    ├── com.xport.host.json        # Native host manifest template (Chrome)
    ├── com.xport.host.firefox.json # Native host manifest template (Firefox)
    ├── install.sh                # Installer for macOS / Linux
    ├── install.ps1               # Installer for Windows
    ├── xport_host.bat             # Windows native host wrapper
    └── xport_daemon.bat           # Windows daemon wrapper
```

## Development

After modifying extension files (`extension/background.js`, `extension/lib/`, `extension/content-*.js`, `extension/popup.*`), reload the extension in your browser (`chrome://extensions` or `about:debugging#/runtime/this-firefox`) and hard-reload any open X tabs.

**Debug dashboard:** Click "Debug Dashboard" in the popup to open a live view of capture events, transport health, and a parser sandbox for testing `extractTweets` against raw GraphQL JSON. Debug logging and discovery mode toggles are also here — enable debug logging to write timestamped service worker logs to `debug-YYYY-MM-DD.log`, or discovery mode to log endpoint response shapes to the console.

**Dev mode:** When loaded unpacked (developer mode), the extension prefers `chrome.storage.session` for the `seenIds` dedup cache, and falls back to `chrome.storage.local` if session storage APIs are unavailable. When session storage is available, reloading the extension automatically clears the cache — no need to manually clear storage between test runs.

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

CI runs the Python and Node suites on every push and pull request to `main` with coverage uploaded to [Codecov](https://codecov.io/gh/TheSethRose/xPort). The E2E workflow separately runs the Chromium + extension + daemon golden-JSONL test.

Parser fixture packs live under `tests/fixtures/`. Raw captures stay local in
`tests/fixtures/private-raw/` (gitignored), while committed anonymized packs
live in `tests/fixtures/sanitized/`. The anonymization methodology and review
checklist are documented in `tests/fixtures/FIXTURES.md`.

## License

[MIT](LICENSE) — use it however you like.
