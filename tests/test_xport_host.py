"""Tests for native-host/xport_host.py — message framing and startup."""

import io
import json
import os
import struct
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'native-host'))
import xport_host


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class ChunkedReader:
    """Wraps bytes and yields them in fixed-size chunks to simulate pipe fragmentation."""

    def __init__(self, data: bytes, chunk_size: int = 3):
        self._data = data
        self._pos = 0
        self._chunk_size = chunk_size

    def read(self, n: int) -> bytes:
        actual = min(n, self._chunk_size, len(self._data) - self._pos)
        if actual <= 0:
            return b''
        chunk = self._data[self._pos:self._pos + actual]
        self._pos += actual
        return chunk


def _encode_native_message(obj):
    """Encode a Python object into the Chrome native-messaging wire format."""
    payload = json.dumps(obj).encode('utf-8')
    return struct.pack('<I', len(payload)) + payload


# ---------------------------------------------------------------------------
# read_message / read_exact
# ---------------------------------------------------------------------------

class TestReadMessage:

    def test_handles_chunked_pipe(self, monkeypatch):
        msg = {'type': 'LOG', 'lines': ['hello']}
        raw = _encode_native_message(msg)
        chunked = ChunkedReader(raw, chunk_size=3)
        monkeypatch.setattr('sys.stdin', type('', (), {'buffer': chunked})())
        assert xport_host.read_message() == msg

    def test_invalid_json_raises_value_error(self, monkeypatch):
        payload = b'not json at all'
        raw = struct.pack('<I', len(payload)) + payload
        monkeypatch.setattr('sys.stdin', type('', (), {'buffer': io.BytesIO(raw)})())
        with pytest.raises(json.JSONDecodeError):
            xport_host.read_message()

    def test_eof_mid_payload_raises_eoferror(self, monkeypatch):
        # Header claims 100 bytes but only 5 are available
        raw = struct.pack('<I', 100) + b'short'
        monkeypatch.setattr('sys.stdin', type('', (), {'buffer': io.BytesIO(raw)})())
        with pytest.raises(EOFError):
            xport_host.read_message()


# ---------------------------------------------------------------------------
# GET_TOKEN without storage init
# ---------------------------------------------------------------------------

class TestGetTokenWithoutStorage:

    def test_get_token_returns_secret(self, monkeypatch, tmp_path):
        """GET_TOKEN should read ~/.xport/secret and return it."""
        # Create a secret file
        xport_dir = tmp_path / '.xport'
        xport_dir.mkdir()
        secret_file = xport_dir / 'secret'
        secret_file.write_text('test-token-abc')
        monkeypatch.setattr(xport_host, 'XPORT_SECRET', str(secret_file))
        monkeypatch.setattr(xport_host, 'XPORT_DIR', str(xport_dir))

        # Build a stdin stream: one GET_TOKEN message, then EOF
        raw = _encode_native_message({'type': 'GET_TOKEN'})
        monkeypatch.setattr('sys.stdin', type('', (), {'buffer': io.BytesIO(raw)})())

        # Capture stdout
        out_buf = io.BytesIO()
        monkeypatch.setattr('sys.stdout', type('', (), {'buffer': out_buf})())

        xport_host.main()

        # Parse the response
        out_buf.seek(0)
        resp_len = struct.unpack('<I', out_buf.read(4))[0]
        resp = json.loads(out_buf.read(resp_len))
        assert resp['ok'] is True
        assert resp['token'] == 'test-token-abc'
        assert resp['port'] == 17381

    def test_unsupported_message_returns_error(self, monkeypatch, tmp_path):
        """Non-GET_TOKEN messages should return an error."""
        xport_dir = tmp_path / '.xport'
        xport_dir.mkdir()
        monkeypatch.setattr(xport_host, 'XPORT_DIR', str(xport_dir))

        raw = _encode_native_message({'type': 'TWEETS', 'tweets': []})
        monkeypatch.setattr('sys.stdin', type('', (), {'buffer': io.BytesIO(raw)})())

        out_buf = io.BytesIO()
        monkeypatch.setattr('sys.stdout', type('', (), {'buffer': out_buf})())

        xport_host.main()

        out_buf.seek(0)
        resp_len = struct.unpack('<I', out_buf.read(4))[0]
        resp = json.loads(out_buf.read(resp_len))
        assert resp['ok'] is False
        assert 'Unsupported' in resp['error']

    def test_missing_secret_returns_error(self, monkeypatch, tmp_path):
        """GET_TOKEN when secret file is missing should return a clear error."""
        xport_dir = tmp_path / '.xport'
        xport_dir.mkdir()
        monkeypatch.setattr(xport_host, 'XPORT_SECRET', str(xport_dir / 'nonexistent'))
        monkeypatch.setattr(xport_host, 'XPORT_DIR', str(xport_dir))

        raw = _encode_native_message({'type': 'GET_TOKEN'})
        monkeypatch.setattr('sys.stdin', type('', (), {'buffer': io.BytesIO(raw)})())

        out_buf = io.BytesIO()
        monkeypatch.setattr('sys.stdout', type('', (), {'buffer': out_buf})())

        xport_host.main()

        out_buf.seek(0)
        resp_len = struct.unpack('<I', out_buf.read(4))[0]
        resp = json.loads(out_buf.read(resp_len))
        assert resp['ok'] is False
        assert 'not found' in resp['error']
