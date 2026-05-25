#!/usr/bin/env python3
"""XPort HTTP Daemon — runs as a system service (launchd/systemd/Scheduled Task)."""

import hmac
import json
import os
import platform
import signal
import sys
import time
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

from xport_core import (DEFAULT_API_URL, DEFAULT_INGEST_TOKEN,
                       DEFAULT_OUTPUT_DIR, resolve_output_dir,
                       validate_output_dir, write_log, write_dump, test_path,
                       forward_tweets_to_api, list_stored_tweets_from_api,
                       enqueue_image_asset_storage, start_media_transcription,
                       get_transcription_status, fetch_store_image_asset)

VERSION = '0.23.1'
BIND_HOST = '127.0.0.1'
BIND_PORT = int(os.environ.get('XPORT_DAEMON_PORT', 17381))
MAX_BODY_SIZE = 10 * 1024 * 1024  # 10 MB
XPORT_DIR = os.path.expanduser('~/.xport')
XPORT_SECRET = os.path.join(XPORT_DIR, 'secret')

# Log level: 'info' (default) or 'debug'
LOG_LEVEL = os.environ.get('XPORT_LOG_LEVEL', 'info').lower()


def log_info(msg):
    print(msg, file=sys.stderr)


def log_debug(msg):
    if LOG_LEVEL == 'debug':
        print(f'[DEBUG] {msg}', file=sys.stderr)


def load_token():
    try:
        with open(XPORT_SECRET, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        log_info(f'FATAL: {XPORT_SECRET} not found. Run install.sh first.')
        sys.exit(1)


# Module-level state shared across requests
_token = None
_state_lock = threading.Lock()


class DaemonHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Log to stderr (captured by launchd/systemd)
        log_info(f'{self.client_address[0]} - {format % args}')

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)
        log_debug(f'  -> {status} ({len(body)} bytes)')

    def _read_json(self, length):
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def _check_auth(self):
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or not hmac.compare_digest(auth[7:], _token):
            log_debug(f'  Auth failed (header {"present" if auth else "missing"})')
            self._send_json({'ok': False, 'error': 'Unauthorized'}, 401)
            return False
        return True

    def do_GET(self):
        log_debug(f'GET {self.path}')
        if self.path == '/status':
            # Validate token when provided (allows probeHttp to detect stale credentials)
            auth = self.headers.get('Authorization', '')
            if auth and (not auth.startswith('Bearer ') or not hmac.compare_digest(auth[7:], _token)):
                self._send_json({'ok': False, 'error': 'Unauthorized'}, 401)
                return
            self._send_json({'ok': True, 'version': VERSION})
            return
        self._send_json({'ok': False, 'error': 'Not found'}, 404)

    def _validate_content_length(self):
        """Validate Content-Length header. Returns length or -1 on error (response already sent)."""
        raw = self.headers.get('Content-Length')
        if raw is None:
            self._send_json({'ok': False, 'error': 'Missing Content-Length header'}, 400)
            return -1
        try:
            length = int(raw)
        except ValueError:
            self._send_json({'ok': False, 'error': f'Invalid Content-Length: {raw!r}'}, 400)
            return -1
        if length < 0:
            self._send_json({'ok': False, 'error': 'Content-Length must not be negative'}, 400)
            return -1
        if length > MAX_BODY_SIZE:
            self._send_json({'ok': False, 'error': 'Payload too large'}, 413)
            return -1
        return length

    def do_POST(self):
        log_debug(f'POST {self.path} (Content-Length: {self.headers.get("Content-Length", "?")})')

        length = self._validate_content_length()
        if length < 0:
            return

        if not self._check_auth():
            return

        try:
            body = self._read_json(length)
        except (json.JSONDecodeError, ValueError) as e:
            self._send_json({'ok': False, 'error': f'Invalid JSON: {e}'}, 400)
            return

        t0 = time.monotonic()
        if self.path == '/tweets':
            self._handle_tweets(body)
        elif self.path == '/log':
            self._handle_log(body)
        elif self.path == '/dump':
            self._handle_dump(body)
        elif self.path == '/test-path':
            self._handle_test_path(body)
        elif self.path == '/stored-tweets':
            self._handle_stored_tweets(body)
        elif self.path == '/transcribe-media':
            self._handle_transcribe_media(body)
        elif self.path == '/transcription-status':
            self._handle_transcription_status(body)
        elif self.path == '/fetch-media-image':
            self._handle_fetch_media_image(body)
        else:
            self._send_json({'ok': False, 'error': 'Not found'}, 404)
        elapsed = (time.monotonic() - t0) * 1000
        log_debug(f'  Completed in {elapsed:.1f}ms')

    def _handle_tweets(self, body):
        try:
            tweets = body.get('tweets', [])
            if not isinstance(tweets, list):
                self._send_json({'ok': False, 'error': 'tweets must be an array'}, 400)
                return

            forward = forward_tweets_to_api(tweets)
            if forward.get('ok') is not True:
                error = forward.get('error') or 'Postgres ingest failed'
                log_info(f'WARN /tweets remote ingest failed: {error}')
                status = 503 if not forward.get('enabled') else 502
                self._send_json({'ok': False, 'error': error}, status)
                return

            count = forward.get('count')
            if count is None:
                count = len(tweets)
            images_queued = enqueue_image_asset_storage(tweets)
            log_debug(f'  Tweets: {count} ingested; images queued: {images_queued}')
            response = {
                'ok': True,
                'count': count,
                'dupes': 0,
                'images_queued': images_queued,
                'forwarded': True,
                'remote_count': count,
                'remote_batch_id': forward.get('batch_id'),
            }
            self._send_json(response)
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /tweets: {e}')
            log_debug(f'  Traceback: {_format_exc()}')
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_log(self, body):
        try:
            msg_dir = body.get('outputDir', '').strip()
            with _state_lock:
                out_dir = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR)
            lines = body.get('lines', [])
            logged = write_log(lines, out_dir)
            self._send_json({'ok': True, 'logged': logged})
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /log: {e}')
            log_debug(f'  Traceback: {_format_exc()}')
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_dump(self, body):
        try:
            msg_dir = body.get('outputDir', '').strip()
            with _state_lock:
                out_dir = resolve_output_dir(msg_dir, DEFAULT_OUTPUT_DIR)
                filename = body.get('filename', 'dump.json')
                content = body.get('content', '')
                path = write_dump(filename, content, out_dir)
            self._send_json({'ok': True, 'path': path})
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /dump: {e}')
            log_debug(f'  Traceback: {_format_exc()}')
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_test_path(self, body):
        try:
            msg_dir = body.get('outputDir', '').strip()
            if not msg_dir:
                self._send_json({'ok': False, 'error': 'outputDir is required'}, 400)
                return
            out_dir = validate_output_dir(os.path.expanduser(msg_dir))
            test_path(out_dir)
            self._send_json({'ok': True, 'type': 'TEST_PATH'})
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /test-path: {e}')
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_stored_tweets(self, body):
        try:
            tweets = list_stored_tweets_from_api(
                limit=body.get('limit', 50),
                offset=body.get('offset', 0),
                include_raw=bool(body.get('includeRaw') or body.get('include_raw')),
                query=body.get('query') or body.get('q'),
                author=body.get('author'),
                endpoint=body.get('endpoint'),
                since=body.get('since'),
                until=body.get('until'),
                media=body.get('media'),
                transcription=body.get('transcription'),
                has_quoted=bool(body.get('hasQuoted') or body.get('has_quoted')),
                has_reply=bool(body.get('hasReply') or body.get('has_reply')),
                sort=body.get('sort') or 'newest',
                include_total=bool(body.get('includeTotal') or body.get('include_total')),
                include_facets=bool(body.get('includeFacets') or body.get('include_facets')),
                include_metrics=bool(body.get('includeMetrics') or body.get('include_metrics')),
            )
            if isinstance(tweets, dict):
                self._send_json({'ok': True, **tweets})
            else:
                self._send_json({'ok': True, 'tweets': tweets})
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /stored-tweets: {e}')
            log_debug(f'  Traceback: {_format_exc()}')
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_transcribe_media(self, body):
        try:
            result = start_media_transcription(
                body.get('media_id') or body.get('mediaId'),
                body.get('tweet_id') or body.get('tweetId'),
                body.get('source_url') or body.get('sourceUrl'),
                body.get('duration_ms') or body.get('durationMs'),
            )
            if result.get('status') == 'busy':
                status_code = 409
            elif result.get('ok') is not True:
                status_code = 503
            else:
                status_code = 200
            self._send_json(result, status_code)
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /transcribe-media: {e}')
            log_debug(f'  Traceback: {_format_exc()}')
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_transcription_status(self, body):
        media_id = body.get('media_id') or body.get('mediaId')
        if not media_id:
            self._send_json({'ok': False, 'error': 'media_id is required'}, 400)
            return
        self._send_json({'ok': True, 'media_id': media_id, **get_transcription_status(str(media_id))})

    def _handle_fetch_media_image(self, body):
        try:
            result = fetch_store_image_asset(
                body.get('media_id') or body.get('mediaId'),
                body.get('tweet_id') or body.get('tweetId'),
                body.get('source_url') or body.get('sourceUrl'),
            )
            self._send_json(result)
        except ValueError as e:
            self._send_json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            log_info(f'ERROR /fetch-media-image: {e}')
            log_debug(f'  Traceback: {_format_exc()}')
            self._send_json({'ok': False, 'error': str(e)}, 500)


def _format_exc():
    import traceback
    return traceback.format_exc().replace('\n', ' | ')


def _setup_stdio():
    """Redirect stdio to log files when running under pythonw (no console)."""
    if sys.stderr is not None and sys.stdout is not None:
        return
    os.makedirs(XPORT_DIR, exist_ok=True)
    if sys.stdout is None:
        sys.stdout = open(os.path.join(XPORT_DIR, 'daemon-stdout.log'), 'a')
    if sys.stderr is None:
        sys.stderr = open(os.path.join(XPORT_DIR, 'daemon-stderr.log'), 'a')


def _log_startup_diagnostics():
    """Log system and configuration info on startup."""
    log_info(f'XPort daemon v{VERSION}')
    log_info(f'  Python:     {sys.version.split(chr(10))[0]}')
    log_info(f'  Executable: {sys.executable}')
    log_info(f'  Script:     {os.path.abspath(__file__)}')
    log_info(f'  Platform:   {platform.system()} {platform.release()}')
    log_info(f'  Output dir: {DEFAULT_OUTPUT_DIR}')
    log_info(f'  Postgres:   {"configured" if DEFAULT_API_URL and DEFAULT_INGEST_TOKEN else "NOT configured"}')
    log_info(f'  Token:      loaded ({len(_token)} chars)')
    log_info(f'  Log level:  {LOG_LEVEL}')

    # Check output dir writability
    try:
        test_path(DEFAULT_OUTPUT_DIR)
        log_info(f'  Output dir: writable')
    except Exception as e:
        log_info(f'  Output dir: NOT writable ({e})')


def main():
    global _token

    _setup_stdio()

    _token = load_token()

    # Initialize local artifact directory used for debug logs, dumps, media, and videos.
    os.makedirs(DEFAULT_OUTPUT_DIR, exist_ok=True)

    _log_startup_diagnostics()

    try:
        server = ThreadingHTTPServer((BIND_HOST, BIND_PORT), DaemonHandler)
    except OSError as e:
        log_info(f'FATAL: Cannot bind to {BIND_HOST}:{BIND_PORT} — {e}')
        log_info(f'  Is another instance already running?')
        sys.exit(1)

    def shutdown(signum, frame):
        log_info(f'Received signal {signum}, shutting down...')
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    if platform.system() == 'Windows':
        signal.signal(signal.SIGBREAK, shutdown)
    else:
        signal.signal(signal.SIGTERM, shutdown)

    log_info(f'Listening on {BIND_HOST}:{BIND_PORT}')
    server.serve_forever()


if __name__ == '__main__':
    main()
