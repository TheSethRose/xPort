#!/usr/bin/env python3
"""XPort ingestion API for storing captured tweets in PostgreSQL."""

import hmac
import json
import os
import signal
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


BIND_HOST = os.environ.get('HOST', '0.0.0.0')
BIND_PORT = int(os.environ.get('PORT', '8080'))
MAX_BODY_SIZE = int(os.environ.get('MAX_BODY_SIZE', str(10 * 1024 * 1024)))
DATABASE_URL = os.environ.get('DATABASE_URL', '')
INGEST_TOKEN = os.environ.get('INGEST_TOKEN') or os.environ.get('XPORT_INGEST_TOKEN') or ''


SCHEMA_SQL = """
create table if not exists tweets (
  tweet_id text primary key,
  author_id text,
  author_username text,
  author_name text,
  text text,
  conversation_id text,
  created_at timestamptz,
  captured_at timestamptz not null default now(),
  source_endpoint text,
  url text,
  lang text,
  reply_count integer,
  repost_count integer,
  like_count integer,
  quote_count integer,
  bookmark_count integer,
  view_count bigint,
  raw jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists ingest_batches (
  batch_id uuid primary key,
  source text not null default 'xport',
  received_at timestamptz not null default now(),
  tweet_count integer not null default 0,
  raw jsonb
);

create index if not exists tweets_created_at_idx on tweets (created_at desc);
create index if not exists tweets_captured_at_idx on tweets (captured_at desc);
create index if not exists tweets_author_username_idx on tweets (lower(author_username));
create index if not exists tweets_raw_gin_idx on tweets using gin (raw);
"""


UPSERT_TWEET_SQL = """
insert into tweets (
  tweet_id,
  author_id,
  author_username,
  author_name,
  text,
  conversation_id,
  created_at,
  captured_at,
  source_endpoint,
  url,
  lang,
  reply_count,
  repost_count,
  like_count,
  quote_count,
  bookmark_count,
  view_count,
  raw
) values (
  %(tweet_id)s,
  %(author_id)s,
  %(author_username)s,
  %(author_name)s,
  %(text)s,
  %(conversation_id)s,
  %(created_at)s,
  %(captured_at)s,
  %(source_endpoint)s,
  %(url)s,
  %(lang)s,
  %(reply_count)s,
  %(repost_count)s,
  %(like_count)s,
  %(quote_count)s,
  %(bookmark_count)s,
  %(view_count)s,
  %(raw)s
)
on conflict (tweet_id) do update set
  author_id = excluded.author_id,
  author_username = excluded.author_username,
  author_name = excluded.author_name,
  text = excluded.text,
  conversation_id = excluded.conversation_id,
  created_at = excluded.created_at,
  captured_at = excluded.captured_at,
  source_endpoint = excluded.source_endpoint,
  url = excluded.url,
  lang = excluded.lang,
  reply_count = excluded.reply_count,
  repost_count = excluded.repost_count,
  like_count = excluded.like_count,
  quote_count = excluded.quote_count,
  bookmark_count = excluded.bookmark_count,
  view_count = excluded.view_count,
  raw = excluded.raw,
  updated_at = now()
"""


def _json_response(handler, status, payload):
    body = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _parse_iso(value):
    if not value or not isinstance(value, str):
        return None
    try:
        if value.endswith('Z'):
            value = value[:-1] + '+00:00'
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _as_int(value):
    if value is None or value == '':
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_tweet(tweet):
    if not isinstance(tweet, dict):
        return None
    tweet_id = tweet.get('id') or tweet.get('tweet_id')
    if not tweet_id:
        return None

    author = tweet.get('author') if isinstance(tweet.get('author'), dict) else {}
    metrics = tweet.get('metrics') if isinstance(tweet.get('metrics'), dict) else {}
    captured_at = _parse_iso(tweet.get('captured_at')) or datetime.now(timezone.utc)

    return {
        'tweet_id': str(tweet_id),
        'author_id': _str_or_none(author.get('id') or tweet.get('author_id')),
        'author_username': _str_or_none(author.get('username') or tweet.get('author_username')),
        'author_name': _str_or_none(author.get('display_name') or author.get('name') or tweet.get('author_name')),
        'text': _str_or_none(tweet.get('text')),
        'conversation_id': _str_or_none(tweet.get('conversation_id')),
        'created_at': _parse_iso(tweet.get('created_at')),
        'captured_at': captured_at,
        'source_endpoint': _str_or_none(tweet.get('source_endpoint')),
        'url': _str_or_none(tweet.get('url')),
        'lang': _str_or_none(tweet.get('lang')),
        'reply_count': _as_int(metrics.get('replies') or metrics.get('reply_count') or tweet.get('reply_count')),
        'repost_count': _as_int(metrics.get('retweets') or metrics.get('reposts') or tweet.get('repost_count')),
        'like_count': _as_int(metrics.get('likes') or metrics.get('like_count')),
        'quote_count': _as_int(metrics.get('quotes') or metrics.get('quote_count')),
        'bookmark_count': _as_int(metrics.get('bookmarks') or tweet.get('bookmark_count')),
        'view_count': _as_int(metrics.get('views') or tweet.get('view_count')),
        'raw': Jsonb(tweet),
    }


def _str_or_none(value):
    if value is None:
        return None
    return str(value)


def connect():
    if not DATABASE_URL:
        raise RuntimeError('DATABASE_URL is not configured')
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, connect_timeout=5)


def ensure_schema():
    with connect() as conn:
        conn.execute(SCHEMA_SQL)


def ingest_tweets(payload):
    tweets = payload.get('tweets') if isinstance(payload, dict) else None
    if not isinstance(tweets, list):
        raise ValueError('tweets must be an array')
    rows = [row for row in (normalize_tweet(tweet) for tweet in tweets) if row]
    batch_id = str(uuid4())
    source = payload.get('source') if isinstance(payload.get('source'), str) else 'xport'

    with connect() as conn:
        conn.execute(
            """
            insert into ingest_batches (batch_id, source, tweet_count, raw)
            values (%s, %s, %s, %s)
            """,
            (batch_id, source, len(rows), Jsonb(payload)),
        )
        if rows:
            with conn.cursor() as cur:
                cur.executemany(UPSERT_TWEET_SQL, rows)
    return {'ok': True, 'batch_id': batch_id, 'received': len(tweets), 'upserted': len(rows)}


class ApiHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f'{self.client_address[0]} - {fmt % args}', file=sys.stderr)

    def do_GET(self):
        if self.path != '/health':
            _json_response(self, 404, {'ok': False, 'error': 'Not found'})
            return
        try:
            with connect() as conn:
                conn.execute('select 1')
            _json_response(self, 200, {'ok': True})
        except Exception as e:
            _json_response(self, 503, {'ok': False, 'error': str(e)})

    def do_POST(self):
        if self.path != '/api/ingest/tweets':
            _json_response(self, 404, {'ok': False, 'error': 'Not found'})
            return

        if not INGEST_TOKEN:
            _json_response(self, 500, {'ok': False, 'error': 'INGEST_TOKEN is not configured'})
            return
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or not hmac.compare_digest(auth[7:], INGEST_TOKEN):
            _json_response(self, 401, {'ok': False, 'error': 'Unauthorized'})
            return

        raw_length = self.headers.get('Content-Length')
        try:
            length = int(raw_length or '')
        except ValueError:
            _json_response(self, 400, {'ok': False, 'error': 'Invalid Content-Length'})
            return
        if length < 0:
            _json_response(self, 400, {'ok': False, 'error': 'Content-Length must not be negative'})
            return
        if length > MAX_BODY_SIZE:
            _json_response(self, 413, {'ok': False, 'error': 'Payload too large'})
            return

        try:
            payload = json.loads(self.rfile.read(length) or b'{}')
        except json.JSONDecodeError as e:
            _json_response(self, 400, {'ok': False, 'error': f'Invalid JSON: {e}'})
            return

        try:
            result = ingest_tweets(payload)
            _json_response(self, 200, result)
        except ValueError as e:
            _json_response(self, 400, {'ok': False, 'error': str(e)})
        except Exception as e:
            _json_response(self, 500, {'ok': False, 'error': str(e)})


def main():
    ensure_schema()
    server = ThreadingHTTPServer((BIND_HOST, BIND_PORT), ApiHandler)

    def shutdown(signum, frame):
        print(f'Received signal {signum}, shutting down...', file=sys.stderr)
        server.shutdown()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    print(f'XPort API listening on {BIND_HOST}:{BIND_PORT}', file=sys.stderr)
    server.serve_forever()


if __name__ == '__main__':
    main()
