import json
import os
import subprocess
import sys
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CLI = os.path.join(ROOT, 'skill', 'xport')


class CliApiHandler(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        self.__class__.requests.append({
            'path': self.path,
            'authorization': self.headers.get('Authorization'),
        })
        if self.path.startswith('/api/tweets/123'):
            payload = {
                'ok': True,
                'tweet': {
                    'tweet_id': '123',
                    'author_username': 'seth',
                    'text': 'saved from extension',
                },
            }
        else:
            payload = {
                'ok': True,
                'tweets': [{
                    'tweet_id': '123',
                    'author_username': 'seth',
                    'text': 'saved from extension',
                }],
            }
        body = json.dumps(payload).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextmanager
def api_server():
    CliApiHandler.requests = []
    server = ThreadingHTTPServer(('127.0.0.1', 0), CliApiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_address[1]}'
    finally:
        server.shutdown()


def run_cli(args, env=None):
    merged_env = os.environ.copy()
    merged_env.update(env or {})
    return subprocess.run(
        [sys.executable, CLI, *args],
        cwd=ROOT,
        env=merged_env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_cli_search_reads_from_xport_api():
    with api_server() as server:
        result = run_cli(['search', 'extension', '--api-url', server, '--token', 'read-token', '--limit', '3'])

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == [{
        'tweet_id': '123',
        'author_username': 'seth',
        'text': 'saved from extension',
    }]
    assert CliApiHandler.requests[0]['authorization'] == 'Bearer read-token'
    assert CliApiHandler.requests[0]['path'].startswith('/api/tweets?')
    assert 'q=extension' in CliApiHandler.requests[0]['path']
    assert 'limit=3' in CliApiHandler.requests[0]['path']


def test_cli_get_reads_single_tweet_from_xport_api():
    with api_server() as server:
        result = run_cli(['get', '123', '--api-url', server, '--token', 'read-token'])

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['tweet_id'] == '123'
    assert CliApiHandler.requests[0]['path'] == '/api/tweets/123'
