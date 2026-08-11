import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

test('setup rejects world-readable credentials and repairs existing config permissions', () => {
  const workspace = temporaryWorkspace();
  try {
    writeFileSync(workspace.credentials, 'test-account\ntest-password\n', { mode: 0o644 });
    const rejected = runCli([
      'setup',
      '--cred-file', workspace.credentials,
      '--namespace', 'TEAM_',
      '--naming', 'prefix',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /credentials file must use mode 0600/);

    writeFileSync(workspace.credentials, 'test-account\ntest-password\n', { mode: 0o600 });
    writeFileSync(workspace.config, '{}\n', { mode: 0o644 });
    chmodSync(workspace.credentials, 0o600);
    const repaired = runCli([
      'setup',
      '--cred-file', workspace.credentials,
      '--namespace', 'TEAM_',
      '--naming', 'prefix',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(statSync(workspace.config).mode & 0o777, 0o600);
  } finally {
    workspace.cleanup();
  }
});

test('setup rejects unknown options and competition profile without school', () => {
  const workspace = temporaryWorkspace();
  try {
    writeFileSync(workspace.credentials, 'test-account\ntest-password\n', { mode: 0o600 });
    const unknown = runCli(['setup', '--base-urlx', 'https://example.test/smartbi/vision'], {
      SMARTBI_CONFIG_FILE: workspace.config,
    });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown setup option: --base-urlx/);

    const missingSchool = runCli([
      'setup',
      '--base-url', 'https://tiaozhanbei.cloud.smartbi.com.cn/smartbi/vision',
      '--cred-file', workspace.credentials,
      '--namespace', 'TEAM_',
      '--naming', 'prefix',
      '--profile', 'competition-2026',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(missingSchool.status, 1);
    assert.match(missingSchool.stderr, /school name must not be empty/);
  } finally {
    workspace.cleanup();
  }
});

test('setup persists an explicit competition profile only on its official tenant', () => {
  const workspace = temporaryWorkspace();
  try {
    writeFileSync(workspace.credentials, 'test-account\ntest-password\n', { mode: 0o600 });
    const configured = runCli([
      'setup',
      '--base-url', 'https://tiaozhanbei.cloud.smartbi.com.cn/smartbi/vision',
      '--cred-file', workspace.credentials,
      '--namespace', 'TEAM_',
      '--naming', 'prefix',
      '--profile', 'competition-2026',
      '--school-name', '示例大学',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(configured.status, 0, configured.stderr);
    assert.deepEqual(JSON.parse(configured.stdout).saved.platformProfile, {
      id: 'competition-2026',
      schoolName: '示例大学',
    });

    const schoolOverride = runCli(['config'], {
      SMARTBI_CONFIG_FILE: workspace.config,
      SMARTBI_SCHOOL_NAME: '覆盖大学',
    });
    assert.equal(schoolOverride.status, 0, schoolOverride.stderr);
    assert.equal(JSON.parse(schoolOverride.stdout).platformProfile.schoolName, '覆盖大学');
    assert.equal(
      JSON.parse(schoolOverride.stdout).platformProfile.resourceFolderName,
      '覆盖大学-2026“揭榜挂帅”挑战杯擂台赛',
    );

    const agent = runCli(['agent-get', 'test-agent'], {
      SMARTBI_CONFIG_FILE: workspace.config,
    });
    assert.equal(agent.status, 1);
    assert.match(agent.stderr, /Agent is prohibited by platform profile competition-2026/);

    for (const agentCommand of [
      ['agent-create', 'SELF_AGENT_GRAPHS_test', 'agent'],
      ['agent-run', 'test-agent', 'question'],
      ['agent-deploy', 'test-agent'],
    ]) {
      const rejected = runCli(agentCommand, {
        SMARTBI_CONFIG_FILE: workspace.config,
      });
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /Agent is prohibited by platform profile competition-2026/);
    }

    const upload = runCli(['upload', 'dataset.csv'], {
      SMARTBI_CONFIG_FILE: workspace.config,
    });
    assert.equal(upload.status, 1);
    assert.match(upload.stderr, /competition public dataset source URL must not be empty/);

    const union = runCli([
      'etl-union-create',
      'candidate-folder',
      'TAB.input.input.null.team_target',
      'combined',
      '["TAB.input.input.null.a","TAB.input.input.null.b"]',
      '--confirm-target',
      'TEAM_target',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(union.status, 1);
    assert.match(union.stderr, /candidate datasets must not be unioned or appended/);

    const modelWithoutLineage = runCli([
      'model-create',
      'candidate-folder',
      'DS.input',
      'TAB.input.input.null.team_target',
      'team_target',
      'model',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(modelWithoutLineage.status, 1);
    assert.match(modelWithoutLineage.stderr, /requires --etl-flow <ownedFlowId>/);

    const modelClone = runCli([
      'model-clone', 'candidate-folder', 'model-id', 'copy',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(modelClone.status, 1);
    assert.match(modelClone.stderr, /competition model-clone is prohibited/);

    const unsafeMigration = runCli([
      'competition-home', '--migrate-legacy',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(unsafeMigration.status, 1);
    assert.match(unsafeMigration.stderr, /requires --confirm-name <exactLegacyFolderName>/);

    const move = runCli([
      'resource-move', 'candidate-a', 'model-id', 'candidate-b',
      '--confirm-name', 'TEAM_model',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(move.status, 1);
    assert.match(move.stderr, /competition resource-move is prohibited/);

    const copy = runCli([
      'resource-copy', 'candidate-a', 'model-id', 'candidate-b', 'copy',
      '--confirm-name', 'TEAM_model',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(copy.status, 1);
    assert.match(copy.stderr, /competition resource-copy is prohibited/);

    const wrongHost = runCli([
      'setup',
      '--base-url', 'https://portable.example.test/smartbi/vision',
      '--cred-file', workspace.credentials,
      '--namespace', 'TEAM_',
      '--naming', 'prefix',
      '--profile', 'competition-2026',
      '--school-name', '示例大学',
    ], { SMARTBI_CONFIG_FILE: join(workspace.root, 'wrong-host.json') });
    assert.equal(wrongHost.status, 1);
    assert.match(wrongHost.stderr, /requires host tiaozhanbei\.cloud\.smartbi\.com\.cn/);
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
    assert.match(
      build.stderr,
      /aichat-graph-build requires <parentId> <modelId> <fieldNameOrId,\.\.\.> --confirm-name <exactModelName>/,
    );
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
    assert.match(plain.stderr, /plain relative path/);

    const encodedTraversal = runCli([
      'api-post', 'get/%2e%2e/pages/beans?_method=PUT', '{}',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(encodedTraversal.status, 1);
    assert.match(encodedTraversal.stderr, /refuses a non-canonical path/);

    const doubleEncodedTraversal = runCli([
      'api-post', 'get/%252e%252e/pages/beans?method=PATCH', '{}',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(doubleEncodedTraversal.status, 1);
    assert.match(doubleEncodedTraversal.stderr, /refuses a non-canonical path/);

    const methodOverride = runCli([
      'plain-post', 'get/pages?%5fmethod=DELETE', '{}',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(methodOverride.status, 1);
    assert.match(methodOverride.stderr, /refuses routing or method overrides/);

    const encodedAbsolute = runCli([
      'api-get', 'https%3A%2F%2Fexample.com%2Fget',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(encodedAbsolute.status, 1);
    assert.match(encodedAbsolute.stderr, /refuses a non-canonical path/);

    const etl = runCli(['etl-insert'], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(etl.status, 1);
    assert.match(etl.stderr, /etl-insert requires <flowId> <nodeName>/);

    const folder = runCli(['folder-create'], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(folder.status, 1);
    assert.match(folder.stderr, /folder-create requires <parentId> <name>/);

    const rename = runCli([
      'resource-rename', 'parent', 'resource', 'new-name',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(rename.status, 1);
    assert.match(rename.stderr, /resource-rename requires --confirm-name/);

    const move = runCli([
      'resource-move', 'source-parent', 'resource', 'target-parent',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(move.status, 1);
    assert.match(move.stderr, /resource-move requires --confirm-name/);

    const copy = runCli([
      'resource-copy', 'source-parent', 'resource', 'target-parent', 'new-name',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(copy.status, 1);
    assert.match(copy.stderr, /resource-copy requires --confirm-name/);

    const etlCreate = runCli([
      'etl-create', 'parent', 'source', 'target', 'flow',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(etlCreate.status, 1);
    assert.match(etlCreate.stderr, /etl-create requires --confirm-target/);

    const etlUnion = runCli([
      'etl-union-create', 'parent', 'target', 'flow', '["a","b"]',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(etlUnion.status, 1);
    assert.match(etlUnion.stderr, /etl-union-create requires --confirm-target/);

    const agentRun = runCli([
      'agent-run', 'agent', 'question',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(agentRun.status, 1);
    assert.match(agentRun.stderr, /agent-run requires --confirm-name/);

    const agentDeploy = runCli([
      'agent-deploy', 'agent',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(agentDeploy.status, 1);
    assert.match(agentDeploy.stderr, /agent-deploy requires --confirm-name/);

    const replacementFile = join(workspace.root, 'replacement.csv');
    writeFileSync(replacementFile, 'id\n1\n', { mode: 0o600 });
    const replace = runCli([
      'upload', replacementFile, 'replacement', '--replace',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(replace.status, 1);
    assert.match(replace.stderr, /upload --replace requires --confirm-target/);

    const analysisRepair = runCli([
      'analysis-repair', 'analysis', 'row', 'measure', 'Row', 'Measure',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(analysisRepair.status, 1);
    assert.match(analysisRepair.stderr, /analysis-repair requires --confirm-name/);

    const dashboardRepair = runCli([
      'dashboard-repair-multi', 'dashboard', 'model', '[]',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(dashboardRepair.status, 1);
    assert.match(dashboardRepair.stderr, /dashboard-repair-multi requires --confirm-name/);

    const competitionHome = runCli([
      'competition-home',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(competitionHome.status, 1);
    assert.match(competitionHome.stderr, /requires platform profile competition-2026/);

    const deletion = runCli(['resource-delete'], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(deletion.status, 1);
    assert.match(deletion.stderr, /resource-delete requires <parentId> <resourceId>/);

    const unconfirmedDeletion = runCli([
      'resource-delete', 'parent', 'resource',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(unconfirmedDeletion.status, 1);
    assert.match(unconfirmedDeletion.stderr, /resource-delete requires --confirm-name/);

    const legacyDeletion = runCli([
      'resource-delete', 'parent', 'resource', '--confirm-name',
    ], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(legacyDeletion.status, 1);
    assert.match(legacyDeletion.stderr, /--confirm-name requires an exact resource name/);

    const dashboard = runCli(['ui-dashboard-check'], { SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(dashboard.status, 1);
    assert.match(dashboard.stderr, /ui-dashboard-check requires <resourceId>/);
    assert.doesNotMatch(`${plain.stderr}${rawMutation.stderr}${apiMutation.stderr}${encodedTraversal.stderr}${doubleEncodedTraversal.stderr}${methodOverride.stderr}${encodedAbsolute.stderr}${etl.stderr}${folder.stderr}${rename.stderr}${move.stderr}${copy.stderr}${competitionHome.stderr}${deletion.stderr}${legacyDeletion.stderr}${dashboard.stderr}${doctor.stderr}`, /password|cookie/i);
  } finally {
    workspace.cleanup();
  }
});

test('manuals exposes the official Java SDK alongside workflow guides', () => {
  const result = runCli(['manuals']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.javaApi, 'https://wiki.smartbi.com.cn/api/javaapi/index.html');
  assert.match(output.clientConnectorApi, /ClientConnector\.html$/);
  assert.match(output.catalogApi, /service\/catalog\/CatalogService\.html$/);
  assert.match(output.insightApi, /service\/insight\/ClientInsightService\.html$/);
  assert.match(output.pageApi, /page\/service\/PageService\.html$/);
});
