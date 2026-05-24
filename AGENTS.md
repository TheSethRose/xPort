# AGENTS.md - XPort

## What This Is

XPort is a Chrome extension, local daemon, and hosted ingestion API that passively captures tweets from X/Twitter by intercepting GraphQL API responses the browser already receives. No scraping, no extra browser-side requests — just structured tweet data sent to PostgreSQL through the hosted API.

**Repo:** github.com/TheSethRose/xPort
**License:** MIT (public repo)

## Architecture

```
extension/content-main.js (MAIN world)
  │  Patches fetch() + XHR.open() to intercept GraphQL responses
  │  Emits CustomEvent with random per-page name
  ▼
extension/content-bridge.js (ISOLATED world)
  │  Reads event name from <meta> tag, listens, relays
  │  Removes <meta> immediately after reading
  ▼
extension/background.js (Service Worker, ES module)
  │  Parses tweet data via extension/lib/tweet-parser.js
  │  Deduplicates (seen IDs + media-enriched IDs, max 50k; session storage in dev, local in prod)
  │  Batches (50 tweets or 30–45s jittered flush)
  │  Debug logging: intercepts console.log/warn/error, sends to host
  │  Transport: HTTP daemon only (reprobes on failure with 30s cooldown)
  ▼
┌─── HTTP transport ─────────────────────────────────────────────┐
│ xport_daemon.py (127.0.0.1:17381)                               │
│   Managed by launchd (macOS), systemd (Linux), Scheduled Task  │
│   (Windows). Bearer token auth from ~/.xport/secret             │
│   Endpoints: GET /status, POST /tweets, /stored-tweets,       │
│   /log, /test-path, /transcribe-media, /transcription-status, │
│   /fetch-media-image. /tweets forwards tweet + media metadata │
│   to Postgres and queues captured photos for asset storage.   │
└────────────────────────────────────────────────────────────────┘
┌─── Native messaging (token bootstrap only) ───────────────────┐
│ xport_host.py (Python, stdio)                                   │
│   Chrome native messaging protocol                             │
│   Serves GET_TOKEN to bootstrap HTTP transport                 │
│   Crashes logged to ~/.xport/host-error.log                    │
└────────────────────────────────────────────────────────────────┘
  │  xport_daemon.py uses shared logic from xport_core.py
  ▼
debug-YYYY-MM-DD.log     (when debug logging enabled)
XPort API (required for tweet capture; configured with XPORT_API_URL + XPORT_INGEST_TOKEN)
  │  POST /api/ingest/tweets
  │  GET /api/tweets, /api/tweets/<tweet_id>, /api/stats
  │  GET /api/tweets/<tweet_id>/media, /api/media/<media_id>
  │  POST /api/media/<media_id>/transcription, /asset
  ▼
PostgreSQL tables: tweets, tweet_media, ingest_batches
skill/xport (optional CLI for Hermes/agentskills)
  │  Reads from hosted API or DATABASE_URL
  ▼
Stored XPort captures only; no live X/Twitter requests
```

### Key Design Decisions

- **Two content scripts (MAIN + ISOLATED):** MV3 requires this split. MAIN world can patch browser APIs but can't use chrome.runtime. ISOLATED world bridges the gap.
- **Random event channel:** The CustomEvent name is generated per page load (`'_' + Math.random().toString(36).slice(2)`) and passed via a `<meta>` tag that's immediately removed. Avoids predictable DOM markers.
- **HTTP-only transport:** All data flows through the HTTP daemon (`xport_daemon.py`), managed by launchd (macOS), systemd (Linux), or Scheduled Task (Windows). On macOS, it runs outside browser TCC sandboxes, allowing writes to protected paths. If the daemon goes down, parsed tweets stay buffered in extension storage and the extension reprobes every 30 seconds until the daemon recovers.
- **PostgreSQL-first capture:** `POST /tweets` on the daemon forwards every tweet batch to `POST /api/ingest/tweets`. If `XPORT_API_URL` and `XPORT_INGEST_TOKEN` are missing or the ingest API rejects the batch, the daemon returns an error and the extension keeps the batch buffered. There is no local tweet JSONL fallback. After successful ingest, the daemon queues captured `pbs.twimg.com` photos for asset storage in `tweet_media`.
- **Stored capture access:** The hosted API exposes bearer-protected tweet and media read endpoints. `skill/xport` wraps those endpoints for Hermes/agentskills and can fall back to direct `DATABASE_URL` reads.
- **Token bootstrap via native messaging:** On first run, the extension connects to `xport_host.py` via native messaging to request `GET_TOKEN` (reads `~/.xport/secret`). The token is cached in `chrome.storage.local` for subsequent HTTP requests. The native host handles nothing else — all data goes through HTTP.
- **Popup control center:** The popup should answer capture health first, then show session/all-time tweet counts, pause/resume, recent session tweets, media/debug directory feedback, and links into the tweet and debug dashboard tabs. Keep deeper filtering/debugging in the dashboard.
- **Debug dashboard data:** The dashboard is tweet-first. The default Tweets tab displays recent stored tweets from Postgres through daemon `/stored-tweets`, supplemented by recent capture event statuses from extension storage. Debug, transport, parser, and settings surfaces live in secondary tabs. Stored tweets and capture events should keep auto-refresh and auto-scroll controls.
- **Shared core logic:** `xport_core.py` contains artifact file I/O, API forwarding, path validation, stored tweet lookup, automatic image asset queueing, and explicit media enrichment helpers used by `xport_daemon.py`.
- **Environment detection:** `isDevMode = !chrome.runtime.getManifest().update_url` — packed CWS extensions have `update_url`, unpacked don't. Used to switch seenIds storage between session (dev) and local (production).
- **Volatile dev cache:** In dev mode (unpacked), `seenIds` is stored in `chrome.storage.session`, which clears on extension reload. This eliminates the need to manually clear storage during development. Production behavior is unchanged (persisted to `chrome.storage.local`).
- **Dedup in service worker:** Multiple tabs feed the same service worker. `seenIds` Set (max 50,000, FIFO eviction) prevents duplicates. `mediaSeenIds` lets a duplicate tweet enqueue once when a later GraphQL response adds media that an earlier text-only capture missed. In production, both sets are persisted to `chrome.storage.local`; in dev mode, they use volatile `chrome.storage.session`.
- **Jittered flush:** Batch flush uses `setTimeout` with randomized interval (30s base + up to 50% jitter = 30–45s), re-randomized each cycle. Flush sends at most 50 tweets per daemon POST. Avoids clockwork-regular patterns.
- **Path validation:** When the user sets a custom media/debug directory, the service worker sends a `TEST_PATH` request to the HTTP daemon, which attempts `makedirs` + write/delete of a temp file before accepting the path.
- **Error resilience:** The native host logs crashes to `~/.xport/host-error.log` with Python version and traceback. The HTTP daemon returns error status codes and logs startup diagnostics (Python version, output dir, token status). When the daemon is unreachable, the extension shows a red "!" badge and buffers tweets until the next successful reprobe (30s cooldown). The popup auto-refreshes every 2 seconds to reflect transport state changes.
- **Daemon debug logging:** Set `XPORT_LOG_LEVEL=debug` to get per-request logging (method, path, duration, tweet counts, tracebacks). Configured via environment variable in the service template (launchd/systemd). Re-run `install.sh` after changing.
- **Media tuning (env vars, all optional):** `XPORT_AUTO_STORE_IMAGES` defaults to true; `XPORT_TRANSCRIBE_COMMAND` configures the local transcription command; macOS/Linux installs auto-use `native-host/xport_transcribe_parakeet.sh` when `parakeet-mlx` and `ffmpeg` are on PATH and no command is set; `XPORT_TRANSCRIBE_MODEL` defaults to `nvidia/parakeet-tdt-0.6b-v3`; `XPORT_TRANSCRIBE_MAX_DURATION_MS` defaults to `90000`; `XPORT_TRANSCRIBE_MAX_FILE_MB` defaults to `75`; `XPORT_IMAGE_FETCH_MAX_FILE_MB` defaults to `XPORT_MAX_FILE_MB` or `50`.

## Stealth Constraints

**These are non-negotiable. XPort must remain completely passive.**

1. **Zero extra browser-side X requests** — the extension only reads responses the browser already received. Allowed daemon-side media requests are listed in the carve-outs below.
2. **Native-looking patches** — `toString()` on patched `fetch` returns `'function fetch() { [native code] }'`. `XHR.open` toString returns the original native string. `fetch.name` is set to `'fetch'` via `Object.defineProperty`.
3. **No expando properties** — XHR URL tracking uses a `WeakMap`, never attaches properties to instances.
4. **No DOM footprint** — no injected elements, no visible page modifications. The only transient artifact is the `<meta name="__cfg">` tag, removed within milliseconds by the bridge script.
5. **No console output in page context** — all logging happens in the service worker, which runs outside the page's JavaScript environment.
6. **Minimal permissions** — only `storage` and `nativeMessaging`. Host permissions scoped to `x.com`, `twitter.com`, and `127.0.0.1` (local daemon only). No `webRequest`, no `tabs`, no `scripting`, no web-accessible resources. The debug dashboard is an internal extension page (`chrome-extension://` origin), not a web-accessible resource.
7. **Random event channel** — per-page-load name, meta tag removed immediately after reading.
8. **Only `open()` patched on XHR** — `send()` is not patched, so non-GraphQL XHR calls have clean stack traces.

**Any change that adds browser-side network requests to X/Twitter domains must be rejected.**

**Carve-outs (daemon-side only):**
- **Automatic image asset storage** — after a successful tweet ingest, the daemon fetches captured `pbs.twimg.com` photo URLs in the background and stores binary bytes plus metadata in `tweet_media`. Redirects are blocked and host allowlisting remains mandatory.
- **Video transcription** (`/transcribe-media`) — user-initiated from popup/debug/CLI; fetches one selected `video.twimg.com` or `pbs.twimg.com` media URL after allowlist validation, runs the configured local transcription command, and stores transcript status/text in `tweet_media`.
- **Image asset endpoint** (`/fetch-media-image`) — retained for API/CLI compatibility; dashboard UI should rely on automatic image storage instead of exposing a manual image action.

The browser-side capture path stays passive. These carve-outs run on the daemon, not the extension, so the page itself never originates the request.

## File Structure

```
XPort/
├── extension/                 # Load this directory in Chrome, never the repo root
│   ├── manifest.json          # Chrome MV3 manifest (permissions: storage, nativeMessaging)
│   ├── background.js          # Service worker (ES module) - transport, parsing, dedup
│   ├── content-main.js        # MAIN world - fetch/XHR patching
│   ├── content-bridge.js      # ISOLATED world - event relay
│   ├── popup.html/js/css      # Extension popup (stats, pause/resume, output dir)
│   ├── debug.html/js/css      # Debug dashboard (captured tweets, live events, persisted display settings, transport health, parser sandbox)
│   ├── icons/                 # Extension icons (16, 48, 128)
│   └── lib/
│       └── tweet-parser.js    # GraphQL response → normalized tweet objects
├── api/
│   └── xport_api.py           # Hosted PostgreSQL ingestion API
├── skill/
│   ├── SKILL.md               # Hermes/agentskills usage guide
│   └── xport                  # Read-only stored capture CLI
├── Dockerfile                 # API container for Coolify
├── requirements.txt           # API runtime dependencies
└── native-host/
    ├── xport_core.py              # Shared daemon helper logic
    ├── xport_host.py              # Native messaging host — token bootstrap only (Python, stdio)
    ├── xport_daemon.py            # HTTP daemon (127.0.0.1:17381)
    ├── xport_transcribe_parakeet.sh # parakeet-mlx wrapper that prints transcript text to stdout
    ├── com.xport.daemon.plist     # launchd plist template (macOS)
    ├── com.xport.daemon.service   # systemd unit template (Linux)
    ├── com.xport.host.json        # Native messaging host manifest (Chrome)
    ├── install.sh                # macOS/Linux installer (+ daemon)
    ├── install.ps1               # Windows installer (+ daemon)
    ├── xport_host.bat             # Windows native host wrapper
    └── xport_daemon.bat           # Windows daemon wrapper
```

## Supported Endpoints

The tweet parser (`extension/lib/tweet-parser.js`) has known instruction paths for:

`HomeTimeline`, `HomeLatestTimeline`, `UserTweets`, `UserTweetsAndReplies`, `UserMedia`, `UserLikes`, `TweetDetail`, `SearchTimeline`, `ListLatestTweetsTimeline`, `Bookmarks`, `Likes`, `CommunityTweetsTimeline`, `BookmarkFolderTimeline`

`TweetResultByRestId` is also handled — it returns a single tweet (not a timeline), including regular tweets and long-form article tweets.

Unknown endpoints fall back to a recursive search for `instructions[]` arrays (max depth 5). Non-tweet endpoints are filtered in `extension/background.js` via `IGNORED_ENDPOINTS`.

## Output Schema

PostgreSQL stores normalized columns plus the raw captured tweet JSON. The raw tweet object has this shape:

```jsonc
{
  "id": "1234567890",
  "url": "https://x.com/handle/status/1234567890",
  "created_at": "2024-01-01T00:00:00.000Z",       // ISO 8601
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
    "likes": 10, "retweets": 5, "replies": 2,
    "views": 1000, "bookmarks": 1, "quotes": 0
  },
  "media": [{"type": "photo|video|animated_gif", "url": "...", "alt_text": "...", "duration_ms": 1234}],
  "urls": [{"display": "...", "expanded": "...", "shortened": "..."}],
  "hashtags": ["tag"],
  "mentions": [{"id": "...", "username": "..."}],
  "in_reply_to": null,
  "quoted_tweet_id": null,
  "conversation_id": "1234567890",
  "is_retweet": false,
  "retweeted_tweet_id": null,
  "is_subscriber_only": false,
  "is_article": true,                   // only for long-form articles
  "article": {                          // only for long-form articles
    "title": "Article Title",
    "text": "Rendered plain text with ![img](media/<id>/file.png) refs",
    "blocks": [],                       // raw Draft.js content_state blocks
    "media": [{
      "id": "...",
      "url": "https://pbs.twimg.com/...",
      "filename": "image.png",
      "local_path": "media/<tweet_id>/image.png",
      "width": 1200, "height": 800
    }]
  },
  "source_endpoint": "HomeTimeline",
  "captured_at": "2024-01-01T00:00:00.000Z"
}
```

Notes: `media[].duration_ms` only present for videos. `views` may be `null`. For retweets, `text` contains the full original tweet text (not the truncated `RT @user:` form). For articles, `is_article` and `article` are present — `article.text` is a markdown rendering with inline `![](media/<id>/file)` image refs, `article.blocks` preserves the raw Draft.js structure, and `article.media[]` lists images with CDN URLs and local paths. Article tweets bypass dedup so the enriched version (from `TweetResultByRestId`) replaces the stub captured from timeline endpoints. Media-bearing duplicates also bypass dedup once when the previous capture for that tweet ID had no media. Top-level `media[]` entries deliberately do NOT carry `local_path` — when image download is enabled, photos land at `media/<tweet_id>/<basename(url)>` by convention. Consumers reconstruct the path; the daemon never stores it in the tweet payload.

## Known Issues

### macOS TCC (Transparency, Consent, and Control)

On macOS, native messaging hosts can inherit browser TCC sandbox restrictions. After browser restarts, writes to protected paths (`~/Documents`, iCloud Drive, etc.) can fail with `PermissionError`.

**Solution:** The HTTP daemon (`xport_daemon.py`) runs via launchd, independent of the browser process tree. It has its own TCC entitlements and can write to protected paths after a one-time macOS permission prompt. The daemon is the sole data transport — if it's not running, the extension buffers tweets and shows an error.

### Tombstone tweets

X sometimes returns `TimelineTweet` entries where `tweet_results.result` is missing (deleted/suspended tweets). These are skipped by the parser. Since no ID is extracted, they don't enter `seenIds` — if the tweet later appears with full data, it will be captured.

## Development Notes

- **No build step** — plain JS, no bundler, no transpilation. Load and go.
- **Testing:** `uv run --with pytest --with 'psycopg[binary]==3.2.13' pytest tests/ -v && node --test tests/*.test.mjs`. Run after every change. CI runs these on every push to main with coverage uploaded to Codecov. For manual browser testing, load unpacked in Chrome (`chrome://extensions`) from `extension/`. Chrome extension IDs vary per install; pass the installed ID to `install.sh` or `install.ps1`.
- **Parser golden test (fast, use for iteration):** `node --test tests/parser-golden.test.mjs` — runs `extractTweets` against all fixture scenarios in `tests/fixtures/sanitized/*/` and compares to golden `expected.jsonl`. Sub-second, reports field-level diffs on failure. Use this as the inner loop when modifying the parser.
- **E2E test (slow, CI gate):** `cd tests/e2e && npm test` — launches Chromium + real extension + daemon + Fake X server + fake ingest API. Auto-discovers all scenarios in `tests/fixtures/sanitized/`. Full pipeline integration proof without writing tweet JSONL locally.
- **Fixtures:** Parser fixture packs live under `tests/fixtures/`. Keep raw captures in `tests/fixtures/private-raw/` only (gitignored) and commit only sanitized packs from `tests/fixtures/sanitized/`. The anonymization methodology and review checklist are documented in `tests/fixtures/FIXTURES.md`.
- **Adding a fixture from a dump:** Discovery mode auto-dumps the first response per endpoint per session to the output dir as `dump-{endpoint}-{timestamp}.json` (in `{ endpoint, data }` envelope format). Feed directly to the sanitizer: `node tests/fixtures/tools/sanitize.mjs <dump-file> <scenario-name>`. This produces `tests/fixtures/sanitized/<scenario-name>/` with fixture.json, expected.jsonl, and manifest.json. Both parser and E2E tests pick it up automatically.
- **Workflow for supporting a new endpoint:** (1) Human enables discovery mode and browses X normally — dumps appear automatically for every endpoint, (2) run `node tests/fixtures/tools/sanitize.mjs <dump-file> <scenario-name>`, (3) run `node --test tests/parser-golden.test.mjs` — if it fails, the parser doesn't handle this endpoint yet, (4) fix the parser in `extension/lib/tweet-parser.js`, (5) re-run parser test until green (ms feedback loop), (6) regenerate expected: re-run sanitize.mjs (overwrites).
- **Debugging:** Use the dashboard for stored Postgres tweets, capture events, transport health, debug logging, discovery mode, and the parser sandbox. It opens to Captured Tweets with filters, export actions, bulk actions, and a detail drawer for raw/parsed JSON; Live Events, Parser, Debug, and Settings are secondary tabs. Logs write to `debug-YYYY-MM-DD.log` in the output directory. Service worker console is visible in each browser's extension debugger. Stored tweets and capture events have auto-refresh and auto-scroll controls.
- **Dev mode dedup state:** In dev mode, `seenIds` and `mediaSeenIds` use `chrome.storage.session` when available (volatile — clears on extension reload). If session storage APIs are unavailable, they safely fall back to `chrome.storage.local`.
- **tweet-parser.js** is the most fragile file — it handles multiple GraphQL response shapes and X changes their API schema without notice. The recursive fallback (`findInstructionsRecursive`) catches many new endpoint shapes automatically, but field-level changes to tweet objects will need manual updates to `normalizeTweet()`.
- **Service worker module:** `extension/background.js` is loaded as an ES module (`"type": "module"` in manifest). It imports `tweet-parser.js` directly.
- **HTTP daemon:** `xport_daemon.py` binds `127.0.0.1:17381`. Auth token stored at `~/.xport/secret` (mode 600). Managed by launchd (macOS: `launchctl kickstart -k gui/$(id -u)/com.xport.daemon`), systemd (Linux: `systemctl --user restart com.xport.daemon`), or Scheduled Task (Windows: `Stop-ScheduledTask -TaskName XPortDaemon; Start-ScheduledTask -TaskName XPortDaemon`). Logs: macOS/Windows at `~/.xport/daemon-stderr.log`, Linux via `journalctl --user -u com.xport.daemon`.
- **Transport debugging:** The popup shows connection status and auto-refreshes every 2s. When transport is unavailable, the popup and debug dashboard show an actionable error message. Service worker console logs transport selection at startup and reprobe attempts. Daemon startup diagnostics are always logged to `~/.xport/daemon-stderr.log`; set `XPORT_LOG_LEVEL=debug` for request-level detail.
- **XPort skill CLI:** `skill/xport` must stay aligned with the hosted API plus `tweets`/`tweet_media` tables. Search/get/recent/stats are stored-data reads only. `transcribe` is an explicit daemon-side enrichment carve-out and must only use media URLs already stored in `tweet_media`; photo asset storage is automatic after ingest.
- **Release checklist:** (1) Bump `extension/manifest.json` version, (2) bump `native-host/xport_daemon.py` `VERSION`, (3) if any new files were added to the extension or native-host, **update the file list in `.github/workflows/release.yml`** — the release zip uses an explicit list, not a glob, so new files will be silently missing from releases if not added. (4) Follow the **Release procedure** below to publish.

## Release Procedure

Every release follows the same flow so notes stay consistent across tags. Notes
are always hand-written from the squashed PR body + the diff — never let the
workflow auto-generate them.

1. After the version-bump PR merges, pull main: `git checkout main && git pull --ff-only`.
2. Draft notes locally using the template below. Save to `/tmp/release-notes-vX.Y.Z.md`.
3. Pre-create the GitHub release as a draft with those notes:
   `gh release create vX.Y.Z --draft --title vX.Y.Z --notes-file /tmp/release-notes-vX.Y.Z.md`
4. Push the tag: `git push origin vX.Y.Z`.
5. The Release workflow detects the existing draft and uploads `xport-X.Y.Z.zip` into it (no notes overwritten).
6. Verify the release page: zip attached, notes render correctly. Click **Publish release** when ready.
7. Delete the local notes file and any merged feature branches.

If the workflow ever runs against a tag with no pre-existing release, it falls
back to `gh release create --generate-notes`. That fallback is a safety net,
not the intended path. Always pre-create.

### Release Notes Template

Required sections (always present, in this order):

```markdown
## Highlights

<1–3 bullets in plain English. What changed for users. Concrete, no hype.>

## Upgrading

<One line. Either: "No installer re-run needed — `git pull`, restart daemon,
reload extension." Or: "Re-run `install.sh` (or `install.ps1`) because <reason>.">
```

Optional sections (include ONLY when content exists; never ship an empty header):

- `## What's new` — feature details, link to the PR (#NN).
- `## Fixes` — user-visible bug fixes, one bullet each, link to PRs.
- `## Hardening` — security-relevant changes (path validation, allowlists, size caps, etc.).
- `## Tuning` — new env vars / config knobs, with defaults.
- `## Stats` — test count, coverage, e2e scenarios. Trust signal — keep it factual.

Voice rules (same as the rest of the project):

- Concrete, specific, terse. Name files, env vars, PR numbers.
- No AI vocabulary (no "comprehensive", "robust", "nuanced", etc.) and no marketing copy.
- Reference issues and PRs by number so users can dig in.
- If a section would only have a single trivial bullet, fold it into Highlights instead of giving it its own header.
- Imperative, active voice in bullets. "Block redirects" beats "Redirects are now blocked."

When working with the user during a release, the assistant drafts the notes,
shows them in chat for approval, then runs the `gh release create --draft`
command. The user reviews on GitHub and clicks Publish.

## Contributing

- Keep it simple. No build tools, no frameworks, no dependencies beyond Python 3 stdlib.
- Run `python3 -m pytest tests/ -v && node --test tests/*.test.mjs` before submitting changes.
- Every change must maintain zero network footprint. This is the core promise.
- Stealth constraints are non-negotiable — review the list above before submitting changes.
- **Update README.md and AGENTS.md after every relevant change** — new features, changed behavior, new config options, output format changes, new endpoints, architectural changes, etc. Both files must stay in sync with the code.
