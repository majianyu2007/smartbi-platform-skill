import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const testDir = dirname(fileURLToPath(import.meta.url));
const cli = join(testDir, '..', 'scripts', 'smartbi.mjs');

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function temporaryWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'smartbi-setup-'));
  return {
    root,
    config: join(root, 'config.json'),
    credentials: join(root, 'credentials.txt'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('non-interactive setup emits safe first-run guidance', () => {
  const workspace = temporaryWorkspace();
  try {
    const result = runCli(['setup'], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.action, 'setup_needed');
    assert.match(output.message, /account\/password/);
    assert.ok(output.commands.some((command) => command.includes('--interactive')));
    assert.doesNotMatch(result.stdout, /password\s*:/i);
  } finally {
    workspace.cleanup();
  }
});

test('config applies prefix and suffix naming idempotently', () => {
  const workspace = temporaryWorkspace();
  try {
    const prefix = runCli(['config'], {
      SMARTBI_CONFIG_FILE: workspace.config,
      SMARTBI_NAMESPACE: 'TEAM_',
      SMARTBI_NAMING: 'prefix',
    });
    assert.equal(prefix.status, 0, prefix.stderr);
    assert.deepEqual(JSON.parse(prefix.stdout).naming, { mode: 'prefix', value: 'TEAM_' });
    assert.equal(JSON.parse(prefix.stdout).example, 'TEAM_survey_demo');
    assert.equal(JSON.parse(prefix.stdout).alreadyNamespacedExample, 'TEAM_survey_demo');

    const suffix = runCli(['config'], {
      SMARTBI_CONFIG_FILE: workspace.config,
      SMARTBI_NAMESPACE: '_TEAM',
      SMARTBI_NAMING: 'suffix',
    });
    assert.equal(suffix.status, 0, suffix.stderr);
    assert.deepEqual(JSON.parse(suffix.stdout).naming, { mode: 'suffix', value: '_TEAM' });
    assert.equal(JSON.parse(suffix.stdout).example, 'survey_demo_TEAM');
    assert.equal(JSON.parse(suffix.stdout).alreadyNamespacedExample, 'survey_demo_TEAM');
  } finally {
    workspace.cleanup();
  }
});

test('non-interactive setup validates credentials and writes private config', () => {
  const workspace = temporaryWorkspace();
  try {
    const password = 'test-secret-never-emit';
    writeFileSync(workspace.credentials, `test-account\n${password}\n`, { mode: 0o600 });
    const result = runCli([
      'setup',
      '--cred-file', workspace.credentials,
      '--namespace', '_TEAM',
      '--naming', 'suffix',
    ], { SMARTBI_CONFIG_FILE: workspace.config });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(password));
    const output = JSON.parse(result.stdout);
    assert.equal(output.action, 'setup_done');
    assert.deepEqual(output.saved.naming, { mode: 'suffix', value: '_TEAM' });
    assert.equal(output.saved.credFile, workspace.credentials);
    assert.deepEqual(JSON.parse(readFileSync(workspace.config, 'utf8')), output.saved);
    assert.equal(statSync(workspace.config).mode & 0o777, 0o600);
  } finally {
    workspace.cleanup();
  }
});

test('setup rejects unsupported naming modes', () => {
  const workspace = temporaryWorkspace();
  try {
    writeFileSync(workspace.credentials, 'test-account\ntest-password\n', { mode: 0o600 });
    const result = runCli([
      'setup',
      '--cred-file', workspace.credentials,
      '--namespace', 'TEAM_',
      '--naming', 'middle',
    ], { SMARTBI_CONFIG_FILE: workspace.config });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid naming mode/);
  } finally {
    workspace.cleanup();
  }
});
