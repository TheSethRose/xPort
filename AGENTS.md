# AGENTS.md - XPort

## Project

XPort passively captures tweets from X/Twitter GraphQL responses the browser already received, then sends structured tweet/media data through a local daemon to the hosted PostgreSQL API.

- Repo: `github.com/TheSethRose/xPort`
- License: MIT
- Load the Chrome extension from `extension/`, never the repo root.
- No build step: plain extension JS plus Python daemon/API code.

## Hard Rules

XPort must remain browser-passive.

- Reject browser-side network requests to `x.com`, `twitter.com`, `pbs.twimg.com`, or `video.twimg.com`.
- Browser code may only read responses the page already received.
- Keep native-looking patches: patched `fetch.toString()` returns `function fetch() { [native code] }`, `fetch.name` stays `fetch`, and `XHR.open.toString()` returns the original native string.
- Track XHR URLs with `WeakMap`; no expando properties.
- Keep page DOM footprint invisible. The only page artifact is the transient `<meta name="__cfg">`, removed by the bridge.
- Never log from page context.
- Keep extension permissions minimal: `storage`, `nativeMessaging`, scoped host permissions, no `webRequest`, `tabs`, `scripting`, or web-accessible debug dashboard.
- Patch only `XHR.open()`, not `send()`.
- Keep `README.md` and `AGENTS.md` in sync after relevant behavior, config, endpoint, schema, architecture, or release-process changes.

Allowed daemon-side media fetches, after allowlist validation only:

- Automatic photo asset storage for captured `pbs.twimg.com` photo URLs after successful ingest.
- User-initiated `/transcribe-media` for one stored `video.twimg.com` or `pbs.twimg.com` media URL.
- `/fetch-media-image` for API/CLI compatibility. Dashboard UI should rely on automatic image storage.

## Architecture

Capture path:

`content-main.js` -> random `CustomEvent` -> `content-bridge.js` -> `background.js` -> `xport_daemon.py` -> `POST /api/ingest/tweets` -> PostgreSQL tables `tweets`, `tweet_media`, `ingest_batches`.

Key files:

- `extension/content-main.js`: MAIN world `fetch()` and `XHR.open()` observer.
- `extension/content-bridge.js`: ISOLATED world event relay; removes the transient meta tag.
- `extension/background.js`: ES module service worker; imports parser, dedups IDs, batches 50 tweets, flushes every 30-45s with jitter, talks only to daemon.
- `extension/lib/tweet-parser.js`: fragile GraphQL parser. Use fixtures and golden tests for changes.
- `native-host/xport_host.py`: native messaging token bootstrap only. Serves `GET_TOKEN` from `~/.xport/secret`; no capture data.
- `native-host/xport_daemon.py`: HTTP daemon on `127.0.0.1:17381`; bearer auth; forwards ingest, stores assets, exposes daemon endpoints.
- `native-host/xport_core.py`: shared daemon logic for API forwarding, file I/O, path validation, stored tweet lookup, image queueing, and media enrichment.
- `api/xport_api.py`: hosted PostgreSQL ingestion/read API.
- `skill/xport`: stored capture CLI. Reads hosted API or `DATABASE_URL`; transcription is explicit daemon-side enrichment from stored media URLs.

## Data/API Contract

- Capture requires `XPORT_API_URL` and `XPORT_INGEST_TOKEN`. If ingest fails, the daemon returns an error and the extension keeps the batch buffered.
- There is no local tweet JSONL fallback.
- Daemon endpoints: `GET /status`, `POST /tweets`, `POST /log`, `POST /dump`, `POST /test-path`, `POST /stored-tweets`, `POST /transcribe-media`, `POST /transcription-status`, `POST /fetch-media-image`.
- Hosted endpoints: `GET /health`, `POST /api/ingest/tweets`, `GET /api/tweets`, `GET /api/tweets/<tweet_id>`, `GET /api/tweets/<tweet_id>/media`, `GET /api/media/<media_id>`, `GET /api/media/<media_id>/content`, `GET /api/stats`, `POST /api/media/<media_id>/transcription`, `POST /api/media/<media_id>/asset`.

Raw tweet JSON stores normalized tweet data plus raw fields: IDs, URL, timestamps, author, text, lang, metrics, media, URLs, hashtags, mentions, reply/quote/retweet/conversation fields, and article-only `article.title`, `article.text`, `article.blocks`, `article.media`.

Important tweet behavior:

- `media[].duration_ms` is video-only; `metrics.views` may be `null`.
- Retweets store the original full text, not truncated `RT @user:` text.
- Article tweets bypass dedup so `TweetResultByRestId` can replace timeline stubs.
- Media-bearing duplicates bypass dedup once when an earlier capture had no media.
- Duplicate captures are still sent to Postgres as upserts so revisiting a tweet updates the stored row without adding a second tweet.
- Top-level `media[]` does not include `local_path`; consumers reconstruct `media/<tweet_id>/<basename(url)>`.

## Parser and Fixtures

Known parser endpoints: `HomeTimeline`, `HomeLatestTimeline`, `UserTweets`, `UserTweetsAndReplies`, `UserMedia`, `UserLikes`, `UserArticlesTweets`, `UserHighlightsTweets`, `TweetDetail`, `SearchTimeline`, `ListLatestTweetsTimeline`, `Bookmarks`, `Likes`, `CommunityTweetsTimeline`, `BookmarkFolderTimeline`, `TweetResultByRestId`.

- Unknown endpoints fall back to recursive `instructions[]` search, max depth 5.
- Non-tweet endpoints are filtered by `IGNORED_ENDPOINTS` in `extension/background.js`.
- Sanitized fixture packs live in `tests/fixtures/sanitized/<scenario>/`.
- Raw captures belong only in gitignored `tests/fixtures/private-raw/`.
- Fixture docs/checklist live in `tests/fixtures/FIXTURES.md`.
- Discovery mode emits `dump-{endpoint}-{timestamp}.json` in `{ endpoint, data }` format.
- Sanitize dumps with `node tests/fixtures/tools/sanitize.mjs <dump-file> <scenario-name>`.

New endpoint workflow: human captures discovery dump, sanitize it, run `node --test tests/parser-golden.test.mjs`, fix parser if needed, rerun until green, regenerate expected output by rerunning `sanitize.mjs`.

## Development Commands

- Full local check: `uv run --with pytest --with 'psycopg[binary]==3.2.13' pytest tests/ -v && node --test tests/*.test.mjs`
- Legacy/full-submit check: `python3 -m pytest tests/ -v && node --test tests/*.test.mjs`
- Parser inner loop: `node --test tests/parser-golden.test.mjs`
- E2E gate: `cd tests/e2e && npm test`

Run the smallest relevant validation. Parser changes should at least run the golden parser test.

## Runtime Notes

- Dev mode is `!chrome.runtime.getManifest().update_url`.
- Dev mode stores `seenIds` and `mediaSeenIds` in `chrome.storage.session` when available, falling back to `chrome.storage.local`; production uses `chrome.storage.local`.
- Raw staged GraphQL payloads use session storage when available so MV3 service worker suspension can replay them; they are not meant to survive browser restart.
- `seenIds` is FIFO capped at 50,000.
- Path validation goes through daemon `TEST_PATH`, which attempts `makedirs` plus temp write/delete before accepting a media/debug directory.
- Popup refreshes transport status every 2s. On daemon failure, the extension buffers and reprobes every 30s.
- Debug logs write to `debug-YYYY-MM-DD.log` in the output directory when enabled.
- Daemon startup diagnostics go to `~/.xport/daemon-stderr.log` on macOS/Windows and `journalctl --user -u com.xport.daemon` on Linux.
- Set `XPORT_LOG_LEVEL=debug` for request-level daemon logs; re-run `install.sh` after service-template env changes.

Daemon management:

- macOS: `launchctl kickstart -k gui/$(id -u)/com.xport.daemon`
- Linux: `systemctl --user restart com.xport.daemon`
- Windows: `Stop-ScheduledTask -TaskName XPortDaemon; Start-ScheduledTask -TaskName XPortDaemon`

Media env vars: `XPORT_AUTO_STORE_IMAGES` default true, `XPORT_TRANSCRIBE_COMMAND`, `XPORT_TRANSCRIBE_MODEL` default `nvidia/parakeet-tdt-0.6b-v3`, `XPORT_TRANSCRIBE_MAX_FILE_MB` default `75`, `XPORT_TRANSCRIBE_REQUEST_TIMEOUT_SECONDS` default `60`, `XPORT_IMAGE_FETCH_MAX_FILE_MB` default `XPORT_MAX_FILE_MB` or `50`.

macOS/Linux installs auto-use `native-host/xport_transcribe_parakeet.sh` when `parakeet-mlx` and `ffmpeg` are on `PATH` and no transcription command is set.

## UI Rules

- Popup answers capture health first, then current-session count plus stored Postgres all-time count, pause/resume, recent session tweets, and dashboard links.
- Dashboard opens tweet-first. Tweets tab pages stored Postgres tweets via `/stored-tweets`, supplemented by related current-session capture events, and renders the table 100 rows per page. Default posted-date sorts must not promote event-only rows that lack `created_at`; use captured-date sorts for recency-by-capture. Keep tweet search/filter/sort, including date and metric sorts, server-side so the browser does not hydrate the full tweet history.
- Tweets table header selection stays page-scoped. Use `Select all N matching` for query-scoped bulk actions across all matching paginated tweets; resolve matching rows lazily only when a bulk action needs the rows.
- Live Events is current-session only. Debug, transport, parser, and settings are secondary tabs.
- Stored tweets and capture events keep auto-refresh and auto-scroll controls.
- Dynamic Tweets filters for authors, sources, and endpoints must use API facets from the full stored dataset, not just the visible page. Typed author/source/endpoint option searches should query facets through the daemon/API instead of hydrating all tweets.
- Long-list filters, including transcription status, use searchable dropdowns.
- Open filter dropdowns count as active editing: background refresh may fetch, but must not rebuild visible controls until close.
- Tweet detail drawer shows video/GIF transcript status, model, timestamp, error, and stored transcript text when media metadata includes it.

## Known Issues

- macOS TCC: browser-launched native messaging hosts can lose protected-path access after browser restart. The launchd daemon is the write path.
- Tombstone tweets: `TimelineTweet` entries missing `tweet_results.result` are skipped. No ID enters dedup, so a later full tweet can still be captured.

## Release

Checklist:

1. Bump `extension/manifest.json` version.
2. Bump `native-host/xport_daemon.py` `VERSION`.
3. If extension or native-host files were added, update the explicit release zip list in `.github/workflows/release.yml`.
4. Follow the release procedure.

Procedure:

1. After version-bump PR merge: `git checkout main && git pull --ff-only`.
2. Draft notes at `/tmp/release-notes-vX.Y.Z.md`.
3. Create draft release: `gh release create vX.Y.Z --draft --title vX.Y.Z --notes-file /tmp/release-notes-vX.Y.Z.md`.
4. Push tag: `git push origin vX.Y.Z`.
5. Confirm workflow uploads `xport-X.Y.Z.zip` into the draft without overwriting notes.
6. Verify the release page; user publishes on GitHub.
7. Delete local notes and merged feature branches.

Release notes:

- Required sections: `## Highlights` with 1-3 concrete user-facing bullets, then `## Upgrading` with one installer/restart line.
- Optional sections only with real content: `## What's new`, `## Fixes`, `## Hardening`, `## Tuning`, `## Stats`.
- Concrete, terse, active voice. Name files, env vars, issues, and PRs when relevant.
- No AI vocabulary or marketing copy.
- During a release, draft notes in chat for approval before running `gh release create --draft`.

## Contributing

- Keep it simple. No build tools, frameworks, or production dependencies beyond current project choices unless explicitly approved.
- Every change must maintain zero browser-side X/Twitter network footprint.
- Review stealth rules before capture-path changes.
