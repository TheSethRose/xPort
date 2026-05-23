import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const extensionRoot = path.join(root, 'extension');
const chromeManifestPath = path.join(extensionRoot, 'manifest.json');
const firefoxManifestPath = path.join(extensionRoot, 'manifest.firefox.json');

// Regenerate to ensure it's up-to-date
execFileSync('node', [path.join(root, 'scripts', 'build-firefox-manifest.js')]);

const chrome = JSON.parse(fs.readFileSync(chromeManifestPath, 'utf8'));
const firefox = JSON.parse(fs.readFileSync(firefoxManifestPath, 'utf8'));

test('Firefox manifest uses background scripts instead of service_worker', () => {
  assert.equal(firefox.manifest_version, 3);
  assert.deepEqual(firefox.background.scripts, ['background.js']);
  assert.equal(firefox.background.type, 'module');
  assert.equal(firefox.background.service_worker, undefined);
});

test('Firefox manifest declares Gecko metadata', () => {
  const gecko = firefox.browser_specific_settings?.gecko;
  assert.ok(gecko);
  assert.equal(gecko.id, 'xport@sethrose.dev');
  assert.equal(gecko.strict_min_version, '128.0');
});

test('Firefox manifest preserves permissions from Chrome manifest', () => {
  assert.deepEqual(firefox.permissions, chrome.permissions);
  assert.deepEqual(firefox.host_permissions, chrome.host_permissions);
});

test('Firefox manifest version matches Chrome manifest', () => {
  assert.equal(firefox.version, chrome.version);
});

test('Firefox manifest preserves content scripts from Chrome manifest', () => {
  assert.deepEqual(firefox.content_scripts, chrome.content_scripts);
});

test('Chrome manifest does not have browser_specific_settings', () => {
  assert.equal(chrome.browser_specific_settings, undefined);
});
