#!/usr/bin/env node
// Generates extension/manifest.firefox.json from extension/manifest.json.
// Run as part of release to keep a single source of truth for version,
// permissions, and content scripts.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const extensionRoot = path.join(root, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));

// Firefox MV3 uses background.scripts instead of service_worker
delete manifest.background.service_worker;
manifest.background.scripts = ['background.js'];

// Gecko-specific metadata
manifest.browser_specific_settings = {
  gecko: {
    id: 'xport@sethrose.dev',
    strict_min_version: '128.0'
  }
};

fs.writeFileSync(
  path.join(extensionRoot, 'manifest.firefox.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);

console.log('Generated extension/manifest.firefox.json');
