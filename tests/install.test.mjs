import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_NODE_MAJOR,
  browserCandidates,
  parseNodeMajor,
  playwrightCandidates,
} from '../scripts/install.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const installShell = join(testDir, '..', 'scripts', 'install.sh');


test('parses supported and unsupported Node.js versions', () => {
  assert.equal(MIN_NODE_MAJOR, 20);
  assert.equal(parseNodeMajor('v24.18.0'), 24);
  assert.equal(parseNodeMajor('20.0.0'), 20);
  assert.equal(parseNodeMajor('19.9.0'), 19);
  assert.equal(parseNodeMajor('unknown'), null);
});


test('orders reusable Playwright locations without duplicates', () => {
  const candidates = playwrightCandidates({
    env: { SMARTBI_PLAYWRIGHT_PATH: '/opt/custom/playwright' },
    homeDir: '/home/tester',
    skillDir: '/opt/skill',
  });
  assert.deepEqual(candidates.map((candidate) => candidate.source), [
    'environment',
    'skill-local',
    'smartbi-managed',
    'omp-bundled',
  ]);
  assert.equal(candidates[0].modulePath, '/opt/custom/playwright/index.mjs');
  assert.equal(
    candidates[2].modulePath,
    '/home/tester/.local/share/smartbi-platform/playwright/node_modules/playwright/index.mjs',
  );
  assert.equal(new Set(candidates.map((candidate) => candidate.modulePath)).size, candidates.length);
});


test('detects platform-specific browser paths and honors an override first', () => {
  const mac = browserCandidates({
    env: { SMARTBI_BROWSER_PATH: '/custom/chrome' },
    homeDir: '/Users/tester',
    platform: 'darwin',
  });
  assert.equal(mac[0], '/custom/chrome');
  assert.ok(mac.some((candidate) => candidate.includes('Google Chrome.app')));

  const linux = browserCandidates({ env: {}, homeDir: '/home/tester', platform: 'linux' });
  assert.ok(linux.includes('/usr/bin/google-chrome'));
  assert.ok(linux.includes('/usr/bin/chromium'));
});


test('shell bootstrap reports a missing Node.js before invoking MJS', () => {
  const result = spawnSync('/bin/sh', [installShell, '--check'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_COMMAND: 'definitely-missing-smartbi-node',
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Node\.js was not found/);
  assert.match(result.stderr, /Node\.js 20 or newer/);
});
