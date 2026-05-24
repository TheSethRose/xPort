import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const extensionRoot = path.join(root, 'extension');
const manifestPath = path.join(extensionRoot, 'manifest.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

test('Chrome manifest uses MV3 service worker module', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.background.type, 'module');
});

test('Chrome manifest keeps minimal permissions', () => {
  assert.deepEqual(manifest.permissions, ['storage', 'nativeMessaging']);
  assert.deepEqual(manifest.host_permissions, [
    '*://*.x.com/*',
    '*://*.twitter.com/*',
    'http://127.0.0.1/*',
  ]);
});

test('Chrome manifest has no Firefox metadata', () => {
  assert.equal(manifest.browser_specific_settings, undefined);
  assert.equal(manifest.background.scripts, undefined);
});
