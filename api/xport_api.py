#!/usr/bin/env python3
"""XPort ingestion API for storing captured tweets in PostgreSQL."""

import base64
import hashlib
import hmac
import json
import os
import signal
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse
from uuid import uuid4

import psycopg
from psycopg import sql
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

create table if not exists tweet_media (
  media_id text primary key,
  tweet_id text not null references tweets(tweet_id) on delete cascade,
  media_index integer not null default 0,
  media_type text not null,
  source_url text,
  alt_text text,
  duration_ms integer,
  width integer,
  height integer,
  transcript_text text,
  transcript_model text,
  transcript_status text not null default 'not_requested',
  transcript_error text,
  transcribed_at timestamptz,
  asset_status text not null default 'not_requested',
  asset_mime_type text,
  asset_byte_size integer,
  content_sha256 text,
  asset_bytes bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tweet_id, media_index)
);

create index if not exists tweets_created_at_idx on tweets (created_at desc);
create index if not exists tweets_captured_at_idx on tweets (captured_at desc);
create index if not exists tweets_author_username_idx on tweets (lower(author_username));
create index if not exists tweets_raw_gin_idx on tweets using gin (raw);
create index if not exists tweet_media_tweet_id_idx on tweet_media (tweet_id);
create index if not exists tweet_media_type_idx on tweet_media (media_type);
create index if not exists tweet_media_transcript_status_idx on tweet_media (transcript_status);
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


UPSERT_MEDIA_SQL = """
insert into tweet_media (
  media_id,
  tweet_id,
  media_index,
  media_type,
  source_url,
  alt_text,
  duration_ms,
  width,
  height
) values (
  %(media_id)s,
  %(tweet_id)s,
  %(media_index)s,
  %(media_type)s,
  %(source_url)s,
  %(alt_text)s,
  %(duration_ms)s,
  %(width)s,
  %(height)s
)
on conflict (media_id) do update set
  tweet_id = excluded.tweet_id,
  media_index = excluded.media_index,
  media_type = excluded.media_type,
  source_url = excluded.source_url,
  alt_text = excluded.alt_text,
  duration_ms = excluded.duration_ms,
  width = excluded.width,
  height = excluded.height,
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


def normalize_media(tweet):
    if not isinstance(tweet, dict):
        return []
    tweet_id = tweet.get('id') or tweet.get('tweet_id')
    if not tweet_id:
        return []
    rows = []
    media_items = tweet.get('media') if isinstance(tweet.get('media'), list) else []
    for idx, item in enumerate(media_items):
        row = _media_row(str(tweet_id), idx, item)
        if row:
            rows.append(row)

    article = tweet.get('article') if isinstance(tweet.get('article'), dict) else {}
    article_media = article.get('media') if isinstance(article.get('media'), list) else []
    for idx, item in enumerate(article_media, start=len(rows)):
        row = _media_row(str(tweet_id), idx, item, media_id=f'{tweet_id}:article:{idx - len(media_items)}')
        if row:
            rows.append(row)
    return rows


def _media_row(tweet_id, index, item, media_id=None):
    if not isinstance(item, dict):
        return None
    media_type = item.get('type') or ('photo' if item.get('url') else None)
    if not media_type:
        return None
    media_id = item.get('media_id') or item.get('id') or media_id or f'{tweet_id}:{index}'
    return {
        'media_id': str(media_id),
        'tweet_id': str(tweet_id),
        'media_index': index,
        'media_type': str(media_type),
        'source_url': _str_or_none(item.get('url') or item.get('source_url')),
        'alt_text': _str_or_none(item.get('alt_text')),
        'duration_ms': _as_int(item.get('duration_ms')),
        'width': _as_int(item.get('width')),
        'height': _as_int(item.get('height')),
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
    normalized = []
    media_rows = []
    for tweet in tweets:
        row = normalize_tweet(tweet)
        if not row:
            continue
        normalized.append(row)
        media_rows.extend(normalize_media(tweet))
    batch_id = str(uuid4())
    source = payload.get('source') if isinstance(payload.get('source'), str) else 'xport'

    with connect() as conn:
        conn.execute(
            """
            insert into ingest_batches (batch_id, source, tweet_count, raw)
            values (%s, %s, %s, %s)
            """,
            (batch_id, source, len(normalized), Jsonb(payload)),
        )
        if normalized:
            with conn.cursor() as cur:
                cur.executemany(UPSERT_TWEET_SQL, normalized)
                if media_rows:
                    cur.executemany(UPSERT_MEDIA_SQL, media_rows)
    return {
        'ok': True,
        'batch_id': batch_id,
        'received': len(tweets),
        'upserted': len(normalized),
        'media_upserted': len(media_rows),
    }


def _bool_param(value):
    return str(value or '').lower() in {'1', 'true', 'yes', 'on'}


def _bounded_int(value, default, minimum=0, maximum=500):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return min(max(parsed, minimum), maximum)


def _tweet_projection(include_raw):
    fields = [
        'tweet_id',
        'author_id',
        'author_username',
        'author_name',
        'text',
        'conversation_id',
        'created_at',
        'captured_at',
        'source_endpoint',
        'url',
        'lang',
        'reply_count',
        'repost_count',
        'like_count',
        'quote_count',
        'bookmark_count',
        'view_count',
        'updated_at',
    ]
    if include_raw:
        fields.append('raw')
    return sql.SQL(', ').join(sql.Identifier(field) for field in fields)


def _row_to_json(row):
    out = dict(row)
    for key, value in list(out.items()):
        if isinstance(value, datetime):
            out[key] = value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    return out


def list_tweets(
    query=None,
    author=None,
    since=None,
    until=None,
    endpoint=None,
    media=None,
    transcription=None,
    has_quoted=False,
    has_reply=False,
    sort='newest',
    limit=50,
    offset=0,
    include_raw=False,
    include_media=False,
    include_total=False,
    include_facets=False,
    include_metrics=False,
    facet_query=None,
):
    where, params = _tweet_filter_where(
        query=query,
        author=author,
        since=since,
        until=until,
        endpoint=endpoint,
        media=media,
        transcription=transcription,
        has_quoted=has_quoted,
        has_reply=has_reply,
    )
    query_sql = sql.SQL("""
        select {projection}
        from tweets
        {where_clause}
        order by {order_by}
        limit %s offset %s
    """).format(
        projection=_tweet_projection(include_raw),
        where_clause=where,
        order_by=sql.SQL(_tweet_order_by(sort)),
    )
    query_params = params + [limit, offset]
    with connect() as conn:
        rows = conn.execute(query_sql, query_params).fetchall()
        tweets = [_row_to_json(row) for row in rows]
        if include_media and tweets:
            _attach_media(conn, tweets)
        if include_total or include_facets or include_metrics:
            result = {'tweets': tweets}
            if include_total:
                count_sql = sql.SQL("select count(*) as total from tweets {where_clause}").format(where_clause=where)
                result['total'] = conn.execute(count_sql, params).fetchone()['total']
            if include_facets:
                result['facets'] = tweet_facets(conn, facet_query)
            if include_metrics:
                result['metrics'] = tweet_list_metrics(conn)
            return result
    return tweets


def _tweet_filter_where(
    query=None,
    author=None,
    since=None,
    until=None,
    endpoint=None,
    media=None,
    transcription=None,
    has_quoted=False,
    has_reply=False,
):
    clauses = []
    params = []
    if query:
        clauses.append('(text ilike %s or url ilike %s or author_username ilike %s or author_name ilike %s or raw::text ilike %s)')
        needle = f'%{query}%'
        params.extend([needle, needle, needle, needle, needle])
    if author:
        clauses.append('lower(author_username) = lower(%s)')
        params.append(author.lstrip('@'))
    if since:
        clauses.append('coalesce(created_at, captured_at) >= %s')
        params.append(since)
    if until:
        clauses.append('coalesce(created_at, captured_at) <= %s')
        params.append(until)
    if endpoint:
        clauses.append('source_endpoint = %s')
        params.append(endpoint)
    if media:
        _add_media_filter(clauses, params, media)
    if transcription:
        _add_transcription_filter(clauses, params, transcription)
    if has_quoted:
        clauses.append("coalesce(raw->>'quoted_tweet_id', '') <> ''")
    if has_reply:
        clauses.append("coalesce(raw->>'in_reply_to', '') <> ''")
    if not clauses:
        return sql.SQL(''), params
    return sql.SQL('where ') + sql.SQL(' and ').join(sql.SQL(clause) for clause in clauses), params


def _add_media_filter(clauses, params, media):
    if media == 'none':
        clauses.append('not exists (select 1 from tweet_media tm where tm.tweet_id = tweets.tweet_id)')
    elif media == 'media':
        clauses.append('exists (select 1 from tweet_media tm where tm.tweet_id = tweets.tweet_id)')
    elif media == 'image':
        clauses.append("exists (select 1 from tweet_media tm where tm.tweet_id = tweets.tweet_id and tm.media_type = 'photo')")
    elif media in {'video', 'gif'}:
        media_type = 'animated_gif' if media == 'gif' else 'video'
        clauses.append('exists (select 1 from tweet_media tm where tm.tweet_id = tweets.tweet_id and tm.media_type = %s)')
        params.append(media_type)
    elif media == 'link':
        clauses.append(_tweet_link_clause())
    elif media == 'multiple':
        clauses.append(f"""(
            (select count(*) from tweet_media tm where tm.tweet_id = tweets.tweet_id) > 1
            or (
                exists (select 1 from tweet_media tm where tm.tweet_id = tweets.tweet_id)
                and {_tweet_link_clause()}
            )
        )""")


def _add_transcription_filter(clauses, params, transcription):
    if transcription == 'has_text':
        clauses.append("exists (select 1 from tweet_media tm where tm.tweet_id = tweets.tweet_id and coalesce(tm.transcript_text, '') <> '')")
    elif transcription in {'not_requested', 'queued', 'transcribing', 'done', 'skipped', 'error'}:
        clauses.append("exists (select 1 from tweet_media tm where tm.tweet_id = tweets.tweet_id and tm.media_type in ('video', 'animated_gif') and tm.transcript_status = %s)")
        params.append(transcription)


def _tweet_link_clause():
    return """(
        coalesce(text, '') ~* 'https?://'
        or case
            when jsonb_typeof(raw->'urls') = 'array' then jsonb_array_length(raw->'urls') > 0
            else false
        end
    )"""


def _tweet_order_by(sort):
    newest = 'coalesce(created_at, captured_at) desc, captured_at desc'
    if sort == 'oldest':
        return 'coalesce(created_at, captured_at) asc, captured_at asc'
    if sort == 'captured_newest':
        return 'captured_at desc, coalesce(created_at, captured_at) desc'
    if sort == 'captured_oldest':
        return 'captured_at asc, coalesce(created_at, captured_at) asc'
    if sort == 'author':
        return "lower(coalesce(author_username, '')) asc, coalesce(created_at, captured_at) desc, captured_at desc"
    if sort in {'source', 'status'}:
        return "coalesce(source_endpoint, '') asc, coalesce(created_at, captured_at) desc, captured_at desc"
    if sort == 'media':
        media_count = '(select count(*) from tweet_media tm where tm.tweet_id = tweets.tweet_id)'
        return f'({media_count} + case when {_tweet_link_clause()} then 1 else 0 end) desc, {newest}'
    metric_sorts = {
        'replies': 'reply_count',
        'retweets': 'repost_count',
        'likes': 'like_count',
        'quotes': 'quote_count',
        'bookmarks': 'bookmark_count',
        'views': 'view_count',
    }
    if sort in metric_sorts:
        return f'{metric_sorts[sort]} desc nulls last, {newest}'
    if sort == 'engagement':
        engagement = (
            'coalesce(like_count, 0) + coalesce(repost_count, 0) + '
            'coalesce(reply_count, 0) + coalesce(quote_count, 0) + coalesce(bookmark_count, 0)'
        )
        return f'({engagement}) desc, {newest}'
    return newest


def tweet_facets(conn, query=None):
    author_where = ["author_username is not null and author_username <> ''"]
    endpoint_where = ["source_endpoint is not null and source_endpoint <> ''"]
    author_params = []
    endpoint_params = []
    if query:
        needle = f"%{query.lstrip('@')}%"
        author_where.append('(author_username ilike %s or author_name ilike %s)')
        endpoint_where.append('source_endpoint ilike %s')
        author_params.extend([needle, needle])
        endpoint_params.append(needle)
    author_where_sql = sql.SQL('where ') + sql.SQL(' and ').join(sql.SQL(clause) for clause in author_where)
    endpoint_where_sql = sql.SQL('where ') + sql.SQL(' and ').join(sql.SQL(clause) for clause in endpoint_where)
    author_rows = conn.execute(
        sql.SQL("""
        select author_username as value, max(author_name) as label, count(*) as count
        from tweets
        {where_clause}
        group by author_username
        order by lower(author_username)
        """).format(where_clause=author_where_sql),
        author_params,
    ).fetchall()
    endpoint_rows = conn.execute(
        sql.SQL("""
        select source_endpoint as value, source_endpoint as label, count(*) as count
        from tweets
        {where_clause}
        group by source_endpoint
        order by source_endpoint
        """).format(where_clause=endpoint_where_sql),
        endpoint_params,
    ).fetchall()
    return {
        'authors': [_row_to_json(row) for row in author_rows],
        'endpoints': [_row_to_json(row) for row in endpoint_rows],
        'sources': [_row_to_json(row) for row in endpoint_rows],
    }


def tweet_list_metrics(conn):
    row = conn.execute(
        """
        select
          count(*) as tweet_count,
          (select count(distinct tweet_id) from tweet_media) as media_count,
          count(distinct author_username) filter (where author_username is not null and author_username <> '') as author_count
        from tweets
        """
    ).fetchone()
    return _row_to_json(row)


def get_tweet(tweet_id, include_raw=False, include_media=False):
    with connect() as conn:
        row = conn.execute(
            sql.SQL("select {projection} from tweets where tweet_id = %s").format(
                projection=_tweet_projection(include_raw),
            ),
            (tweet_id,),
        ).fetchone()
        if not row:
            return None
        tweet = _row_to_json(row)
        if include_media:
            tweet['media'] = [_row_to_json(media) for media in _media_rows(conn, tweet_id)]
    return tweet


def _media_projection(include_bytes=False):
    fields = [
        'media_id',
        'tweet_id',
        'media_index',
        'media_type',
        'source_url',
        'alt_text',
        'duration_ms',
        'width',
        'height',
        'transcript_text',
        'transcript_model',
        'transcript_status',
        'transcript_error',
        'transcribed_at',
        'asset_status',
        'asset_mime_type',
        'asset_byte_size',
        'content_sha256',
        'created_at',
        'updated_at',
    ]
    if include_bytes:
        fields.append('asset_bytes')
    return sql.SQL(', ').join(sql.Identifier(field) for field in fields)


def _media_rows(conn, tweet_id):
    return conn.execute(
        sql.SQL("""
        select {projection}
        from tweet_media
        where tweet_id = %s
        order by media_index asc, created_at asc
        """).format(projection=_media_projection()),
        (tweet_id,),
    ).fetchall()


def _attach_media(conn, tweets):
    tweet_ids = [tweet['tweet_id'] for tweet in tweets]
    rows = conn.execute(
        sql.SQL("""
        select {projection}
        from tweet_media
        where tweet_id = any(%s)
        order by tweet_id, media_index asc, created_at asc
        """).format(projection=_media_projection()),
        (tweet_ids,),
    ).fetchall()
    by_tweet = {tweet_id: [] for tweet_id in tweet_ids}
    for row in rows:
        by_tweet.setdefault(row['tweet_id'], []).append(_row_to_json(row))
    for tweet in tweets:
        tweet['media'] = by_tweet.get(tweet['tweet_id'], [])


def list_media(tweet_id):
    with connect() as conn:
        exists = conn.execute('select 1 from tweets where tweet_id = %s', (tweet_id,)).fetchone()
        if not exists:
            return None
        return [_row_to_json(row) for row in _media_rows(conn, tweet_id)]


def get_media(media_id, include_bytes=False):
    with connect() as conn:
        row = conn.execute(
            sql.SQL("select {projection} from tweet_media where media_id = %s").format(
                projection=_media_projection(include_bytes),
            ),
            (media_id,),
        ).fetchone()
    return _row_to_json(row) if row else None


def update_media_transcription(media_id, payload):
    status = _str_or_none(payload.get('status')) or 'queued'
    if status not in {'queued', 'transcribing', 'done', 'skipped', 'error', 'not_requested'}:
        raise ValueError('invalid transcription status')
    transcript_text = payload.get('transcript_text')
    model = payload.get('transcript_model')
    error = payload.get('transcript_error') or payload.get('error')
    completed = status in {'done', 'skipped', 'error'}
    with connect() as conn:
        row = conn.execute(
            """
            update tweet_media
            set transcript_status = %s,
                transcript_text = coalesce(%s, transcript_text),
                transcript_model = coalesce(%s, transcript_model),
                transcript_error = %s,
                transcribed_at = case when %s then now() else transcribed_at end,
                updated_at = now()
            where media_id = %s
            returning media_id
            """,
            (status, transcript_text, model, error, completed, media_id),
        ).fetchone()
    return row is not None


def store_media_asset(media_id, payload):
    data = payload.get('data_base64') or payload.get('data')
    mime_type = _str_or_none(payload.get('mime_type') or payload.get('asset_mime_type'))
    if not data or not isinstance(data, str):
        raise ValueError('data_base64 is required')
    if not mime_type:
        raise ValueError('mime_type is required')
    try:
        raw = base64.b64decode(data, validate=True)
    except Exception as e:
        raise ValueError(f'invalid base64: {e}') from e
    sha = hashlib.sha256(raw).hexdigest()
    with connect() as conn:
        row = conn.execute(
            """
            update tweet_media
            set asset_status = 'stored',
                asset_mime_type = %s,
                asset_byte_size = %s,
                content_sha256 = %s,
                asset_bytes = %s,
                updated_at = now()
            where media_id = %s
            returning media_id
            """,
            (mime_type, len(raw), sha, raw, media_id),
        ).fetchone()
    return row is not None


def media_content(media_id, data_url=False):
    media = get_media(media_id, include_bytes=True)
    if not media:
        return None
    raw = media.pop('asset_bytes', None)
    if raw is None:
        return {'media': media, 'data_url': None}
    if isinstance(raw, memoryview):
        raw = raw.tobytes()
    elif not isinstance(raw, bytes):
        raw = bytes(raw)
    if data_url:
        mime_type = media.get('asset_mime_type') or 'application/octet-stream'
        media['data_url'] = f'data:{mime_type};base64,{base64.b64encode(raw).decode("ascii")}'
    return {'media': media, 'data_url': media.pop('data_url', None)}


def tweet_stats():
    with connect() as conn:
        row = conn.execute(
            """
            select
              count(*) as tweet_count,
              min(created_at) as oldest_created_at,
              max(created_at) as newest_created_at,
              max(captured_at) as newest_captured_at,
              count(distinct author_username) as author_count
            from tweets
            """
        ).fetchone()
    return _row_to_json(row)


class ApiHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f'{self.client_address[0]} - {fmt % args}', file=sys.stderr)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/health':
            try:
                with connect() as conn:
                    conn.execute('select 1')
                _json_response(self, 200, {'ok': True})
            except Exception as e:
                _json_response(self, 503, {'ok': False, 'error': str(e)})
            return

        if not self._authorize():
            return

        if parsed.path == '/api/tweets':
            self._handle_list_tweets(parsed.query)
            return
        if parsed.path.startswith('/api/tweets/'):
            suffix = parsed.path.removeprefix('/api/tweets/')
            if suffix.endswith('/media'):
                tweet_id = unquote(suffix[:-len('/media')])
                self._handle_list_media(tweet_id)
            else:
                tweet_id = unquote(suffix)
                self._handle_get_tweet(tweet_id, parsed.query)
            return
        if parsed.path.startswith('/api/media/'):
            suffix = parsed.path.removeprefix('/api/media/')
            if suffix.endswith('/content'):
                media_id = unquote(suffix[:-len('/content')])
                self._handle_media_content(media_id, parsed.query)
            else:
                self._handle_get_media(unquote(suffix))
            return
        if parsed.path == '/api/stats':
            self._handle_stats()
            return

        _json_response(self, 404, {'ok': False, 'error': 'Not found'})

    def _authorize(self):
        if not INGEST_TOKEN:
            _json_response(self, 500, {'ok': False, 'error': 'INGEST_TOKEN is not configured'})
            return False
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or not hmac.compare_digest(auth[7:], INGEST_TOKEN):
            _json_response(self, 401, {'ok': False, 'error': 'Unauthorized'})
            return False
        return True

    def _handle_list_tweets(self, raw_query):
        params = parse_qs(raw_query, keep_blank_values=False)
        value = lambda name: params.get(name, [None])[0]
        try:
            tweets = list_tweets(
                query=value('q'),
                author=value('author'),
                since=value('since'),
                until=value('until'),
                endpoint=value('endpoint'),
                media=value('media'),
                transcription=value('transcription'),
                has_quoted=_bool_param(value('has_quoted')),
                has_reply=_bool_param(value('has_reply')),
                sort=value('sort') or 'newest',
                limit=_bounded_int(value('limit'), 50, 1, 500),
                offset=_bounded_int(value('offset'), 0, 0, 100000),
                include_raw=_bool_param(value('include_raw')),
                include_media=_bool_param(value('include_media')),
                include_total=_bool_param(value('include_total')),
                include_facets=_bool_param(value('include_facets')),
                include_metrics=_bool_param(value('include_metrics')),
                facet_query=value('facet_q'),
            )
            if isinstance(tweets, dict):
                payload = {'ok': True, 'tweets': tweets.get('tweets') or []}
                for key in ['total', 'facets', 'metrics']:
                    if key in tweets:
                        payload[key] = tweets[key]
            else:
                payload = {'ok': True, 'tweets': tweets}
            _json_response(self, 200, payload)
        except Exception as e:
            _json_response(self, 500, {'ok': False, 'error': str(e)})

    def _handle_get_tweet(self, tweet_id, raw_query):
        params = parse_qs(raw_query, keep_blank_values=False)
        try:
            tweet = get_tweet(
                tweet_id,
                include_raw=_bool_param(params.get('include_raw', [None])[0]),
                include_media=_bool_param(params.get('include_media', [None])[0]),
            )
        except Exception as e:
            _json_response(self, 500, {'ok': False, 'error': str(e)})
            return
        if not tweet:
            _json_response(self, 404, {'ok': False, 'error': 'Tweet not found'})
            return
        _json_response(self, 200, {'ok': True, 'tweet': tweet})

    def _handle_list_media(self, tweet_id):
        try:
            media = list_media(tweet_id)
        except Exception as e:
            _json_response(self, 500, {'ok': False, 'error': str(e)})
            return
        if media is None:
            _json_response(self, 404, {'ok': False, 'error': 'Tweet not found'})
            return
        _json_response(self, 200, {'ok': True, 'media': media})

    def _handle_get_media(self, media_id):
        try:
            media = get_media(media_id)
        except Exception as e:
            _json_response(self, 500, {'ok': False, 'error': str(e)})
            return
        if not media:
            _json_response(self, 404, {'ok': False, 'error': 'Media not found'})
            return
        _json_response(self, 200, {'ok': True, 'media': media})

    def _handle_media_content(self, media_id, raw_query):
        params = parse_qs(raw_query, keep_blank_values=False)
        try:
            result = media_content(media_id, data_url=_bool_param(params.get('data_url', [None])[0]))
        except Exception as e:
            _json_response(self, 500, {'ok': False, 'error': str(e)})
            return
        if result is None:
            _json_response(self, 404, {'ok': False, 'error': 'Media not found'})
            return
        if not result.get('data_url'):
            _json_response(self, 404, {'ok': False, 'error': 'Media asset not stored'})
            return
        _json_response(self, 200, {'ok': True, **result})

    def _handle_stats(self):
        try:
            _json_response(self, 200, {'ok': True, 'stats': tweet_stats()})
        except Exception as e:
            _json_response(self, 500, {'ok': False, 'error': str(e)})

    def do_POST(self):
        parsed = urlparse(self.path)
        if not self._authorize():
            return

        payload = self._read_json_body()
        if payload is None:
            return

        try:
            if parsed.path == '/api/ingest/tweets':
                result = ingest_tweets(payload)
                _json_response(self, 200, result)
                return
            if parsed.path.startswith('/api/media/') and parsed.path.endswith('/transcription'):
                media_id = unquote(parsed.path.removeprefix('/api/media/')[:-len('/transcription')])
                if not update_media_transcription(media_id, payload):
                    _json_response(self, 404, {'ok': False, 'error': 'Media not found'})
                    return
                _json_response(self, 200, {'ok': True, 'media_id': media_id})
                return
            if parsed.path.startswith('/api/media/') and parsed.path.endswith('/asset'):
                media_id = unquote(parsed.path.removeprefix('/api/media/')[:-len('/asset')])
                if not store_media_asset(media_id, payload):
                    _json_response(self, 404, {'ok': False, 'error': 'Media not found'})
                    return
                _json_response(self, 200, {'ok': True, 'media_id': media_id})
                return
            _json_response(self, 404, {'ok': False, 'error': 'Not found'})
        except ValueError as e:
            _json_response(self, 400, {'ok': False, 'error': str(e)})
        except Exception as e:
            _json_response(self, 500, {'ok': False, 'error': str(e)})

    def _read_json_body(self):
        raw_length = self.headers.get('Content-Length')
        try:
            length = int(raw_length or '')
        except ValueError:
            _json_response(self, 400, {'ok': False, 'error': 'Invalid Content-Length'})
            return None
        if length < 0:
            _json_response(self, 400, {'ok': False, 'error': 'Content-Length must not be negative'})
            return None
        if length > MAX_BODY_SIZE:
            _json_response(self, 413, {'ok': False, 'error': 'Payload too large'})
            return None
        try:
            return json.loads(self.rfile.read(length) or b'{}')
        except json.JSONDecodeError as e:
            _json_response(self, 400, {'ok': False, 'error': f'Invalid JSON: {e}'})
            return None


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
