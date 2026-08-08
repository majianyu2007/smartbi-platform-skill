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
      SMARTBI_BASE_URL: 'https://portable.example.test/smartbi/vision/',
    });
    assert.equal(prefix.status, 0, prefix.stderr);
    assert.deepEqual(JSON.parse(prefix.stdout).naming, { mode: 'prefix', value: 'TEAM_' });
    assert.equal(JSON.parse(prefix.stdout).baseUrl, 'https://portable.example.test/smartbi/vision');
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
      '--base-url', 'https://portable.example.test/smartbi/vision/',
      '--cred-file', workspace.credentials,
      '--namespace', '_TEAM',
      '--naming', 'suffix',
    ], { SMARTBI_CONFIG_FILE: workspace.config });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(password));
    const output = JSON.parse(result.stdout);
    assert.equal(output.action, 'setup_done');
    assert.equal(output.saved.baseUrl, 'https://portable.example.test/smartbi/vision');
    assert.deepEqual(output.saved.naming, { mode: 'suffix', value: '_TEAM' });
    assert.equal(output.saved.credFile, workspace.credentials);
    assert.deepEqual(JSON.parse(readFileSync(workspace.config, 'utf8')), output.saved);
    assert.equal(JSON.parse(readFileSync(workspace.config, 'utf8')).baseUrl, output.saved.baseUrl);
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

test('setup rejects unsafe or malformed tenant URLs', () => {
  const workspace = temporaryWorkspace();
  try {
    writeFileSync(workspace.credentials, 'test-account\ntest-password\n', { mode: 0o600 });
    for (const baseUrl of [
      'ftp://example.test/smartbi/vision',
      'https://user:secret@example.test/smartbi/vision',
      'https://example.test/smartbi',
    ]) {
      const result = runCli([
        'setup',
        '--base-url', baseUrl,
        '--cred-file', workspace.credentials,
        '--namespace', 'TEAM_',
        '--naming', 'prefix',
      ], { SMARTBI_CONFIG_FILE: workspace.config });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /base URL/);
    }
  } finally {
    workspace.cleanup();
  }
});

test('AIChat graph commands validate required arguments before authentication', () => {
  const workspace = temporaryWorkspace();
  try {
    const fields = runCli(['aichat-graph-fields'], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(fields.status, 1);
    assert.match(fields.stderr, /aichat-graph-fields requires <modelId>/);

    const build = runCli(['aichat-graph-build'], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(build.status, 1);
    assert.match(build.stderr, /aichat-graph-build requires <modelId> <fieldNameOrId,\.\.\.>/);
    assert.doesNotMatch(`${fields.stderr}${build.stderr}`, /password|cookie/i);
  } finally {
    workspace.cleanup();
  }
});

test('generic API and ETL commands reject unsafe or incomplete input before authentication', () => {
  const workspace = temporaryWorkspace();
  try {
    const plain = runCli(['plain-post', 'https://example.com/api', '{}'], {
      SMARTBI_CONFIG_FILE: workspace.config,
    });

    const doctor = runCli(['doctor', '--install'], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(doctor.status, 1);
    assert.match(doctor.stderr, /doctor accepts only/);
    assert.equal(plain.status, 1);
    const rawMutation = runCli([
      'invoke', 'CatalogService', 'deleteCatalogElement', '["foreign-id"]',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(rawMutation.status, 1);
    assert.match(rawMutation.stderr, /only permits read-only discovery methods/);

    const apiMutation = runCli(['api-post', 'pages/beans/create', '{}'], {
      SMARTBI_CONFIG_FILE: workspace.config,
    });
    assert.equal(apiMutation.status, 1);
    assert.match(apiMutation.stderr, /refuses a mutating path/);
    assert.match(plain.stderr, /relative Smartbi root API path/);

    const etl = runCli(['etl-insert'], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(etl.status, 1);
    assert.match(etl.stderr, /etl-insert requires <flowId> <nodeName>/);

    const folder = runCli(['folder-create'], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(folder.status, 1);
    assert.match(folder.stderr, /folder-create requires <parentId> <name>/);

    const deletion = runCli(['resource-delete'], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(deletion.status, 1);
    assert.match(deletion.stderr, /resource-delete requires <parentId> <resourceId>/);

    const dashboard = runCli(['ui-dashboard-check'], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(dashboard.status, 1);
    assert.match(dashboard.stderr, /ui-dashboard-check requires <resourceId>/);
    assert.doesNotMatch(`${plain.stderr}${rawMutation.stderr}${apiMutation.stderr}${etl.stderr}${folder.stderr}${deletion.stderr}${dashboard.stderr}${doctor.stderr}`, /password|cookie/i);
  } finally {
    workspace.cleanup();
  }
});
