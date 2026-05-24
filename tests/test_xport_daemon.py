"""Tests for native-host/xport_daemon.py — request hardening (issue #7)."""

import json
import os
import sys
import threading

import pytest
import urllib.request
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'native-host'))
import xport_core
import xport_daemon


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

TEST_TOKEN = 'test-token-for-daemon'


@pytest.fixture(autouse=True)
def _set_module_token():
    """Inject a known token into the daemon module for all tests."""
    old = xport_daemon._token
    xport_daemon._token = TEST_TOKEN
    yield
    xport_daemon._token = old


@pytest.fixture()
def daemon_url():
    """Start DaemonHandler on an ephemeral port and return its base URL."""
    from http.server import ThreadingHTTPServer
    server = ThreadingHTTPServer(('127.0.0.1', 0), xport_daemon.DaemonHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    yield f'http://127.0.0.1:{port}'
    server.shutdown()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _post(base_url, path='/', body=None, token=None, headers=None):
    """Send a POST request and return (status, parsed_json)."""
    data = json.dumps(body).encode() if body is not None else b''
    req = urllib.request.Request(f'{base_url}{path}', data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    if token is not None:
        req.add_header('Authorization', f'Bearer {token}')
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    # Content-Length is set automatically by urllib from data
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _raw_post(base_url, path='/', raw_body=b'', token=None, content_length=None):
    """Send a POST with explicit Content-Length control."""
    req = urllib.request.Request(f'{base_url}{path}', data=raw_body, method='POST')
    req.add_header('Content-Type', 'application/json')
    if token is not None:
        req.add_header('Authorization', f'Bearer {token}')
    if content_length is not None:
        req.add_header('Content-Length', str(content_length))
    # Remove auto-set Content-Length so our override takes effect
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _stub_forward_success(monkeypatch, forwarded=None, delay=0):
    """Make daemon tweet ingestion look like a successful Postgres API write."""
    import time

    def fake_forward(tweets):
        if delay:
            time.sleep(delay)
        if forwarded is not None:
            forwarded.extend(tweets)
        return {'enabled': True, 'ok': True, 'count': len(tweets), 'batch_id': 'remote-1'}

    monkeypatch.setattr(xport_daemon, 'forward_tweets_to_api', fake_forward)
    monkeypatch.setattr(xport_daemon, 'enqueue_image_asset_storage', lambda tweets: 0)


# ---------------------------------------------------------------------------
# Tests — Content-Length validation
# ---------------------------------------------------------------------------

class TestContentLengthValidation:

    def test_missing_content_length(self, daemon_url):
        """POST without Content-Length should return 400."""
        import http.client
        conn = http.client.HTTPConnection('127.0.0.1', int(daemon_url.rsplit(':', 1)[1]))
        conn.putrequest('POST', '/tweets')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Authorization', f'Bearer {TEST_TOKEN}')
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 400
        assert 'Missing Content-Length' in body['error']
        conn.close()

    def test_non_numeric_content_length(self, daemon_url):
        """Non-numeric Content-Length should return 400."""
        import http.client
        conn = http.client.HTTPConnection('127.0.0.1', int(daemon_url.rsplit(':', 1)[1]))
        conn.putrequest('POST', '/tweets')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', 'abc')
        conn.putheader('Authorization', f'Bearer {TEST_TOKEN}')
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 400
        assert 'Invalid Content-Length' in body['error']
        conn.close()

    def test_negative_content_length(self, daemon_url):
        """Negative Content-Length should return 400."""
        import http.client
        conn = http.client.HTTPConnection('127.0.0.1', int(daemon_url.rsplit(':', 1)[1]))
        conn.putrequest('POST', '/tweets')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', '-1')
        conn.putheader('Authorization', f'Bearer {TEST_TOKEN}')
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 400
        assert 'negative' in body['error'].lower()
        conn.close()

    def test_oversized_content_length(self, daemon_url):
        """Content-Length exceeding MAX_BODY_SIZE should return 413."""
        import http.client
        huge_length = xport_daemon.MAX_BODY_SIZE + 1
        conn = http.client.HTTPConnection('127.0.0.1', int(daemon_url.rsplit(':', 1)[1]))
        conn.putrequest('POST', '/tweets')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', str(huge_length))
        conn.putheader('Authorization', f'Bearer {TEST_TOKEN}')
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 413
        assert 'too large' in body['error'].lower()
        conn.close()


# ---------------------------------------------------------------------------
# Tests — Auth
# ---------------------------------------------------------------------------

class TestAuth:

    def test_unauthorized_request_rejected(self, daemon_url):
        """POST without token should return 401."""
        status, body = _post(daemon_url, '/tweets', body={'tweets': []})
        assert status == 401
        assert body['error'] == 'Unauthorized'

    def test_wrong_token_rejected(self, daemon_url):
        """POST with wrong token should return 401."""
        status, body = _post(daemon_url, '/tweets', body={'tweets': []}, token='wrong-token')
        assert status == 401
        assert body['error'] == 'Unauthorized'

    def test_content_length_checked_before_auth(self, daemon_url):
        """Oversized request should be rejected with 413 even without auth."""
        import http.client
        huge_length = xport_daemon.MAX_BODY_SIZE + 1
        conn = http.client.HTTPConnection('127.0.0.1', int(daemon_url.rsplit(':', 1)[1]))
        conn.putrequest('POST', '/tweets')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', str(huge_length))
        # No Authorization header
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        # Should get 413, not 401
        assert resp.status == 413
        conn.close()


# ---------------------------------------------------------------------------
# Tests — Normal authorized request
# ---------------------------------------------------------------------------

class TestAuthorizedRequest:

    def test_status_endpoint(self, daemon_url):
        """GET /status should work (no auth, no body)."""
        req = urllib.request.Request(f'{daemon_url}/status')
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read())
        assert resp.status == 200
        assert body['ok'] is True
        assert 'version' in body

    def test_valid_post_succeeds(self, daemon_url, monkeypatch):
        """An authorized POST /tweets with valid body should succeed."""
        import tempfile
        out_dir = tempfile.mkdtemp(dir=os.path.expanduser('~'), prefix='.xport-test-')
        forwarded = []
        _stub_forward_success(monkeypatch, forwarded)
        try:
            status, body = _post(
                daemon_url, '/tweets',
                body={'outputDir': out_dir, 'tweets': [{'id': 'valid-post-1', 'text': 'hello'}]},
                token=TEST_TOKEN,
            )
            assert status == 200
            assert body['ok'] is True
            assert body['count'] == 1
            assert body['forwarded'] is True
            assert forwarded == [{'id': 'valid-post-1', 'text': 'hello'}]
            assert not [p for p in os.listdir(out_dir) if p.startswith('tweets-')]
        finally:
            import shutil
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_tweets_forward_to_api_when_configured(self, daemon_url, monkeypatch):
        """POST /tweets includes remote ingest result when API forwarding is configured."""
        import shutil
        import tempfile

        out_dir = tempfile.mkdtemp(dir=os.path.expanduser('~'), prefix='.xport-test-')
        forwarded = []

        def fake_forward(tweets):
            forwarded.extend(tweets)
            return {'enabled': True, 'ok': True, 'count': len(tweets), 'batch_id': 'remote-1'}

        monkeypatch.setattr(xport_daemon, 'forward_tweets_to_api', fake_forward)
        try:
            status, body = _post(
                daemon_url, '/tweets',
                body={'outputDir': out_dir, 'tweets': [{'id': 'forward-1', 'text': 'hello'}]},
                token=TEST_TOKEN,
            )
            assert status == 200
            assert body['ok'] is True
            assert body['forwarded'] is True
            assert body['remote_count'] == 1
            assert body['remote_batch_id'] == 'remote-1'
            assert forwarded == [{'id': 'forward-1', 'text': 'hello'}]
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_tweets_rejected_when_postgres_not_configured(self, daemon_url, monkeypatch):
        """POST /tweets fails closed instead of falling back to local JSON storage."""
        monkeypatch.setattr(
            xport_daemon,
            'forward_tweets_to_api',
            lambda tweets: {
                'enabled': False,
                'ok': False,
                'error': 'XPORT_API_URL and XPORT_INGEST_TOKEN are required for tweet capture',
            },
        )
        status, body = _post(
            daemon_url, '/tweets',
            body={'tweets': [{'id': 'no-db', 'text': 'hello'}]},
            token=TEST_TOKEN,
        )
        assert status == 503
        assert body['ok'] is False
        assert 'XPORT_API_URL' in body['error']

    def test_stored_tweets_proxies_postgres_api(self, daemon_url, monkeypatch):
        """Debug dashboard gets human-readable stored tweets from Postgres."""
        captured = []

        def fake_list(limit=50, offset=0):
            captured.append((limit, offset))
            return [{'tweet_id': '1', 'author_username': 'seth', 'text': 'hello', 'media': []}]

        monkeypatch.setattr(xport_daemon, 'list_stored_tweets_from_api', fake_list)
        status, body = _post(
            daemon_url,
            '/stored-tweets',
            body={'limit': 25, 'offset': 5},
            token=TEST_TOKEN,
        )
        assert status == 200
        assert body == {
            'ok': True,
            'tweets': [{'tweet_id': '1', 'author_username': 'seth', 'text': 'hello', 'media': []}],
        }
        assert captured == [(25, 5)]

    def test_zero_content_length_post(self, daemon_url):
        """POST with Content-Length: 0 exercises _read_json returning {}."""
        import http.client
        port = int(daemon_url.rsplit(':', 1)[1])
        conn = http.client.HTTPConnection('127.0.0.1', port)
        # Use /log with an empty body; it does not require tweet forwarding.
        conn.putrequest('POST', '/log')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Content-Length', '0')
        conn.putheader('Authorization', f'Bearer {TEST_TOKEN}')
        conn.endheaders()
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 200
        assert body['ok'] is True
        assert body['logged'] == 0
        conn.close()

    def test_tweets_auto_queues_image_asset_storage(self, daemon_url, monkeypatch):
        """POST /tweets auto-queues photo storage after successful Postgres ingest."""
        import shutil
        import tempfile

        out_dir = tempfile.mkdtemp(dir=os.path.expanduser('~'), prefix='.xport-test-')
        _stub_forward_success(monkeypatch)
        queued = []

        def fake_enqueue(tweets):
            queued.extend(tweets)
            return 1

        monkeypatch.setattr(xport_daemon, 'enqueue_image_asset_storage', fake_enqueue)
        try:
            tweet = {
                'id': '42',
                'media': [{'type': 'photo', 'url': 'https://pbs.twimg.com/media/HGK.jpg:orig'}],
            }
            status, body = _post(
                daemon_url, '/tweets',
                body={'outputDir': out_dir, 'tweets': [tweet], 'image_download': True},
                token=TEST_TOKEN,
            )
            assert status == 200
            assert body['ok'] is True
            assert body['images_queued'] == 1
            assert queued == [tweet]
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_tweets_auto_queue_does_not_mutate_payload(self, daemon_url, monkeypatch):
        """Auto image storage must not inject local paths into forwarded tweets."""
        import shutil
        import tempfile

        out_dir = tempfile.mkdtemp(dir=os.path.expanduser('~'), prefix='.xport-test-')
        forwarded = []
        _stub_forward_success(monkeypatch, forwarded)
        monkeypatch.setattr(xport_daemon, 'enqueue_image_asset_storage', lambda tweets: 1)
        try:
            tweet = {
                'id': '43',
                'media': [{'type': 'photo', 'url': 'https://pbs.twimg.com/media/HGK.jpg:orig'}],
            }
            status, body = _post(
                daemon_url, '/tweets',
                body={'outputDir': out_dir, 'tweets': [tweet]},
                token=TEST_TOKEN,
            )
            assert status == 200
            assert body['images_queued'] == 1
            assert 'local_path' not in json.dumps(forwarded)
            assert not [p for p in os.listdir(out_dir) if p.startswith('tweets-')]
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_passive_tweets_do_not_start_transcription(self, daemon_url, monkeypatch):
        """Passive /tweets only forwards metadata; it must not fetch/transcribe media."""
        _stub_forward_success(monkeypatch)
        called = []
        monkeypatch.setattr(xport_daemon, 'start_media_transcription', lambda *args: called.append(args))
        status, body = _post(
            daemon_url,
            '/tweets',
            body={'tweets': [{'id': '55', 'media': [{'type': 'video', 'url': 'https://video.twimg.com/a.mp4'}]}]},
            token=TEST_TOKEN,
        )
        assert status == 200
        assert body['ok'] is True
        assert called == []

    def test_transcribe_media_rejects_unallowed_host(self, daemon_url):
        """Explicit transcription still validates the media URL host."""
        status, body = _post(
            daemon_url,
            '/transcribe-media',
            body={
                'media_id': '55:0',
                'tweet_id': '55',
                'source_url': 'https://example.com/a.mp4',
                'duration_ms': 1000,
            },
            token=TEST_TOKEN,
        )
        assert status == 400
        assert 'not allowed' in body['error']

    def test_transcribe_media_queues_explicit_job(self, daemon_url, monkeypatch):
        """Explicit transcription route delegates to the on-demand job runner."""
        captured = []

        def fake_start(media_id, tweet_id, source_url, duration_ms):
            captured.append((media_id, tweet_id, source_url, duration_ms))
            return {'ok': True, 'media_id': media_id, 'status': 'queued'}

        monkeypatch.setattr(xport_daemon, 'start_media_transcription', fake_start)
        status, body = _post(
            daemon_url,
            '/transcribe-media',
            body={
                'media_id': '55:0',
                'tweet_id': '55',
                'source_url': 'https://video.twimg.com/a.mp4',
                'duration_ms': 1000,
            },
            token=TEST_TOKEN,
        )
        assert status == 200
        assert body == {'ok': True, 'media_id': '55:0', 'status': 'queued'}
        assert captured == [('55:0', '55', 'https://video.twimg.com/a.mp4', 1000)]

    def test_tweets_image_download_flag_no_longer_controls_image_queue(self, daemon_url, monkeypatch):
        """Photo storage is automatic; legacy image_download values do not change it."""
        import shutil
        import tempfile

        out_dir = tempfile.mkdtemp(dir=os.path.expanduser('~'), prefix='.xport-test-')
        _stub_forward_success(monkeypatch)
        monkeypatch.setattr(xport_daemon, 'enqueue_image_asset_storage', lambda tweets: 1)
        try:
            tweet = {
                'id': '44',
                'media': [{'type': 'photo', 'url': 'https://pbs.twimg.com/media/x.jpg'}],
            }
            for bad in ['false', 1, 'true', [1]]:
                status, body = _post(
                    daemon_url, '/tweets',
                    body={'outputDir': out_dir, 'tweets': [tweet], 'image_download': bad},
                    token=TEST_TOKEN,
                )
                assert status == 200
                assert body['images_queued'] == 1, f'truthy {bad!r} should not alter automatic storage'
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)

    def test_dump_rejects_dotdot_filename(self, daemon_url):
        """POST /dump with '..' filename should return 400."""
        status, body = _post(
            daemon_url, '/dump',
            body={'filename': '..', 'content': 'x'},
            token=TEST_TOKEN,
        )
        assert status == 400
        assert 'Invalid dump filename' in body['error']


# ---------------------------------------------------------------------------
# Tests — Concurrency (issue #8)
# ---------------------------------------------------------------------------

class TestConcurrency:

    def test_status_responsive_during_slow_tweets(self, daemon_url):
        """GET /status should respond promptly while a slow /tweets is in progress."""
        import shutil
        import tempfile
        import time
        from unittest.mock import patch
        import concurrent.futures

        out_dir = tempfile.mkdtemp(dir=os.path.expanduser('~'), prefix='.xport-test-')

        slow_entered = threading.Event()

        def slow_forward_tweets(tweets):
            slow_entered.set()
            time.sleep(1.0)
            return {'enabled': True, 'ok': True, 'count': len(tweets), 'batch_id': 'remote-1'}

        try:
            with patch.object(xport_daemon, 'forward_tweets_to_api', side_effect=slow_forward_tweets):
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    # Fire off the slow /tweets request
                    tweets_future = pool.submit(
                        _post, daemon_url, '/tweets',
                        {'outputDir': out_dir, 'tweets': [{'id': '1', 'text': 'hi'}]},
                        TEST_TOKEN,
                    )

                    # Wait until the slow handler has started
                    assert slow_entered.wait(timeout=5), 'slow forward_tweets_to_api never entered'

                    # Now /status should respond quickly
                    t0 = time.monotonic()
                    req = urllib.request.Request(f'{daemon_url}/status')
                    with urllib.request.urlopen(req, timeout=2) as resp:
                        status_body = json.loads(resp.read())
                    elapsed = time.monotonic() - t0

                    assert status_body['ok'] is True
                    assert elapsed < 0.5, f'/status took {elapsed:.2f}s — blocked by slow /tweets'

                    # Let the tweets request finish
                    tweets_status, tweets_body = tweets_future.result(timeout=5)
                    assert tweets_status == 200
                    assert tweets_body['ok'] is True
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)
