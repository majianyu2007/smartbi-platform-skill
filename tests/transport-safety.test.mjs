import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCompetitionGenericAccess,
  assertCredentialFileMetadata,
  assertCredentialTransport,
  assertLoginSucceeded,
  assertSessionProbeSucceeded,
  nextSmartbixResendState,
  normalizeCdpUrl,
  normalizeVisionBaseUrl,
  parseConfigJson,
  redactCdpUrl,
  readBoundedResponseText,
  safeHttpError,
  sanitizeErrorMessage,
} from '../scripts/transport-safety.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const cli = join(testDir, '..', 'scripts', 'smartbi.mjs');

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function temporaryWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'smartbi-transport-safety-'));
  return {
    root,
    config: join(root, 'config.json'),
    credentials: join(root, 'credentials.txt'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function credentialMetadata({
  file = true,
  symlink = false,
  uid = 501,
  mode = 0o100600,
} = {}) {
  return {
    isFile: () => file,
    isSymbolicLink: () => symlink,
    uid,
    mode,
  };
}

test('credential-backed login requires HTTPS', () => {
  const secure = normalizeVisionBaseUrl('https://tenant.example/smartbi/vision/?ignored=yes#fragment');
  assert.equal(secure, 'https://tenant.example/smartbi/vision');
  assert.doesNotThrow(() => assertCredentialTransport(secure));
  assert.throws(
    () => assertCredentialTransport('http://tenant.example/smartbi/vision'),
    /requires HTTPS/,
  );
  assert.throws(
    () => normalizeVisionBaseUrl('https://user:password@tenant.example/smartbi/vision'),
    /without embedded credentials/,
  );
});

test('credential metadata must prove a private current-user regular file', () => {
  assert.doesNotThrow(() => assertCredentialFileMetadata(
    credentialMetadata(),
    { effectiveUid: 501 },
  ));
  assert.throws(
    () => assertCredentialFileMetadata(credentialMetadata({ symlink: true }), { effectiveUid: 501 }),
    /must not be a symbolic link/,
  );
  assert.throws(
    () => assertCredentialFileMetadata(credentialMetadata({ file: false }), { effectiveUid: 501 }),
    /regular file/,
  );
  assert.throws(
    () => assertCredentialFileMetadata(credentialMetadata({ uid: 502 }), { effectiveUid: 501 }),
    /owned by the current user/,
  );
  assert.throws(
    () => assertCredentialFileMetadata(credentialMetadata({ mode: 0o100640 }), { effectiveUid: 501 }),
    /mode 0600/,
  );
  assert.throws(
    () => assertCredentialFileMetadata(credentialMetadata(), { effectiveUid: undefined }),
    /ownership cannot be verified/,
  );
});

test('login and session validators accept only proven postconditions without echoing responses', () => {
  assert.doesNotThrow(() => assertLoginSucceeded({ retCode: 0, result: true }));
  assert.throws(
    () => assertLoginSucceeded({
      retCode: 'INVALID_CREDENTIAL',
      result: false,
      detail: { password: 'response-secret' },
    }),
    (error) => {
      assert.equal(error.message, 'Smartbi login was rejected');
      assert.doesNotMatch(error.message, /response-secret/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertSessionProbeSucceeded({
    retCode: 0,
    result: 'synthetic-principal',
  }));
  assert.throws(
    () => assertSessionProbeSucceeded({
      retCode: 0,
      result: '',
      detail: { account: 'response-account' },
    }),
    (error) => {
      assert.equal(error.message, 'Smartbi session verification failed');
      assert.doesNotMatch(error.message, /response-account/);
      return true;
    },
  );
  assert.throws(
    () => assertSessionProbeSucceeded({
      retCode: 'SERVER_ERROR',
      result: null,
      detail: 'unlabelled-response-body',
    }),
    (error) => {
      assert.equal(error.message, 'Smartbi session verification failed');
      assert.doesNotMatch(error.message, /unlabelled-response-body/);
      return true;
    },
  );
});

test('Smartbix RESEND retries share one terminal budget across codecs', () => {
  let state = { resendCount: 0, encodeTransport: true };
  state = nextSmartbixResendState(state);
  assert.deepEqual(state, { resendCount: 1, encodeTransport: true });
  state = nextSmartbixResendState(state);
  state = nextSmartbixResendState(state);
  assert.deepEqual(state, { resendCount: 3, encodeTransport: true });
  state = nextSmartbixResendState(state);
  assert.deepEqual(state, { resendCount: 4, encodeTransport: false });
  assert.throws(
    () => nextSmartbixResendState(state),
    /retry budget exhausted/,
  );
});

test('bounded response reads reject oversized bodies before exposing content', async () => {
  assert.equal(
    await readBoundedResponseText(new Response('four'), { maxBytes: 4 }),
    'four',
  );
  await assert.rejects(
    readBoundedResponseText(new Response('five!'), { maxBytes: 4, label: 'test response' }),
    /test response exceeded the 4-byte limit/,
  );
  await assert.rejects(
    readBoundedResponseText(new Response('x', {
      headers: { 'content-length': '100' },
    }), { maxBytes: 4, label: 'declared response' }),
    /declared response exceeded the 4-byte limit/,
  );
});

test('error and CDP output redaction never emits credentials or URL tokens', () => {
  const unsafe = 'wss://operator:cdp-secret@remote.example/devtools/browser/id?token=query-secret';
  assert.equal(redactCdpUrl(unsafe), 'wss://remote.example');
  assert.throws(() => normalizeCdpUrl(unsafe, { allowRemote: true }), /embedded credentials/);
  assert.throws(
    () => normalizeCdpUrl('https://remote.example:9222/devtools', { allowRemote: false }),
    /remote CDP requires/,
  );
  assert.throws(
    () => normalizeCdpUrl('http://remote.example:9222/devtools', { allowRemote: true }),
    /remote CDP requires HTTPS or WSS/,
  );
  assert.equal(
    redactCdpUrl(normalizeCdpUrl(
      'wss://remote.example:9222/devtools/browser/id?token=query-secret',
      { allowRemote: true },
    )),
    'wss://remote.example:9222',
  );
  assert.throws(
    () => normalizeCdpUrl('http://127.0.0.1:9222/\nunsafe'),
    /invalid CDP URL/,
  );
  assert.equal(
    redactCdpUrl(normalizeCdpUrl('http://127.0.0.1:9222/devtools?token=query-secret')),
    'http://127.0.0.1:9222',
  );

  const message = sanitizeErrorMessage(
    new Error('login failed https://user:pw@example.test/fail?token=url-secret password=hunter2\nCookie: SID=cookie-secret'),
  );
  assert.doesNotMatch(
    message,
    /hunter2|cookie-secret|url-secret|user:pw|example\.test\/fail/,
  );
  assert.match(message, /\[REDACTED\]/);

  const transportError = safeHttpError('RMI', {
    status: 502,
    headers: { get: () => 'text/html; token=header-secret' },
    body: 'unlabelled-tenant-response-secret',
  }, 'response could not be decoded');
  assert.match(transportError.message, /status 502; content-type text\/html/);
  assert.doesNotMatch(
    transportError.message,
    /unlabelled-tenant-response-secret|header-secret/,
  );
});

test('malformed and structurally invalid configuration fails closed', () => {
  assert.throws(() => parseConfigJson('{"baseUrl":'), /not valid JSON/);
  assert.throws(() => parseConfigJson('[]'), /root must be a JSON object/);
  assert.throws(
    () => parseConfigJson('{"cdpUrl":{"url":"http://127.0.0.1:9222"}}'),
    /field cdpUrl must be a string/,
  );
  assert.throws(
    () => parseConfigJson('{"baseUrl":""}'),
    /field baseUrl must not be empty/,
  );
  assert.throws(
    () => parseConfigJson('{"naming":{"mode":"prefix"}}'),
    /naming.value must be a string/,
  );
  assert.throws(
    () => parseConfigJson('{"platformProfile":{}}'),
    /platformProfile.id must be a non-empty string/,
  );
  assert.deepEqual(parseConfigJson('{"naming":{"mode":"prefix","value":"TEAM_"}}'), {
    naming: { mode: 'prefix', value: 'TEAM_' },
  });
});

test('competition profile disables generic replay and denies Agent navigation', () => {
  const competition = { id: 'competition-2026' };
  assert.throws(
    () => assertCompetitionGenericAccess(competition, {
      kind: 'rmi',
      className: 'CatalogService',
      methodName: 'getCatalogElementById',
    }),
    /disables generic RMI and API replay/,
  );
  assert.throws(
    () => assertCompetitionGenericAccess(competition, {
      kind: 'smartbix',
      path: 'dataagent/graph/resource-id',
    }),
    /disables generic RMI and API replay/,
  );
  assert.throws(
    () => assertCompetitionGenericAccess(competition, {
      kind: 'plain',
      path: 'cgi/aichat-train/list-knowledge-graph-node',
    }),
    /disables generic RMI and API replay/,
  );
  assert.throws(
    () => assertCompetitionGenericAccess(competition, { kind: 'nav', moduleName: 'Agent' }),
    /prohibits Agent navigation/,
  );
  assert.doesNotThrow(() => assertCompetitionGenericAccess(competition, {
    kind: 'nav',
    moduleName: 'AIChat',
  }));
  assert.doesNotThrow(() => assertCompetitionGenericAccess({ id: 'general' }, {
    kind: 'smartbix',
    path: 'dataagent/graph/resource-id',
  }));
});

test('CLI rejects HTTP credential setup and malformed config without echoing content', () => {
  const workspace = temporaryWorkspace();
  const neutralProfile = {
    SMARTBI_ALLOW_REMOTE_CDP: '',
    SMARTBI_CDP_URL: 'http://127.0.0.1:9222',
    SMARTBI_NAMING: 'prefix',
    SMARTBI_NAMESPACE: 'TEAM_',
    SMARTBI_PLATFORM_PROFILE: '',
    SMARTBI_SCHOOL_NAME: '',
  };
  try {
    const secret = 'config-body-secret';
    writeFileSync(workspace.config, `{"baseUrl":"${secret}"`, { mode: 0o600 });
    const malformed = runCli(['config'], {
      ...neutralProfile,
      SMARTBI_CONFIG_FILE: workspace.config,
    });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /invalid Smartbi config file/);
    assert.doesNotMatch(malformed.stderr, new RegExp(secret));

    writeFileSync(workspace.credentials, 'test-account\ntest-password\n', { mode: 0o600 });
    chmodSync(workspace.credentials, 0o600);
    rmSync(workspace.config, { force: true });
    const insecure = runCli([
      'setup',
      '--base-url', 'http://tenant.example/smartbi/vision',
      '--cred-file', workspace.credentials,
      '--namespace', 'TEAM_',
      '--naming', 'prefix',
    ], { ...neutralProfile, SMARTBI_CONFIG_FILE: workspace.config });
    assert.equal(insecure.status, 1);
    assert.match(insecure.stderr, /credential-backed login requires HTTPS/);

    const linkedCredentials = join(workspace.root, 'linked-credentials.txt');
    symlinkSync(workspace.credentials, linkedCredentials);
    const linked = runCli([
      'setup',
      '--base-url', 'https://tenant.example/smartbi/vision',
      '--cred-file', linkedCredentials,
      '--namespace', 'TEAM_',
      '--naming', 'prefix',
    ], {
      ...neutralProfile,
      SMARTBI_CONFIG_FILE: join(workspace.root, 'linked-config.json'),
    });
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /credentials file must not be a symbolic link/);
    assert.doesNotMatch(linked.stderr, /test-account|test-password/);

    const login = runCli(['login'], {
      SMARTBI_CONFIG_FILE: workspace.config,
      SMARTBI_BASE_URL: 'http://tenant.example/smartbi/vision',
      SMARTBI_CRED_FILE: workspace.credentials,
      ...neutralProfile,
    });
    assert.equal(login.status, 1);
    assert.match(login.stderr, /credential-backed login requires HTTPS/);
    assert.doesNotMatch(login.stderr, /test-account|test-password/);

    const health = runCli(['health'], {
      SMARTBI_CONFIG_FILE: workspace.config,
      SMARTBI_BASE_URL: 'http://tenant.example/smartbi/vision',
      SMARTBI_CRED_FILE: workspace.credentials,
      ...neutralProfile,
    });
    assert.equal(health.status, 1);
    assert.match(health.stderr, /credential-backed login requires HTTPS/);
    assert.doesNotMatch(health.stderr, /test-account|test-password/);
  } finally {
    workspace.cleanup();
  }
});

test('CLI redacts valid CDP paths and rejects unapproved remote CDP endpoints', () => {
  const workspace = temporaryWorkspace();
  const neutralBrowserEnv = {
    SMARTBI_ALLOW_REMOTE_CDP: '',
    SMARTBI_BASE_URL: 'https://tenant.example/smartbi/vision',
    SMARTBI_NAMING: 'prefix',
    SMARTBI_NAMESPACE: 'TEAM_',
    SMARTBI_PLATFORM_PROFILE: '',
    SMARTBI_SCHOOL_NAME: '',
  };
  try {
    const redacted = runCli(['config'], {
      ...neutralBrowserEnv,
      SMARTBI_CONFIG_FILE: workspace.config,
      SMARTBI_CDP_URL: 'http://127.0.0.1:9222/devtools/browser/id?token=cdp-query-secret',
    });
    assert.equal(redacted.status, 0, redacted.stderr);
    assert.equal(JSON.parse(redacted.stdout).cdpUrl, 'http://127.0.0.1:9222');
    assert.doesNotMatch(redacted.stdout, /cdp-query-secret|devtools\/browser/);

    const remote = runCli(['config'], {
      ...neutralBrowserEnv,
      SMARTBI_CONFIG_FILE: workspace.config,
      SMARTBI_CDP_URL: 'https://remote.example:9222/devtools',
    });
    assert.equal(remote.status, 1);
    assert.match(remote.stderr, /remote CDP requires SMARTBI_ALLOW_REMOTE_CDP=1/);
  } finally {
    workspace.cleanup();
  }
});

test('competition CLI generic RMI, API, and Agent navigation fail before authentication', () => {
  const workspace = temporaryWorkspace();
  const env = {
    SMARTBI_ALLOW_REMOTE_CDP: '',
    SMARTBI_CDP_URL: 'http://127.0.0.1:9222',
    SMARTBI_NAMING: 'prefix',
    SMARTBI_NAMESPACE: 'TEAM_',
    SMARTBI_CONFIG_FILE: workspace.config,
    SMARTBI_BASE_URL: 'https://tiaozhanbei.cloud.smartbi.com.cn/smartbi/vision',
    SMARTBI_PLATFORM_PROFILE: 'competition-2026',
    SMARTBI_SCHOOL_NAME: '测试学校',
  };
  try {
    const invoke = runCli([
      'invoke', 'CatalogService', 'getCatalogElementById', '["opaque-agent-id"]',
    ], env);
    const api = runCli(['api-get', 'dataagent/graph/opaque-agent-id'], env);
    const nav = runCli(['nav', 'Agent'], env);
    for (const result of [invoke, api, nav]) {
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stderr, /password|cookie|opaque-agent-id/i);
    }
    assert.match(invoke.stderr, /disables generic RMI and API replay/);
    assert.match(api.stderr, /disables generic RMI and API replay/);
    assert.match(nav.stderr, /prohibits Agent navigation/);
  } finally {
    workspace.cleanup();
  }
});
