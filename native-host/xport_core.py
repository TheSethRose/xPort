"""XPort Core — shared daemon helpers."""

import json
import os
import base64
import shlex
import subprocess
import sys
import threading
import time
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import queue
from datetime import date
from urllib.parse import urlparse


DEFAULT_OUTPUT_DIR = os.environ.get('XPORT_OUTPUT_DIR', os.path.expanduser('~/Downloads/xport'))
DEFAULT_API_URL = os.environ.get('XPORT_API_URL', '').rstrip('/')
DEFAULT_INGEST_TOKEN = os.environ.get('XPORT_INGEST_TOKEN', '')

# Allowed roots for outputDir validation: user's home + DEFAULT_OUTPUT_DIR
# (the latter covers XPORT_OUTPUT_DIR pointing outside home, e.g. /data/xport)
_ALLOWED_ROOTS = tuple(dict.fromkeys([
    os.path.realpath(os.path.expanduser('~')),
    os.path.realpath(DEFAULT_OUTPUT_DIR),
]))


def validate_output_dir(path):
    """Validate that a resolved path is under an allowed root directory.

    Args:
        path: The path to validate (should already be expanduser'd).

    Returns:
        The realpath-resolved path.

    Raises:
        ValueError: If the path resolves outside all allowed roots.
    """
    resolved = os.path.realpath(path)
    for root in _ALLOWED_ROOTS:
        # Append os.sep so '/home/userX' doesn't match root '/home/user'
        if resolved == root or resolved.startswith(root + os.sep):
            return resolved
    raise ValueError(
        f'outputDir resolves outside allowed directories: {resolved}'
    )


def resolve_output_dir(msg_dir, default_dir):
    """Resolve the local artifact directory from a request."""
    if msg_dir:
        out_dir = validate_output_dir(os.path.expanduser(msg_dir))
        os.makedirs(out_dir, exist_ok=True)
    else:
        out_dir = default_dir
    return out_dir


def forward_tweets_to_api(tweets, source='xport-daemon'):
    """Forward a captured tweet batch to the hosted XPort API when configured."""
    api_url = DEFAULT_API_URL
    token = DEFAULT_INGEST_TOKEN
    if not api_url or not token:
        return {
            'enabled': False,
            'ok': False,
            'error': 'XPORT_API_URL and XPORT_INGEST_TOKEN are required for tweet capture',
        }
    if not isinstance(tweets, list) or not tweets:
        return {'enabled': True, 'ok': True, 'count': 0}

    timeout = _env_float('XPORT_API_TIMEOUT_SECONDS', 5.0)
    retries = max(0, _env_int('XPORT_API_RETRIES', 2))
    endpoint = f'{api_url}/api/ingest/tweets'
    body = json.dumps({'source': source, 'tweets': tweets}, ensure_ascii=False).encode('utf-8')
    last_error = None

    for attempt in range(retries + 1):
        req = urllib.request.Request(endpoint, data=body, method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('Authorization', f'Bearer {token}')
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read() or b'{}')
                if 200 <= resp.status < 300 and payload.get('ok') is True:
                    return {
                        'enabled': True,
                        'ok': True,
                        'count': payload.get('upserted', payload.get('count')),
                        'batch_id': payload.get('batch_id'),
                    }
                last_error = f'HTTP {resp.status}: {payload}'
        except urllib.error.HTTPError as e:
            try:
                details = e.read().decode('utf-8', errors='replace')
            except Exception:
                details = ''
            last_error = f'HTTP {e.code}: {details}'
        except Exception as e:
            last_error = str(e)

        if attempt < retries:
            time.sleep(min(2 ** attempt, 5))

    return {'enabled': True, 'ok': False, 'error': last_error or 'forward failed'}


def _api_json(method, path, payload=None, query=None):
    api_url = DEFAULT_API_URL
    token = DEFAULT_INGEST_TOKEN
    if not api_url or not token:
        raise RuntimeError('XPORT_API_URL and XPORT_INGEST_TOKEN are required')
    url = f'{api_url}{path}'
    if query:
        encoded = urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        if encoded:
            url = f'{url}?{encoded}'
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', f'Bearer {token}')
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=_env_float('XPORT_API_TIMEOUT_SECONDS', 5.0)) as resp:
        return json.loads(resp.read() or b'{}')


def list_stored_tweets_from_api(limit=50, offset=0, include_raw=False):
    """Fetch a stored tweet page from the hosted API, including media rows."""
    limit = max(1, min(int(limit or 50), 500))
    offset = max(0, int(offset or 0))
    query = {
        'limit': limit,
        'offset': offset,
        'include_media': 'true',
    }
    if include_raw:
        query['include_raw'] = 'true'
    result = _api_json('GET', '/api/tweets', query=query)
    if result.get('ok') is not True:
        raise RuntimeError(result.get('error') or 'stored tweet lookup failed')
    return result.get('tweets') or []


def write_log(lines, out_dir):
    """Append debug log lines to daily log file. Returns logged count."""
    os.makedirs(out_dir, exist_ok=True)
    log_file = os.path.join(out_dir, f'debug-{date.today().isoformat()}.log')
    with open(log_file, 'a') as f:
        for line in lines:
            f.write(line + '\n')
    return len(lines)


def write_dump(filename, content, out_dir):
    """Write a raw JSON dump file for discovery/debugging."""
    # Strip path components — only the basename is allowed
    safe_name = os.path.basename(filename)
    if not safe_name or safe_name in ('.', '..'):
        raise ValueError(f'Invalid dump filename: {filename!r}')
    os.makedirs(out_dir, exist_ok=True)
    dump_file = os.path.join(out_dir, safe_name)
    with open(dump_file, 'w') as f:
        f.write(content)
    return dump_file


def test_path(out_dir):
    """Test that we can write to the output directory. Raises on failure."""
    os.makedirs(out_dir, exist_ok=True)
    test_file = os.path.join(out_dir, f'.xport-write-test-{threading.get_ident()}')
    try:
        with open(test_file, 'w') as f:
            f.write('ok')
    finally:
        try:
            os.remove(test_file)
        except FileNotFoundError:
            pass


# --- Media fetch helpers ---

ALLOWED_IMAGE_HOSTS = frozenset({'pbs.twimg.com'})
ALLOWED_VIDEO_HOSTS = frozenset({'video.twimg.com', 'pbs.twimg.com'})
USER_AGENT = 'XPort/1.0 (+https://github.com/TheSethRose/xPort)'
REQUEST_TIMEOUT_S = 30
CHUNK_SIZE = 64 * 1024
_image_asset_queue = None
_image_asset_worker = None
_image_asset_lock = threading.Lock()


def collect_image_asset_jobs(tweets):
    """Return Postgres media asset jobs for photos in a captured tweet batch."""
    jobs = []
    if not isinstance(tweets, list):
        return jobs
    for tweet in tweets:
        if not isinstance(tweet, dict):
            continue
        tweet_id = tweet.get('id') or tweet.get('tweet_id')
        if not tweet_id:
            continue
        tweet_id = str(tweet_id)
        media_items = tweet.get('media') if isinstance(tweet.get('media'), list) else []
        for index, item in enumerate(media_items):
            job = _image_asset_job(tweet_id, index, item)
            if job:
                jobs.append(job)
        article = tweet.get('article') if isinstance(tweet.get('article'), dict) else {}
        article_media = article.get('media') if isinstance(article.get('media'), list) else []
        for index, item in enumerate(article_media):
            media_id = f'{tweet_id}:article:{index}'
            job = _image_asset_job(tweet_id, len(media_items) + index, item, media_id=media_id)
            if job:
                jobs.append(job)
    return jobs


def _image_asset_job(tweet_id, index, item, media_id=None):
    if not isinstance(item, dict):
        return None
    media_type = item.get('type') or ('photo' if item.get('url') or item.get('source_url') else None)
    if media_type != 'photo':
        return None
    source_url = item.get('url') or item.get('source_url')
    if not source_url:
        return None
    return {
        'media_id': str(item.get('media_id') or item.get('id') or media_id or f'{tweet_id}:{index}'),
        'tweet_id': str(tweet_id),
        'source_url': source_url,
    }


def enqueue_image_asset_storage(tweets):
    """Queue automatic photo asset storage. Returns number of queued jobs."""
    if not _env_bool('XPORT_AUTO_STORE_IMAGES', True):
        return 0
    jobs = collect_image_asset_jobs(tweets)
    if not jobs:
        return 0
    worker_queue = _ensure_image_asset_worker()
    for job in jobs:
        worker_queue.put(job)
    return len(jobs)


def _ensure_image_asset_worker():
    global _image_asset_queue, _image_asset_worker
    with _image_asset_lock:
        if _image_asset_queue is None:
            _image_asset_queue = queue.Queue()
        if _image_asset_worker is None or not _image_asset_worker.is_alive():
            _image_asset_worker = threading.Thread(
                target=_image_asset_worker_loop,
                daemon=True,
                name='xport-image-assets',
            )
            _image_asset_worker.start()
        return _image_asset_queue


def _image_asset_worker_loop():  # pragma: no cover - covered through queue/job helpers
    while True:
        job = _image_asset_queue.get()
        try:
            fetch_store_image_asset(job['media_id'], job['tweet_id'], job['source_url'])
        except Exception as e:
            print(
                f'[xport:image] auto-store failed for {job.get("media_id")}: {e}',
                file=sys.stderr,
            )
        finally:
            _image_asset_queue.task_done()


def _env_int(name, default):
    """Parse an int env var, falling back to default on missing/empty/invalid."""
    raw = (os.environ.get(name) or '').strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        print(f'[xport:image] invalid {name}={raw!r}, using {default}', file=sys.stderr)
        return default


def _env_float(name, default):
    raw = (os.environ.get(name) or '').strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        print(f'[xport:image] invalid {name}={raw!r}, using {default}', file=sys.stderr)
        return default


def _env_bool(name, default):
    raw = (os.environ.get(name) or '').strip().lower()
    if not raw:
        return default
    if raw in {'1', 'true', 'yes', 'on'}:
        return True
    if raw in {'0', 'false', 'no', 'off'}:
        return False
    print(f'[xport:image] invalid {name}={raw!r}, using {default}', file=sys.stderr)
    return default


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Treat any redirect as an error so we never fetch beyond the allowlisted host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f'redirect to {newurl} blocked', headers, fp)


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler())


# --- On-demand transcription ---

TRANSCRIPTION_MODEL = os.environ.get('XPORT_TRANSCRIBE_MODEL', 'nvidia/parakeet-tdt-0.6b-v3')
TRANSCRIBE_MAX_FILE_MB = _env_int('XPORT_TRANSCRIBE_MAX_FILE_MB', 75)
TRANSCRIBE_REQUEST_TIMEOUT_S = _env_float('XPORT_TRANSCRIBE_REQUEST_TIMEOUT_SECONDS', 60.0)
TRANSCRIBE_COMMAND = os.environ.get('XPORT_TRANSCRIBE_COMMAND', '').strip()

_transcriptions = {}
_transcriptions_lock = threading.Lock()
_active_transcription_id = None


class EmptyTranscriptError(RuntimeError):
    pass


def get_transcription_status(media_id):
    with _transcriptions_lock:
        info = _transcriptions.get(media_id)
        if not info:
            return {'status': 'unknown'}
        return dict(info)


def start_media_transcription(media_id, tweet_id, source_url, duration_ms=None):
    """Start an explicit, user-triggered media transcription job.

    The passive capture path never calls this. The media URL is fetched only
    after this function is invoked by the daemon endpoint/UI/CLI path.
    """
    global _active_transcription_id
    media_id = str(media_id or '').strip()
    tweet_id = str(tweet_id or '').strip()
    if not media_id:
        raise ValueError('media_id is required')
    if not tweet_id:
        raise ValueError('tweet_id is required')
    if not source_url:
        raise ValueError('source_url is required')
    if not _is_allowed_media_url(source_url, ALLOWED_VIDEO_HOSTS):
        raise ValueError('source_url host is not allowed')
    if not TRANSCRIBE_COMMAND:
        error = 'XPORT_TRANSCRIBE_COMMAND is not configured'
        _set_transcription_status(media_id, 'error', error=error)
        try:
            update_media_transcription_api(media_id, 'error', error=error, transcript_model=TRANSCRIPTION_MODEL)
        except Exception as update_error:
            _set_transcription_status(media_id, 'error', error=f'{error}; status update failed: {update_error}')
        return {'ok': False, 'media_id': media_id, 'status': 'error', 'error': error}

    with _transcriptions_lock:
        if _active_transcription_id:
            return {
                'ok': False,
                'error': f'transcription already running: {_active_transcription_id}',
                'status': 'busy',
            }
        _active_transcription_id = media_id
        _transcriptions[media_id] = {'status': 'queued', 'error': None}

    update_media_transcription_api(media_id, 'queued')
    thread = threading.Thread(
        target=_run_media_transcription,
        args=(media_id, tweet_id, source_url),
        daemon=True,
        name=f'xport-transcribe-{media_id}',
    )
    thread.start()
    return {'ok': True, 'media_id': media_id, 'status': 'queued'}


def _run_media_transcription(media_id, tweet_id, source_url):  # pragma: no cover - integration-tested with fakes
    global _active_transcription_id
    try:
        _set_transcription_status(media_id, 'transcribing')
        update_media_transcription_api(media_id, 'transcribing')
        if not TRANSCRIBE_COMMAND:
            raise RuntimeError('XPORT_TRANSCRIBE_COMMAND is not configured')
        max_bytes = max(1, TRANSCRIBE_MAX_FILE_MB) * 1024 * 1024
        with tempfile.TemporaryDirectory(prefix='xport-transcribe-') as tmpdir:
            media_path, byte_size = _download_temp_media(source_url, tmpdir, max_bytes)
            transcript = _run_transcription_command(media_path)
        _set_transcription_status(media_id, 'done', byte_size=byte_size)
        update_media_transcription_api(
            media_id,
            'done',
            transcript_text=transcript,
            transcript_model=TRANSCRIPTION_MODEL,
        )
    except EmptyTranscriptError as e:
        _set_transcription_status(media_id, 'skipped', error=str(e))
        try:
            update_media_transcription_api(media_id, 'skipped', error=str(e), transcript_model=TRANSCRIPTION_MODEL)
        except Exception as update_error:
            _set_transcription_status(media_id, 'error', error=f'{e}; status update failed: {update_error}')
    except Exception as e:
        _set_transcription_status(media_id, 'error', error=str(e))
        try:
            update_media_transcription_api(media_id, 'error', error=str(e), transcript_model=TRANSCRIPTION_MODEL)
        except Exception as update_error:
            _set_transcription_status(media_id, 'error', error=f'{e}; status update failed: {update_error}')
    finally:
        with _transcriptions_lock:
            if _active_transcription_id == media_id:
                _active_transcription_id = None


def _set_transcription_status(media_id, status, error=None, byte_size=None):
    with _transcriptions_lock:
        existing = _transcriptions.get(media_id, {})
        existing.update(status=status, error=error)
        if byte_size is not None:
            existing['byte_size'] = byte_size
        _transcriptions[media_id] = existing


def _download_temp_media(url, tmpdir, max_bytes):
    parsed = urlparse(url)
    suffix = os.path.splitext(parsed.path)[1] or '.media'
    dest_path = os.path.join(tmpdir, 'source' + suffix)
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    written = 0
    with _NO_REDIRECT_OPENER.open(req, timeout=TRANSCRIBE_REQUEST_TIMEOUT_S) as resp:
        cl = resp.headers.get('Content-Length')
        if cl and cl.isdigit() and int(cl) > max_bytes:
            raise RuntimeError('media file exceeds size cap')
        with open(dest_path, 'wb') as f:
            while True:
                chunk = resp.read(CHUNK_SIZE)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    raise RuntimeError('media file exceeds size cap')
                f.write(chunk)
    return dest_path, written


def _run_transcription_command(media_path):
    if '{input}' in TRANSCRIBE_COMMAND:
        cmd = shlex.split(TRANSCRIBE_COMMAND.format(input=media_path))
    else:
        cmd = shlex.split(TRANSCRIBE_COMMAND) + [media_path]
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=_env_float('XPORT_TRANSCRIBE_COMMAND_TIMEOUT_SECONDS', 300.0),
        check=False,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or '').strip()
        raise RuntimeError(f'transcription command failed: {detail}' if detail else f'transcription command exited {proc.returncode}')
    transcript = proc.stdout.strip()
    if not transcript:
        raise EmptyTranscriptError('transcription command returned empty transcript')
    return transcript


def update_media_transcription_api(media_id, status, transcript_text=None, transcript_model=None, error=None):
    api_url = DEFAULT_API_URL
    token = DEFAULT_INGEST_TOKEN
    if not api_url or not token:
        raise RuntimeError('XPORT_API_URL and XPORT_INGEST_TOKEN are required for media transcription status updates')
    endpoint = f'{api_url}/api/media/{urllib.parse.quote(str(media_id), safe="")}/transcription'
    payload = {
        'status': status,
        'transcript_text': transcript_text,
        'transcript_model': transcript_model,
        'transcript_error': error,
    }
    body = json.dumps({k: v for k, v in payload.items() if v is not None}, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(endpoint, data=body, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(req, timeout=_env_float('XPORT_API_TIMEOUT_SECONDS', 5.0)) as resp:
        result = json.loads(resp.read() or b'{}')
    if result.get('ok') is not True:
        raise RuntimeError(result.get('error') or 'media transcription update failed')
    return result


def fetch_store_image_asset(media_id, tweet_id, source_url):
    """Explicitly fetch one image and store it in the API as binary asset bytes."""
    media_id = str(media_id or '').strip()
    tweet_id = str(tweet_id or '').strip()
    if not media_id:
        raise ValueError('media_id is required')
    if not tweet_id:
        raise ValueError('tweet_id is required')
    if not _is_allowed_media_url(source_url, ALLOWED_IMAGE_HOSTS):
        raise ValueError('source_url host is not allowed')
    max_file_mb = _env_float('XPORT_IMAGE_FETCH_MAX_FILE_MB', _env_float('XPORT_MAX_FILE_MB', 50.0))
    max_bytes = int(max_file_mb * 1024 * 1024) if max_file_mb > 0 else 50 * 1024 * 1024
    req = urllib.request.Request(source_url, headers={'User-Agent': USER_AGENT})
    chunks = []
    written = 0
    mime_type = 'application/octet-stream'
    with _NO_REDIRECT_OPENER.open(req, timeout=REQUEST_TIMEOUT_S) as resp:
        content_type = resp.headers.get('Content-Type')
        if content_type:
            mime_type = content_type.split(';', 1)[0].strip().lower()
        if not mime_type.startswith('image/'):
            raise RuntimeError(f'unexpected media type: {mime_type}')
        cl = resp.headers.get('Content-Length')
        if cl and cl.isdigit() and int(cl) > max_bytes:
            raise RuntimeError('image file exceeds size cap')
        while True:
            chunk = resp.read(CHUNK_SIZE)
            if not chunk:
                break
            written += len(chunk)
            if written > max_bytes:
                raise RuntimeError('image file exceeds size cap')
            chunks.append(chunk)
    update_media_asset_api(media_id, b''.join(chunks), mime_type)
    return {'ok': True, 'media_id': media_id, 'tweet_id': tweet_id, 'asset_byte_size': written, 'asset_mime_type': mime_type}


def update_media_asset_api(media_id, raw_bytes, mime_type):
    api_url = DEFAULT_API_URL
    token = DEFAULT_INGEST_TOKEN
    if not api_url or not token:
        raise RuntimeError('XPORT_API_URL and XPORT_INGEST_TOKEN are required for media asset storage')
    endpoint = f'{api_url}/api/media/{urllib.parse.quote(str(media_id), safe="")}/asset'
    body = json.dumps({
        'mime_type': mime_type,
        'data_base64': base64.b64encode(raw_bytes).decode('ascii'),
    }).encode('utf-8')
    req = urllib.request.Request(endpoint, data=body, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(req, timeout=_env_float('XPORT_API_TIMEOUT_SECONDS', 5.0)) as resp:
        result = json.loads(resp.read() or b'{}')
    if result.get('ok') is not True:
        raise RuntimeError(result.get('error') or 'media asset update failed')
    return result


def _is_allowed_media_url(url, allowed_hosts):
    if not url or not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != 'https':
        return False
    return (parsed.hostname or '').lower() in allowed_hosts
