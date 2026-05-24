"""Tests for native-host/xport_core.py"""

import json
import os
import sys
import threading
import urllib.request

import pytest

# Import module under test
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'native-host'))
import xport_core


# ---------------------------------------------------------------------------
# resolve_output_dir
# ---------------------------------------------------------------------------


class TestResolveOutputDir:
    def test_falsy_msg_dir(self, tmp_path):
        default = str(tmp_path / 'default')
        result = xport_core.resolve_output_dir('', default)
        assert result == default

    def test_none_msg_dir(self, tmp_path):
        default = str(tmp_path / 'default')
        result = xport_core.resolve_output_dir(None, default)
        assert result == default

    def test_custom_dir_created(self, tmp_path, monkeypatch):
        monkeypatch.setattr(xport_core, '_ALLOWED_ROOTS', (os.path.realpath(str(tmp_path)),))
        custom = str(tmp_path / 'custom')
        result = xport_core.resolve_output_dir(custom, '/default')
        assert os.path.realpath(result) == os.path.realpath(custom)
        assert os.path.isdir(result)

    def test_tilde_expansion(self, tmp_path):
        result = xport_core.resolve_output_dir('~/xport-test-dir', '/default')
        expected = os.path.expanduser('~/xport-test-dir')
        assert result == expected
        # Clean up
        if os.path.isdir(expected):
            os.rmdir(expected)


# ---------------------------------------------------------------------------
# validate_output_dir
# ---------------------------------------------------------------------------


class TestValidateOutputDir:

    def test_path_under_home_allowed(self):
        home = os.path.expanduser('~')
        result = xport_core.validate_output_dir(os.path.join(home, 'some', 'subdir'))
        assert result.startswith(os.path.realpath(home))

    def test_home_itself_allowed(self):
        home = os.path.expanduser('~')
        result = xport_core.validate_output_dir(home)
        assert result == os.path.realpath(home)

    def test_traversal_outside_home_rejected(self):
        with pytest.raises(ValueError, match='outside allowed directories'):
            xport_core.validate_output_dir('/etc/cron.d/evil')

    def test_dot_dot_traversal_rejected(self):
        home = os.path.expanduser('~')
        with pytest.raises(ValueError, match='outside allowed directories'):
            # Enough '..' to escape home
            xport_core.validate_output_dir(os.path.join(home, '..', '..', 'tmp', 'pwned'))

    def test_absolute_path_outside_home_rejected(self):
        with pytest.raises(ValueError, match='outside allowed directories'):
            xport_core.validate_output_dir('/tmp/pwned')

    def test_resolve_output_dir_rejects_traversal(self):
        with pytest.raises(ValueError, match='outside allowed directories'):
            xport_core.resolve_output_dir('/etc/evil', '/default')

    def test_default_output_dir_allowed(self):
        result = xport_core.validate_output_dir(xport_core.DEFAULT_OUTPUT_DIR)
        assert result == os.path.realpath(xport_core.DEFAULT_OUTPUT_DIR)


# ---------------------------------------------------------------------------
# write_log
# ---------------------------------------------------------------------------


class TestWriteLog:
    def test_basic_write(self, tmp_path):
        count = xport_core.write_log(['line one', 'line two'], str(tmp_path))
        assert count == 2
        files = list(tmp_path.glob('debug-*.log'))
        assert len(files) == 1
        content = files[0].read_text()
        assert 'line one\n' in content
        assert 'line two\n' in content

    def test_appends(self, tmp_path):
        xport_core.write_log(['first'], str(tmp_path))
        xport_core.write_log(['second'], str(tmp_path))
        files = list(tmp_path.glob('debug-*.log'))
        lines = files[0].read_text().strip().split('\n')
        assert len(lines) == 2

    def test_empty_list(self, tmp_path):
        count = xport_core.write_log([], str(tmp_path))
        assert count == 0


# ---------------------------------------------------------------------------
# write_dump
# ---------------------------------------------------------------------------


class TestWriteDump:
    def test_basic_write(self, tmp_path):
        path = xport_core.write_dump('test.json', '{"key": "value"}', str(tmp_path))
        assert os.path.exists(path)
        assert (tmp_path / 'test.json').read_text() == '{"key": "value"}'

    def test_overwrites_existing(self, tmp_path):
        xport_core.write_dump('test.json', 'old', str(tmp_path))
        xport_core.write_dump('test.json', 'new', str(tmp_path))
        assert (tmp_path / 'test.json').read_text() == 'new'

    def test_traversal_filename_stripped(self, tmp_path):
        path = xport_core.write_dump('../../.ssh/authorized_keys', 'data', str(tmp_path))
        # Traversal stripped — writes to out_dir/authorized_keys
        assert path == os.path.join(str(tmp_path), 'authorized_keys')
        assert (tmp_path / 'authorized_keys').read_text() == 'data'

    def test_absolute_filename_stripped(self, tmp_path):
        path = xport_core.write_dump('/etc/cron.d/evil', 'data', str(tmp_path))
        # Should write to out_dir/evil, not /etc/cron.d/evil
        assert path == os.path.join(str(tmp_path), 'evil')
        assert (tmp_path / 'evil').read_text() == 'data'

    def test_empty_filename_rejected(self, tmp_path):
        with pytest.raises(ValueError, match='Invalid dump filename'):
            xport_core.write_dump('', 'data', str(tmp_path))

    def test_dot_filename_rejected(self, tmp_path):
        with pytest.raises(ValueError, match='Invalid dump filename'):
            xport_core.write_dump('.', 'data', str(tmp_path))

    def test_dotdot_filename_rejected(self, tmp_path):
        with pytest.raises(ValueError, match='Invalid dump filename'):
            xport_core.write_dump('..', 'data', str(tmp_path))


# ---------------------------------------------------------------------------
# test_path
# ---------------------------------------------------------------------------


class TestTestPath:
    def test_writable_dir(self, tmp_path):
        xport_core.test_path(str(tmp_path))  # should not raise

    def test_creates_dir(self, tmp_path):
        new_dir = str(tmp_path / 'sub' / 'dir')
        xport_core.test_path(new_dir)
        assert os.path.isdir(new_dir)

    def test_no_leftover_file(self, tmp_path):
        xport_core.test_path(str(tmp_path))
        leftover = [f for f in os.listdir(str(tmp_path)) if f.startswith('.xport-write-test')]
        assert leftover == [], f'Sentinel not cleaned up: {leftover}'

    def test_cleanup_tolerates_missing_sentinel(self, tmp_path, monkeypatch):
        """test_path should not raise if the sentinel is already removed (race)."""
        original_remove = os.remove

        def remove_twice(path):
            original_remove(path)
            # Simulate a concurrent removal — file is already gone
            original_remove(path)

        monkeypatch.setattr(os, 'remove', remove_twice)
        xport_core.test_path(str(tmp_path))  # should not raise


class TestForwardTweetsToApi:
    def test_requires_api_configuration(self, monkeypatch):
        monkeypatch.setattr(xport_core, 'DEFAULT_API_URL', '')
        monkeypatch.setattr(xport_core, 'DEFAULT_INGEST_TOKEN', '')
        result = xport_core.forward_tweets_to_api([{'id': '1'}])
        assert result['enabled'] is False
        assert result['ok'] is False
        assert 'XPORT_API_URL' in result['error']

    def test_posts_tweets_to_ingest_endpoint(self, monkeypatch):
        monkeypatch.setattr(xport_core, 'DEFAULT_API_URL', 'https://xport.example')
        monkeypatch.setattr(xport_core, 'DEFAULT_INGEST_TOKEN', 'secret')
        monkeypatch.setenv('XPORT_API_RETRIES', '0')

        captured = {}

        class _Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return b'{"ok":true,"upserted":1,"batch_id":"batch-1"}'

        def fake_urlopen(req, timeout):
            captured['url'] = req.full_url
            captured['auth'] = req.get_header('Authorization')
            captured['body'] = json.loads(req.data.decode('utf-8'))
            captured['timeout'] = timeout
            return _Response()

        monkeypatch.setattr(urllib.request, 'urlopen', fake_urlopen)

        result = xport_core.forward_tweets_to_api([{'id': '1'}], source='test')

        assert result == {'enabled': True, 'ok': True, 'count': 1, 'batch_id': 'batch-1'}
        assert captured['url'] == 'https://xport.example/api/ingest/tweets'
        assert captured['auth'] == 'Bearer secret'
        assert captured['body'] == {'source': 'test', 'tweets': [{'id': '1'}]}


class TestListStoredTweetsFromApi:
    def test_gets_recent_tweets_with_media(self, monkeypatch):
        monkeypatch.setattr(xport_core, 'DEFAULT_API_URL', 'https://xport.example')
        monkeypatch.setattr(xport_core, 'DEFAULT_INGEST_TOKEN', 'secret')
        captured = {}

        class _Response:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return b'{"ok":true,"tweets":[{"tweet_id":"1","text":"hello","media":[]}]}'

        def fake_urlopen(req, timeout):
            captured['url'] = req.full_url
            captured['auth'] = req.get_header('Authorization')
            return _Response()

        monkeypatch.setattr(urllib.request, 'urlopen', fake_urlopen)

        tweets = xport_core.list_stored_tweets_from_api(limit=25, offset=5)

        assert tweets == [{'tweet_id': '1', 'text': 'hello', 'media': []}]
        assert captured['url'] == 'https://xport.example/api/tweets?limit=25&offset=5&include_media=true'
        assert captured['auth'] == 'Bearer secret'


class TestImageAssetJobs:
    def test_collects_top_level_and_article_photos(self):
        tweets = [{
            'id': '123',
            'media': [
                {'type': 'photo', 'url': 'https://pbs.twimg.com/media/a.jpg'},
                {'type': 'video', 'url': 'https://video.twimg.com/a.mp4'},
            ],
            'article': {
                'media': [{'url': 'https://pbs.twimg.com/media/b.jpg'}],
            },
        }]

        assert xport_core.collect_image_asset_jobs(tweets) == [
            {
                'media_id': '123:0',
                'tweet_id': '123',
                'source_url': 'https://pbs.twimg.com/media/a.jpg',
            },
            {
                'media_id': '123:article:0',
                'tweet_id': '123',
                'source_url': 'https://pbs.twimg.com/media/b.jpg',
            },
        ]

    def test_enqueue_returns_zero_without_photos(self):
        assert xport_core.enqueue_image_asset_storage([{
            'id': '123',
            'media': [{'type': 'video', 'url': 'https://video.twimg.com/a.mp4'}],
        }]) == 0
