import importlib
import json
import os
import sys
import threading
import urllib.error
import urllib.request

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture()
def api_module(monkeypatch):
    monkeypatch.setenv('INGEST_TOKEN', 'test-ingest-token')
    import api.xport_api as xport_api
    return importlib.reload(xport_api)


def test_normalize_tweet_maps_output_schema(api_module):
    row = api_module.normalize_tweet({
        'id': '123',
        'url': 'https://x.com/u/status/123',
        'created_at': '2026-05-23T12:00:00.000Z',
        'captured_at': '2026-05-23T12:00:01.000Z',
        'author': {'id': '42', 'username': 'seth', 'display_name': 'Seth'},
        'text': 'hello',
        'conversation_id': '123',
        'source_endpoint': 'HomeTimeline',
        'lang': 'en',
        'metrics': {'likes': 1, 'retweets': 2, 'replies': 3, 'quotes': 4, 'bookmarks': 5, 'views': '6'},
    })

    assert row['tweet_id'] == '123'
    assert row['author_username'] == 'seth'
    assert row['like_count'] == 1
    assert row['view_count'] == 6
    assert row['created_at'].isoformat().startswith('2026-05-23T12:00:00')


def test_normalize_tweet_skips_invalid_tweet(api_module):
    assert api_module.normalize_tweet({'text': 'missing id'}) is None
    assert api_module.normalize_tweet('nope') is None


@pytest.fixture()
def api_url(api_module, monkeypatch):
    captured = []

    def fake_ingest(payload):
        captured.append(payload)
        return {'ok': True, 'batch_id': 'batch-1', 'received': len(payload['tweets']), 'upserted': len(payload['tweets'])}

    monkeypatch.setattr(api_module, 'ingest_tweets', fake_ingest)
    server = api_module.ThreadingHTTPServer(('127.0.0.1', 0), api_module.ApiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{server.server_address[1]}', captured
    server.shutdown()


def _post(base_url, body, token=None):
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(f'{base_url}/api/ingest/tweets', data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_ingest_requires_bearer_token(api_url):
    base_url, _ = api_url
    status, body = _post(base_url, {'tweets': []})
    assert status == 401
    assert body['error'] == 'Unauthorized'


def test_ingest_accepts_authorized_batch(api_url):
    base_url, captured = api_url
    status, body = _post(base_url, {'tweets': [{'id': '1'}]}, token='test-ingest-token')
    assert status == 200
    assert body['ok'] is True
    assert body['upserted'] == 1
    assert captured == [{'tweets': [{'id': '1'}]}]
