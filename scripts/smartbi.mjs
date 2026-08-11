#!/usr/bin/env node
// Smartbi Insight V11 AI-operable tool.
// Primary mode: direct HTTP API (reverse-engineered RMI protocol + DataPackageServlet).
// Fallback mode: Playwright over CDP for UI-only operations (dashboard editing etc).
//
// Protocol notes (reverse-engineered from frontend bundles, verified live):
//   * Business calls: POST <configured Vision root>/RMIServlet
//     body: encode=<negotiated frontend coder over class + method + JSON params>.
//     response: encoded JSON {retCode, result, detail, succeeded}; retCode===0 means success.
//   * Transport coder: live bundle discovery + SHA-256 cache + SF1/SF2/SF3 negotiation.
//   * File import chain (DataPackageServlet, form-encoded except upload):
//       UPLOAD_FILE (multipart: action + file) -> {clientId, sheetNames}
//       GET_PREVIEW_DATA&clientId&previewRows&sheetIndex -> {rowCount, datas, fieldTypeList, fieldNameList, fieldAliasList}
//       INSERT_DATA&clientId&settings=<JSON> -> import
//       poll: RMI DataPackageModule.getImportStatus(clientId)
//
// Resource naming: mutations require the configured namespace, except exact-confirmed legacy tables in the personal acquisition folder.

import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectEnvironment, loadPlaywright } from './install.mjs';
import { createTransportCodec } from './transport-codec.mjs';
import {
  assertCompetitionGenericAccess,
  assertCredentialFileMetadata,
  assertCredentialTransport,
  assertLoginSucceeded,
  assertSessionProbeSucceeded,
  nextSmartbixResendState,
  normalizeCdpUrl,
  normalizeVisionBaseUrl as normalizeBaseUrl,
  parseConfigJson,
  redactCdpUrl,
  readBoundedResponseText,
  safeHttpError as safeHttpFailure,
  sanitizeErrorMessage,
} from './transport-safety.mjs';
import {
  DELETION_PARENT_KINDS,
  authorizeResourceDeletion,
  parseResourceDeleteArgs,
} from './deletion-guard.mjs';
import {
  agentOutputResourceId,
  assertAgentNodeStatesSucceeded,
  assertAgentRunSucceeded,
  createAgentOutputReceipt,
  extractAgentFinishOutput,
  isAgentTerminalState,
  summarizeAgentNodeStates,
} from './agent-state.mjs';
import {
  agentRootIdForSelf,
  assertAgentDeploymentRelations,
  assertExactAgentNameConfirmation,
  assertOwnedAgentGraphIdentity,
  assertSameAgentGraphContract,
  assertSupportedAgentGraph,
  findDirectOwnedAgentChild,
  summarizeAgentDeploymentRelation,
  summarizeAgentResource,
  validateSupportedAgentResource,
} from './agent-graph.mjs';
import { normalizeCatalogElements } from './catalog-elements.mjs';
import {
  applyNamespaceMarker,
  assertCatalogPlacementCompatible,
  assertCopyTargetOutsideSource,
  assertContiguousOwnedFolderChain,
  assertDirectResourceSnapshot,
  createImmutableCatalogCopyManifest,
  findCatalogCollision,
  isCopyableCatalogFolder,
  isKnownCatalogFolder,
  normalizeNamingConfig,
  shouldTraverseCatalogNode,
} from './catalog-safety.mjs';
import {
  auditAnalysisPresentation,
  improveAnalysisPresentation,
} from './analysis-presentation.mjs';
import {
  analysisBindingSnapshot,
  analysisCrossTables,
  analysisModelIds,
  assertAnalysisBindings,
  assertAnalysisQueryResult,
  assertSavedAnalysisEquivalent,
  assertSimpleAnalysisRepairable,
  buildAnalysisQuery as buildVerifiedAnalysisQuery,
  patchSimpleAnalysisDefinition,
  remapAnalysisPortlets,
  resolveAnalysisResource,
} from './analysis-definition.mjs';
import {
  MODEL_AGGREGATORS,
  assertModelBaselineUnchanged,
  assertModelReferenceGraph,
  assertNoModelCloneResidue,
  assertOnlyModelCollectionsChanged,
  assertSavedModelEquivalent,
  buildExplicitMeasures,
  normalizeMeasureSpecifications,
  normalizeModelSourceReference,
  normalizeModelSourceTable,
  modelSemanticDefinition,
  qualifyModelResource,
  remapModelClone,
  synchronizeModelMeasureNode,
} from './model-semantics.mjs';
import {
  assertCompleteImportSchema,
  assertImportedSchemaMatches,
  assertReplacementSchemaCompatible,
} from './import-schema.mjs';
import {
  classifyLocalImportSource,
  importRowCountReceipt,
  planImportMutation,
  planLocalImportSource,
  resolveWorksheetSelection,
  validateImportPreview,
} from './import-contract.mjs';
import {
  DEFAULT_AICHAT_STREAM_LIMITS,
  parseAichatStream,
} from './aichat-stream.mjs';
import {
  buildAichatRequest,
  createAichatEnvelope,
  parseAichatExportArgs,
  parseAichatRunArgs,
  selectAichatLlm,
  selectAichatSkills,
  summarizeAichatEnvelope,
} from './aichat-query.mjs';
import { writePrivateAichatEnvelope } from './aichat-export.mjs';
import {
  assertAichatGraphReady,
  assertExactPersistedGraphFieldIds,
  authorizeAichatGraphMutationTarget,
  extractAichatValidationCount,
  inspectAichatGraphNode,
  inspectAichatGraphStatus,
  aichatGraphBuildCompletionEvidence,
  parseAichatGraphBuildArgs,
  planAichatGraphBuild,
  resolveUniqueGraphFields,
  verifyAichatTrainingCountProvenance,
} from './aichat-graph.mjs';
import {
  chartTypeContract,
  dashboardGrid,
  normalizeDashboardCharts,
} from './dashboard-multi.mjs';
import { auditDashboardPresentation } from './dashboard-presentation.mjs';
import { serializeDashboardResource } from './dashboard-model.mjs';
import {
  assertCompatibleDashboardDataTypes,
  assertFilterImpactsVisualization,
  assertInteractiveDashboardPersisted,
  assertJumpRulePersisted,
  locateDashboardPortletField,
  parseDashboardJumpSpec,
  parseInteractiveDashboardSpec,
  resolveDashboardPortletReference,
  validateDashboardPortletIndexes,
} from './dashboard-interactions.mjs';
import {
  assertDashboardRepairable,
  assertSavedDashboardMatchesDefinition,
} from './dashboard-verification.mjs';
import { summarizeDimensionKeys } from './dimension-profile.mjs';
import {
  assertCurrentEtlRunEvidence,
  assertEtlRunSucceeded,
  isEtlTerminalState,
  summarizeEtlPortResult,
} from './etl-state.mjs';
import { positionEtlNodeBeforeTarget } from './etl-layout.mjs';
import {
  assertDistinctEtlTableIds,
  assertExecutableEtlGraph,
  assertEtlGraphPersisted,
  assertEtlProcessDagMetadataPreserved,
  assertEtlSchemasIdentical,
  assertVerifiedEtlTemplate,
  configureEtlNode,
  createEtlLink,
  describeEtlNodeTemplate,
  extractEtlTableBindings,
  normalizeEtlGraph,
  normalizeEtlNodeCatalog,
  normalizeEtlSchema,
  parseImportedTableReference,
  prepareEtlProcessDag,
  sanitizeEtlContractValue,
  spliceUnaryBeforeTerminal,
} from './etl-contracts.mjs';
import {
  assertCompetitionCatalogDestination,
  assertCompetitionEtlGraph,
  assertCompetitionEtlOutputMutationAllowed,
  assertCompetitionEtlTableBindings,
  assertCompetitionSameCandidateParent,
  assertCompetitionTrainingCount,
  assertCompetitionUnionAllowed,
  assertCompetitionUploadSource,
  assertProfileAllowsAgent,
  isCompetitionFolder,
  normalizePlatformProfile,
} from './platform-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, '..');
const CONFIG_FILE = process.env.SMARTBI_CONFIG_FILE || join(SKILL_DIR, 'config.json');

// ---- config: credentials + naming preference ----
// Config file (config.json in skill dir, gitignored) is written by `setup`.
// Environment variables always take precedence over the config file.
function loadConfig() {
  let source;
  try {
    source = readFileSync(CONFIG_FILE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: {}, error: null };
    return { config: {}, error: new Error('unable to read Smartbi config file') };
  }
  try {
    return { config: parseConfigJson(source), error: null };
  } catch (error) {
    return {
      config: {},
      error: new Error(`invalid Smartbi config file: ${sanitizeErrorMessage(error)}`),
    };
  }
}
const { config: CONFIG, error: CONFIG_ERROR } = loadConfig();
let STARTUP_ERROR = CONFIG_ERROR;

function startupValue(factory, fallback) {
  try {
    return factory();
  } catch (error) {
    STARTUP_ERROR ||= new Error(sanitizeErrorMessage(error));
    return fallback;
  }
}

const CDP_URL = startupValue(
  () => normalizeCdpUrl(
    process.env.SMARTBI_CDP_URL || CONFIG.cdpUrl || 'http://127.0.0.1:9222',
    { allowRemote: process.env.SMARTBI_ALLOW_REMOTE_CDP === '1' },
  ),
  'http://127.0.0.1:9222/',
);
const CDP_DISPLAY_URL = redactCdpUrl(CDP_URL);
const DEFAULT_BASE_URL = 'https://smartbi.example.com/smartbi/vision';

const BASE_URL = startupValue(
  () => normalizeBaseUrl(process.env.SMARTBI_BASE_URL || CONFIG.baseUrl || DEFAULT_BASE_URL),
  DEFAULT_BASE_URL,
);
const PROFILE_ENV_OVERRIDE = process.env.SMARTBI_PLATFORM_PROFILE || process.env.SMARTBI_SCHOOL_NAME
  ? {
      id: process.env.SMARTBI_PLATFORM_PROFILE || CONFIG.platformProfile?.id,
      schoolName: process.env.SMARTBI_SCHOOL_NAME || CONFIG.platformProfile?.schoolName,
    }
  : CONFIG.platformProfile;
const PLATFORM_PROFILE = startupValue(
  () => normalizePlatformProfile(PROFILE_ENV_OVERRIDE, BASE_URL),
  null,
);
const LOGIN_URL = `${BASE_URL}/index.jsp`;
const CRED_FILE = process.env.SMARTBI_CRED_FILE
  || CONFIG.credFile
  || join(homedir(), '.config', 'smartbi-platform', 'credentials.txt');
const CODEC_CACHE_FILE = process.env.SMARTBI_CODEC_CACHE_FILE
  || CONFIG.codecCacheFile
  || join(homedir(), '.cache', 'smartbi-platform', 'transport-codec.json');

// Naming preference: prefix (default) or suffix, value configurable.
// e.g. prefix "TEAM_" -> TEAM_survey_demo ; suffix "_TEAM" -> survey_demo_TEAM
const MAX_TABLE_NAME = 30; // server truncates longer table names
const EFFECTIVE_NAMING = startupValue(
  () => normalizeNamingConfig(
    process.env.SMARTBI_NAMING || CONFIG.naming?.mode || 'prefix',
    process.env.SMARTBI_NAMESPACE || CONFIG.naming?.value || 'TEAM_',
    { maxLength: MAX_TABLE_NAME },
  ),
  { mode: 'prefix', value: 'TEAM_' },
);
const { mode: NAMING_MODE, value: NAMESPACE } = EFFECTIVE_NAMING;

function applyNamespace(base) {
  return applyNamespaceMarker(base, EFFECTIVE_NAMING);
}

function applyTableNamespace(base) {
  return applyNamespaceMarker(base, EFFECTIVE_NAMING, { maxLength: MAX_TABLE_NAME });
}

function hasNamespace(name) {
  const source = String(name || '');
  const value = String(NAMESPACE || '');
  return NAMING_MODE === 'suffix' ? source.endsWith(value) : source.startsWith(value);
}

// ---- adaptive frontend transport coder ----
// The frontend selects SF1 (ReplaceCoder), SF2 (ReplaceCoder + hex escaping),
// or SF3 (identity). Discover live coder bundles, cache by content hash, and
// retain the last verified mapping plus a fixed fallback for offline startup.
const transportCodec = createTransportCodec({
  baseUrl: BASE_URL,
  cacheFile: CODEC_CACHE_FILE,
});

const replaceEncode = (data) => transportCodec.encode(data);
const replaceDecode = (data) => transportCodec.decode(data);

function parseTransportJson(text, decoder = transportCodec) {
  const knownKeys = new Set([
    'id', 'originId', 'name', 'alias', 'fields', 'views', 'nodes', 'dataSource',
    'retCode', 'result', 'detail', 'succeeded', 'success', 'report', 'macros',
    'processDag', 'define', 'columns', 'rowMap', 'hierarchyFieldMap', 'total',
  ]);
  const parsed = [];
  const candidates = [...new Set([String(text), decoder.decode(text)])];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      const root = Array.isArray(value) ? value[0] : value;
      const score = root && typeof root === 'object'
        ? Object.keys(root).filter((key) => knownKeys.has(key)).length
        : 0;
      parsed.push({ value, score });
    } catch {}
  }
  if (parsed.length > 0) {
    parsed.sort((left, right) => right.score - left.score);
    return parsed[0].value;
  }
  throw new Error('response is not valid raw or ReplaceCoder JSON');
}

// ---- session / cookie jar ----
const jar = new Map();
const grabCookies = (res) => {
  for (const sc of res.headers.getSetCookie?.() || []) {
    const [pair] = sc.split(';');
    jar.set(pair.split('=')[0], pair);
  }
};
const cookieHeader = () => [...jar.values()].join('; ');

const rawRmiPayload = (className, methodName, paramsArray) => {
  const paramsStr = JSON.stringify(paramsArray);
  return encodeURIComponent(className)
    + '+'
    + encodeURIComponent(methodName)
    + '+'
    + encodeURIComponent(paramsStr);
};

const encodeRmi = (className, methodName, paramsArray) => (
  `encode=${replaceEncode(rawRmiPayload(className, methodName, paramsArray))}`
);

let codecNegotiationPromise = null;

async function ensureTransportCodec({ refresh = false } = {}) {
  if (refresh) {
    await transportCodec.refresh();
    codecNegotiationPromise = null;
  }
  if (!codecNegotiationPromise) {
    codecNegotiationPromise = transportCodec.negotiate(async (adapter) => {
      const response = await fetch(`${BASE_URL}/RMIServlet`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'If-Modified-Since': '0',
          Cookie: cookieHeader(),
        },
        body: `encode=${adapter.encode(rawRmiPayload(
          'AIextRemoteService',
          'getCurrentUserName',
          [],
        ))}`,
        signal: AbortSignal.timeout(15000),
      });
      grabCookies(response);
      const text = await response.text();
      let parsed;
      try {
        parsed = parseTransportJson(text, adapter);
      } catch {
        return false;
      }
      return parsed?.retCode === 0 || parsed?.retCode === 'CLIENT_USER_NOT_LOGIN';
    }).catch((error) => {
      codecNegotiationPromise = null;
      throw error;
    });
  }
  return codecNegotiationPromise;
}

async function rmi(
  className,
  methodName,
  params = [],
  timeoutMs = 60000,
  { allowUnauthenticated = false } = {},
) {
  await ensureTransportCodec();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${BASE_URL}/RMIServlet`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'If-Modified-Since': '0',
        Cookie: cookieHeader(),
      },
      body: encodeRmi(className, methodName, params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    grabCookies(response);
    const text = await response.text();
    let decoded;
    try {
      decoded = parseTransportJson(text);
    } catch {
      if (!response.ok) {
        throw safeHttpFailure('RMI', response, 'response could not be decoded');
      }
      if (attempt === 0) {
        await ensureTransportCodec({ refresh: true });
        continue;
      }
      throw safeHttpFailure('RMI', response, 'response could not be decoded');
    }
    if (!response.ok) throw safeHttpFailure('RMI', response);
    const result = { status: response.status, ...decoded };
    if (result.retCode === 'CLIENT_USER_NOT_LOGIN' && !allowUnauthenticated) {
      throw new Error('Smartbi authentication is required');
    }
    return result;
  }
  throw new Error('unreachable RMI transport state');
}

const SMARTBIX_API = `${BASE_URL.replace(/\/vision\/?$/, '')}/smartbix/api`;

function isAuthenticationFailure(status, responseUrl, text, parsed = null) {
  if ([401, 403].includes(status)) return true;
  if (String(responseUrl || '').includes('/login.jsp')) return true;
  if (parsed?.code === 'REDIRECT_TO_SMARTBI') return true;
  const sample = String(text || '').slice(0, 1000);
  return sample.includes('REDIRECT_TO_SMARTBI')
    || (sample.includes('/smartbi/vision/login.jsp') && sample.includes('<html'));
}

async function smartbixApi(
  path,
  {
    method = 'GET',
    body,
    timeoutMs = 60000,
  } = {},
) {
  if (jar.size === 0) await ensureSession();
  const normalizedMethod = String(method).toUpperCase();
  const rawBody = body === undefined
    ? undefined
    : (typeof body === 'string' ? body : JSON.stringify(body));
  const expectedTextResponse = (
    normalizedMethod === 'GET'
    && /^miningnode\/portresult\/[^/]+\/[^/]+\/csv(?:\?.*)?$/i.test(String(path))
  );
  const deadline = Date.now() + timeoutMs;
  let retryAuth = true;
  let retryCodec = normalizedMethod === 'GET';
  let resendState = { resendCount: 0, encodeTransport: true };

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('Smartbix request deadline exceeded');
    const headers = {
      Accept: 'application/json, text/plain, */*; charset=utf-8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'If-Modified-Since': '0',
      ...(resendState.encodeTransport ? { 'SMX-Encode': 'encode' } : {}),
      Cookie: cookieHeader(),
    };
    if (rawBody !== undefined) headers['Content-Type'] = 'application/json;charset=UTF-8';
    const response = await fetch(`${SMARTBIX_API}/${String(path).replace(/^\/+/, '')}`, {
      method: normalizedMethod,
      redirect: 'manual',
      headers,
      body: rawBody === undefined
        ? undefined
        : (resendState.encodeTransport ? replaceEncode(rawBody) : rawBody),
      signal: AbortSignal.timeout(Math.max(1, remainingMs)),
    });
    grabCookies(response);
    const text = await response.text();
    let parsed;
    try {
      parsed = parseTransportJson(text);
    } catch {
      if (isAuthenticationFailure(response.status, response.url, text)) {
        if (!retryAuth) throw new Error('Smartbix authentication failed after retry');
        retryAuth = false;
        jar.clear();
        await ensureSession();
        continue;
      }
      if (response.ok && expectedTextResponse) return text;
      if (response.ok && retryCodec) {
        retryCodec = false;
        await ensureTransportCodec({ refresh: true });
        continue;
      }
      throw safeHttpFailure('Smartbix API', response, 'response could not be decoded');
    }

    if (isAuthenticationFailure(response.status, response.url, text, parsed)) {
      if (!retryAuth) throw new Error('Smartbix authentication failed after retry');
      retryAuth = false;
      jar.clear();
      await ensureSession();
      continue;
    }
    if (parsed?.code === 'RESEND_REQUEST') {
      resendState = nextSmartbixResendState(resendState);
      const delayMs = 200 * resendState.resendCount;
      const remainingAfterResponse = deadline - Date.now();
      if (remainingAfterResponse <= delayMs) {
        throw new Error('Smartbix request deadline exceeded during RESEND retry');
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    if (!response.ok) throw safeHttpFailure('Smartbix API', response);
    return parsed;
  }
}

const SMARTBI_ROOT = BASE_URL.replace(/\/vision\/?$/, '');

async function plainJsonRequest(path, {
  method = 'POST',
  body,
  accept = 'application/json, text/plain, */*',
  timeoutMs = 120000,
  maxResponseBytes = 8 * 1024 * 1024,
  retryAuth = true,
} = {}) {
  if (!path || /^https?:/i.test(path) || String(path).includes('..')) {
    throw new Error('plain API request requires a relative Smartbi path');
  }
  if (jar.size === 0) await ensureSession();
  const headers = {
    Accept: accept,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'X-Requested-With': 'XMLHttpRequest',
    Cookie: cookieHeader(),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${SMARTBI_ROOT}/${String(path).replace(/^\/+/, '')}`, {
    method,
    redirect: 'manual',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  grabCookies(response);
  const text = await readBoundedResponseText(response, {
    maxBytes: maxResponseBytes,
    label: 'Smartbi API response',
  });
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  if (isAuthenticationFailure(response.status, response.url, text, parsed)) {
    if (!retryAuth) throw new Error('Smartbi API authentication failed after retry');
    jar.clear();
    await ensureSession();
    return plainJsonRequest(path, {
      method, body, accept, timeoutMs, maxResponseBytes, retryAuth: false,
    });
  }
  if (!response.ok) {
    throw safeHttpFailure('Smartbi API', response);
  }
  return parsed ?? text;
}

function resourceId() {
  return randomBytes(16).toString('hex');
}

function shortId(bytes = 9) {
  return randomBytes(bytes).toString('base64url');
}

// ---- commands ----
function effectiveUserId() {
  return typeof process.geteuid === 'function' ? process.geteuid() : undefined;
}

function readPrivateCredentialFile(path) {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    throw new Error('credentials file is unavailable');
  }
  const effectiveUid = effectiveUserId();
  assertCredentialFileMetadata(before, { effectiveUid });
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error('credentials file symlink protection is unavailable');
  }

  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_CLOEXEC || 0),
    );
  } catch {
    throw new Error('credentials file could not be opened safely');
  }
  try {
    const opened = fstatSync(descriptor);
    assertCredentialFileMetadata(opened, { effectiveUid });
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error('credentials file changed during validation');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function parseCredentials(source) {
  const [user, pass] = String(source).split(/\r?\n/);
  if (!user || !pass) throw new Error('credentials file is incomplete');
  return { user, pass };
}

function loadCredentials() {
  assertCredentialTransport(BASE_URL);
  return parseCredentials(readPrivateCredentialFile(CRED_FILE));
}

async function seedSessionCookies() {
  const response = await fetch(LOGIN_URL, {
    headers: { Cookie: cookieHeader() },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  grabCookies(response);
  await response.body?.cancel();
  if (!response.ok) throw safeHttpFailure('Smartbi session seed', response);
}

async function loginWithCredentials() {
  const { user, pass } = loadCredentials();
  const login = await rmi('UserService', 'login', [user, pass]);
  assertLoginSucceeded(login);
  const probe = await rmi('AIextRemoteService', 'getCurrentUserName', [], 15000);
  return assertSessionProbeSucceeded(probe);
}

async function ensureSession() {
  assertCredentialTransport(BASE_URL);
  if (jar.size === 0) await seedSessionCookies();
  const probe = await rmi(
    'AIextRemoteService',
    'getCurrentUserName',
    [],
    15000,
    { allowUnauthenticated: true },
  );
  if (probe?.retCode === 0) return assertSessionProbeSucceeded(probe);
  if (probe?.retCode !== 'CLIENT_USER_NOT_LOGIN') {
    throw new Error('Smartbi session probe failed');
  }
  return loginWithCredentials();
}

async function cmdLogin() {
  assertCredentialTransport(BASE_URL);
  if (jar.size === 0) await seedSessionCookies();
  await loginWithCredentials();
  safeOutput({ state: 'authenticated', retCode: 0, verified: true });
}

async function cmdHealth() {
  await ensureSession();
  safeOutput({ state: 'workspace', retCode: 0, verified: true });
}

function assertReadOnlyRmi(className, methodName) {
  assertCompetitionGenericAccess(PLATFORM_PROFILE, {
    kind: 'rmi',
    className,
    methodName,
  });
  const key = `${className}.${methodName}`;
  const denied = new Set([
    'AIextRemoteService.getCookie',
    'AIextRemoteService.getCurrentUserName',
    'UserService.login',
    'UserService.logout',
  ]);
  if (
    denied.has(key)
    || !/^(get|list|search|query|find|is|has|supports|check|validate|count|load|preview|lookup|resolve|detect|inspect|read)/i.test(methodName)
  ) {
    throw new Error(`invoke only permits read-only discovery methods: ${key}`);
  }
}

function assertSafeGenericPath(path, { post = false, base = 'smartbix' } = {}) {
  const raw = String(path || '').trim();
  if (
    !raw
    || /^[a-z][a-z\d+.-]*:/i.test(raw)
    || raw.startsWith('//')
    || /[\\#\u0000-\u001f\u007f]/.test(raw)
  ) {
    throw new Error('generic API replay requires a plain relative path');
  }
  let decoded = raw;
  try {
    for (let depth = 0; depth < 5; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
      if (depth === 4 && decodeURIComponent(decoded) !== decoded) {
        throw new Error('excessive percent encoding');
      }
    }
  } catch {
    throw new Error('API path contains invalid or excessive percent encoding');
  }
  if (
    /^[a-z][a-z\d+.-]*:/i.test(decoded)
    || decoded.startsWith('//')
    || /[\\#\u0000-\u001f\u007f]/.test(decoded)
    || /(^|\/)\.{1,2}(?:[;/]|$)/.test(decoded)
    || decoded.split('?')[0].split('/').some((segment) => segment.includes(';'))
  ) {
    throw new Error(`generic API replay refuses a non-canonical path: ${path}`);
  }
  const parsed = new URL(decoded, 'https://smartbi.invalid/');
  if (
    parsed.origin !== 'https://smartbi.invalid'
    || parsed.username
    || parsed.password
    || [...parsed.searchParams.keys()].some((key) => (
      /^(?:_?method|httpmethod|x-http-method-override)$/i.test(key)
    ))
  ) {
    throw new Error(`generic API replay refuses routing or method overrides: ${path}`);
  }
  const canonical = `${parsed.pathname.replace(/^\/+/, '')}${parsed.search}`;
  assertCompetitionGenericAccess(PLATFORM_PROFILE, { kind: base, path: canonical });
  const normalized = canonical.toLowerCase();
  const explicitlySafePost = post && (
    base === 'smartbix'
      ? (
        normalized === 'datasets/table'
        || /^adhocanalysis\/data\/[^/?]+(?:\?.*)?$/.test(normalized)
      )
      : /^cgi\/aichat-train\/validate_field_data_count\/[^/?]+(?:\?.*)?$/.test(normalized)
  );
  if (
    !explicitlySafePost
    && /(^|\/)(create|delete|remove|update|save|insert|deploy|publish|offline|train|build|run|stop|force|clear|copy|move|upload|import|login|logout|put|patch|write|set|edit|modify)([/_.?=-]|$)/i.test(normalized)
  ) {
    throw new Error(`generic API replay refuses a mutating path: ${path}`);
  }
  if (post && !explicitlySafePost) {
    throw new Error(`generic POST only permits explicitly allowlisted read-only endpoints: ${path}`);
  }
  return canonical;
}

async function cmdInvoke(className, methodName, paramsJson) {
  if (!className || !methodName) throw new Error('invoke requires <class> <method> [json]');
  assertReadOnlyRmi(className, methodName);
  const params = paramsJson ? JSON.parse(paramsJson) : [];
  await ensureSession();
  const ret = await rmi(className, methodName, params);
  if (ret.retCode !== 0) throw new Error('generic RMI invocation failed');
  safeOutput(ret);
}

async function cmdApiGet(path) {
  const canonical = assertSafeGenericPath(path);
  await ensureSession();
  safeOutput(await smartbixApi(canonical));
}

async function cmdApiPost(path, bodyJson = '{}') {
  const canonical = assertSafeGenericPath(path, { post: true, base: 'smartbix' });
  await ensureSession();
  safeOutput(await smartbixApi(canonical, { method: 'POST', body: JSON.parse(bodyJson) }));
}

async function cmdPlainGet(path) {
  const canonical = assertSafeGenericPath(path, { base: 'plain' });
  await ensureSession();
  safeOutput(await plainJsonRequest(canonical, { method: 'GET' }));
}

async function cmdPlainPost(path, bodyJson = '{}') {
  const canonical = assertSafeGenericPath(path, { post: true, base: 'plain' });
  await ensureSession();
  safeOutput(await plainJsonRequest(canonical, { body: JSON.parse(bodyJson) }));
}

function replaceExactStrings(value, replacements) {
  if (typeof value === 'string') {
    let replaced = value;
    for (const [source, target] of replacements) replaced = replaced.split(source).join(target);
    return replaced;
  }
  if (Array.isArray(value)) return value.map((item) => replaceExactStrings(item, replacements));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, replaceExactStrings(item, replacements)]),
  );
}

function createdResourceId(result, fallback) {
  if (typeof result === 'string' && result) return result;
  if (Array.isArray(result)) {
    const candidate = result.find((item) => typeof item === 'string' && item);
    if (candidate) return candidate;
  }
  return result?.id || result?.result?.id || fallback;
}

function makeTreeNode({
  id,
  name,
  aliasFromDb,
  descFromDb = null,
  type,
  group,
  level,
  order,
  parentId,
  valueType = null,
  dataFormat = '',
  viewId = null,
  alias,
  desc = null,
  aggregator = null,
  refDataSetFieldId = null,
}) {
  return {
    id,
    name,
    aliasFromDb,
    descFromDb,
    useFromDb: false,
    type,
    group,
    level,
    order,
    visible: 1,
    parentId,
    valueType,
    dataFormat,
    extended: null,
    refDataSetFieldId,
    referenceFieldId: null,
    originalDataType: null,
    aggregator,
    businessCaliber: null,
    children: [],
    reportVisible: true,
    desc,
    alias,
    creatorId: null,
    ...(viewId ? { viewId } : {}),
  };
}

function buildSingleTableModel(
  table,
  requestedName,
  description = '',
  measureSpecifications,
) {
  if (!table?.fields?.length || !table?.dataSource?.id || !table?.originId) {
    throw new Error(
      `table metadata is incomplete; keys=${Object.keys(table || {}).join(',')} `
      + `dataSourceKeys=${Object.keys(table?.dataSource || {}).join(',')} `
      + `originId=${Boolean(table?.originId)} fields=${table?.fields?.length || 0}`,
    );
  }
  const id = resourceId();
  const viewId = resourceId();
  const name = applyNamespace(requestedName);
  const viewFields = table.fields.map((field) => ({
    id: field.id,
    name: field.name,
    aliasFromDb: field.alias || field.name,
    descFromDb: field.desc || field.name,
    useFromDb: false,
    valueType: field.dataType,
    dataFormat: field.dataFormat || '',
    sqlColumnName: null,
    maskingRule: field.maskingRule,
    viewId: null,
    viewAlias: null,
    resType: null,
    desc: field.desc || field.name,
    alias: field.alias || field.name,
    creatorId: null,
  }));
  const modelFields = table.fields.map((field, order) => ({
    ...viewFields[order],
    id: qualifyModelResource(id, 'FIELD', field.id),
    sqlColumnName: field.name,
    maskingRule: field.maskingRule || '',
    viewId,
    visible: 1,
    referenceFieldId: field.id,
    extended: null,
    transformRule: field.transformRule || '',
    needExtract: true,
    type: 'FIELD',
    order,
    parentId: viewId,
    group: 'DIMENSION',
    children: [],
  }));
  const dimensionNodes = table.fields.map((field, order) => makeTreeNode({
    id: modelFields[order].id,
    name: field.name,
    aliasFromDb: field.alias || field.name,
    descFromDb: field.desc || field.name,
    type: 'FIELD',
    group: 'DIMENSION',
    level: 2,
    order,
    parentId: viewId,
    valueType: field.dataType,
    viewId,
    alias: field.alias || field.name,
    desc: field.desc || field.name,
  }));
  const measures = buildExplicitMeasures({
    modelId: id,
    viewId,
    sourceFields: table.fields,
    modelFields,
    specifications: measureSpecifications,
    idFactory: resourceId,
  });
  const view = {
    id: viewId,
    alias: table.alias || table.name,
    name: table.name,
    desc: table.desc || '',
    parameters: [],
    fields: viewFields,
    extractSetting: {
      type: 'FULL',
      clearBeforeExtract: true,
      failHandler: { failModel: 'STOP' },
      incremental: {
        currentDay: false,
        type: null,
        rows: null,
        parameters: null,
        settings: { reExtract: null, reExtractTimeUnit: null },
      },
      orderSettings: null,
      clusterSetting: { type: '', field: '', extended: null },
      bucketSetting: { count: 1, field: '' },
      parameters: [],
      scheduleInfo: null,
    },
    storeType: 'DIRECT',
    showHiddenAttr: false,
    showAlias: true,
    limit: 100,
    dataSource: table.dataSource.id,
    catalog: '',
    schema: '',
    tableName: '',
    define: {
      dbtype: table.dataType || table.dataSource?.type?.name,
      dataSource: table.dataSource.id,
      catalog: table.catalog,
      schema: table.schema,
      tableId: table.originId,
      tableName: table.name,
      _dataSource: { ...table, fields: null },
    },
    enable: true,
    type: 'BASIC_TABLE',
    reload: true,
  };
  const dimensionRoot = makeTreeNode({
    id: 'dimension',
    name: 'dimension',
    aliasFromDb: '维度',
    type: 'DIMENSION_FOLDER',
    group: 'DIMENSION',
    level: 0,
    order: 0,
    parentId: null,
    alias: '维度',
  });
  const viewFolder = makeTreeNode({
    id: viewId,
    name: table.name,
    aliasFromDb: table.alias || table.name,
    descFromDb: table.desc || '',
    type: 'FOLDER',
    group: 'DIMENSION',
    level: 1,
    order: 0,
    parentId: 'dimension',
    alias: table.alias || table.name,
    desc: table.desc || '',
  });
  const measureRoot = makeTreeNode({
    id: 'measure',
    name: 'measure',
    aliasFromDb: '度量',
    type: 'MEASURE_FOLDER',
    group: 'MEASURE',
    level: 0,
    order: 1,
    parentId: null,
    alias: '度量',
  });
  return {
    id,
    alias: name,
    name,
    desc: description,
    storeType: 'DIRECT',
    views: [view],
    relationGraph: {
      relations: [],
      positions: [{ viewId, x: 36, y: 36, width: 160, height: 42 }],
      layouts: [],
      activeLayout: '0',
    },
    deletedViews: [],
    fields: modelFields,
    levels: [],
    measures,
    calcMembers: [],
    calcMeasures: [],
    namedSets: [],
    nodes: [dimensionRoot, viewFolder, ...dimensionNodes, measureRoot, ...measures],
    parameters: [],
    aggregatorTypes: [...MODEL_AGGREGATORS],
    preAggregates: [],
    directPartitions: [],
    extractStatus: 'INIT',
    cacheSetting: null,
    fieldTreeSetting: null,
    augmentedDataSetSetting: null,
    smartCubeSetting: null,
    duckDbSetting: null,
    _extendProps: { options: {}, batchId: resourceId() },
    relationSetting: null,
    mppTypeName: 'CLICK_HOUSE',
  };
}

const MODEL_RELATION_LINK_TYPES = new Set(['LEFTJOIN', 'RIGHTJOIN', 'INNERJOIN', 'FULLJOIN']);
const MODEL_RELATION_CARDINALITIES = new Set(['MANY2ONE', 'ONE2MANY', 'ONE2ONE', 'MANY2MANY']);
const MODEL_RELATION_FILTER_DIRECTIONS = new Set(['SINGLE', 'BOTH']);

function buildRelationalModel(
  tables,
  relations,
  requestedName,
  description = '',
  measureSpecificationsByTable,
) {
  if (!Array.isArray(tables) || tables.length < 2) {
    throw new Error('relational model requires at least two source tables');
  }
  if (!Array.isArray(relations) || relations.length === 0) {
    throw new Error('relational model requires at least one confirmed relation');
  }
  if (
    !Array.isArray(measureSpecificationsByTable)
    || measureSpecificationsByTable.length !== tables.length
  ) {
    throw new Error('relational model requires one explicit measures array per source table');
  }

  const rawParts = tables.map((table, index) => buildSingleTableModel(
    table,
    requestedName,
    description,
    measureSpecificationsByTable[index],
  ));
  const model = rawParts[0];
  const parts = rawParts.map((part) => {
    if (part.id === model.id) return part;
    const remapped = replaceExactStrings(part, new Map([[part.id, model.id]]));
    remapped.id = model.id;
    return remapped;
  });
  const views = [];
  const fields = [];
  const measures = [];
  const nodes = [
    model.nodes.find((node) => node.id === 'dimension'),
    model.nodes.find((node) => node.id === 'measure'),
  ].filter(Boolean);
  const positions = [];
  const usedFieldNames = new Set();
  const usedMeasureNames = new Set();
  const usedMeasureAliases = new Set();
  const uniqueResourceName = (used, name, viewName) => {
    let candidate = name;
    if (used.has(candidate)) candidate = `${viewName}_${name}`;
    for (let suffix = 2; used.has(candidate); suffix += 1) {
      candidate = `${viewName}_${name}_${suffix}`;
    }
    used.add(candidate);
    return candidate;
  };
  let measureOrder = 0;

  for (const [index, part] of parts.entries()) {
    const view = part.views[0];
    views.push(view);
    for (const field of part.fields) {
      field.name = uniqueResourceName(usedFieldNames, field.name, view.name);
      const node = part.nodes.find((item) => item.id === field.id);
      if (node) node.name = field.name;
      fields.push(field);
    }
    for (const measure of part.measures) {
      measure.name = uniqueResourceName(usedMeasureNames, measure.name, view.name);
      measure.alias = uniqueResourceName(
        usedMeasureAliases,
        measure.alias || measure.name,
        view.alias || view.name,
      );
      measure.aliasFromDb = measure.alias;
      measure.order = measureOrder;
      measureOrder += 1;
      const node = part.nodes.find((item) => item.id === measure.id);
      if (node) synchronizeModelMeasureNode(measure, node);
      measures.push(measure);
    }
    for (const node of part.nodes) {
      if (node.id === 'dimension' || node.id === 'measure') continue;
      if (node.id === view.id) node.order = index;
      nodes.push(node);
    }
    positions.push({
      viewId: view.id,
      x: 36 + (index % 3) * 220,
      y: 36 + Math.floor(index / 3) * 100,
      width: 160,
      height: 42,
    });
  }

  const resolveField = (tableIndex, fieldName, relationIndex, side) => {
    if (!Number.isInteger(tableIndex) || tableIndex < 0 || tableIndex >= parts.length) {
      throw new Error(`relation ${relationIndex + 1} ${side} table index is invalid: ${tableIndex}`);
    }
    const requested = String(fieldName || '').trim();
    const matches = parts[tableIndex].fields.filter(
      (item) => [item.id, item.sqlColumnName, item.name, item.alias].includes(requested),
    );
    if (matches.length !== 1) {
      throw new Error(
        `relation ${relationIndex + 1} ${side} field must resolve exactly once `
        + `in table ${tableIndex}: ${requested}`,
      );
    }
    return {
      viewId: parts[tableIndex].views[0].id,
      fieldId: matches[0].id,
      field: matches[0],
    };
  };

  const connectedIndexes = new Map(tables.map((_, index) => [index, new Set()]));
  const relationKeys = new Set();
  const relationGraph = relations.map((relation, index) => {
    if (relation?.confirmed !== true || !String(relation?.grain || '').trim()) {
      throw new Error(`relation ${index + 1} requires confirmed=true and a non-empty grain`);
    }
    const fromIndex = Number(relation.from);
    const toIndex = Number(relation.to);
    if (fromIndex === toIndex) {
      throw new Error(`relation ${index + 1} cannot join a table to itself`);
    }
    const from = resolveField(fromIndex, relation.fromField, index, 'from');
    const to = resolveField(toIndex, relation.toField, index, 'to');
    if (String(from.field.valueType).toUpperCase() !== String(to.field.valueType).toUpperCase()) {
      throw new Error(`relation ${index + 1} joins fields with different data types`);
    }
    const requiredSemantics = [
      'linkType',
      'cardinalityType',
      'filterDirection',
      'assumeReferentialIntegrity',
    ];
    for (const property of requiredSemantics) {
      if (!String(relation[property] || '').trim()) {
        throw new Error(`relation ${index + 1} requires explicit ${property}`);
      }
    }
    const linkType = String(relation.linkType).toUpperCase();
    const cardinalityType = String(relation.cardinalityType).toUpperCase();
    const filterDirection = String(relation.filterDirection).toUpperCase();
    const assumeReferentialIntegrity = String(relation.assumeReferentialIntegrity).trim();
    if (!MODEL_RELATION_LINK_TYPES.has(linkType)) {
      throw new Error(`relation ${index + 1} has unsupported linkType: ${linkType}`);
    }
    if (!MODEL_RELATION_CARDINALITIES.has(cardinalityType)) {
      throw new Error(`relation ${index + 1} has unsupported cardinalityType: ${cardinalityType}`);
    }
    if (!MODEL_RELATION_FILTER_DIRECTIONS.has(filterDirection)) {
      throw new Error(`relation ${index + 1} has unsupported filterDirection: ${filterDirection}`);
    }
    const relationKey = [from.viewId, from.fieldId, to.viewId, to.fieldId].join('|');
    const reverseKey = [to.viewId, to.fieldId, from.viewId, from.fieldId].join('|');
    if (relationKeys.has(relationKey) || relationKeys.has(reverseKey)) {
      throw new Error(`relation ${index + 1} duplicates an existing relation`);
    }
    relationKeys.add(relationKey);
    connectedIndexes.get(fromIndex).add(toIndex);
    connectedIndexes.get(toIndex).add(fromIndex);
    return {
      srcViewId: from.viewId,
      destViewId: to.viewId,
      fieldRelations: [{
        srcFieldId: from.fieldId,
        destFieldId: to.fieldId,
        operator: 'EQUALS',
      }],
      linkType,
      cardinalityType,
      srcViewBO: null,
      destViewBO: null,
      assumeReferentialIntegrity,
      filterDirection,
    };
  });
  const visited = new Set([0]);
  const pending = [0];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const next of connectedIndexes.get(current)) {
      if (visited.has(next)) continue;
      visited.add(next);
      pending.push(next);
    }
  }
  if (visited.size !== tables.length) {
    throw new Error('relational model relation graph must connect every source table');
  }

  model.name = model.alias = applyNamespace(requestedName);
  model.desc = description;
  model.views = views;
  model.fields = fields;
  model.measures = measures;
  model.nodes = nodes;
  model.relationGraph = {
    relations: relationGraph,
    positions,
    layouts: [],
    activeLayout: '0',
  };
  model._extendProps = { ...(model._extendProps || {}), batchId: resourceId() };
  return model;
}

async function loadModel(modelId) {
  if (!modelId) throw new Error('model id is required');
  await ensureSession();
  const model = await smartbixApi(`augmentedDataSet/${encodeURIComponent(modelId)}`);
  if (!model?.id || !model?.name) throw new Error(`model not found or incomplete: ${modelId}`);
  if (model.id !== modelId) {
    throw new Error(`model identity mismatch while reopening requested resource: ${modelId}`);
  }
  assertModelReferenceGraph(model);
  return model;
}

function requireNamespacedResource(resource, kind) {
  const name = resource?.alias || resource?.name;
  if (!resource || !hasNamespace(name)) {
    throw new Error(`refusing to use non-namespaced ${kind}: ${name || 'unknown'}`);
  }
  return resource;
}
function assertExactCurrentNameConfirmation(resource, confirmation, label) {
  if (confirmation !== resource?.name) {
    throw new Error(`${label} confirmation mismatch: expected current name ${resource?.name || 'unknown'}`);
  }
}
async function assertSavedResourceDirectChild(parentId, resourceId, expectedName, label) {
  const children = await listCatalogChildren(parentId, `${label} destination`);
  const matches = children.filter((child) => child.id === resourceId);
  if (matches.length !== 1) {
    throw new Error(`${label} is not an exact direct child of its requested destination: ${resourceId}`);
  }
  const saved = matches[0];
  if (saved.name !== expectedName) {
    throw new Error(`${label} destination entry has an unexpected name: ${resourceId}`);
  }
  requireNamespacedResource(saved, label);
  return saved;
}

async function cmdModelGet(modelId) {
  if (PLATFORM_PROFILE) await locateCompetitionResourceParent(modelId, 'model');
  const model = requireNamespacedResource(await loadModel(modelId), 'model');
  const {
    parameters,
    calcMembers,
    namedSets,
    ...definition
  } = modelSemanticDefinition(model);
  safeOutput({
    ok: true,
    model: definition,
    parameterCount: parameters.length,
    calculatedMemberCount: calcMembers.length,
    namedSetCount: namedSets.length,
  });
}

async function cmdModelCreate(
  parentId,
  dataSourceId,
  tableId,
  tableName,
  requestedName,
  description = '',
  sourceFlowId = null,
  measureSpecifications = null,
) {
  if (![parentId, dataSourceId, tableId, tableName, requestedName].every(Boolean)) {
    throw new Error(
      'model-create requires <parentId> <dataSourceId> <tableId> <tableName> <name> '
      + '[description] --measures <jsonArray> [--etl-flow <flowId>]',
    );
  }
  if (PLATFORM_PROFILE && !sourceFlowId) {
    throw new Error('competition model-create requires --etl-flow <ownedFlowId>');
  }
  if (!Array.isArray(measureSpecifications)) {
    throw new Error('model-create requires --measures <jsonArray>; use [] for no measures');
  }
  const sourceReference = normalizeModelSourceReference({
    dataSourceId,
    tableId,
    tableName,
  });
  await assertOwnedCatalogParent(parentId);
  const lineage = await assertCompetitionModelLineage({
    parentId,
    dataSourceId: sourceReference.dataSource,
    tableId: sourceReference.tableId,
    tableName: sourceReference.table,
    sourceFlowId,
  });
  await ensureSession();
  const returnedTable = await smartbixApi('datasets/table', {
    method: 'POST',
    body: {
      dataSourceId: sourceReference.dataSource,
      tableId: sourceReference.tableId,
      tableName: sourceReference.table,
    },
  });
  requireNamespacedResource(returnedTable, 'source table');
  const { table } = normalizeModelSourceTable(returnedTable, {
    dataSourceId: sourceReference.dataSource,
    tableId: sourceReference.tableId,
    tableName: sourceReference.table,
  });
  normalizeMeasureSpecifications(table.fields, measureSpecifications);
  const model = buildSingleTableModel(
    table,
    requestedName,
    description,
    measureSpecifications,
  );
  const result = await smartbixApi(`augmentedDataSet/${encodeURIComponent(parentId)}`, {
    method: 'POST',
    body: model,
  });
  const createdId = createdResourceId(result, model.id);
  if (!createdId) throw new Error('model create returned no resource id');
  const saved = await loadModel(createdId);
  assertSavedModelEquivalent(model, saved, 'created model');
  await assertSavedResourceDirectChild(parentId, saved.id, model.name, 'created model');
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    fieldCount: saved.fields.length,
    measureCount: saved.measures.length,
    viewCount: saved.views.length,
    source: sourceReference,
    lineage,
  });
}

async function cmdModelCreateArgs(argsList) {
  const positional = [];
  let sourceFlowId = null;
  let measureSpecifications = null;
  for (let index = 0; index < argsList.length; index += 1) {
    const argument = argsList[index];
    if (argument === '--etl-flow') {
      if (sourceFlowId !== null) throw new Error('--etl-flow may be provided only once');
      sourceFlowId = argsList[index + 1];
      if (!sourceFlowId || sourceFlowId.startsWith('--')) {
        throw new Error('--etl-flow requires an owned ETL flow id');
      }
      index += 1;
      continue;
    }
    if (argument === '--measures') {
      if (measureSpecifications !== null) {
        throw new Error('--measures may be provided only once');
      }
      const raw = argsList[index + 1];
      if (!raw || raw.startsWith('--')) {
        throw new Error('--measures requires a JSON array');
      }
      try {
        measureSpecifications = JSON.parse(raw);
      } catch {
        throw new Error('--measures must be valid JSON');
      }
      if (!Array.isArray(measureSpecifications)) {
        throw new Error('--measures must be a JSON array');
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) throw new Error(`unknown model-create option: ${argument}`);
    positional.push(argument);
  }
  if (positional.length < 5 || positional.length > 6) {
    throw new Error(
      'model-create requires five positional arguments plus optional description and '
      + '--measures <jsonArray>',
    );
  }
  if (PLATFORM_PROFILE && !sourceFlowId) {
    throw new Error('competition model-create requires --etl-flow <ownedFlowId>');
  }
  if (!Array.isArray(measureSpecifications)) {
    throw new Error('model-create requires --measures <jsonArray>; use [] for no measures');
  }
  await cmdModelCreate(
    positional[0],
    positional[1],
    positional[2],
    positional[3],
    positional[4],
    positional[5] || '',
    sourceFlowId,
    measureSpecifications,
  );
}

async function cmdModelCreateRelational(parentId, requestedName, specJson, description = '') {
  if (![parentId, requestedName, specJson].every(Boolean)) {
    throw new Error(
      'model-create-relational requires <parentId> <name> <specJson> [description]',
    );
  }
  if (PLATFORM_PROFILE) {
    throw new Error('competition model-create-relational is prohibited; create one single-table candidate model');
  }
  let spec;
  try {
    spec = JSON.parse(specJson);
  } catch {
    throw new Error('model-create-relational specJson must be valid JSON');
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('model-create-relational specJson must be an object');
  }
  const topLevelKeys = new Set(['tables', 'relations']);
  for (const key of Object.keys(spec)) {
    if (!topLevelKeys.has(key)) {
      throw new Error(`model-create-relational spec has unsupported property: ${key}`);
    }
  }
  if (!Array.isArray(spec.tables) || spec.tables.length < 2) {
    throw new Error('model-create-relational spec requires at least two tables');
  }
  if (!Array.isArray(spec.relations) || spec.relations.length === 0) {
    throw new Error('model-create-relational spec requires at least one relation');
  }
  const tableKeys = new Set(['dataSourceId', 'tableId', 'tableName', 'measures']);
  const relationKeys = new Set([
    'from',
    'to',
    'fromField',
    'toField',
    'confirmed',
    'grain',
    'linkType',
    'cardinalityType',
    'filterDirection',
    'assumeReferentialIntegrity',
  ]);
  for (const [index, source] of spec.tables.entries()) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(`model-create-relational table ${index + 1} must be an object`);
    }
    for (const key of Object.keys(source)) {
      if (!tableKeys.has(key)) {
        throw new Error(`model-create-relational table ${index + 1} has unsupported property: ${key}`);
      }
    }
    if (![source.dataSourceId, source.tableId, source.tableName].every(Boolean)) {
      throw new Error(`model-create-relational table ${index + 1} is incomplete`);
    }
    if (!Array.isArray(source.measures)) {
      throw new Error(
        `model-create-relational table ${index + 1} requires an explicit measures array`,
      );
    }
    normalizeModelSourceReference(source);
  }
  for (const [index, relation] of spec.relations.entries()) {
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
      throw new Error(`model-create-relational relation ${index + 1} must be an object`);
    }
    for (const key of Object.keys(relation)) {
      if (!relationKeys.has(key)) {
        throw new Error(`model-create-relational relation ${index + 1} has unsupported property: ${key}`);
      }
    }
  }
  await assertOwnedCatalogParent(parentId);
  await ensureSession();

  const tables = [];
  for (const [index, source] of spec.tables.entries()) {
    const reference = normalizeModelSourceReference(source);
    const returnedTable = await smartbixApi('datasets/table', {
      method: 'POST',
      body: {
        dataSourceId: reference.dataSource,
        tableId: reference.tableId,
        tableName: reference.table,
      },
    });
    requireNamespacedResource(returnedTable, `source table ${index + 1}`);
    const { table } = normalizeModelSourceTable(returnedTable, {
      dataSourceId: reference.dataSource,
      tableId: reference.tableId,
      tableName: reference.table,
    });
    normalizeMeasureSpecifications(table.fields, source.measures);
    tables.push(table);
  }

  const model = buildRelationalModel(
    tables,
    spec.relations,
    requestedName,
    description,
    spec.tables.map((source) => source.measures),
  );
  const result = await smartbixApi(`augmentedDataSet/${encodeURIComponent(parentId)}`, {
    method: 'POST',
    body: model,
  });
  const createdId = createdResourceId(result, model.id);
  if (!createdId) throw new Error('relational model create returned no resource id');
  const saved = await loadModel(createdId);
  assertSavedModelEquivalent(model, saved, 'created relational model');
  await assertSavedResourceDirectChild(parentId, saved.id, model.name, 'created relational model');
  const savedRelations = saved.relationGraph.relations;
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    fieldCount: saved.fields.length,
    measureCount: saved.measures.length,
    viewCount: saved.views.length,
    relationCount: savedRelations.length,
    relations: savedRelations.map((relation) => ({
      srcViewId: relation.srcViewId,
      destViewId: relation.destViewId,
      fieldRelations: relation.fieldRelations,
      linkType: relation.linkType,
      cardinalityType: relation.cardinalityType,
      filterDirection: relation.filterDirection,
      assumeReferentialIntegrity: relation.assumeReferentialIntegrity,
    })),
  });
}

function parseHierarchyLevelSpecs(levelSpecJson) {
  let parsed;
  try {
    parsed = JSON.parse(levelSpecJson);
  } catch {
    throw new Error('model-hierarchy-add levelSpecJson must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error('model-hierarchy-add requires at least two ordered level fields');
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !entry.field) {
      throw new Error(`hierarchy level ${index + 1} requires an object with field and levelType`);
    }
    const allowedKeys = new Set(['field', 'alias', 'levelType']);
    for (const key of Object.keys(entry)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`hierarchy level ${index + 1} has unsupported property: ${key}`);
      }
    }
    if (!entry.levelType) throw new Error(`hierarchy level ${index + 1} requires levelType`);
    const levelType = String(entry.levelType).toUpperCase();
    if (!['LEVEL', 'LEVEL_GEO'].includes(levelType)) {
      throw new Error(`hierarchy level ${index + 1} has unsupported type: ${levelType}`);
    }
    return {
      field: String(entry.field),
      alias: entry.alias ? String(entry.alias) : null,
      levelType,
    };
  });
}

async function cmdModelHierarchyAdd(
  modelId,
  requestedName,
  levelSpecJson,
  description = '',
  confirmName = null,
) {
  if (![modelId, requestedName, levelSpecJson].every(Boolean)) {
    throw new Error(
      'model-hierarchy-add requires <modelId> <hierarchyName> <levelSpecJson> '
      + '[description] --confirm-name <exactModelName>',
    );
  }
  const specs = parseHierarchyLevelSpecs(levelSpecJson);
  const guardedParentId = PLATFORM_PROFILE
    ? await locateCompetitionResourceParent(modelId, 'model')
    : null;
  const baseline = requireNamespacedResource(await loadModel(modelId), 'model');
  assertExactCurrentNameConfirmation(baseline, confirmName, 'model');
  if (guardedParentId) {
    await assertCompetitionResourceDirectChild(guardedParentId, modelId, 'model');
  }
  const model = structuredClone(baseline);
  const hierarchyAlias = applyNamespace(requestedName);
  if ((model.nodes || []).some(
    (node) => node.type === 'HIERARCHY'
      && [node.name, node.alias, node.aliasFromDb].includes(hierarchyAlias),
  )) {
    throw new Error(`model hierarchy already exists: ${hierarchyAlias}`);
  }

  const fields = specs.map((spec, index) => resolveAnalysisResource(
    model.fields || [],
    spec.field,
    { kind: `hierarchy level ${index + 1} field` },
  ));
  if (new Set(fields.map((field) => field.id)).size !== fields.length) {
    throw new Error('model hierarchy level fields must be unique');
  }
  const viewIds = new Set(fields.map((field) => field.viewId));
  if (viewIds.size !== 1) {
    throw new Error('model hierarchy level fields must belong to one model view');
  }

  const dimensionRoot = (model.nodes || []).find(
    (node) => node.type === 'DIMENSION_FOLDER'
      || String(node.id || '').endsWith('.dimension')
      || node.id === 'dimension',
  );
  if (!dimensionRoot) throw new Error('model dimension root is missing');
  const existingNames = new Set([
    ...(model.fields || []).map((item) => item.name),
    ...(model.measures || []).map((item) => item.name),
    ...(model.levels || []).map((item) => item.name),
    ...(model.nodes || []).map((item) => item.name),
  ].filter(Boolean));
  const uniqueName = (base) => {
    let candidate = base;
    let suffix = 2;
    while (existingNames.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    existingNames.add(candidate);
    return candidate;
  };
  const hierarchyId = qualifyModelResource(
    model.id,
    'FOLDER',
    `HIERARCHY-${resourceId()}`,
  );
  const hierarchyName = uniqueName(`custom_${resourceId()}`);
  const fieldPrefix = `AUGMENTED_DATASET_FIELD.${model.id}.`;
  const levelModels = [];
  const levelNodes = [];
  for (const [index, field] of fields.entries()) {
    const spec = specs[index];
    const fieldTail = String(field.id).startsWith(fieldPrefix)
      ? String(field.id).slice(fieldPrefix.length)
      : String(field.id);
    const levelId = qualifyModelResource(
      model.id,
      'LEVEL',
      `${fieldTail}-LEVEL-${resourceId()}`,
    );
    const levelName = uniqueName(`${field.name}_level`);
    const alias = spec.alias || field.alias || field.name;
    levelModels.push({
      id: levelId,
      name: levelName,
      aliasFromDb: alias,
      descFromDb: field.desc || '',
      useFromDb: false,
      valueType: field.valueType,
      dataFormat: field.dataFormat || null,
      sqlColumnName: null,
      maskingRule: null,
      viewId: field.viewId,
      viewAlias: field.viewAlias || null,
      hierName: null,
      expression: null,
      dimName: null,
      transformRule: field.transformRule || null,
      visible: 1,
      extended: null,
      levelType: spec.levelType,
      refDataSetFieldId: qualifyModelResource(model.id, 'FIELD', field.id),
      reportVisible: true,
      resType: null,
      desc: field.desc || '',
      alias,
      creatorId: null,
    });
    levelNodes.push({
      id: levelId,
      name: levelName,
      aliasFromDb: alias,
      descFromDb: field.desc || '',
      useFromDb: false,
      type: spec.levelType,
      group: 'LEVEL',
      level: 2,
      order: index,
      visible: 1,
      parentId: hierarchyId,
      valueType: null,
      dataFormat: null,
      extended: null,
      refDataSetFieldId: null,
      referenceFieldId: null,
      originalDataType: null,
      aggregator: null,
      businessCaliber: null,
      children: [],
      reportVisible: true,
      desc: field.desc || '',
      alias,
      creatorId: null,
    });
  }
  const rootChildren = Array.isArray(dimensionRoot.children) ? dimensionRoot.children : [];
  const hierarchyOrder = rootChildren.reduce(
    (maximum, child) => Math.max(maximum, Number(child.order) || 0),
    -1,
  ) + 1;
  const hierarchyNode = {
    id: hierarchyId,
    name: hierarchyName,
    aliasFromDb: hierarchyAlias,
    descFromDb: description,
    useFromDb: false,
    type: 'HIERARCHY',
    group: null,
    level: 0,
    order: hierarchyOrder,
    visible: 1,
    parentId: dimensionRoot.id,
    valueType: null,
    dataFormat: null,
    extended: '{"timeHierarchy":false}',
    refDataSetFieldId: null,
    referenceFieldId: null,
    originalDataType: null,
    aggregator: null,
    businessCaliber: null,
    children: levelNodes,
    reportVisible: true,
    desc: description,
    alias: hierarchyAlias,
    creatorId: null,
  };
  dimensionRoot.children = [...rootChildren, hierarchyNode];
  model.levels = [...(model.levels || []), ...levelModels];
  model.nodes = [...(model.nodes || []), hierarchyNode, ...levelNodes];
  assertOnlyModelCollectionsChanged(baseline, model, ['levels', 'nodes']);
  const current = requireNamespacedResource(await loadModel(model.id), 'model');
  assertExactCurrentNameConfirmation(current, confirmName, 'model');
  assertModelBaselineUnchanged(baseline, current);
  if (guardedParentId) {
    const currentParentId = await locateCompetitionResourceParent(model.id, 'model');
    if (currentParentId !== guardedParentId) {
      throw new Error('model placement changed after it was loaded; refusing full-model overwrite');
    }
    await assertCompetitionResourceDirectChild(currentParentId, model.id, 'model');
  }

  await smartbixApi('augmentedDataSet', {
    method: 'PUT',
    body: model,
    timeoutMs: 120000,
  });
  const saved = await loadModel(model.id);
  assertSavedModelEquivalent(model, saved, 'hierarchy-mutated model');
  const savedHierarchy = (saved.nodes || []).find((node) => node.id === hierarchyId);
  const savedLevels = (saved.levels || []).filter(
    (level) => levelModels.some((candidate) => candidate.id === level.id),
  );
  safeOutput({
    ok: true,
    modelId: saved.id,
    modelName: saved.name,
    hierarchy: {
      id: savedHierarchy.id,
      name: savedHierarchy.name,
      alias: savedHierarchy.alias,
      levelCount: savedLevels.length,
      levels: savedHierarchy.children.map((node) => ({
        id: node.id,
        name: node.name,
        alias: node.alias,
        type: node.type,
      })),
    },
  });
}

async function cmdModelHierarchyAddArgs(argsList) {
  if (argsList.filter((argument) => argument === '--confirm-name').length > 1) {
    throw new Error('model-hierarchy-add accepts --confirm-name only once');
  }
  const { positional, confirmation } = parseExactConfirmationArgs(
    argsList,
    'model-hierarchy-add',
    '--confirm-name',
  );
  if (positional.length < 3 || positional.length > 4) {
    throw new Error(
      'model-hierarchy-add requires <modelId> <hierarchyName> <levelSpecJson> '
      + '[description] --confirm-name <exactModelName>',
    );
  }
  await cmdModelHierarchyAdd(
    positional[0],
    positional[1],
    positional[2],
    positional[3] || '',
    confirmation,
  );
}

function parseCalcMeasureSpec(specJson) {
  let spec;
  try {
    spec = JSON.parse(specJson);
  } catch {
    throw new Error('model-calc-measure-add specJson must be valid JSON');
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('model-calc-measure-add specJson must be an object');
  }
  const allowedKeys = new Set(['expression', 'references', 'valueType', 'dataFormat']);
  for (const key of Object.keys(spec)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`calculated measure has unsupported property: ${key}`);
    }
  }
  if (!String(spec.expression || '').trim()) {
    throw new Error('calculated measure requires a non-empty expression');
  }
  if (!Array.isArray(spec.references) || spec.references.length === 0) {
    throw new Error('calculated measure requires at least one referenced measure');
  }
  if (!String(spec.valueType || '').trim() || !String(spec.dataFormat || '').trim()) {
    throw new Error('calculated measure requires explicit valueType and dataFormat');
  }
  return {
    expression: String(spec.expression).trim(),
    references: spec.references.map((reference, index) => {
      const normalized = String(reference ?? '').trim();
      if (!normalized) throw new Error(`calculated measure reference ${index + 1} is required`);
      return normalized;
    }),
    valueType: String(spec.valueType).trim().toUpperCase(),
    dataFormat: String(spec.dataFormat).trim(),
  };
}

async function cmdModelCalcMeasureAdd(
  modelId,
  requestedName,
  specJson,
  description = '',
  confirmName = null,
) {
  if (![modelId, requestedName, specJson].every(Boolean)) {
    throw new Error(
      'model-calc-measure-add requires <modelId> <measureName> <specJson> '
      + '[description] --confirm-name <exactModelName>',
    );
  }
  const spec = parseCalcMeasureSpec(specJson);
  const guardedParentId = PLATFORM_PROFILE
    ? await locateCompetitionResourceParent(modelId, 'model')
    : null;
  const baseline = requireNamespacedResource(await loadModel(modelId), 'model');
  assertExactCurrentNameConfirmation(baseline, confirmName, 'model');
  if (guardedParentId) {
    await assertCompetitionResourceDirectChild(guardedParentId, modelId, 'model');
  }
  const model = structuredClone(baseline);
  const alias = applyNamespace(requestedName);
  const allMeasures = [...(model.measures || []), ...(model.calcMeasures || [])];
  if (allMeasures.some((measure) => [measure.name, measure.alias].includes(alias))) {
    throw new Error(`model measure already exists: ${alias}`);
  }
  const references = spec.references.map((reference, index) => resolveAnalysisResource(
    model.measures || [],
    reference,
    { kind: `calculated measure reference ${index + 1}` },
  ));
  if (new Set(references.map((measure) => measure.id)).size !== references.length) {
    throw new Error('calculated measure references must be unique');
  }
  const expressionNames = [...spec.expression.matchAll(/\[Measures\]\.\[([^\]]+)\]/g)]
    .map((match) => match[1]);
  const referenceNames = references.map((measure) => measure.name);
  if (
    expressionNames.length === 0
    || expressionNames.some((name) => !referenceNames.includes(name))
    || referenceNames.some((name) => !expressionNames.includes(name))
  ) {
    throw new Error(
      'calculated measure expression references must exactly match resolved measure names',
    );
  }

  const measureRoot = (model.nodes || []).find(
    (node) => node.type === 'MEASURE_FOLDER'
      || String(node.id || '').endsWith('.measure')
      || node.id === 'measure',
  );
  if (!measureRoot) throw new Error('model measure root is missing');
  const internalName = `custom_${resourceId()}`;
  const calcId = qualifyModelResource(
    model.id,
    'CALC_MEASURE',
    `${resourceId()}_${internalName}`,
  );
  let expressionParamAlias = spec.expression;
  const measurePrefix = `AUGMENTED_DATASET_MEASURE.${model.id}.`;
  const editorObjects = references.map((measure) => {
    const uniqueName = `[Measures].[${measure.name}]`;
    expressionParamAlias = expressionParamAlias.split(uniqueName).join(`^C_${uniqueName}^`);
    const editorId = String(measure.id).startsWith(measurePrefix)
      ? String(measure.id).slice(measurePrefix.length)
      : String(measure.id);
    return {
      id: editorId,
      alias: measure.alias || measure.name,
      name: measure.name,
      type: 'MEASURE',
      uniqueName,
      path: `/度量/${measure.alias || measure.name}`,
      label: `[${measure.alias || measure.name}]`,
      tooltipKeys: ['name', 'path'],
    };
  });
  const extended = JSON.stringify({
    calcMeasure: {
      type: 'CALC_MEASURE',
      define: {
        expression: spec.expression,
        expressionParamAlias,
        edtiorObjList: JSON.stringify(editorObjects),
      },
    },
  });
  const calcMeasure = {
    id: calcId,
    name: internalName,
    aliasFromDb: alias,
    descFromDb: description,
    useFromDb: false,
    valueType: spec.valueType,
    dataFormat: spec.dataFormat,
    sqlColumnName: null,
    maskingRule: null,
    viewId: null,
    viewAlias: null,
    hierName: '[Measures]',
    expression: spec.expression,
    dimName: '[Measures]',
    transformRule: null,
    visible: 1,
    extended,
    extendedType: null,
    reportVisible: true,
    resType: null,
    desc: description,
    alias,
    creatorId: null,
  };
  const rootChildren = Array.isArray(measureRoot.children) ? measureRoot.children : [];
  const order = rootChildren.reduce(
    (maximum, child) => Math.max(maximum, Number(child.order) || 0),
    -1,
  ) + 1;
  const calcNode = {
    id: calcId,
    name: internalName,
    aliasFromDb: alias,
    descFromDb: description,
    useFromDb: false,
    type: 'CALC_MEASURE',
    group: 'CALC_MEASURE',
    level: 0,
    order,
    visible: 1,
    parentId: measureRoot.id,
    valueType: null,
    dataFormat: null,
    extended,
    refDataSetFieldId: null,
    referenceFieldId: null,
    originalDataType: null,
    aggregator: null,
    businessCaliber: null,
    children: [],
    reportVisible: true,
    desc: description,
    alias,
    creatorId: null,
  };
  measureRoot.children = [...rootChildren, calcNode];
  model.calcMeasures = [...(model.calcMeasures || []), calcMeasure];
  model.nodes = [...(model.nodes || []), calcNode];
  assertOnlyModelCollectionsChanged(baseline, model, ['calcMeasures', 'nodes']);
  const current = requireNamespacedResource(await loadModel(model.id), 'model');
  assertExactCurrentNameConfirmation(current, confirmName, 'model');
  assertModelBaselineUnchanged(baseline, current);
  if (guardedParentId) {
    const currentParentId = await locateCompetitionResourceParent(model.id, 'model');
    if (currentParentId !== guardedParentId) {
      throw new Error('model placement changed after it was loaded; refusing full-model overwrite');
    }
    await assertCompetitionResourceDirectChild(currentParentId, model.id, 'model');
  }
  await smartbixApi('augmentedDataSet', {
    method: 'PUT',
    body: model,
    timeoutMs: 120000,
  });
  const saved = await loadModel(model.id);
  assertSavedModelEquivalent(model, saved, 'calculated-measure-mutated model');
  const persisted = (saved.calcMeasures || []).find((measure) => measure.id === calcId);
  safeOutput({
    ok: true,
    modelId: saved.id,
    modelName: saved.name,
    measure: {
      id: persisted.id,
      name: persisted.name,
      alias: persisted.alias,
      valueType: persisted.valueType,
      dataFormat: persisted.dataFormat,
      expression: persisted.expression,
      references: referenceNames,
    },
  });
}

async function cmdModelCalcMeasureAddArgs(argsList) {
  if (argsList.filter((argument) => argument === '--confirm-name').length > 1) {
    throw new Error('model-calc-measure-add accepts --confirm-name only once');
  }
  const { positional, confirmation } = parseExactConfirmationArgs(
    argsList,
    'model-calc-measure-add',
    '--confirm-name',
  );
  if (positional.length < 3 || positional.length > 4) {
    throw new Error(
      'model-calc-measure-add requires <modelId> <measureName> <specJson> '
      + '[description] --confirm-name <exactModelName>',
    );
  }
  await cmdModelCalcMeasureAdd(
    positional[0],
    positional[1],
    positional[2],
    positional[3] || '',
    confirmation,
  );
}

async function cmdModelClone(parentId, sourceModelId, requestedName, description = '') {
  if (![parentId, sourceModelId, requestedName].every(Boolean)) {
    throw new Error('model-clone requires <parentId> <sourceModelId> <name> [description]');
  }
  if (PLATFORM_PROFILE) {
    throw new Error('competition model-clone is prohibited; use model-create --etl-flow <ownedFlowId>');
  }
  await assertOwnedCatalogParent(parentId);
  const source = requireNamespacedResource(await loadModel(sourceModelId), 'source model');
  const sourceIds = [source.id, ...(source.views || []).map((view) => view.id)];
  const targetModelId = resourceId();
  const viewIds = new Map((source.views || []).map((view) => [view.id, resourceId()]));
  const model = remapModelClone(source, {
    modelId: targetModelId,
    viewIds,
    batchId: resourceId(),
  });
  model.name = model.alias = applyNamespace(requestedName);
  model.desc = description || source.desc || '';
  const result = await smartbixApi(`augmentedDataSet/${encodeURIComponent(parentId)}`, {
    method: 'POST',
    body: model,
  });
  const createdId = createdResourceId(result, model.id);
  if (!createdId) throw new Error('model clone returned no resource id');
  const saved = await loadModel(createdId);
  assertSavedModelEquivalent(model, saved, 'cloned model');
  assertNoModelCloneResidue(saved, sourceIds);
  await assertSavedResourceDirectChild(parentId, saved.id, model.name, 'cloned model');
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    fieldCount: saved.fields.length,
    measureCount: saved.measures.length,
    viewCount: saved.views.length,
    relationCount: saved.relationGraph.relations.length,
    hierarchyCount: saved.nodes.filter((node) => (
      node.type === 'HIERARCHY' || node.type === 'HIERARCHY_TIME'
    )).length,
    calculatedMeasureCount: saved.calcMeasures.length,
  });
}

async function loadAnalysis(analysisId) {
  if (!analysisId) throw new Error('analysis id is required');
  await ensureSession();
  const wrapper = await smartbixApi(`adhocanalysis/getReport/${encodeURIComponent(analysisId)}`);
  if (!wrapper?.report?.id) throw new Error(`analysis not found or incomplete: ${analysisId}`);
  if (wrapper.report.id !== analysisId) {
    throw new Error(`analysis identity mismatch while reopening requested resource: ${analysisId}`);
  }
  return wrapper;
}
async function cmdAnalysisGet(analysisId) {
  if (PLATFORM_PROFILE) await locateCompetitionResourceParent(analysisId, 'analysis');
  const { report } = await loadAnalysis(analysisId);
  requireNamespacedResource(report, 'analysis');
  const tables = analysisCrossTables(report);
  safeOutput({
    id: report.id,
    name: report.name,
    alias: report.alias || null,
    description: report.desc || '',
    portlets: (report.define?.portlets || []).map((portlet) => ({
      id: portlet.id,
      name: portlet.name || null,
      type: portlet.type || null,
    })),
    crossTables: tables.map((table) => ({
      id: table.id,
      modelId: table.extended?.dataSource?.id || null,
      rowBindings: (table.extended?.fields?.rows || []).map((field) => ({
        id: field.id,
        name: field.name,
        alias: field.alias || null,
        type: field.type,
      })),
      measureBindings: (table.extended?.fields?.measures || []).map((field) => ({
        id: field.id,
        name: field.name,
        alias: field.alias || null,
        type: field.type,
        aggregate: field.aggregate ?? null,
      })),
    })),
    privateDefinitionCounts: {
      folders: report.define?.privateDataset?.folders?.length || 0,
      fields: report.define?.privateDataset?.fields?.length || 0,
    },
  });
}

function buildAnalysisQuery(report, options = {}) {
  return buildVerifiedAnalysisQuery(report, { ...options, idFactory: resourceId });
}


function analysisDimension(model, field) {
  return {
    id: qualifyModelResource(model.id, 'FIELD', field.id),
    name: field.name,
    alias: field.alias || field.name,
    desc: field.desc || '',
    label: field.alias || field.name,
    type: 'FIELD',
    dataType: field.valueType,
    fieldType: 'DIMENSION',
    hierarchy: 'FIELD',
    group: 'DIMENSION',
    children: [],
    dataFormat: field.dataFormat || '',
    orderByType: null,
    orderBySettings: null,
    maskingRule: field.maskingRule || null,
    originalMaskingRule: null,
    maskingRuleAlias: null,
    transformRule: field.transformRule || null,
    parentId: model.nodes?.find((node) => node.id === field.id)?.parentId
      || `AUGMENTED_DATASET_FOLDER.${model.id}.${field.viewId}`,
    order: model.nodes?.find((node) => node.id === field.id)?.order || field.order || 0,
    visible: true,
    originalDataType: field.originalDataType || null,
    refDataSetFieldId: field.refDataSetFieldId || null,
    extended: field.extended || null,
    businessCaliber: field.businessCaliber || null,
    aggregate: null,
    aggregatedCalcField: false,
    creatorId: null,
    uniqueId: resourceId(),
    originAggregate: null,
  };
}

function analysisMeasure(model, measure) {
  const isCalculated = (model.calcMeasures || []).some((candidate) => candidate.id === measure.id);
  let aggregate = null;
  if (!isCalculated) {
    aggregate = String(measure.aggregator || '').trim().toUpperCase();
    if (!MODEL_AGGREGATORS.includes(aggregate)) {
      throw new Error(`analysis measure has no supported explicit aggregator: ${measure.id}`);
    }
  }
  const type = isCalculated ? 'CALC_MEASURE' : 'MEASURE';
  return {
    id: qualifyModelResource(model.id, type, measure.id),
    name: measure.name,
    alias: measure.alias || measure.name,
    desc: measure.desc || '',
    label: measure.alias || measure.name,
    type,
    dataType: measure.valueType,
    fieldType: 'MEASURE',
    hierarchy: 'MEASURE',
    group: type,
    children: [],
    dataFormat: measure.dataFormat || '',
    orderByType: null,
    orderBySettings: null,
    maskingRule: measure.maskingRule || null,
    originalMaskingRule: null,
    maskingRuleAlias: null,
    transformRule: measure.transformRule || null,
    parentId: model.nodes?.find((node) => node.id === measure.id)?.parentId
      || `AUGMENTED_DATASET_FOLDER.${model.id}.measure`,
    order: model.nodes?.find((node) => node.id === measure.id)?.order || measure.order || 0,
    visible: true,
    originalDataType: measure.valueType,
    refDataSetFieldId: !isCalculated && measure.refDataSetFieldId
      ? qualifyModelResource(model.id, 'FIELD', measure.refDataSetFieldId)
      : null,
    extended: measure.extended || null,
    businessCaliber: measure.businessCaliber || null,
    aggregate,
    aggregatedCalcField: false,
    creatorId: null,
    contentClass: 'sx-measure-content',
    uniqueId: resourceId(),
    originAggregate: aggregate,
  };
}

function analysisLevel(model, hierarchy, level, index) {
  const node = (model.nodes || []).find((candidate) => candidate.id === level.id);
  const levelType = level.levelType || node?.type || 'LEVEL';
  return {
    id: qualifyModelResource(model.id, 'LEVEL', level.id),
    name: level.name,
    alias: level.alias || level.name,
    desc: level.desc || '',
    label: level.alias || level.name,
    type: levelType,
    dataType: level.valueType,
    fieldType: 'DIMENSION',
    hierarchy: levelType,
    group: 'LEVEL',
    children: [],
    dataFormat: level.dataFormat || '',
    orderByType: null,
    orderBySettings: null,
    maskingRule: level.maskingRule || null,
    originalMaskingRule: null,
    maskingRuleAlias: null,
    transformRule: level.transformRule || null,
    parentId: hierarchy.id,
    order: node?.order ?? index,
    visible: true,
    originalDataType: null,
    refDataSetFieldId: null,
    extended: level.extended || null,
    businessCaliber: null,
    aggregate: null,
    aggregatedCalcField: false,
    creatorId: null,
    uniqueId: resourceId(),
    originAggregate: null,
    subtotal: 'SHOW',
    showName: level.alias || level.name,
  };
}

function defaultBusinessLabel(fieldName) {
  return String(fieldName || '').trim().replaceAll('_', ' ');
}

function buildAnalysisReport(model, rowFieldName, measureFieldName, requestedName, description = '') {
  const dimensionField = resolveAnalysisResource(
    model.fields || [],
    rowFieldName,
    { kind: 'analysis dimension field' },
  );
  const modelMeasure = resolveAnalysisResource(
    [...(model.measures || []), ...(model.calcMeasures || [])],
    measureFieldName,
    {
      kind: 'analysis measure',
      namespacedRequested: applyNamespace(measureFieldName),
    },
  );
  const dimension = analysisDimension(model, dimensionField);
  const measure = analysisMeasure(model, modelMeasure);
  const dataSource = { id: model.id, type: 'AUGMENTED' };
  const sortSetting = { row: { sorts: [] }, col: { sorts: [] } };
  const rowLabel = defaultBusinessLabel(rowFieldName);
  const measureLabel = defaultBusinessLabel(measureFieldName);
  const report = {
    name: applyNamespace(requestedName),
    alias: applyNamespace(requestedName),
    desc: description,
    define: {
      reportSetting: { refresh: {}, tableHeader: null, tableFooter: null },
      portlets: [{
        id: resourceId(),
        name: '表格',
        type: 'CROSS_TABLE',
        extended: {
          fields: {
            cols: [{
              id: 'MEASURE_GROUP_NAME',
              name: 'MEASURE_GROUP_NAME',
              alias: '度量名称',
              label: '度量名称',
              type: 'MEASURE_GROUP_NAME',
              hierarchy: 'MEASURE_GROUP_NAME',
              group: 'DIMENSION',
              fieldType: 'DIMENSION',
              dataType: 'STRING',
              uniqueId: resourceId(),
            }],
            rows: [dimension],
            measures: [measure],
          },
          sortSetting,
          dataSource,
          viewState: { groupOrderByState: null },
        },
      }],
      privateDataset: { folders: [], fields: [] },
    },
  };
  return improveAnalysisPresentation(report, {
    rowLabel,
    measureLabel,
    description: description || `${rowLabel} / ${measureLabel}`,
  });
}

function buildHierarchyAnalysisReport(
  model,
  hierarchyName,
  measureFieldName,
  requestedName,
  description = '',
) {
  const hierarchy = resolveAnalysisResource(
    (model.nodes || []).filter((node) => (
      node.type === 'HIERARCHY' || node.type === 'HIERARCHY_TIME'
    )),
    hierarchyName,
    {
      kind: 'model hierarchy',
      namespacedRequested: applyNamespace(hierarchyName),
    },
  );
  const levels = (hierarchy.children || []).map((node, index) => resolveAnalysisResource(
    model.levels || [],
    node.id,
    { kind: `model hierarchy level ${index + 1}` },
  ));
  if (levels.length < 2) {
    throw new Error(`model hierarchy is incomplete: ${hierarchy.alias || hierarchy.name}`);
  }
  const firstFields = (model.fields || []).filter(
    (field) => qualifyModelResource(model.id, 'FIELD', field.id) === levels[0].refDataSetFieldId,
  );
  if (firstFields.length !== 1) {
    throw new Error('model hierarchy first level source field must resolve exactly once');
  }
  const firstField = firstFields[0];
  const report = buildAnalysisReport(
    model,
    firstField.name,
    measureFieldName,
    requestedName,
    description,
  );
  const rows = levels.map((level, index) => analysisLevel(model, hierarchy, level, index));
  report.define.portlets[0].extended.fields.rows = rows;
  report.desc = description || report.desc;
  return report;
}

async function cmdAnalysisCreate(
  parentId,
  modelId,
  rowFieldName,
  measureFieldName,
  requestedName,
  description = '',
) {
  if (![parentId, modelId, rowFieldName, measureFieldName, requestedName].every(Boolean)) {
    throw new Error('analysis-create requires <parentId> <modelId> <rowField> <measure> <name> [description]');
  }
  await assertOwnedCatalogParent(parentId);
  await assertCompetitionResourceDirectChild(parentId, modelId, 'model');
  const model = requireNamespacedResource(await loadModel(modelId), 'model');
  const report = buildAnalysisReport(
    model,
    rowFieldName,
    measureFieldName,
    requestedName,
    description,
  );
  const requestedBindings = analysisBindingSnapshot(report);
  const result = await smartbixApi(
    `adhocanalysis/createReport?pid=${encodeURIComponent(parentId)}`,
    { method: 'POST', body: report },
  );
  const createdId = createdResourceId(result);
  if (!createdId) throw new Error('analysis create returned no resource id');
  const { report: saved } = await loadAnalysis(createdId);
  assertSavedAnalysisEquivalent(report, saved, 'created analysis');
  assertAnalysisBindings(saved, requestedBindings);
  await assertSavedResourceDirectChild(parentId, saved.id, report.name, 'created analysis');
  const queryResult = await smartbixApi(`adhocanalysis/data/${encodeURIComponent(createdId)}`, {
    method: 'POST',
    body: buildAnalysisQuery(saved),
    timeoutMs: 120000,
  });
  const executionPreview = assertAnalysisQueryResult(queryResult, {
    label: 'created analysis execution',
  });
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    bindings: requestedBindings,
    executionPreview,
  });
}

async function cmdAnalysisCreateHierarchy(
  parentId,
  modelId,
  hierarchyName,
  measureFieldName,
  requestedName,
  description = '',
) {
  if (![parentId, modelId, hierarchyName, measureFieldName, requestedName].every(Boolean)) {
    throw new Error(
      'analysis-create-hierarchy requires <parentId> <modelId> <hierarchy> <measure> '
      + '<name> [description]',
    );
  }
  await assertOwnedCatalogParent(parentId);
  await assertCompetitionResourceDirectChild(parentId, modelId, 'model');
  const model = requireNamespacedResource(await loadModel(modelId), 'model');
  const report = buildHierarchyAnalysisReport(
    model,
    hierarchyName,
    measureFieldName,
    requestedName,
    description,
  );
  const requestedBindings = analysisBindingSnapshot(report);
  const result = await smartbixApi(
    `adhocanalysis/createReport?pid=${encodeURIComponent(parentId)}`,
    { method: 'POST', body: report },
  );
  const createdId = createdResourceId(result);
  if (!createdId) throw new Error('hierarchy analysis create returned no resource id');
  const { report: saved } = await loadAnalysis(createdId);
  assertSavedAnalysisEquivalent(report, saved, 'created hierarchy analysis');
  assertAnalysisBindings(saved, requestedBindings);
  await assertSavedResourceDirectChild(parentId, saved.id, report.name, 'created hierarchy analysis');
  const queryResult = await smartbixApi(`adhocanalysis/data/${encodeURIComponent(createdId)}`, {
    method: 'POST',
    body: buildAnalysisQuery(saved),
    timeoutMs: 120000,
  });
  const executionPreview = assertAnalysisQueryResult(queryResult, {
    label: 'created hierarchy analysis execution',
  });
  const rows = saved.define.portlets[0].extended.fields.rows;
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    hierarchy: hierarchyName,
    levels: rows.map((row) => ({
      id: row.id,
      name: row.name,
      alias: row.alias,
      type: row.type,
    })),
    bindings: requestedBindings,
    executionPreview,
  });
}

async function cmdAnalysisRepairArgs(argsList) {
  if (argsList.filter((argument) => argument === '--confirm-name').length > 1) {
    throw new Error('analysis-repair accepts --confirm-name only once');
  }
  const { positional, confirmation } = parseExactConfirmationArgs(
    argsList,
    'analysis-repair',
    '--confirm-name',
  );
  if (positional.length < 5) {
    throw new Error(
      'analysis-repair requires <analysisId> <rowField> <measure> <rowLabel> '
      + '<measureLabel> [description] --confirm-name <exactAnalysisName>',
    );
  }
  await cmdAnalysisRepair(
    positional[0],
    positional[1],
    positional[2],
    positional[3],
    positional[4],
    positional.slice(5).join(' '),
    confirmation,
  );
}

async function cmdAnalysisRepair(
  analysisId,
  rowFieldName,
  measureFieldName,
  rowLabel,
  measureLabel,
  description = '',
  confirmName = null,
) {
  if (![analysisId, rowFieldName, measureFieldName, rowLabel, measureLabel].every(Boolean)) {
    throw new Error(
      'analysis-repair requires <analysisId> <rowField> <measure> <rowLabel> '
      + '<measureLabel> [description] --confirm-name <exactAnalysisName>',
    );
  }
  const guardedAnalysisParentId = PLATFORM_PROFILE
    ? await locateCompetitionResourceParent(analysisId, 'analysis')
    : null;
  const { report: current } = await loadAnalysis(analysisId);
  requireNamespacedResource(current, 'analysis');
  assertExactCurrentNameConfirmation(current, confirmName, 'analysis');
  const currentTable = assertSimpleAnalysisRepairable(current);
  const modelId = currentTable.extended?.dataSource?.id;
  if (!modelId) throw new Error('analysis has no model-backed CROSS_TABLE');

  if (guardedAnalysisParentId) {
    await assertCompetitionResourceDirectChild(guardedAnalysisParentId, modelId, 'model');
  }
  const model = requireNamespacedResource(await loadModel(modelId), 'model');
  const requestedDefinition = buildAnalysisReport(
    model,
    rowFieldName,
    measureFieldName,
    current.name,
    description || current.desc || '',
  );
  const requestedTable = assertSimpleAnalysisRepairable(requestedDefinition);
  const repaired = patchSimpleAnalysisDefinition(current, {
    row: requestedTable.extended.fields.rows[0],
    measure: requestedTable.extended.fields.measures[0],
    rowLabel,
    measureLabel,
    description: description || current.desc || '',
  });
  const expectedBindings = analysisBindingSnapshot(repaired);
  const beforeAudit = auditAnalysisPresentation(current);

  const preflightResult = await smartbixApi(
    `adhocanalysis/data/${encodeURIComponent(analysisId)}`,
    {
      method: 'POST',
      body: buildAnalysisQuery(repaired),
      timeoutMs: 120000,
    },
  );
  assertAnalysisQueryResult(preflightResult, { label: 'analysis repair preflight' });
  const { report: latest } = await loadAnalysis(analysisId);
  requireNamespacedResource(latest, 'analysis');
  assertExactCurrentNameConfirmation(latest, confirmName, 'analysis');
  assertSavedAnalysisEquivalent(current, latest, 'analysis repair baseline');
  assertModelBaselineUnchanged(model, await loadModel(modelId));
  if (guardedAnalysisParentId) {
    const latestParentId = await locateCompetitionResourceParent(analysisId, 'analysis');
    if (latestParentId !== guardedAnalysisParentId) {
      throw new Error('analysis placement changed after it was loaded; refusing repair');
    }
    await assertCompetitionResourceDirectChild(latestParentId, modelId, 'model');
  }

  await smartbixApi('adhocanalysis/updateReport', {
    method: 'POST',
    body: repaired,
    timeoutMs: 120000,
  });
  const { report: saved } = await loadAnalysis(analysisId);
  assertSavedAnalysisEquivalent(repaired, saved, 'repaired analysis');
  assertAnalysisBindings(saved, expectedBindings);
  const presentation = auditAnalysisPresentation(saved);
  if (!presentation.ok) {
    throw new Error(`analysis presentation repair failed: ${presentation.issues.join('; ')}`);
  }
  const queryResult = await smartbixApi(`adhocanalysis/data/${encodeURIComponent(analysisId)}`, {
    method: 'POST',
    body: buildAnalysisQuery(saved),
    timeoutMs: 120000,
  });
  const executionPreview = assertAnalysisQueryResult(queryResult, {
    label: 'repaired analysis execution',
  });
  safeOutput({
    ok: true,
    id: analysisId,
    name: saved.name,
    bindings: expectedBindings,
    rowLabel,
    measureLabel,
    removedIssues: beforeAudit.issues,
    presentation,
    executionPreview,
  });
}

async function cmdAnalysisRun(analysisId) {
  const analysisParentId = PLATFORM_PROFILE
    ? await locateCompetitionResourceParent(analysisId, 'analysis')
    : null;
  const { report } = await loadAnalysis(analysisId);
  requireNamespacedResource(report, 'analysis');
  const modelIds = analysisModelIds(report);
  for (const modelId of modelIds) {
    if (analysisParentId) {
      await assertCompetitionResourceDirectChild(analysisParentId, modelId, 'analysis source model');
    }
    requireNamespacedResource(await loadModel(modelId), 'analysis source model');
  }
  const tables = analysisCrossTables(report);
  if (tables.length === 0) throw new Error('analysis has no runnable CROSS_TABLE portlet');
  const executionPreview = [];
  for (const table of tables) {
    const result = await smartbixApi(`adhocanalysis/data/${encodeURIComponent(analysisId)}`, {
      method: 'POST',
      body: buildAnalysisQuery(report, { portletId: table.id }),
      timeoutMs: 120000,
    });
    executionPreview.push({
      portletId: table.id,
      ...assertAnalysisQueryResult(result, {
        label: `analysis portlet ${table.id} execution`,
      }),
    });
  }
  safeOutput({ ok: true, analysisId, name: report.name, executionPreview });
}

async function cmdAnalysisProfile(analysisId, fieldNamesCsv) {
  if (![analysisId, fieldNamesCsv].every(Boolean)) {
    throw new Error('analysis-profile requires <analysisId> <field,...>');
  }
  const analysisParentId = PLATFORM_PROFILE
    ? await locateCompetitionResourceParent(analysisId, 'analysis')
    : null;
  const { report } = await loadAnalysis(analysisId);
  requireNamespacedResource(report, 'analysis');
  const tables = analysisCrossTables(report);
  if (tables.length !== 1) {
    throw new Error(`analysis-profile requires exactly one CROSS_TABLE; found ${tables.length}`);
  }
  const table = tables[0];
  const modelId = table.extended?.dataSource?.id;
  if (!modelId) throw new Error('analysis has no model-backed CROSS_TABLE');
  if (analysisParentId) {
    await assertCompetitionResourceDirectChild(analysisParentId, modelId, 'model');
  }
  const model = requireNamespacedResource(await loadModel(modelId), 'model');
  const fieldNames = [...new Set(
    String(fieldNamesCsv).split(',').map((name) => name.trim()).filter(Boolean),
  )];
  if (fieldNames.length === 0) throw new Error('analysis-profile requires at least one field');

  const profiles = [];
  for (const fieldName of fieldNames) {
    const field = resolveAnalysisResource(
      model.fields || [],
      fieldName,
      { kind: 'analysis profile field' },
    );
    const query = buildAnalysisQuery(report, { portletId: table.id });
    query.queryFields = {
      ...query.queryFields,
      rows: [analysisDimension(model, field)],
    };
    query.querySortSetting = { rowSorts: [], colSorts: [] };
    query.groupOrderByState = null;
    query.useAdvancedSort = false;
    const result = await smartbixApi(`adhocanalysis/data/${encodeURIComponent(analysisId)}`, {
      method: 'POST',
      body: query,
      timeoutMs: 120000,
    });
    const executionPreview = assertAnalysisQueryResult(result, {
      label: `analysis profile field ${field.id}`,
    });
    profiles.push({
      field: field.name,
      label: field.alias || field.name,
      ...summarizeDimensionKeys(executionPreview.rowKeys),
      executionPreview,
    });
  }
  safeOutput({
    ok: true,
    analysisId,
    name: report.name,
    model: { id: model.id, name: model.name },
    profiles,
  });
}

async function cmdAnalysisClone(parentId, sourceAnalysisId, requestedName, description = '') {
  if (![parentId, sourceAnalysisId, requestedName].every(Boolean)) {
    throw new Error('analysis-clone requires <parentId> <sourceAnalysisId> <name> [description]');
  }
  await assertOwnedCatalogParent(parentId);
  await assertCompetitionResourceDirectChild(parentId, sourceAnalysisId, 'source analysis');
  const { report: source } = await loadAnalysis(sourceAnalysisId);
  requireNamespacedResource(source, 'source analysis');
  const modelIds = analysisModelIds(source);
  for (const modelId of modelIds) {
    await assertCompetitionResourceDirectChild(parentId, modelId, 'analysis source model');
    requireNamespacedResource(await loadModel(modelId), 'analysis source model');
  }
  for (const table of analysisCrossTables(source)) {
    const sourceResult = await smartbixApi(
      `adhocanalysis/data/${encodeURIComponent(sourceAnalysisId)}`,
      {
        method: 'POST',
        body: buildAnalysisQuery(source, { portletId: table.id }),
        timeoutMs: 120000,
      },
    );
    assertAnalysisQueryResult(sourceResult, {
      label: `source analysis portlet ${table.id} clone preflight`,
    });
  }
  const seed = structuredClone(source);
  delete seed.id;
  delete seed.creatorId;
  const { report } = remapAnalysisPortlets(seed, resourceId);
  report.name = report.alias = applyNamespace(requestedName);
  report.desc = description || source.desc || '';
  const result = await smartbixApi(
    `adhocanalysis/createReport?pid=${encodeURIComponent(parentId)}`,
    { method: 'POST', body: report },
  );
  const createdId = createdResourceId(result);
  if (!createdId) throw new Error('analysis clone returned no resource id');
  report.id = createdId;
  const { report: saved } = await loadAnalysis(createdId);
  assertSavedAnalysisEquivalent(report, saved, 'cloned analysis');
  await assertSavedResourceDirectChild(parentId, saved.id, report.name, 'cloned analysis');
  const executionPreview = [];
  for (const table of analysisCrossTables(saved)) {
    const cloneResult = await smartbixApi(`adhocanalysis/data/${encodeURIComponent(createdId)}`, {
      method: 'POST',
      body: buildAnalysisQuery(saved, { portletId: table.id }),
      timeoutMs: 120000,
    });
    executionPreview.push({
      portletId: table.id,
      ...assertAnalysisQueryResult(cloneResult, {
        label: `cloned analysis portlet ${table.id} execution`,
      }),
    });
  }
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    portletCount: saved.define.portlets.length,
    modelIds,
    executionPreview,
  });
}

function dashboardResource(model, name, kind, displayLabel) {
  return serializeDashboardResource(model, name, kind, displayLabel, resourceId);
}

function dashboardChartLabel(chart, name) {
  if (Object.hasOwn(chart.labels, name)) return chart.labels[name];
  if (name === chart.dimension && chart.dimensionLabel !== name) return chart.dimensionLabel;
  if (name === chart.measure && chart.measureLabel !== name) return chart.measureLabel;
  return null;
}

function dashboardPortletType(chart) {
  return chart.type.startsWith('ECHARTS_MAP') ? 'ECHARTS_MAP' : chart.type;
}

function dashboardChartSlot(model, chart, slot) {
  const kind = chartTypeContract(chart.type).slots[slot]?.kind || 'any';
  return (chart.slots[slot] || []).map((name) => {
    const resource = dashboardResource(
      model,
      name,
      kind,
      dashboardChartLabel(chart, name),
    );
    if (!chart.type.startsWith('ECHARTS_MAP') || !['cols', 'rows'].includes(slot)) {
      return resource;
    }
    return {
      ...resource,
      type: chart.type === 'ECHARTS_MAP'
        ? 'GEO'
        : (slot === 'cols' ? 'GEO_LON' : 'GEO_LAT'),
      portletType: chart.type,
    };
  });
}

function dashboardChartDefine(chart) {
  const { axes } = chartTypeContract(chart.type);
  const chartDefine = {
    tooltip: {
      trigger: ['ECHARTS_PIE', 'ECHARTS_PIE__DONUT', 'ECHARTS_GAUGE'].some(
        (prefix) => chart.type.startsWith(prefix),
      ) ? 'item' : 'axis',
    },
    seriesConfig: {
      global: {
        label: { show: true, position: 'top', fontSize: 11 },
        stack: false,
      },
    },
  };
  if (axes === 'cartesian') {
    chartDefine.grid = {
      left: 72,
      right: 24,
      top: 64,
      bottom: 96,
      containLabel: true,
    };
    chartDefine.xAxis = {
      name: chart.xAxisTitle,
      nameLocation: 'middle',
      nameGap: 62,
      axisLabel: { interval: 0, rotate: 24 },
    };
    chartDefine.yAxis = {
      name: chart.yAxisTitle,
      nameLocation: 'middle',
      nameGap: 54,
      axisLabel: {},
    };
  } else if (axes === 'polar') {
    chartDefine.angleAxis = { name: chart.angleAxisTitle };
    chartDefine.radiusAxis = { name: chart.radiusAxisTitle };
  }
  if (['ECHARTS_PIE', 'ECHARTS_PIE__DONUT', 'ECHARTS_SUNBURST'].includes(chart.type)) {
    chartDefine.legend = {};
  }
  if (chart.type.startsWith('ECHARTS_MAP')) {
    chartDefine.visualMap = { show: true };
    chartDefine.geo = { roam: true };
  }
  if (chart.type.startsWith('ECHARTS_GAUGE')) chartDefine.valueAxis = {};
  if (chart.type === 'ECHARTS_GRAPH') chartDefine.layout = 'force';
  return chartDefine;
}

function buildChartDashboard(model, requestedName, chart) {
  const pageId = resourceId();
  const portletId = resourceId();
  const name = applyNamespace(requestedName);
  const portletType = dashboardPortletType(chart);
  const mapChart = portletType === 'ECHARTS_MAP';
  const columns = dashboardChartSlot(model, chart, 'cols');
  const rows = dashboardChartSlot(model, chart, 'rows');
  const tableChart = portletType === 'TABLE_CROSS';
  const tableMeasures = tableChart
    ? dashboardChartSlot(model, chart, 'measureGroup')
    : [];
  if (tableChart && tableMeasures.length === 0) {
    throw new Error('TABLE_CROSS requires at least one measure');
  }
  const tableMeasureName = tableChart ? {
    id: 'MEASURE_GROUP_NAME',
    alias: '度量名称',
    label: '度量名称',
    label0: '度量名称',
    showName: null,
    aggregate: 'NONE',
    orderBy: null,
    orderBySettings: null,
    align: null,
    dataFormat: null,
    orderPriority: 0,
    subtotal: null,
    group: 'DIMENSION',
    dataType: 'STRING',
    type: 'MEASURE_GROUP_NAME',
    fieldType: 'DIMENSION',
    uniqueId: resourceId(),
    parentId: null,
    parentNodeName: null,
    name: 'MEASURE_GROUP_NAME',
    fieldLabelStatus: { aggregate: '' },
  } : null;
  const tableMeasureValue = tableChart ? {
    id: 'MEASURE_GROUP_VALUE',
    alias: '度量值',
    label: '度量值',
    label0: '度量值',
    showName: null,
    aggregate: null,
    orderBy: null,
    orderBySettings: null,
    align: null,
    dataFormat: null,
    orderPriority: 0,
    subtotal: null,
    group: 'MEASURE',
    dataType: 'DOUBLE',
    type: 'MEASURE_GROUP_VALUE',
    fieldType: 'MEASURE',
    uniqueId: resourceId(),
    parentId: null,
    parentNodeName: null,
    name: 'MEASURE_GROUP_VALUE',
    groupName: 'GLOBAL_MARK',
    originAggregate: null,
    originalDataType: null,
  } : null;
  const publicMapGroup = 'PUBLIC_MARK_NONE_ECHARTS_MAP';
  const markFields = Object.fromEntries(
    ['color', 'size', 'angle', 'label', 'tooltip', 'shape'].map((slot) => {
      const fields = dashboardChartSlot(model, chart, slot);
      return [slot, mapChart ? fields.map((field) => ({
        ...field,
        groupName: publicMapGroup,
        portletType: chart.type,
        position: 'LB',
      })) : fields];
    }),
  );
  const markFieldGroups = tableChart
    ? { GLOBAL_MARK: { sum: [tableMeasureValue] } }
    : mapChart
      ? {
        GLOBAL_MARK: { color: [], label: [], tooltip: [] },
        [publicMapGroup]: markFields,
        ...(chart.type === 'ECHARTS_MAP' && columns[0] ? {
          [`${columns[0].id}_NONE_ECHARTS_MAP_${columns[0].uniqueId}`]: markFields,
        } : {}),
      }
      : { GLOBAL_MARK: markFields };
  return {
    id: pageId,
    name,
    alias: name,
    desc: chart.title,
    define: {
      devices: {
        default: {
          gridLine: null,
          style: { background: {}, theme: 'fashion_light_blue', padding: {} },
          layout: {
            type: 'FREE',
            define: {
              floats: {
                1: {
                  portletId,
                  type: portletType,
                  left: 0,
                  top: 0,
                  width: 720,
                  height: 420,
                  'z-index': 1000,
                  id: '1',
                },
              },
              table: { direction: 'vertical', slots: [] },
            },
            mobileDeviceLayoutType: null,
            size: { width: 1280, height: 720, scaleType: 'FIT_WIDTH' },
            mobileDevice: null,
            screenType: null,
            useMobileFilters: null,
          },
        },
      },
      portlets: [{
        id: portletId,
        name: portletId,
        type: portletType,
        displayMode: chart.displayMode,
        style: null,
        macros: [],
        extended: {
          asFilter: false,
          skillChartType: chart.type,
          title: { text: chart.title, left: 'center', top: 8 },
          datasetIds: [model.id],
          fields: {
            cols: tableChart ? [tableMeasureName] : columns,
            rows,
            filters: [],
            marks: [],
          },
          markFieldGroups,
          ...(tableChart ? {
            fieldGroup: {
              [`${model.id}-MEASURE_GROUP`]: tableMeasures,
            },
            data: { showinner: 2 },
            showSeriesNumber: null,
            table: {
              mainColor: 'rgba(236,240,246,1)',
              styleType: 'custom',
            },
            header: {
              backgroundColor: 'rgba(223,229,239,1)',
              font: {
                textStyle: {
                  fontFamily: 'Microsoft YaHei',
                  fontSize: 12,
                  fontWeight: 'bold',
                  color: 'rgba(78,89,105,1)',
                  align: 'center',
                },
              },
            },
            rowheader: { backgroundColor: 'rgba(236,240,246,1)' },
          } : {}),
          ...(mapChart ? {
            scatterLargeCount: {},
            ...(chart.type === 'ECHARTS_MAP' && columns[0]
              ? { areaMapId: columns[0].uniqueId }
              : {}),
          } : {}),
          linkedSelectionValue: 'KeepSelectedValue',
          pagination: {},
          layoutType: 'FREE',
          sortSetting: { row: { sorts: [] }, col: { sorts: [] } },
          providerName: 'AUGMENTED',
          markFieldGroupsCfg: {
            sum: {},
            color: { GLOBAL_MARK: {}, PRIVATE_MARK: {}, isPreview: false },
            size: { value: 1 },
            angle: {},
            label: {},
            tooltip: {},
            shape: { GLOBAL_MARK: {}, PRIVATE_MARK: {} },
          },
          ...(!tableChart ? {
            table: {},
            chartDefine: dashboardChartDefine(chart),
          } : {}),
          refresh: { enable: false },
          viewState: {},
        },
        invalidField: null,
      }],
      containers: [],
      datasetRelations: null,
      privateDatasets: [],
      pageOptions: {},
      globalExtended: {},
      pageThemeDefine: {
        version: '1',
        page: {},
        portlet: {},
        chart: {},
        table: {},
        filter: {},
        indicator: {},
      },
      themeStyleOptions: null,
      refresh: { systemOpenRefresh: true, systemFilterChangeRefresh: true },
      macros: [],
      activeDevice: 'default',
    },
    editDefine: {
      rulerLineConfigs: [{ layoutId: 'default', state: 'show', lines: [] }],
    },
  };
}

function buildBarDashboard(
  model,
  dimensionName,
  measureName,
  requestedName,
  chartTitle,
  presentation = {},
) {
  const [chart] = normalizeDashboardCharts([{
    ...presentation,
    type: 'ECHARTS_BAR',
    dimension: dimensionName,
    measure: measureName,
    title: chartTitle,
  }]);
  return buildChartDashboard(model, requestedName, chart);
}

function buildMultiDashboard(model, requestedName, chartInput, description = '') {
  const layout = dashboardGrid(chartInput);
  const dashboards = layout.charts.map(
    (chart) => buildChartDashboard(model, requestedName, chart),
  );
  const dashboard = dashboards[0];
  const portlets = dashboards.map((item) => item.define.portlets[0]);
  dashboard.desc = description || `${layout.charts.length} independent charts`;
  dashboard.define.portlets = portlets;
  dashboard.define.devices.default.layout.define.floats = Object.fromEntries(
    portlets.map((portlet, index) => {
      const position = layout.floats[index + 1];
      return [position.slot, {
        portletId: portlet.id,
        type: portlet.type,
        left: position.left,
        top: position.top,
        width: position.width,
        height: position.height,
        'z-index': 1000 + index,
        id: position.slot,
      }];
    }),
  );
  dashboard.define.devices.default.layout.define.table = { direction: 'vertical', slots: [] };
  dashboard.define.devices.default.layout.size = {
    ...layout.canvas,
    scaleType: 'FIT_WIDTH',
  };
  return { dashboard, charts: layout.charts };
}


function buildInteractiveDashboard(model, requestedName, specJson, description = '') {
  const spec = parseInteractiveDashboardSpec(specJson);
  const { dashboard, charts } = buildMultiDashboard(
    model,
    requestedName,
    spec.charts,
    description,
  );
  const chartPortlets = dashboard.define.portlets;
  const filterField = dashboardResource(
    model,
    spec.filter.field,
    'dimension',
    spec.filter.label || spec.filter.title || null,
  );
  const filterId = resourceId();
  const filterTargets = validateDashboardPortletIndexes(
    spec.filter.targets || chartPortlets.map((_, index) => index),
    chartPortlets.length,
    'dashboard filter',
  );
  const filterTargetIds = filterTargets.map((index) => chartPortlets[index].id);
  const filterPortlet = {
    id: filterId,
    name: filterId,
    type: 'FILTER_LIST',
    displayMode: null,
    style: null,
    macros: [],
    extended: {
      asFilter: false,
      title: { text: spec.filter.title || filterField.label },
      datasetIds: [model.id],
      fields: {
        filters: [{
          ...filterField,
          showName: null,
          temp: null,
          fieldGroupType: 'filters',
        }],
      },
      markFieldGroups: { GLOBAL_MARK: {} },
      layoutType: 'FREE',
      filterSelectType: spec.filter.selectType,
      dataType: filterField.dataType,
      filterOp: 'EQUALS',
      dateFormat: '自动',
      showAllAlternate: true,
      impactWidgets: filterTargetIds,
      providerName: 'AUGMENTED',
      impactReportsType: 'filterCustom',
      filtersOrder: [filterField.id],
      filterLabel: '',
      filterListType: 'SINGLE',
      columnNum: spec.filter.columnNum,
      viewState: {},
      warnImpacts: [],
      padding: {
        left: { val: 10, isPx: true },
        right: { val: 10, isPx: true },
        top: { val: 4, isPx: true },
        bottom: { val: 4, isPx: true },
      },
      defaultValueSetting: { defaultType: 'ALL' },
    },
    invalidField: null,
  };
  dashboard.define.portlets = [...chartPortlets, filterPortlet];
  const allPortletIds = dashboard.define.portlets.map((portlet) => portlet.id);
  const linkages = spec.linkage.map((linkage, index) => {
    const [source] = validateDashboardPortletIndexes(
      [linkage.source],
      chartPortlets.length,
      `dashboard linkage ${index + 1} source`,
    );
    const targets = validateDashboardPortletIndexes(
      linkage.targets,
      chartPortlets.length,
      `dashboard linkage ${index + 1} targets`,
    );
    if (targets.includes(source)) {
      throw new Error(`dashboard linkage ${index + 1} cannot target its source chart`);
    }
    const sourcePortlet = chartPortlets[source];
    const targetIds = targets.map((target) => chartPortlets[target].id);
    sourcePortlet.extended.asFilter = true;
    sourcePortlet.extended.impactReportsType = 'custom';
    sourcePortlet.extended.ignoreFilters = allPortletIds.filter(
      (portletId) => !targetIds.includes(portletId),
    );
    sourcePortlet.extended.warnImpacts = [];
    return {
      source,
      sourcePortletId: sourcePortlet.id,
      targets,
      targetPortletIds: targetIds,
      ignorePortletIds: [...sourcePortlet.extended.ignoreFilters],
    };
  });

  const layout = dashboard.define.devices.default.layout;
  const filterHeight = 80;
  const verticalGap = 16;
  for (const position of Object.values(layout.define.floats)) {
    position.top += filterHeight + verticalGap;
  }
  const slot = String(Object.keys(layout.define.floats).length + 1);
  layout.define.floats[slot] = {
    portletId: filterId,
    type: 'FILTER_LIST',
    left: 0,
    top: 0,
    width: layout.size.width,
    height: filterHeight,
    'z-index': 2000,
    id: slot,
  };
  layout.size.height += filterHeight + verticalGap;
  dashboard.desc = description || 'Dashboard with persisted filter and chart linkage';
  return {
    dashboard,
    charts,
    interaction: {
      filter: {
        id: filterId,
        field: spec.filter.field,
        resolvedFieldId: filterField.id,
        targets: filterTargets,
        targetPortletIds: filterTargetIds,
        portlet: filterPortlet,
      },
      linkages,
    },
  };
}

async function cmdDashboardCreateInteractive(
  parentId,
  modelId,
  requestedName,
  specJson,
  description = '',
) {
  if (![parentId, modelId, requestedName, specJson].every(Boolean)) {
    throw new Error(
      'dashboard-create-interactive requires <parentId> <modelId> <name> <specJson> '
      + '[description]',
    );
  }
  await assertOwnedCatalogParent(parentId);
  await assertCompetitionResourceDirectChild(parentId, modelId, 'model');
  const model = requireNamespacedResource(await loadModel(modelId), 'model');
  const { dashboard, charts, interaction } = buildInteractiveDashboard(
    model,
    requestedName,
    specJson,
    description,
  );
  const proposalPresentation = auditDashboardPresentation(dashboard, charts.length);
  if (!proposalPresentation.ok) {
    throw new Error(
      `interactive dashboard proposal is invalid: ${proposalPresentation.issues.join('; ')}`,
    );
  }
  const result = await smartbixApi(
    `pages/beans/create?pid=${encodeURIComponent(parentId)}`,
    { method: 'POST', body: dashboard },
  );
  const createdId = createdResourceId(result, dashboard.id);
  const saved = await loadDashboard(createdId);
  const definition = assertSavedDashboardMatchesDefinition(saved, dashboard);
  const persistedInteraction = assertInteractiveDashboardPersisted(saved, interaction);
  const presentation = auditDashboardPresentation(saved, charts.length);
  if (!presentation.ok) {
    throw new Error(`interactive dashboard presentation mismatch: ${presentation.issues.join('; ')}`);
  }
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    model: { id: model.id, name: model.name },
    portletCount: definition.portletCount,
    presentation,
    interaction: {
      ...interaction,
      filter: {
        ...interaction.filter,
        portlet: undefined,
      },
      persisted: persistedInteraction,
    },
  });
}


async function cmdDashboardJumpAddArgs(argsList) {
  const { positional, confirmation } = parseExactConfirmationArgs(
    argsList,
    'dashboard-jump-add',
    '--confirm-name',
  );
  if (positional.length !== 3) {
    throw new Error(
      'dashboard-jump-add requires <sourceDashboardId> <targetDashboardId> <specJson> '
      + '--confirm-name <exactSourceDashboardName>; specJson must select exactly one '
      + 'sourcePortletId/sourceChart and targetFilterPortletId/targetFilter',
    );
  }
  await cmdDashboardJumpAdd(
    positional[0],
    positional[1],
    positional[2],
    confirmation,
  );
}

async function cmdDashboardJumpAdd(
  sourceDashboardId,
  targetDashboardId,
  specJson,
  confirmName,
) {
  const source = requireNamespacedResource(
    await loadDashboard(sourceDashboardId),
    'source dashboard',
  );
  const target = requireNamespacedResource(
    await loadDashboard(targetDashboardId),
    'target dashboard',
  );
  assertExactResourceConfirmation(source, confirmName);
  if (PLATFORM_PROFILE) {
    const [sourceParentId, targetParentId] = await Promise.all([
      locateCompetitionResourceParent(sourceDashboardId, 'source dashboard'),
      locateCompetitionResourceParent(targetDashboardId, 'target dashboard'),
    ]);
    if (sourceParentId !== targetParentId) {
      throw new Error('dashboard jump source and target must share one candidate folder');
    }
  }
  const spec = parseDashboardJumpSpec(specJson);
  const sourcePortlet = resolveDashboardPortletReference(
    source.define?.portlets || [],
    {
      portletId: spec.sourcePortletId,
      index: spec.sourceChart,
      kind: 'visualization',
      label: 'dashboard-jump-add source',
    },
  );
  const targetPortlet = resolveDashboardPortletReference(
    target.define?.portlets || [],
    {
      portletId: spec.targetFilterPortletId,
      index: spec.targetFilter,
      kind: 'filter',
      label: 'dashboard-jump-add target',
    },
  );
  const sourceField = locateDashboardPortletField(
    sourcePortlet,
    spec.field,
    spec.sourceSlot,
  );
  const targetField = locateDashboardPortletField(
    targetPortlet,
    spec.targetField,
    'filters',
  );
  const dataTypeFamily = assertCompatibleDashboardDataTypes(
    sourceField.field.dataType || sourcePortlet.extended?.dataType,
    targetField.field.dataType || targetPortlet.extended?.dataType,
  );
  const impactedTargetIds = assertFilterImpactsVisualization(target, targetPortlet);
  const rule = {
    name: spec.name,
    disabled: false,
    source: { trigger: 'RIGHT_CLICK', fieldIds: [] },
    target: {
      pageId: target.id,
      openType: spec.openType,
      url: 'http://',
      title: target.alias || target.name,
      width: 900,
      height: 600,
      providerName: 'SMARTBIX_PAGE',
      ...(spec.openType === 'DIALOG' ? {
        dialogSize: {
          unit: '%',
          widthRate: 72,
          heightRate: 72,
          width: 900,
          height: 600,
        },
      } : {}),
    },
    jumpType: '',
    method: 'post',
    params: [{
      sourceFieldIds: [
        sourcePortlet.id,
        `${sourceField.field.id};${sourceField.slot};${sourceField.index}`,
      ],
      paramType: 'select',
      targetFieldIds: [
        targetPortlet.id,
        `${targetField.field.id};filters;${targetField.index}`,
      ],
    }],
    urlParams: [{
      paramName: '',
      paramType: 'value',
      paramValues: '',
    }],
  };
  sourcePortlet.extended ||= {};
  sourcePortlet.extended.jumpRules = [
    ...(sourcePortlet.extended.jumpRules || []).filter(
      (candidate) => candidate?.name !== rule.name,
    ),
    rule,
  ];
  await smartbixApi('pages/beans?_method=PUT', {
    method: 'POST',
    body: source,
    timeoutMs: 120000,
  });
  const [saved, reopenedTarget] = await Promise.all([
    loadDashboard(source.id),
    loadDashboard(target.id),
  ]);
  assertSavedDashboardMatchesDefinition(saved, source);
  const savedSource = (saved.define?.portlets || []).find(
    (portlet) => portlet.id === sourcePortlet.id,
  );
  const savedRules = (savedSource?.extended?.jumpRules || []).filter(
    (candidate) => candidate?.name === rule.name,
  );
  if (savedRules.length !== 1) {
    throw new Error('dashboard conditional jump persistence mismatch: rule name is not unique');
  }
  const [savedRule] = savedRules;
  assertJumpRulePersisted(savedRule, rule);
  const reopenedTargetPortlet = resolveDashboardPortletReference(
    reopenedTarget.define?.portlets || [],
    {
      portletId: targetPortlet.id,
      kind: 'filter',
      label: 'dashboard-jump-add reopened target',
    },
  );
  const savedSourceField = locateDashboardPortletField(
    savedSource,
    sourceField.field.id,
    sourceField.slot,
  );
  const reopenedTargetField = locateDashboardPortletField(
    reopenedTargetPortlet,
    targetField.field.id,
    'filters',
  );
  if (
    savedSourceField.field.id !== sourceField.field.id
    || savedSourceField.slot !== sourceField.slot
    || savedSourceField.index !== sourceField.index
    || reopenedTargetField.field.id !== targetField.field.id
    || reopenedTargetField.slot !== targetField.slot
    || reopenedTargetField.index !== targetField.index
  ) {
    throw new Error('dashboard conditional jump field mapping changed after reopen');
  }
  const reopenedDataTypeFamily = assertCompatibleDashboardDataTypes(
    savedSourceField.field.dataType || savedSource.extended?.dataType,
    reopenedTargetField.field.dataType || reopenedTargetPortlet.extended?.dataType,
  );
  if (reopenedDataTypeFamily !== dataTypeFamily) {
    throw new Error('dashboard conditional jump field type contract changed after reopen');
  }
  const reopenedImpactIds = assertFilterImpactsVisualization(
    reopenedTarget,
    reopenedTargetPortlet,
  );
  if (
    JSON.stringify([...new Set(reopenedImpactIds)].sort())
    !== JSON.stringify([...new Set(impactedTargetIds)].sort())
  ) {
    throw new Error('dashboard conditional jump target impact scope changed after reopen');
  }
  safeOutput({
    ok: true,
    source: { id: saved.id, name: saved.name, portletId: sourcePortlet.id },
    target: {
      id: reopenedTarget.id,
      name: reopenedTarget.name,
      filterPortletId: reopenedTargetPortlet.id,
      impactedPortletIds: reopenedImpactIds,
    },
    field: {
      source: `${sourceField.field.id};${sourceField.slot};${sourceField.index}`,
      target: `${targetField.field.id};filters;${targetField.index}`,
      dataTypeFamily,
    },
    rule: savedRule,
  });
}

async function cmdDashboardCreateMulti(parentId, modelId, requestedName, chartsJson, description = '') {
  if (![parentId, modelId, requestedName, chartsJson].every(Boolean)) {
    throw new Error(
      'dashboard-create-multi requires <parentId> <modelId> <name> <chartsJson> [description]',
    );
  }
  await assertOwnedCatalogParent(parentId);
  await assertCompetitionResourceDirectChild(parentId, modelId, 'model');
  const model = requireNamespacedResource(await loadModel(modelId), 'model');
  const { dashboard, charts } = buildMultiDashboard(
    model,
    requestedName,
    chartsJson,
    description,
  );
  const proposal = auditDashboardPresentation(dashboard, charts.length);
  if (!proposal.ok) {
    throw new Error(`dashboard proposal is invalid: ${proposal.issues.join('; ')}`);
  }
  const result = await smartbixApi(
    `pages/beans/create?pid=${encodeURIComponent(parentId)}`,
    { method: 'POST', body: dashboard },
  );
  const createdId = createdResourceId(result, dashboard.id);
  const saved = await loadDashboard(createdId);
  const definition = assertSavedDashboardMatchesDefinition(saved, dashboard);
  const presentation = auditDashboardPresentation(saved, charts.length);
  if (!presentation.ok) {
    throw new Error(`dashboard saved presentation mismatch: ${presentation.issues.join('; ')}`);
  }
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    model: { id: model.id, name: model.name },
    portletCount: definition.portletCount,
    presentation,
  });
}

async function cmdDashboardRepairMultiArgs(argsList) {
  const { positional, confirmation } = parseExactConfirmationArgs(
    argsList,
    'dashboard-repair-multi',
    '--confirm-name',
  );
  if (positional.length < 3) {
    throw new Error(
      'dashboard-repair-multi requires <dashboardId> <modelId> <chartsJson> '
      + '[description] --confirm-name <exactDashboardName>',
    );
  }
  await cmdDashboardRepairMulti(
    positional[0],
    positional[1],
    positional[2],
    positional.slice(3).join(' '),
    confirmation,
  );
}

async function cmdDashboardRepairMulti(
  dashboardId,
  modelId,
  chartsJson,
  description = '',
  confirmName = null,
) {
  if (![dashboardId, modelId, chartsJson].every(Boolean)) {
    throw new Error(
      'dashboard-repair-multi requires <dashboardId> <modelId> <chartsJson> '
      + '[description] --confirm-name <exactDashboardName>',
    );
  }
  const current = requireNamespacedResource(
    await loadDashboard(dashboardId),
    'dashboard',
  );
  assertExactResourceConfirmation(current, confirmName);
  if (PLATFORM_PROFILE) {
    const dashboardParentId = await locateCompetitionResourceParent(dashboardId, 'dashboard');
    await assertCompetitionResourceDirectChild(dashboardParentId, modelId, 'model');
  }
  const original = structuredClone(current);
  assertDashboardRepairable(original);
  const model = requireNamespacedResource(await loadModel(modelId), 'model');
  const { dashboard: rebuilt, charts } = buildMultiDashboard(
    model,
    current.name,
    chartsJson,
    description || current.desc || '',
  );
  const repaired = {
    ...current,
    name: current.name,
    alias: current.alias || current.name,
    desc: description || current.desc || rebuilt.desc,
    define: rebuilt.define,
    editDefine: rebuilt.editDefine,
  };
  assertDashboardRepairable(repaired);
  const proposal = auditDashboardPresentation(repaired, charts.length);
  if (!proposal.ok) {
    throw new Error(`dashboard repair proposal is invalid: ${proposal.issues.join('; ')}`);
  }
  const beforeAudit = auditDashboardPresentation(original);
  await smartbixApi('pages/beans?_method=PUT', {
    method: 'POST',
    body: repaired,
    timeoutMs: 120000,
  });

  let saved;
  let definition;
  let presentation;
  try {
    saved = await loadDashboard(dashboardId);
    definition = assertSavedDashboardMatchesDefinition(saved, repaired);
    presentation = auditDashboardPresentation(saved, charts.length);
    if (!presentation.ok) {
      throw new Error(presentation.issues.join('; '));
    }
  } catch (postconditionError) {
    try {
      await smartbixApi('pages/beans?_method=PUT', {
        method: 'POST',
        body: original,
        timeoutMs: 120000,
      });
      const restored = await loadDashboard(dashboardId);
      assertSavedDashboardMatchesDefinition(restored, original);
    } catch (rollbackError) {
      throw new Error(
        `dashboard repair postcondition failed: ${postconditionError.message}; `
        + `original rollback could not be verified: ${rollbackError.message}`,
      );
    }
    throw new Error(
      `dashboard repair postcondition failed and the captured original was restored: `
      + postconditionError.message,
    );
  }
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    model: { id: model.id, name: model.name },
    removedIssues: beforeAudit.issues,
    definition,
    presentation,
  });
}

async function cmdDashboardCreate(
  parentId,
  modelId,
  dimensionName,
  measureName,
  requestedName,
  chartTitle,
) {
  if (![parentId, modelId, dimensionName, measureName, requestedName].every(Boolean)) {
    throw new Error('dashboard-create requires <parentId> <modelId> <dimension> <measure> <name> [chartTitle]');
  }
  await assertOwnedCatalogParent(parentId);
  await assertCompetitionResourceDirectChild(parentId, modelId, 'model');
  const model = requireNamespacedResource(await loadModel(modelId), 'model');
  const dashboard = buildBarDashboard(
    model,
    dimensionName,
    measureName,
    requestedName,
    chartTitle,
  );
  const proposal = auditDashboardPresentation(dashboard, 1);
  if (!proposal.ok) {
    throw new Error(`dashboard proposal is invalid: ${proposal.issues.join('; ')}`);
  }
  const result = await smartbixApi(
    `pages/beans/create?pid=${encodeURIComponent(parentId)}`,
    { method: 'POST', body: dashboard },
  );
  const createdId = createdResourceId(result, dashboard.id);
  const saved = await loadDashboard(createdId);
  const definition = assertSavedDashboardMatchesDefinition(saved, dashboard);
  const presentation = auditDashboardPresentation(saved, 1);
  if (!presentation.ok) {
    throw new Error(`dashboard saved presentation mismatch: ${presentation.issues.join('; ')}`);
  }
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    model: { id: model.id, name: model.name },
    portletCount: definition.portletCount,
    presentation,
  });
}
async function loadDashboard(dashboardId) {

  if (!dashboardId) throw new Error('dashboard id is required');
  await ensureSession();
  const result = await smartbixApi(`pages/beans?id=${encodeURIComponent(dashboardId)}`);
  const dashboard = Array.isArray(result) ? result[0] : result;
  if (!dashboard?.id) throw new Error(`dashboard not found or incomplete: ${dashboardId}`);
  return dashboard;
}

async function cmdDashboardGet(dashboardId) {
  safeOutput(requireNamespacedResource(await loadDashboard(dashboardId), 'dashboard'));
}

async function cmdDashboardClone(parentId, sourceDashboardId, requestedName, description = '') {
  if (![parentId, sourceDashboardId, requestedName].every(Boolean)) {
    throw new Error('dashboard-clone requires <parentId> <sourceDashboardId> <name> [description]');
  }
  await assertOwnedCatalogParent(parentId);
  await assertCompetitionResourceDirectChild(parentId, sourceDashboardId, 'source dashboard');
  const source = requireNamespacedResource(
    await loadDashboard(sourceDashboardId),
    'source dashboard',
  );
  const replacements = new Map([[source.id, resourceId()]]);
  for (const portlet of source.define?.portlets || []) replacements.set(portlet.id, resourceId());
  const dashboard = replaceExactStrings(source, replacements);
  dashboard.id = replacements.get(source.id);
  dashboard.name = dashboard.alias = applyNamespace(requestedName);
  dashboard.desc = description || source.desc || '';
  const result = await smartbixApi(
    `pages/beans/create?pid=${encodeURIComponent(parentId)}`,
    { method: 'POST', body: dashboard },
  );
  const createdId = createdResourceId(result, dashboard.id);
  const saved = await loadDashboard(createdId);
  const definition = assertSavedDashboardMatchesDefinition(saved, dashboard);
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    portletCount: definition.portletCount,
    definition,
  });
}


async function cmdAichat({
  modelId,
  question,
  mode,
  llmId = null,
  outputPath = null,
  overwrite = false,
  confirmPath = null,
}) {
  if (!modelId || !question || !['query', 'report'].includes(mode)) {
    throw new Error('AIChat requires an exact model, query|report mode, and non-blank prompt');
  }
  const model = await loadModel(modelId);
  if (model.id !== modelId) throw new Error('AIChat model response did not match the exact requested id');
  requireNamespacedResource(model, 'model');
  if (!hasNamespace(model.name)) {
    throw new Error(`refusing to query a model whose persisted name is not owned: ${model.name}`);
  }
  await assertCatalogPermission(model.id, 'READ', 'AIChat model');
  const selfRoot = await loadSelfRoot();
  const modelPath = await rmi('CatalogService', 'getCatalogElementPath', [model.id]);
  if (
    modelPath.retCode !== 0
    || !Array.isArray(modelPath.result)
    || !modelPath.result.some((node) => node?.id === selfRoot.id)
  ) {
    throw new Error('AIChat model is outside the current personal workspace');
  }
  let competitionPlacement = 'not-required';
  if (PLATFORM_PROFILE) {
    const parentId = await locateCompetitionResourceParent(model.id, 'AIChat model');
    await assertCompetitionResourceDirectChild(parentId, model.id, 'AIChat model');
    competitionPlacement = 'direct-candidate-child';
  }
  const modelAuthorization = {
    exactModelId: true,
    namespaceOwned: true,
    readPermission: true,
    personalWorkspace: true,
    competitionPlacement,
  };

  const { nodes } = await loadAichatGraphReadiness(model);
  const graphReadiness = assertAichatGraphReady({
    modelId: model.id,
    modelName: model.name,
    nodes,
  });
  const llmConfig = await plainJsonRequest('cgi/aichat-llm-config/list-llm-config', {
    body: { filterOption: { keyword: '' } },
  });
  const llm = selectAichatLlm(llmConfig?.result, llmId);
  const skillsResponse = await plainJsonRequest(
    'sdk/cgi/v1/aichat/skill/get-skill-items',
    { body: undefined },
  );
  const skills = selectAichatSkills(skillsResponse?.result, mode);
  const conversationId = shortId();
  const taskId = shortId(6);
  const payload = buildAichatRequest({
    model,
    question,
    mode,
    llm,
    skills,
    conversationId,
    taskId,
    messageId: shortId(6),
  });
  const stream = await plainJsonRequest('sdk/api/v1/aichat/conv/query-rpc', {
    body: payload,
    accept: 'text/event-stream',
    maxResponseBytes: DEFAULT_AICHAT_STREAM_LIMITS.maxStreamBytes,
    timeoutMs: 300000,
  });
  const parsed = parseAichatStream(stream, {
    expectedTaskId: taskId,
    expectedModelId: model.id,
  });
  const envelope = createAichatEnvelope({
    parsed,
    payload,
    mode,
    model,
    graphReadiness,
    modelAuthorization,
    llm,
    skills,
    question,
    conversationId,
    taskId,
  });
  if (outputPath) {
    safeOutput(writePrivateAichatEnvelope({
      outputPath,
      envelope,
      skillDir: SKILL_DIR,
      overwrite,
      confirmPath,
    }));
    return;
  }
  safeOutput(summarizeAichatEnvelope(envelope));
}

const AICHAT_GRAPH_LEAF_TYPES = new Set([
  'FIELD', 'GEO', 'LEVEL_GEO', 'LEVEL_TIME_YEAR', 'LEVEL_TIME_QUARTER',
  'LEVEL_TIME_MONTH', 'LEVEL_TIME_DAY', 'LEVEL_TIME_HALFYEAR', 'LEVEL_TIME_WEEK',
  'LEVEL', 'CALC', 'CALC_GROUP', 'GEO_LON', 'GEO_LAT', 'BUSINESS_ATTRIBUTE',
  'TABULAR_DATASET',
]);

const AICHAT_GRAPH_FILTER_TYPES = [
  'DIMENSION_FOLDER', 'FOLDER', 'HIERARCHY', 'HIERARCHY_TIME', 'BUSINESS_OBJECT',
  ...AICHAT_GRAPH_LEAF_TYPES,
];

function graphResult(response, operation) {
  if (!response || typeof response !== 'object') {
    throw new Error(`${operation} returned an invalid response`);
  }
  if (response.success === false) {
    const reason = typeof response.message === 'string'
      ? response.message
      : (typeof response.error === 'string' ? response.error : 'server rejected the request');
    throw new Error(`${operation} failed: ${reason}`);
  }
  return response.result;
}

function collectGraphFields(node, output = []) {
  if (!node || typeof node !== 'object') return output;
  if (AICHAT_GRAPH_LEAF_TYPES.has(node.type)) {
    output.push({
      id: node.id,
      name: node.name || null,
      alias: node.alias || node.label || node.name || null,
      type: node.type,
      parentId: node.parentId || null,
    });
  }
  for (const child of node.children || []) collectGraphFields(child, output);
  return output;
}

async function listAichatGraphNodes(keyword = '') {
  await ensureSession();
  const response = await plainJsonRequest('cgi/aichat-train/list-knowledge-graph-node', {
    body: {
      option: {
        filterEmptyFolder: true,
        keyword,
        types: ['AUGMENTED_DATASET'],
        statuses: ['SUCCESS', 'FAILED', 'BUILDING', 'PENDING'],
      },
    },
  });
  const nodes = graphResult(response, 'list model graphs');
  if (nodes == null) return [];
  if (!Array.isArray(nodes)) throw new Error('list model graphs returned an unsupported result shape');
  return nodes;
}

async function loadNamespacedGraphModel(modelId) {
  const model = await loadModel(modelId);
  if (!hasNamespace(model.name)) {
    throw new Error(`refusing to use non-namespaced model graph: ${model.name}`);
  }
  return model;
}

async function loadAuthorizedAichatGraphMutationTarget({
  parentId,
  modelId,
  confirmName,
}) {
  await assertOwnedCatalogParent(parentId);
  const catalogChildren = await listCatalogChildren(parentId, 'model graph parent');
  const model = await loadModel(modelId);
  const competitionParentId = PLATFORM_PROFILE
    ? await locateCompetitionResourceParent(modelId, 'model graph')
    : null;
  const authorization = authorizeAichatGraphMutationTarget({
    parentId,
    requestedModelId: modelId,
    model,
    catalogChildren,
    confirmName,
    competitionParentId,
  });
  assertNamespacedResource(authorization.catalogResource);
  if (!hasNamespace(model.name)) {
    throw new Error(`refusing to modify non-namespaced model graph: ${model.name}`);
  }
  if (PLATFORM_PROFILE) {
    await assertCompetitionResourceDirectChild(parentId, modelId, 'model graph');
  }
  await assertCatalogPermission(parentId, 'WRITE', 'model graph parent');
  await assertCatalogPermission(modelId, 'WRITE', 'model graph');
  return {
    model,
    authorization: {
      ...authorization,
      checked: {
        ...authorization.checked,
        catalogParentOwned: true,
        parentWritePermission: true,
        modelWritePermission: true,
      },
    },
  };
}

async function loadAichatGraphFields(modelId, currentModel = null) {
  const model = currentModel || await loadNamespacedGraphModel(modelId);
  if (model.id !== modelId) throw new Error('model graph field target changed during authorization');
  const response = await plainJsonRequest(
    `cgi/aichat-train/get-resource-field-tree/${encodeURIComponent(model.id)}`,
    { body: { fieldTreeOption: { filterTypes: AICHAT_GRAPH_FILTER_TYPES } } },
  );
  const tree = graphResult(response, 'load model graph fields');
  if (!tree) throw new Error(`model graph field tree is unavailable: ${model.name}`);
  return { model, tree, fields: collectGraphFields(tree) };
}

async function loadAichatGraphReadiness(model) {
  const nodes = await listAichatGraphNodes(model.name);
  return {
    nodes,
    status: inspectAichatGraphStatus({
      modelId: model.id,
      modelName: model.name,
      nodes,
    }),
  };
}

async function cmdAichatGraphList(keyword = '') {
  const nodes = (await listAichatGraphNodes(keyword)).filter((node) => hasNamespace(node.name));
  safeOutput({
    ok: true,
    count: nodes.length,
    ownershipEvidence: 'namespace-marker-only',
    graphs: nodes.map((node) => {
      const status = inspectAichatGraphNode(node);
      return {
        id: node.id,
        name: node.name,
        type: node.type,
        pathObserved: Boolean(node.path),
        status: status.status,
        updateTime: status.updateTime,
        duration: status.duration,
        fieldCount: status.persistedFieldIds.length,
        persistedFieldIdsObserved: status.persistedFieldIdsObserved,
        revisionFreshness: status.revisionFreshness,
        revisionEvidence: status.revisionEvidence,
      };
    }),
  });
}

async function cmdAichatGraphFields(modelId) {
  if (!modelId) throw new Error('aichat-graph-fields requires <modelId>');
  const { model, fields } = await loadAichatGraphFields(modelId);
  safeOutput({
    ok: true,
    model: { id: model.id, name: model.name },
    ownershipEvidence: 'namespace-marker-only',
    fieldCount: fields.length,
    fields,
    checked: { exactModelId: true, fieldTreeLoaded: true },
  });
}

async function cmdAichatGraphStatus(modelId) {
  if (!modelId) throw new Error('aichat-graph-status requires <modelId>');
  const model = await loadNamespacedGraphModel(modelId);
  const { nodes, status } = await loadAichatGraphReadiness(model);
  const ready = status.status === 'SUCCESS'
    ? assertAichatGraphReady({ modelId: model.id, modelName: model.name, nodes })
    : null;
  safeOutput({
    ok: true,
    id: model.id,
    name: model.name,
    ownershipEvidence: 'namespace-marker-only',
    status: status.status,
    ready: Boolean(ready),
    updateTime: status.updateTime,
    duration: status.duration,
    fields: ready?.persistedFieldIds || status.persistedFieldIds,
    persistedFieldIdsObserved: status.persistedFieldIdsObserved,
    revisionFreshness: status.revisionFreshness,
    revisionEvidence: status.revisionEvidence,
    checked: ready?.checked || status.checked,
  });
}

async function validateAichatGraphBuild({
  model,
  parentId,
  fieldIds,
  etlFlowId,
}) {
  const result = graphResult(
    await plainJsonRequest(
      `cgi/aichat-train/validate_field_data_count/${encodeURIComponent(model.id)}`,
      { body: { fieldIds } },
    ),
    'validate model graph fields',
  );
  if (!result?.valid) {
    throw new Error(`model graph field validation failed: ${result?.message || 'unknown reason'}`);
  }
  if (!PLATFORM_PROFILE) return { valid: true, trainingLimit: null };
  const validatorCount = extractAichatValidationCount(result);
  const evidence = await loadCompetitionModelTrainingEvidence({
    model,
    parentId,
    sourceFlowId: etlFlowId,
    validatorCount,
  });
  const count = assertCompetitionTrainingCount(
    PLATFORM_PROFILE,
    { rowCount: evidence.count },
  );
  return {
    valid: true,
    trainingLimit: {
      ...evidence,
      count,
      limit: PLATFORM_PROFILE.aichatTrainingLimit,
    },
  };
}

async function cmdAichatGraphBuildArgs(argsList) {
  const options = parseAichatGraphBuildArgs(argsList, {
    requireEtlFlow: Boolean(PLATFORM_PROFILE),
  });
  if (!PLATFORM_PROFILE && options.etlFlowId) {
    throw new Error('aichat-graph-build --etl-flow is valid only for the competition profile');
  }
  await cmdAichatGraphBuild(options);
}

async function cmdAichatGraphBuild({
  parentId,
  modelId,
  selectors,
  confirmName,
  etlFlowId = null,
  rebuild = false,
}) {
  const target = await loadAuthorizedAichatGraphMutationTarget({
    parentId,
    modelId,
    confirmName,
  });
  const { model, fields } = await loadAichatGraphFields(modelId, target.model);
  const selected = resolveUniqueGraphFields(fields, selectors);
  const fieldIds = selected.map((field) => field.id);
  const initialCheck = await loadAichatGraphReadiness(model);
  planAichatGraphBuild({
    status: initialCheck.status.status,
    requestedFieldIds: fieldIds,
    persistedFieldIds: initialCheck.status.persistedFieldIds,
    persistedFieldIdsObserved: initialCheck.status.persistedFieldIdsObserved,
    rebuild,
  });
  const preSubmitValidation = await validateAichatGraphBuild({
    model,
    parentId,
    fieldIds,
    etlFlowId,
  });
  const preSubmitTarget = await loadAuthorizedAichatGraphMutationTarget({
    parentId,
    modelId,
    confirmName,
  });
  const mutationModel = preSubmitTarget.model;
  const initial = await loadAichatGraphReadiness(mutationModel);
  const buildPlan = planAichatGraphBuild({
    status: initial.status.status,
    requestedFieldIds: fieldIds,
    persistedFieldIds: initial.status.persistedFieldIds,
    persistedFieldIdsObserved: initial.status.persistedFieldIdsObserved,
    rebuild,
  });
  const trainResult = graphResult(
    await plainJsonRequest(
      `cgi/aichat-train/train-resource/${encodeURIComponent(mutationModel.id)}`,
      {
        body: {
          trainOption: {
            resourceType: 'AUGMENTED_DATASET',
            fields: fieldIds,
            background: '',
          },
        },
        timeoutMs: 300000,
      },
    ),
    'build model graph',
  );
  if (trainResult == null || trainResult === false) {
    throw new Error('model graph build was not accepted');
  }

  const deadline = Date.now() + 300000;
  let observedStatus = 'PENDING';
  let observedConcurrentState = false;
  let completionEvidence = null;
  while (Date.now() < deadline) {
    const observed = await loadAichatGraphReadiness(mutationModel);
    observedStatus = observed.status.status;
    if (['BUILDING', 'PENDING'].includes(observedStatus)) {
      observedConcurrentState = true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    if (observedStatus === 'SUCCESS') {
      completionEvidence = aichatGraphBuildCompletionEvidence({
        initialStatus: initial.status.status,
        requestedFieldIds: fieldIds,
        initialPersistedFieldIds: initial.status.persistedFieldIds,
        initialPersistedFieldIdsObserved: initial.status.persistedFieldIdsObserved,
        initialUpdateTime: initial.status.updateTime,
        finalStatus: observed.status.status,
        finalPersistedFieldIds: observed.status.persistedFieldIds,
        finalPersistedFieldIdsObserved: observed.status.persistedFieldIdsObserved,
        finalUpdateTime: observed.status.updateTime,
        observedConcurrentState,
      });
      if (!completionEvidence) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      break;
    }
    if (observedStatus === 'FAILED') throw new Error('model graph build failed');
    if (observedStatus !== 'NOTBUILD') {
      throw new Error(`model graph build returned unsupported state ${observedStatus}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!completionEvidence) {
    throw new Error(
      `model graph build timed out without new completion evidence; last status ${observedStatus}`,
    );
  }

  const reopenedTarget = await loadAuthorizedAichatGraphMutationTarget({
    parentId,
    modelId,
    confirmName,
  });
  const finalNodes = await listAichatGraphNodes(reopenedTarget.model.name);
  const ready = assertAichatGraphReady({
    modelId: reopenedTarget.model.id,
    modelName: reopenedTarget.model.name,
    nodes: finalNodes,
  });
  const persistedFieldIds = assertExactPersistedGraphFieldIds(
    fieldIds,
    ready.persistedFieldIds,
  );
  const postBuildValidation = PLATFORM_PROFILE
    ? await validateAichatGraphBuild({
        model: reopenedTarget.model,
        parentId,
        fieldIds,
        etlFlowId,
      })
    : preSubmitValidation;
  safeOutput({
    ok: true,
    id: reopenedTarget.model.id,
    name: reopenedTarget.model.name,
    status: ready.status,
    reused: false,
    buildAction: buildPlan.action,
    priorStatus: buildPlan.priorStatus,
    buildCompletionEvidence: completionEvidence,
    rebuildConfirmed: rebuild,
    updateTime: ready.updateTime,
    duration: ready.duration,
    revisionFreshness: 'unknown',
    revisionEvidence: null,
    requestedSelectors: selectors,
    requestedFieldIds: fieldIds,
    persistedFieldIds,
    trainingLimit: postBuildValidation.trainingLimit,
    checked: {
      ...reopenedTarget.authorization.checked,
      preSubmitAuthorization: true,
      fieldValidation: true,
      ...(PLATFORM_PROFILE ? { trainingCountReopened: true } : {}),
      graphReopened: true,
      terminalSuccess: true,
      persistedFieldIdsExact: true,
      buildCompletionEvidence: true,
    },
  });
}

async function loadAuthenticatedAgentRoot(purview = 'READ') {
  const selfRoot = await loadSelfRoot();
  const rootId = agentRootIdForSelf(selfRoot.id);
  const root = await loadCatalogElement(rootId, 'authenticated Agent workspace root');
  if (root.id !== rootId) throw new Error('authenticated Agent workspace root identity changed');
  await assertCatalogPermission(root.id, purview, 'Agent workspace root');
  const children = await listCatalogChildren(root.id, 'authenticated Agent workspace root');
  return { root, children };
}

async function loadOwnedAgent(
  agentId,
  {
    purview = 'READ',
    expectedPrompts = null,
  } = {},
) {
  if (!agentId) throw new Error('agent id is required');
  const rootState = await loadAuthenticatedAgentRoot(purview);
  const catalogResource = findDirectOwnedAgentChild(agentId, rootState.children);
  assertNamespacedResource(catalogResource);
  await assertCatalogPermission(catalogResource.id, purview, 'Agent');

  const rawAgent = await smartbixApi(`dataagent/graph/${encodeURIComponent(agentId)}`);
  const { agent, contract } = validateSupportedAgentResource(rawAgent, expectedPrompts);
  assertNamespacedResource(agent);
  assertOwnedAgentGraphIdentity(agent, catalogResource, rootState.root.id);
  return { ...rootState, agent, catalogResource, contract };
}

async function reopenOwnedAgent(expected, purview = 'READ') {
  const current = await loadOwnedAgent(expected.agent.id, { purview });
  if (current.root.id !== expected.root.id) {
    throw new Error('authenticated Agent workspace changed during the operation');
  }
  assertDirectResourceSnapshot(
    expected.catalogResource,
    current.catalogResource,
    current.root.id,
  );
  assertSameAgentGraphContract(current.contract, expected.contract);
  return current;
}

function setAgentConfig(node, name, value) {
  const configs = node.configs?.filter((item) => item.name === name) || [];
  if (configs.length !== 1) {
    throw new Error(`${node.name} template requires exactly one config: ${name}`);
  }
  configs[0].value = value;
}

function instantiateAgentNode(template, x, color) {
  const node = structuredClone(template);
  node.id = resourceId();
  node.type = node.name;
  node.x = x;
  node.y = 0;
  node.needCache = false;
  node.state = 'INITED';
  node.color = color;
  for (const port of [...(node.inputs || []), ...(node.outputs || [])]) {
    port.id = resourceId();
    port.label ||= `${port === node.inputs?.[0] ? '输入' : '输出'}${(port.order || 0) + 1}`;
    if (port.varOptions) port.varOptions.value = port.id;
  }
  return node;
}

async function buildBasicAgent(systemPrompt, userPrompt) {
  const catalog = await smartbixApi('dataagent/getNodeOptions');
  const findTemplate = (name) => catalog?.basic?.filter((item) => item.name === name) || [];
  const templateMatches = ['StartNode', 'LLM', 'FinishNode'].map(findTemplate);
  if (templateMatches.some((matches) => matches.length !== 1)) {
    throw new Error('Agent node catalog must contain exactly one StartNode, LLM, and FinishNode template');
  }

  const start = instantiateAgentNode(templateMatches[0][0], 0, '#5E9F76');
  const llm = instantiateAgentNode(templateMatches[1][0], 290, '#3F99E7');
  const finish = instantiateAgentNode(templateMatches[2][0], 580, '#5E9F76');
  if (
    start.outputs?.length !== 1
    || llm.inputs?.length !== 1
    || llm.outputs?.length !== 1
    || finish.inputs?.length !== 1
  ) {
    throw new Error('Agent node templates do not expose the supported linear port contract');
  }
  start.outputs[0].varOptions = {
    label: `${start.alias}-输出1`,
    value: start.outputs[0].id,
    children: [{ label: '用户分析问题', type: 'String', value: 'question' }],
  };
  llm.outputs[0].varOptions = {
    ...(llm.outputs[0].varOptions || {}),
    label: `${llm.alias}-输出1`,
    value: llm.outputs[0].id,
  };

  setAgentConfig(
    start,
    'param',
    JSON.stringify([{ selectLeftOption: 'question', selectRightOption: 'String', descOption: '用户分析问题' }]),
  );
  setAgentConfig(llm, 'llmConfigSelect', JSON.stringify({ id: 'default', value: 'default', type: 'default' }));
  setAgentConfig(
    llm,
    'varSetting',
    JSON.stringify([{ selectLeftOption: 'question', selectRightOption: ['sessionVar', 'query'] }]),
  );
  setAgentConfig(llm, 'mcpSetting', JSON.stringify([{ selectValue: null }]));
  setAgentConfig(llm, 'systemPrompt', systemPrompt);
  setAgentConfig(llm, 'userPrompt', userPrompt);
  setAgentConfig(llm, 'outputType', JSON.stringify(['summary']));
  setAgentConfig(finish, 'outputMode', JSON.stringify(['any']));
  setAgentConfig(
    finish,
    'finishSetting',
    JSON.stringify([{
      selectLeftOption: 'update_attachment_markdown',
      selectRightOption: [llm.outputs[0].id, 'result_content'],
    }]),
  );

  const define = {
    nodes: [start, llm, finish],
    links: [
      {
        from: start.id,
        to: llm.id,
        outputPortName: llm.inputs[0].label,
        inputPortName: start.outputs[0].label,
        inputPortId: start.outputs[0].id,
        outputPortId: llm.inputs[0].id,
      },
      {
        from: llm.id,
        to: finish.id,
        outputPortName: finish.inputs[0].label,
        inputPortName: llm.outputs[0].label,
        inputPortId: llm.outputs[0].id,
        outputPortId: finish.inputs[0].id,
      },
    ],
    top: 0,
    left: 0,
  };
  assertSupportedAgentGraph(define, { systemPrompt, userPrompt });
  return define;
}

async function loadAgentDeployment(agentId, { required = false } = {}) {
  const raw = await smartbixApi(`dataagent/deploy/agent/${encodeURIComponent(agentId)}`);
  return assertAgentDeploymentRelations(raw, agentId, { required });
}

async function cmdAgentGet(agentId) {
  assertProfileAllowsAgent(PLATFORM_PROFILE);
  const owned = await loadOwnedAgent(agentId);
  const deployment = await loadAgentDeployment(owned.agent.id);
  safeOutput({
    ok: true,
    ...summarizeAgentResource(owned.agent, owned.contract),
    deployed: deployment !== null,
    deployment: summarizeAgentDeploymentRelation(deployment),
  });
}

async function cmdAgentCreate(
  parentId,
  requestedName,
  description = '',
  systemPrompt = '你是数据分析助手。仅基于已提供的数据和上下文回答，区分事实、推断与建议；不编造指标或因果结论。',
  userPrompt = '请回答以下用户问题，并给出可核验的分析：{{question}}',
) {
  assertProfileAllowsAgent(PLATFORM_PROFILE);
  if (!parentId || !requestedName) {
    throw new Error('agent-create requires <parentId> <name> [description] [systemPrompt] [userPrompt]');
  }
  const rootState = await loadAuthenticatedAgentRoot('WRITE');
  if (parentId !== rootState.root.id) {
    throw new Error('agent-create requires the exact authenticated Agent workspace root');
  }
  const name = applyNamespace(requestedName);
  const collisions = rootState.children.filter((resource) => (
    resource?.name === name || resource?.alias === name
  ));
  if (collisions.length > 1) {
    throw new Error(`multiple direct Agent resources already use the requested name: ${name}`);
  }
  if (collisions.length === 1) {
    const existing = await loadOwnedAgent(collisions[0].id, {
      purview: 'WRITE',
      expectedPrompts: { systemPrompt, userPrompt },
    });
    assertDirectResourceSnapshot(
      collisions[0],
      existing.catalogResource,
      existing.root.id,
    );
    if (existing.agent.name !== name || existing.agent.alias !== name) {
      throw new Error('requested Agent name collides with a different current name or alias');
    }
    if (!Object.hasOwn(existing.agent, 'desc') || String(existing.agent.desc ?? '') !== description) {
      throw new Error('existing Agent description does not match the requested value');
    }
    safeOutput({
      ok: true,
      created: false,
      reused: true,
      ...summarizeAgentResource(existing.agent, existing.contract),
    });
    return;
  }

  const define = await buildBasicAgent(systemPrompt, userPrompt);
  const expectedContract = assertSupportedAgentGraph(define, { systemPrompt, userPrompt });
  const result = await smartbixApi(`dataagent/graph/create/${encodeURIComponent(parentId)}`, {
    method: 'POST',
    body: {
      id: null,
      name,
      alias: name,
      desc: description,
      define: JSON.stringify(define),
      params: JSON.stringify({ sysParam: [], customParam: [] }),
    },
  });
  const id = createdResourceId(result);
  if (!id) throw new Error('Agent create returned no resource id');
  const saved = await loadOwnedAgent(id, {
    purview: 'WRITE',
    expectedPrompts: { systemPrompt, userPrompt },
  });
  if (saved.agent.name !== name || saved.agent.alias !== name) {
    throw new Error('saved Agent name does not match the requested exact name');
  }
  if (!Object.hasOwn(saved.agent, 'desc') || String(saved.agent.desc ?? '') !== description) {
    throw new Error('saved Agent description does not match the requested value');
  }
  assertSameAgentGraphContract(saved.contract, expectedContract);
  const finalRoot = await loadAuthenticatedAgentRoot('WRITE');
  const finalResource = findDirectOwnedAgentChild(saved.agent.id, finalRoot.children);
  assertDirectResourceSnapshot(saved.catalogResource, finalResource, finalRoot.root.id);
  const finalNameMatches = finalRoot.children.filter((resource) => (
    resource?.name === name || resource?.alias === name
  ));
  if (finalNameMatches.length !== 1 || finalNameMatches[0].id !== saved.agent.id) {
    throw new Error('saved Agent name is not unique in the authenticated Agent root');
  }
  safeOutput({
    ok: true,
    created: true,
    reused: false,
    ...summarizeAgentResource(saved.agent, saved.contract),
  });
}

async function cmdAgentRunArgs(argsList) {
  assertProfileAllowsAgent(PLATFORM_PROFILE);
  const { positional, confirmation } = parseExactConfirmationArgs(
    argsList,
    'agent-run',
    '--confirm-name',
  );
  if (positional.length < 2) {
    throw new Error('agent-run requires <agentId> <question> --confirm-name <exactAgentName>');
  }
  await cmdAgentRun(positional[0], positional.slice(1).join(' '), confirmation);
}

async function cmdAgentRun(agentId, question, confirmName) {
  assertProfileAllowsAgent(PLATFORM_PROFILE);
  if (!agentId || !question) {
    throw new Error('agent-run requires <agentId> <question> --confirm-name <exactAgentName>');
  }
  const owned = await loadOwnedAgent(agentId, { purview: 'WRITE' });
  assertExactAgentNameConfirmation(owned.agent, confirmName);
  const instanceId = resourceId();
  await smartbixApi('dataagent/test/flow', {
    method: 'POST',
    body: {
      query: question,
      queryType: `customagent_${owned.agent.id}`,
      currentInstanceId: instanceId,
      flowId: owned.agent.id,
      convId: instanceId,
    },
  });

  let state = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    state = await smartbixApi(`dataagent/flow/nodestate/${encodeURIComponent(instanceId)}`);
    if (isAgentTerminalState(state?.state)) break;
  }
  if (!state || !isAgentTerminalState(state.state)) {
    throw new Error(`Agent run timed out: ${instanceId}`);
  }
  assertAgentNodeStatesSucceeded(state, owned.contract.nodeIds);
  const outputId = agentOutputResourceId(owned.contract.finish.sourceNodeId, instanceId);
  const outputRecords = await smartbixApi(`dataagent/output/${encodeURIComponent(outputId)}`);
  const finishOutput = extractAgentFinishOutput(outputRecords);
  const answer = assertAgentRunSucceeded(state, {
    expectedNodeIds: owned.contract.nodeIds,
    finishOutput,
  });
  const outputReceipt = createAgentOutputReceipt({ ...finishOutput, content: answer });
  const finalAgent = await reopenOwnedAgent(owned, 'WRITE');
  assertExactAgentNameConfirmation(finalAgent.agent, confirmName);
  const agentReceipt = summarizeAgentResource(finalAgent.agent, finalAgent.contract);
  safeOutput({
    ok: true,
    id: instanceId,
    agent: { id: agentReceipt.id, name: agentReceipt.name },
    graphContract: agentReceipt.graph.contract,
    state: 'FINISH',
    answer: outputReceipt.content,
    answerTruncated: outputReceipt.truncated,
    answerRedacted: outputReceipt.redacted,
    finishOutput: {
      verified: true,
      sourceField: finalAgent.contract.finish.field,
      originalLength: outputReceipt.originalLength,
      inputTokens: outputReceipt.inputTokens,
      outputTokens: outputReceipt.outputTokens,
    },
    nodeStates: summarizeAgentNodeStates(state, finalAgent.contract.nodeIds),
  });
}

async function cmdAgentDeployArgs(argsList) {
  assertProfileAllowsAgent(PLATFORM_PROFILE);
  const { positional, confirmation } = parseExactConfirmationArgs(
    argsList,
    'agent-deploy',
    '--confirm-name',
  );
  if (positional.length !== 1) {
    throw new Error('agent-deploy requires <agentId> --confirm-name <exactAgentName>');
  }
  await cmdAgentDeploy(positional[0], confirmation);
}

async function cmdAgentDeploy(agentId, confirmName) {
  assertProfileAllowsAgent(PLATFORM_PROFILE);
  const owned = await loadOwnedAgent(agentId, { purview: 'WRITE' });
  assertExactAgentNameConfirmation(owned.agent, confirmName);
  const before = await loadAgentDeployment(owned.agent.id);
  let relation = before;
  let createAttempted = false;
  let createResponseUnavailable = false;
  if (!relation) {
    createAttempted = true;
    try {
      await smartbixApi('dataagent/relation/create', {
        method: 'POST',
        body: { id: null, agentId: owned.agent.id, resId: null },
      });
    } catch {
      createResponseUnavailable = true;
    }
    for (let attempt = 0; attempt < 5 && !relation; attempt += 1) {
      relation = await loadAgentDeployment(owned.agent.id);
      if (!relation && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
  if (!relation) {
    throw new Error(`Agent deployment relation was not persisted: ${owned.agent.id}`);
  }

  const finalAgent = await reopenOwnedAgent(owned, 'WRITE');
  assertExactAgentNameConfirmation(finalAgent.agent, confirmName);
  const persisted = await loadAgentDeployment(finalAgent.agent.id, { required: true });
  if (persisted.id !== relation.id) {
    throw new Error('Agent deployment relation changed during postcondition verification');
  }
  safeOutput({
    ok: true,
    id: finalAgent.agent.id,
    name: finalAgent.agent.name,
    deployed: true,
    alreadyDeployed: before !== null,
    createAttempted,
    createResponseUnavailable,
    deployment: summarizeAgentDeploymentRelation(persisted),
  });
}


async function cmdTree(rootId) {
  await ensureSession();
  const id = rootId || '';
  const nodes = (await listCatalogChildren(id, 'catalog tree')).map((node) => ({
    id: node.id,
    name: node.name,
    alias: node.alias,
    type: node.type,
    hasChild: node.hasChild,
  }));
  safeOutput({ parent: id, nodes });
}

async function cmdCatalogAudit(rootId) {
  if (!rootId) throw new Error('catalog-audit requires <rootId>');
  await ensureSession();
  const root = await loadCatalogElement(rootId, 'catalog audit root');
  const queue = [{ parentId: root.id, path: [root.alias || root.name] }];
  const visited = new Set();
  const nodes = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (visited.has(current.parentId)) continue;
    visited.add(current.parentId);
    if (visited.size > 2000) throw new Error('catalog audit exceeded 2000 folders');
    const children = await listCatalogChildren(current.parentId, 'catalog audit');
    for (const node of children) {
      const label = node.alias || node.name;
      const path = [...current.path, label];
      nodes.push({
        id: node.id,
        parentId: current.parentId,
        name: node.name,
        alias: node.alias,
        type: node.type,
        hasChild: node.hasChild,
        namespaced: hasNamespace(node.name) || hasNamespace(node.alias),
        path,
      });
      if (shouldTraverseCatalogNode(node)) queue.push({ parentId: node.id, path });
    }
  }
  safeOutput({
    ok: true,
    root: { id: root.id, name: root.name, alias: root.alias, type: root.type },
    count: nodes.length,
    namespacedCount: nodes.filter((node) => node.namespaced).length,
    nodes,
  });
}

async function loadSelfRoot() {
  await ensureSession();
  const selfRoot = (await listCatalogChildren('', 'catalog root'))
    .find((node) => node.type === 'SELF_TREENODE');
  if (!selfRoot?.id) {
    throw new Error('cannot resolve the current personal workspace root');
  }
  return selfRoot;
}

async function loadCatalogElement(resourceId, label = 'catalog resource') {
  const response = await rmi('CatalogService', 'getCatalogElementById', [resourceId]);
  if (response.retCode !== 0 || !response.result?.id) {
    throw new Error(`${label} not found: ${resourceId}`);
  }
  return response.result;
}

async function listCatalogChildren(parentId, label = 'catalog parent') {
  return normalizeCatalogElements(
    await rmi('CatalogService', 'getChildElements', [parentId]),
    label,
  );
}

async function recheckDirectCatalogResource(parentId, expected, label = 'resource parent') {
  const children = await listCatalogChildren(parentId, label);
  const current = children.find((node) => node.id === expected.id);
  assertDirectResourceSnapshot(expected, current, parentId);
  return { current, children };
}

function assertCatalogNameAvailable(children, name, alias = name, ignoredId = null) {
  const conflict = findCatalogCollision(children, { name, alias, ignoredId });
  if (conflict) {
    throw new Error(`catalog parent already contains a conflicting resource: ${conflict.id}`);
  }
}

async function rollbackCreatedCatalogEntries(journal) {
  const failures = [];
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    let current;
    try {
      const state = await recheckDirectCatalogResource(
        entry.parentId,
        entry,
        'rollback resource parent',
      );
      current = state.current;
      if (Object.hasOwn(entry, 'description')) {
        const detail = await loadCatalogElement(current.id, 'rollback resource');
        if (String(detail.desc || '') !== String(entry.description || '')) {
          failures.push(`${current.id}: description changed after creation`);
          continue;
        }
      }
      if (isKnownCatalogFolder(current)) {
        const children = await listCatalogChildren(current.id, 'rollback folder');
        if (children.length > 0) {
          failures.push(`${current.id}: folder is no longer empty`);
          continue;
        }
      }
      const deleted = await rmi('CatalogService', 'deleteCatalogElement', [current.id]);
      if (deleted.retCode !== 0) {
        failures.push(`${current.id}: delete failed`);
        continue;
      }
      const after = await listCatalogChildren(entry.parentId, 'rollback parent after deletion');
      if (after.some((node) => node.id === current.id)) {
        failures.push(`${current.id}: still visible`);
      }
    } catch (error) {
      const siblings = await listCatalogChildren(entry.parentId, 'rollback resource parent');
      if (siblings.some((node) => node.id === entry.id)) {
        failures.push(`${entry.id}: ${error.message}`);
      }
    }
  }
  for (const entry of journal) {
    try {
      const probe = await rmi('CatalogService', 'getCatalogElementById', [entry.id]);
      if (probe.retCode === 0 && probe.result?.id === entry.id) {
        failures.push(`${entry.id}: still exists after rollback`);
      }
    } catch {
      failures.push(`${entry.id}: rollback absence could not be verified`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`catalog rollback incomplete: ${failures.join('; ')}`);
  }
}

async function assertOwnedCatalogParent(
  parentId,
  {
    allowSelfRoot = false,
    allowAgentRoot = false,
  } = {},
) {
  const selfRoot = await loadSelfRoot();
  const agentRootId = `SELF_AGENT_GRAPHS_${String(selfRoot.id).replace(/^SELF_/, '')}`;
  const parent = parentId === selfRoot.id
    ? selfRoot
    : await loadCatalogElement(parentId, 'catalog parent');
  const exactAgentRoot = !PLATFORM_PROFILE && allowAgentRoot && parentId === agentRootId;
  const pathResponse = parentId === selfRoot.id || exactAgentRoot
    ? { retCode: 0, result: [parent] }
    : await rmi('CatalogService', 'getCatalogElementPath', [parentId]);
  if (pathResponse.retCode !== 0 || !Array.isArray(pathResponse.result)) {
    throw new Error(`catalog parent is outside the current personal workspace: ${parentId}`);
  }
  const path = pathResponse.result;

  if (PLATFORM_PROFILE) {
    const personalChildren = await listCatalogChildren(selfRoot.id, 'personal workspace root');
    const competitionRoot = assertCompetitionCatalogDestination(PLATFORM_PROFILE, {
      personalRootId: selfRoot.id,
      parent,
      path,
      personalChildren,
    });
    return assertContiguousOwnedFolderChain({
      parent,
      path,
      rootId: competitionRoot.id,
      domain: 'competition',
      isOwned: (node) => hasNamespace(node.name) || hasNamespace(node.alias),
    });
  }

  const inAgentDomain = parentId === agentRootId
    || path.some((node) => node.id === agentRootId);
  if (inAgentDomain) {
    if (!allowAgentRoot) {
      throw new Error(`catalog parent is outside the current personal workspace: ${parentId}`);
    }
    const agentRoot = parentId === agentRootId
      ? parent
      : await loadCatalogElement(agentRootId, 'agent workspace root');
    return assertContiguousOwnedFolderChain({
      parent,
      path: parentId === agentRootId ? [agentRoot] : path,
      rootId: agentRoot.id,
      domain: 'agent',
      isOwned: (node) => hasNamespace(node.name) || hasNamespace(node.alias),
    });
  }

  if (parentId === selfRoot.id && !allowSelfRoot) {
    throw new Error(`refusing a non-owned catalog parent: ${parentId}`);
  }
  if (parentId !== selfRoot.id && !path.some((node) => node.id === selfRoot.id)) {
    throw new Error(`catalog parent is outside the current personal workspace: ${parentId}`);
  }
  return assertContiguousOwnedFolderChain({
    parent,
    path,
    rootId: selfRoot.id,
    domain: 'workspace',
    isOwned: (node) => hasNamespace(node.name) || hasNamespace(node.alias),
  });
}


async function cmdFolderCreate(parentId, requestedName, description = '') {
  if (!parentId || !requestedName) {
    throw new Error('folder-create requires <parentId> <name> [description]');
  }
  let parentContext = await assertOwnedCatalogParent(parentId, {
    allowSelfRoot: true,
    allowAgentRoot: true,
  });
  if (!parentContext.isDomainRoot && !isCopyableCatalogFolder(parentContext.parent)) {
    throw new Error(`folder-create cannot place a folder under ${parentContext.parent.type}`);
  }
  const name = applyNamespace(requestedName);
  let children = await listCatalogChildren(parentId, 'folder parent');
  const existing = findCatalogCollision(children, { name, alias: name });
  if (existing) {
    if (
      !isCopyableCatalogFolder(existing)
      || existing.name !== name
      || existing.alias !== name
      || (!hasNamespace(existing.name) && !hasNamespace(existing.alias))
    ) {
      throw new Error(`folder name collides with an existing resource: ${existing.id}`);
    }
    const detail = await loadCatalogElement(existing.id, 'existing folder');
    if (description && String(detail.desc || '') !== description) {
      throw new Error(`folder already exists with a different description: ${existing.id}`);
    }
    safeOutput({
      ok: true,
      created: false,
      id: existing.id,
      name: existing.name,
      alias: existing.alias,
    });
    return;
  }

  await assertCatalogPermission(parentId, 'WRITE', 'folder parent');
  parentContext = await assertOwnedCatalogParent(parentId, {
    allowSelfRoot: true,
    allowAgentRoot: true,
  });
  if (!parentContext.isDomainRoot && !isCopyableCatalogFolder(parentContext.parent)) {
    throw new Error(`folder-create cannot place a folder under ${parentContext.parent.type}`);
  }
  children = await listCatalogChildren(parentId, 'folder parent immediately before creation');
  assertCatalogNameAvailable(children, name, name);
  const beforeIds = new Set(children.map((node) => node.id));
  const created = await rmi('CatalogService', 'createFolderElement', [
    parentId,
    name,
    name,
    description,
    null,
    false,
    'DEFAULT_TREENODE.png',
  ]);
  if (created.retCode !== 0 || !created.result?.id) {
    throw new Error('folder creation failed');
  }
  if (beforeIds.has(created.result.id)) {
    throw new Error(`folder creation returned a pre-existing id: ${created.result.id}`);
  }

  const journal = [{
    id: created.result.id,
    parentId,
    name,
    alias: name,
    type: 'DEFAULT_TREENODE',
    description,
  }];
  try {
    const { current: saved } = await recheckDirectCatalogResource(
      parentId,
      journal[0],
      'folder parent after creation',
    );
    if (!hasNamespace(saved.name) && !hasNamespace(saved.alias)) {
      throw new Error(`created folder is not namespaced: ${saved.id}`);
    }
    const detail = await loadCatalogElement(saved.id, 'created folder');
    if (String(detail.desc || '') !== description) {
      throw new Error(`created folder description was not persisted: ${saved.id}`);
    }
    safeOutput({
      ok: true,
      created: true,
      id: saved.id,
      name: saved.name,
      alias: saved.alias,
    });
  } catch (error) {
    try {
      await rollbackCreatedCatalogEntries(journal);
    } catch (rollbackError) {
      throw new Error(`${error.message}; ${rollbackError.message}`);
    }
    throw error;
  }
}

function parseCatalogMutationArgs(argsList, positionalKeys, command) {
  if (argsList.length < positionalKeys.length) {
    throw new Error(`${command} requires <${positionalKeys.join('> <')}> --confirm-name <exactName>`);
  }
  const parsed = Object.fromEntries(
    positionalKeys.map((key, index) => [key, argsList[index]]),
  );
  for (let index = positionalKeys.length; index < argsList.length; index += 1) {
    const flag = argsList[index];
    if (!['--confirm-name', '--description'].includes(flag)) {
      throw new Error(`unexpected ${command} argument: ${flag}`);
    }
    const value = argsList[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    parsed[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  if (!parsed.confirmName) throw new Error(`${command} requires --confirm-name <exactName>`);
  return parsed;
}

function assertExactResourceConfirmation(resource, confirmName) {
  if (confirmName !== resource.name && confirmName !== resource.alias) {
    throw new Error(`resource confirmation mismatch: expected ${resource.name} or ${resource.alias}`);
  }
}

function parseExactConfirmationArgs(
  argsList,
  command,
  flag = '--confirm-target',
  { required = true } = {},
) {
  const positional = [];
  let confirmation = null;
  for (let index = 0; index < argsList.length; index += 1) {
    const argument = argsList[index];
    if (argument === flag) {
      confirmation = argsList[index + 1];
      if (!confirmation || confirmation.startsWith('--')) {
        throw new Error(`${flag} requires an exact resource name`);
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) throw new Error(`unknown ${command} option: ${argument}`);
    positional.push(argument);
  }
  if (required && !confirmation) throw new Error(`${command} requires ${flag} <exactName>`);
  return { positional, confirmation };
}

function assertNamespacedResource(resource) {
  if (!hasNamespace(resource.name) && !hasNamespace(resource.alias)) {
    throw new Error(`refusing a non-namespaced resource: ${resource.id}`);
  }
}

async function assertCatalogPermission(resourceId, purview, label) {
  const result = await rmi('CatalogService', 'isCatalogElementAccessible', [resourceId, purview]);
  if (result.retCode !== 0 || result.result !== true) {
    throw new Error(`${label} permission denied: ${resourceId}`);
  }
}

async function loadOwnedDirectResource(
  parentId,
  resourceId,
  { allowPersonalAcquisition = false } = {},
) {
  let personalAcquisition = false;
  if (allowPersonalAcquisition) {
    await ensureSession();
    const personal = await locatePersonalFolder();
    personalAcquisition = parentId === personal.folderId;
  }
  if (!personalAcquisition) {
    await assertOwnedCatalogParent(parentId, {
      allowSelfRoot: true,
      allowAgentRoot: true,
    });
  }
  const children = await listCatalogChildren(parentId, 'resource parent');
  const resource = children.find((node) => node.id === resourceId);
  if (!resource) {
    throw new Error(`resource is not a direct child of the supplied parent: ${resourceId}`);
  }
  if (personalAcquisition && resource.type !== 'BASETABLE') {
    throw new Error(`personal acquisition mutation accepts only BASETABLE resources: ${resourceId}`);
  }
  assertNamespacedResource(resource);
  return { resource, children };
}


async function assertCompetitionResourceDirectChild(parentId, resourceId, label) {
  if (!PLATFORM_PROFILE) return;
  const children = await listCatalogChildren(parentId, 'candidate folder');
  assertCompetitionSameCandidateParent(PLATFORM_PROFILE, {
    parentId,
    resourceId,
    children,
    label,
  });
}

async function locateCompetitionResourceParent(resourceId, label) {
  if (!PLATFORM_PROFILE) return null;
  const selfRoot = await loadSelfRoot();
  const personalChildren = await listCatalogChildren(selfRoot.id, 'personal workspace root');
  const competitionRoot = personalChildren.find((node) => (
    isCompetitionFolder(PLATFORM_PROFILE, node)
  ));
  if (!competitionRoot?.id) {
    throw new Error(`competition resource folder is missing: ${PLATFORM_PROFILE.resourceFolderName}`);
  }
  const queue = [competitionRoot.id];
  const visited = new Set();
  for (let cursor = 0; cursor < queue.length && visited.size < 10000; cursor += 1) {
    const parentId = queue[cursor];
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    const children = await listCatalogChildren(parentId, `competition ${label} search`);
    if (children.some((child) => child.id === resourceId)) return parentId;
    for (const child of children) {
      if (shouldTraverseCatalogNode(child)) queue.push(child.id);
    }
  }
  throw new Error(`competition ${label} is outside the competition folder: ${resourceId}`);
}

function parseCompetitionHomeArgs(argsList) {
  const options = { create: false, migrateLegacy: false, confirmName: null };
  for (let index = 0; index < argsList.length; index += 1) {
    const argument = argsList[index];
    if (argument === '--create') {
      options.create = true;
      continue;
    }
    if (argument === '--migrate-legacy') {
      options.migrateLegacy = true;
      continue;
    }
    if (argument === '--confirm-name') {
      options.confirmName = argsList[index + 1];
      if (!options.confirmName || options.confirmName.startsWith('--')) {
        throw new Error('--confirm-name requires the exact legacy folder name');
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown competition-home option: ${argument}`);
  }
  if (options.migrateLegacy && !options.confirmName) {
    throw new Error('competition-home --migrate-legacy requires --confirm-name <exactLegacyFolderName>');
  }
  if (options.confirmName && !options.migrateLegacy) {
    throw new Error('competition-home --confirm-name is valid only with --migrate-legacy');
  }
  if (options.create && options.migrateLegacy) {
    throw new Error('competition-home accepts only one of --create or --migrate-legacy');
  }
  return options;
}

async function cmdCompetitionHome(argsList) {
  const options = parseCompetitionHomeArgs(argsList);
  if (!PLATFORM_PROFILE) {
    throw new Error('competition-home requires platform profile competition-2026');
  }
  const selfRoot = await loadSelfRoot();
  let children = await listCatalogChildren(selfRoot.id, 'personal workspace root');
  const matches = children.filter((node) => isCompetitionFolder(PLATFORM_PROFILE, node));
  if (matches.length > 1) {
    throw new Error(`multiple competition folders named ${PLATFORM_PROFILE.resourceFolderName}`);
  }
  let folder = matches[0];
  if (folder && options.migrateLegacy) {
    throw new Error('competition-home cannot migrate while the competition folder already exists');
  }
  let created = false;
  let migratedLegacy = false;
  if (!folder && options.migrateLegacy) {
    const legacyMatches = children.filter((node) => (
      node.name === PLATFORM_PROFILE.schoolName || node.alias === PLATFORM_PROFILE.schoolName
    ));
    if (legacyMatches.length > 1) {
      throw new Error(`multiple legacy school folders named ${PLATFORM_PROFILE.schoolName}`);
    }
    const legacy = legacyMatches[0];
    if (!legacy) {
      throw new Error(`legacy competition folder not found: ${PLATFORM_PROFILE.schoolName}`);
    }
    if (legacy) {
      if (!['DEFAULT_TREENODE', 'SELF_TREENODE'].includes(legacy.type)) {
        throw new Error(`legacy competition destination is not a folder: ${legacy.id}`);
      }
      assertExactResourceConfirmation(legacy, options.confirmName);
      const detail = await loadCatalogElement(legacy.id);
      const migratedDescription = detail.desc
        || '2026“揭榜挂帅”挑战杯擂台赛 Smartbi Insight 专用资源目录';
      await assertCatalogPermission(legacy.id, 'WRITE', 'competition folder migration');
      const freshChildren = await listCatalogChildren(
        selfRoot.id,
        'personal workspace root immediately before migration',
      );
      const currentLegacy = freshChildren.find((node) => node.id === legacy.id);
      assertDirectResourceSnapshot(legacy, currentLegacy, selfRoot.id);
      assertExactResourceConfirmation(currentLegacy, options.confirmName);
      assertCatalogNameAvailable(
        freshChildren,
        PLATFORM_PROFILE.resourceFolderName,
        PLATFORM_PROFILE.resourceFolderName,
        legacy.id,
      );
      const renamed = await rmi('CatalogService', 'updateCatalogNode', [
        legacy.id,
        JSON.stringify({
          alias: PLATFORM_PROFILE.resourceFolderName,
          desc: migratedDescription,
        }),
        null,
      ]);
      if (renamed.retCode !== 0) {
        throw new Error('legacy competition folder migration failed');
      }
      children = await listCatalogChildren(selfRoot.id, 'personal workspace root after migration');
      folder = children.find((node) => (
        node.id === legacy.id && isCompetitionFolder(PLATFORM_PROFILE, node)
      ));
      if (!folder) throw new Error(`legacy competition folder rename was not persisted: ${legacy.id}`);
      const migratedDetail = await loadCatalogElement(legacy.id, 'migrated competition folder');
      if (
        migratedDetail.alias !== PLATFORM_PROFILE.resourceFolderName
        || String(migratedDetail.desc || '') !== String(migratedDescription)
      ) {
        throw new Error(`legacy competition folder details were not persisted: ${legacy.id}`);
      }
      migratedLegacy = true;
    }
  }
  if (!folder && options.create) {
    const competitionDescription = '2026“揭榜挂帅”挑战杯擂台赛 Smartbi Insight 专用资源目录';
    await assertCatalogPermission(selfRoot.id, 'WRITE', 'competition folder parent');
    children = await listCatalogChildren(
      selfRoot.id,
      'personal workspace root immediately before competition folder creation',
    );
    assertCatalogNameAvailable(
      children,
      PLATFORM_PROFILE.resourceFolderName,
      PLATFORM_PROFILE.resourceFolderName,
    );
    const beforeIds = new Set(children.map((node) => node.id));
    const createdResult = await rmi('CatalogService', 'createFolderElement', [
      selfRoot.id,
      PLATFORM_PROFILE.resourceFolderName,
      PLATFORM_PROFILE.resourceFolderName,
      competitionDescription,
      null,
      false,
      'DEFAULT_TREENODE.png',
    ]);
    if (createdResult.retCode !== 0 || !createdResult.result?.id) {
      throw new Error('competition folder creation failed');
    }
    if (beforeIds.has(createdResult.result.id)) {
      throw new Error(`competition folder creation returned a pre-existing id: ${createdResult.result.id}`);
    }
    const journal = [{
      id: createdResult.result.id,
      parentId: selfRoot.id,
      name: PLATFORM_PROFILE.resourceFolderName,
      alias: PLATFORM_PROFILE.resourceFolderName,
      type: 'DEFAULT_TREENODE',
      description: competitionDescription,
    }];
    try {
      folder = (await recheckDirectCatalogResource(
        selfRoot.id,
        journal[0],
        'personal workspace root after competition folder creation',
      )).current;
      const createdDetail = await loadCatalogElement(folder.id, 'created competition folder');
      if (
        !isCompetitionFolder(PLATFORM_PROFILE, folder)
        || String(createdDetail.desc || '') !== competitionDescription
      ) {
        throw new Error(`competition folder postcondition failed: ${folder.id}`);
      }
      created = true;
    } catch (error) {
      try {
        await rollbackCreatedCatalogEntries(journal);
      } catch (rollbackError) {
        throw new Error(`${error.message}; ${rollbackError.message}`);
      }
      throw error;
    }
  }
  if (!folder) {
    safeOutput({
      ok: false,
      exists: false,
      profile: PLATFORM_PROFILE,
      selfRootId: selfRoot.id,
    });
    return;
  }
  if (!['DEFAULT_TREENODE', 'SELF_TREENODE'].includes(folder.type)) {
    throw new Error(`competition destination is not a folder: ${folder.id}`);
  }
  safeOutput({
    ok: true,
    exists: true,
    created,
    migratedLegacy,
    profile: PLATFORM_PROFILE,
    selfRootId: selfRoot.id,
    folder: { id: folder.id, name: folder.name, alias: folder.alias, type: folder.type },
    placement: {
      artifacts: folder.id,
      importedTables: PLATFORM_PROFILE.dataImportLocation,
    },
  });
}

async function cmdResourceRename(argsList) {
  const {
    parentId,
    resourceId,
    requestedAlias,
    confirmName,
    description,
  } = parseCatalogMutationArgs(
    argsList,
    ['parentId', 'resourceId', 'requestedAlias'],
    'resource-rename',
  );
  const { resource, children } = await loadOwnedDirectResource(
    parentId,
    resourceId,
    { allowPersonalAcquisition: true },
  );
  assertExactResourceConfirmation(resource, confirmName);
  const alias = applyNamespace(requestedAlias);
  assertCatalogNameAvailable(children, alias, alias, resource.id);
  if (resource.alias === alias && description == null) {
    const { current } = await recheckDirectCatalogResource(
      parentId,
      resource,
      'resource parent before rename no-op',
    );
    assertExactResourceConfirmation(current, confirmName);
    safeOutput({
      ok: true,
      renamed: false,
      id: current.id,
      name: current.name,
      alias: current.alias,
    });
    return;
  }

  await assertCatalogPermission(resource.id, 'WRITE', 'rename');
  const originalDetail = await loadCatalogElement(resource.id);
  const newDescription = description ?? originalDetail.desc ?? '';
  const fresh = await loadOwnedDirectResource(
    parentId,
    resourceId,
    { allowPersonalAcquisition: true },
  );
  assertDirectResourceSnapshot(resource, fresh.resource, parentId);
  assertExactResourceConfirmation(fresh.resource, confirmName);
  assertCatalogNameAvailable(fresh.children, alias, alias, resource.id);
  const updated = await rmi('CatalogService', 'updateCatalogNode', [
    resource.id,
    JSON.stringify({ alias, desc: newDescription }),
    null,
  ]);
  if (updated.retCode !== 0) throw new Error('resource rename failed');

  const expectedSaved = { ...resource, alias };
  try {
    const { current: saved } = await recheckDirectCatalogResource(
      parentId,
      expectedSaved,
      'resource parent after rename',
    );
    const savedDetail = await loadCatalogElement(saved.id, 'renamed resource');
    if (savedDetail.alias !== alias || String(savedDetail.desc || '') !== String(newDescription)) {
      throw new Error(`renamed resource details were not persisted: ${resource.id}`);
    }
    safeOutput({
      ok: true,
      renamed: true,
      id: saved.id,
      name: saved.name,
      oldAlias: resource.alias,
      alias: saved.alias,
      description: savedDetail.desc || '',
    });
  } catch (error) {
    try {
      await recheckDirectCatalogResource(
        parentId,
        expectedSaved,
        'resource parent before rename rollback',
      );
      const restored = await rmi('CatalogService', 'updateCatalogNode', [
        resource.id,
        JSON.stringify({
          alias: originalDetail.alias ?? resource.alias ?? resource.name,
          desc: originalDetail.desc ?? '',
        }),
        null,
      ]);
      if (restored.retCode !== 0) throw new Error('rename rollback update failed');
      await recheckDirectCatalogResource(
        parentId,
        resource,
        'resource parent after rename rollback',
      );
      const restoredDetail = await loadCatalogElement(resource.id, 'restored resource');
      if (
        restoredDetail.alias !== (originalDetail.alias ?? resource.alias ?? resource.name)
        || String(restoredDetail.desc || '') !== String(originalDetail.desc ?? '')
      ) {
        throw new Error('rename rollback postcondition failed');
      }
    } catch (rollbackError) {
      throw new Error(`${error.message}; ${rollbackError.message}`);
    }
    throw error;
  }
}

async function cmdResourceMove(argsList) {
  const {
    sourceParentId,
    resourceId,
    targetParentId,
    confirmName,
  } = parseCatalogMutationArgs(
    argsList,
    ['sourceParentId', 'resourceId', 'targetParentId'],
    'resource-move',
  );
  if (PLATFORM_PROFILE) {
    throw new Error('competition resource-move is prohibited; create artifacts in their final candidate folder');
  }
  if (sourceParentId === targetParentId) {
    throw new Error('resource-move source and target parents must differ');
  }
  let [sourceContext, targetContext] = await Promise.all([
    assertOwnedCatalogParent(sourceParentId, {
      allowSelfRoot: true,
      allowAgentRoot: true,
    }),
    assertOwnedCatalogParent(targetParentId, {
      allowSelfRoot: true,
      allowAgentRoot: true,
    }),
  ]);
  const [sourceChildren, targetChildren] = await Promise.all([
    listCatalogChildren(sourceParentId, 'source parent'),
    listCatalogChildren(targetParentId, 'target parent'),
  ]);
  const resource = sourceChildren.find((node) => node.id === resourceId);
  if (!resource) {
    const alreadyMoved = targetChildren.find((node) => node.id === resourceId);
    if (!alreadyMoved) {
      throw new Error(`resource is not a direct child of source or target: ${resourceId}`);
    }
    assertNamespacedResource(alreadyMoved);
    assertExactResourceConfirmation(alreadyMoved, confirmName);
    assertCatalogPlacementCompatible({
      resource: alreadyMoved,
      source: sourceContext,
      target: targetContext,
      operation: 'resource-move',
    });
    const { current } = await recheckDirectCatalogResource(
      targetParentId,
      alreadyMoved,
      'target parent before move no-op',
    );
    safeOutput({
      ok: true,
      moved: false,
      id: current.id,
      name: current.name,
      alias: current.alias,
      parentId: targetParentId,
    });
    return;
  }
  assertNamespacedResource(resource);
  assertExactResourceConfirmation(resource, confirmName);
  assertCatalogPlacementCompatible({
    resource,
    source: sourceContext,
    target: targetContext,
    operation: 'resource-move',
  });
  assertCatalogNameAvailable(targetChildren, resource.name, resource.alias, resource.id);
  let targetPath = await rmi('CatalogService', 'getCatalogElementPath', [targetParentId]);
  assertCopyTargetOutsideSource({
    sourceId: resource.id,
    targetParentId,
    targetPath: targetPath.retCode === 0 ? targetPath.result : null,
    operation: 'move',
  });

  await Promise.all([
    assertCatalogPermission(resource.id, 'WRITE', 'move resource'),
    assertCatalogPermission(sourceParentId, 'WRITE', 'source parent'),
    assertCatalogPermission(targetParentId, 'WRITE', 'target parent'),
  ]);
  [sourceContext, targetContext] = await Promise.all([
    assertOwnedCatalogParent(sourceParentId, {
      allowSelfRoot: true,
      allowAgentRoot: true,
    }),
    assertOwnedCatalogParent(targetParentId, {
      allowSelfRoot: true,
      allowAgentRoot: true,
    }),
  ]);
  assertCatalogPlacementCompatible({
    resource,
    source: sourceContext,
    target: targetContext,
    operation: 'resource-move',
  });
  targetPath = await rmi('CatalogService', 'getCatalogElementPath', [targetParentId]);
  assertCopyTargetOutsideSource({
    sourceId: resource.id,
    targetParentId,
    targetPath: targetPath.retCode === 0 ? targetPath.result : null,
    operation: 'move',
  });
  const [{ current: currentSource }, currentTargetChildren] = await Promise.all([
    recheckDirectCatalogResource(
      sourceParentId,
      resource,
      'source parent immediately before move',
    ),
    listCatalogChildren(targetParentId, 'target parent immediately before move'),
  ]);
  assertExactResourceConfirmation(currentSource, confirmName);
  assertCatalogNameAvailable(
    currentTargetChildren,
    resource.name,
    resource.alias,
    resource.id,
  );
  const moved = await rmi('CatalogService', 'moveCatalogElement', [resource.id, targetParentId]);
  if (moved.retCode !== 0) throw new Error('resource move failed');

  const [sourceAfter, targetAfter] = await Promise.all([
    listCatalogChildren(sourceParentId, 'source parent after move'),
    listCatalogChildren(targetParentId, 'target parent after move'),
  ]);
  if (sourceAfter.some((node) => node.id === resource.id)) {
    throw new Error(`moved resource is still visible in its source parent: ${resource.id}`);
  }
  const saved = targetAfter.find((node) => node.id === resource.id);
  assertDirectResourceSnapshot(resource, saved, targetParentId);
  safeOutput({
    ok: true,
    moved: true,
    id: saved.id,
    name: saved.name,
    alias: saved.alias,
    parentId: targetParentId,
  });
}

async function preflightCatalogCopyManifest({
  sourceParentId,
  resource,
  targetParentId,
}) {
  const targetPathResponse = await rmi('CatalogService', 'getCatalogElementPath', [targetParentId]);
  const targetPath = targetPathResponse.retCode === 0 ? targetPathResponse.result : null;
  assertCopyTargetOutsideSource({
    sourceId: resource.id,
    targetParentId,
    targetPath,
  });

  const entries = [];
  const queue = [{
    snapshot: resource,
    actualParentId: sourceParentId,
    parentSourceId: null,
  }];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (queue.length > 2000) throw new Error('catalog copy manifest exceeded 2000 resources');
    const item = queue[cursor];
    const { current } = await recheckDirectCatalogResource(
      item.actualParentId,
      item.snapshot,
      'copy source manifest parent',
    );
    const detail = await loadCatalogElement(current.id, 'copy source manifest resource');
    assertDirectResourceSnapshot(current, detail, item.actualParentId);
    const entry = {
      id: current.id,
      parentSourceId: item.parentSourceId,
      name: current.name,
      alias: current.alias || current.name,
      type: current.type,
      hasChild: current.hasChild,
      description: detail.desc || '',
    };
    entries.push(entry);
    if (shouldTraverseCatalogNode(current)) {
      if (!isCopyableCatalogFolder(current)) {
        throw new Error(`catalog copy contains an unsupported container type: ${current.type}`);
      }
      const children = await listCatalogChildren(current.id, 'copy source manifest folder');
      for (const child of children) {
        queue.push({
          snapshot: child,
          actualParentId: current.id,
          parentSourceId: current.id,
        });
      }
    }
  }

  const manifest = createImmutableCatalogCopyManifest({
    sourceId: resource.id,
    targetParentId,
    targetPath,
    entries,
    isOwned: (entry) => hasNamespace(entry.name) || hasNamespace(entry.alias),
  });
  for (const entry of manifest.entries) {
    await assertCatalogPermission(entry.id, 'READ', 'copy source');
    if (!isCopyableCatalogFolder(entry)) {
      const supported = await rmi('CatalogService', 'supportsCopy', [entry.id]);
      if (supported.retCode !== 0 || supported.result !== true) {
        throw new Error(`resource type does not support copy: ${entry.id}`);
      }
    }
  }
  return manifest;
}

async function executeCatalogCopyManifest({
  manifest,
  sourceParentId,
  targetParentId,
  rootName,
  rootAlias,
  rootDescription,
  confirmName,
}) {
  const journal = [];
  const targetBySourceId = new Map();
  try {
    for (const entry of manifest.entries) {
      const sourceEntryParentId = entry.parentSourceId ?? sourceParentId;
      const destinationParentId = entry.parentSourceId == null
        ? targetParentId
        : targetBySourceId.get(entry.parentSourceId);
      if (!destinationParentId) {
        throw new Error(`catalog copy manifest parent was not created: ${entry.id}`);
      }
      const desired = entry.id === manifest.sourceId
        ? {
            name: rootName,
            alias: rootAlias,
            description: rootDescription,
          }
        : {
            name: entry.name,
            alias: entry.alias,
            description: entry.description,
          };

      const { current: currentSource } = await recheckDirectCatalogResource(
        sourceEntryParentId,
        entry,
        'copy source immediately before mutation',
      );
      if (entry.id === manifest.sourceId) {
        assertExactResourceConfirmation(currentSource, confirmName);
        const [currentSourceContext, currentTargetContext] = await Promise.all([
          assertOwnedCatalogParent(sourceParentId, {
            allowSelfRoot: true,
            allowAgentRoot: true,
          }),
          assertOwnedCatalogParent(targetParentId, {
            allowSelfRoot: true,
            allowAgentRoot: true,
          }),
        ]);
        assertCatalogPlacementCompatible({
          resource: currentSource,
          source: currentSourceContext,
          target: currentTargetContext,
          operation: 'resource-copy',
        });
        const targetPathResponse = await rmi(
          'CatalogService',
          'getCatalogElementPath',
          [targetParentId],
        );
        assertCopyTargetOutsideSource({
          sourceId: entry.id,
          targetParentId,
          targetPath: targetPathResponse.retCode === 0 ? targetPathResponse.result : null,
        });
      }
      const before = await listCatalogChildren(
        destinationParentId,
        'copy target immediately before mutation',
      );
      assertCatalogNameAvailable(before, desired.name, desired.alias);
      const beforeIds = new Set(before.map((node) => node.id));

      let createdEntry;
      if (isCopyableCatalogFolder(entry)) {
        const created = await rmi('CatalogService', 'createFolderElement', [
          destinationParentId,
          desired.name,
          desired.alias,
          desired.description,
          null,
          false,
          'DEFAULT_TREENODE.png',
        ]);
        if (created.retCode !== 0 || !created.result?.id) {
          throw new Error(`folder copy creation failed: ${entry.id}`);
        }
        if (beforeIds.has(created.result.id)) {
          throw new Error(`folder copy returned a pre-existing id: ${created.result.id}`);
        }
        createdEntry = {
          sourceId: entry.id,
          id: created.result.id,
          parentId: destinationParentId,
          name: desired.name,
          alias: desired.alias,
          type: 'DEFAULT_TREENODE',
          description: desired.description,
        };
        journal.push(createdEntry);
      } else {
        const copied = await rmi('CatalogService', 'copyAndPaste', [
          destinationParentId,
          entry.id,
          desired.name,
          desired.alias,
          desired.description,
        ]);
        if (copied.retCode !== 0) throw new Error(`resource copy failed: ${entry.id}`);
        const after = await listCatalogChildren(
          destinationParentId,
          'copy target after resource copy',
        );
        const candidates = after.filter((node) => (
          !beforeIds.has(node.id)
          && node.name === desired.name
          && node.alias === desired.alias
          && node.type === entry.type
        ));
        if (candidates.length !== 1) {
          throw new Error(`cannot identify exactly one invocation-created copy for ${entry.id}`);
        }
        createdEntry = {
          sourceId: entry.id,
          id: candidates[0].id,
          parentId: destinationParentId,
          name: desired.name,
          alias: desired.alias,
          type: entry.type,
          description: desired.description,
        };
        journal.push(createdEntry);
      }

      const { current: saved } = await recheckDirectCatalogResource(
        destinationParentId,
        createdEntry,
        'copy target postcondition',
      );
      const savedDetail = await loadCatalogElement(saved.id, 'copied resource');
      if (String(savedDetail.desc || '') !== String(desired.description || '')) {
        throw new Error(`copied resource description was not persisted: ${saved.id}`);
      }
      targetBySourceId.set(entry.id, saved.id);
    }

    for (const createdEntry of journal) {
      const { current } = await recheckDirectCatalogResource(
        createdEntry.parentId,
        createdEntry,
        'copy final postcondition',
      );
      const detail = await loadCatalogElement(current.id, 'copied resource final postcondition');
      if (String(detail.desc || '') !== String(createdEntry.description || '')) {
        throw new Error(`copied resource final description mismatch: ${current.id}`);
      }
      if (isKnownCatalogFolder(createdEntry)) {
        const children = await listCatalogChildren(
          current.id,
          'copied folder final postcondition',
        );
        const expectedIds = new Set(
          journal
            .filter((candidate) => candidate.parentId === current.id)
            .map((candidate) => candidate.id),
        );
        if (
          children.length !== expectedIds.size
          || children.some((child) => !expectedIds.has(child.id))
        ) {
          throw new Error(`copied folder contains an unexpected child: ${current.id}`);
        }
      }
    }
    const root = journal.find((entry) => entry.sourceId === manifest.sourceId);
    if (!root) throw new Error(`copied root was not journaled: ${manifest.sourceId}`);
    const savedRoot = (await recheckDirectCatalogResource(
      targetParentId,
      root,
      'copy root final postcondition',
    )).current;
    if (!hasNamespace(savedRoot.name) && !hasNamespace(savedRoot.alias)) {
      throw new Error(`copied resource is not namespaced: ${savedRoot.id}`);
    }
    return savedRoot;
  } catch (error) {
    try {
      await rollbackCreatedCatalogEntries(journal);
    } catch (rollbackError) {
      throw new Error(`${error.message}; ${rollbackError.message}`);
    }
    throw error;
  }
}

async function cmdResourceCopy(argsList) {
  const {
    sourceParentId,
    resourceId,
    targetParentId,
    requestedName,
    confirmName,
    description,
  } = parseCatalogMutationArgs(
    argsList,
    ['sourceParentId', 'resourceId', 'targetParentId', 'requestedName'],
    'resource-copy',
  );
  if (PLATFORM_PROFILE) {
    throw new Error('competition resource-copy is prohibited; rebuild from verified same-candidate lineage');
  }
  const { resource } = await loadOwnedDirectResource(sourceParentId, resourceId);
  assertExactResourceConfirmation(resource, confirmName);
  let [sourceContext, targetContext] = await Promise.all([
    assertOwnedCatalogParent(sourceParentId, {
      allowSelfRoot: true,
      allowAgentRoot: true,
    }),
    assertOwnedCatalogParent(targetParentId, {
      allowSelfRoot: true,
      allowAgentRoot: true,
    }),
  ]);
  assertCatalogPlacementCompatible({
    resource,
    source: sourceContext,
    target: targetContext,
    operation: 'resource-copy',
  });
  const name = applyNamespace(requestedName);
  const targetChildren = await listCatalogChildren(targetParentId, 'copy target parent');
  assertCatalogNameAvailable(targetChildren, name, name);
  const manifest = await preflightCatalogCopyManifest({
    sourceParentId,
    resource,
    targetParentId,
  });
  await assertCatalogPermission(targetParentId, 'WRITE', 'copy target parent');

  [sourceContext, targetContext] = await Promise.all([
    assertOwnedCatalogParent(sourceParentId, {
      allowSelfRoot: true,
      allowAgentRoot: true,
    }),
    assertOwnedCatalogParent(targetParentId, {
      allowSelfRoot: true,
      allowAgentRoot: true,
    }),
  ]);
  assertCatalogPlacementCompatible({
    resource,
    source: sourceContext,
    target: targetContext,
    operation: 'resource-copy',
  });
  const targetPathResponse = await rmi('CatalogService', 'getCatalogElementPath', [targetParentId]);
  assertCopyTargetOutsideSource({
    sourceId: resource.id,
    targetParentId,
    targetPath: targetPathResponse.retCode === 0 ? targetPathResponse.result : null,
  });
  const rootEntry = manifest.entries.find((entry) => entry.id === manifest.sourceId);
  const saved = await executeCatalogCopyManifest({
    manifest,
    sourceParentId,
    targetParentId,
    rootName: name,
    rootAlias: name,
    rootDescription: description ?? rootEntry.description ?? '',
    confirmName,
  });
  safeOutput({
    ok: true,
    copied: true,
    sourceId: resource.id,
    id: saved.id,
    name: saved.name,
    alias: saved.alias,
    parentId: targetParentId,
    copiedCount: manifest.entries.length,
  });
}

async function resolveDeletionParentKind(parentId) {
  try {
    await assertOwnedCatalogParent(parentId, {
      allowSelfRoot: true,
      allowAgentRoot: true,
    });
    return DELETION_PARENT_KINDS.OWNED_CATALOG;
  } catch (error) {
    if (!/refusing a non-owned catalog parent|outside the current personal workspace/.test(error.message)) {
      throw error;
    }
    const personal = await locatePersonalFolder();
    if (parentId === personal.folderId) return DELETION_PARENT_KINDS.PERSONAL_ACQUISITION;
    throw error;
  }
}

async function cmdResourceDelete({ parentId, resourceId, confirmName = null }) {
  const parentKind = await resolveDeletionParentKind(parentId);
  const before = await listCatalogChildren(parentId, 'resource parent');
  const resource = before.find((node) => node.id === resourceId);
  if (!resource) {
    throw new Error(`resource is not a direct child of the supplied parent: ${resourceId}`);
  }
  let authorization = authorizeResourceDeletion({
    resource,
    parentKind,
    confirmName,
    isNamespaced: hasNamespace(resource.name) || hasNamespace(resource.alias),
  });
  if (shouldTraverseCatalogNode(resource)) {
    const children = await listCatalogChildren(resource.id, 'folder before deletion');
    if (children.length > 0) {
      throw new Error(`resource-delete accepts only empty folders: ${resource.id}`);
    }
  }
  await assertCatalogPermission(resourceId, 'DELETE', 'delete');

  const currentParentKind = await resolveDeletionParentKind(parentId);
  if (currentParentKind !== parentKind) {
    throw new Error(`resource deletion parent scope changed after authorization: ${parentId}`);
  }
  const { current } = await recheckDirectCatalogResource(
    parentId,
    resource,
    'resource parent immediately before deletion',
  );
  authorization = authorizeResourceDeletion({
    resource: current,
    parentKind: currentParentKind,
    confirmName,
    isNamespaced: hasNamespace(current.name) || hasNamespace(current.alias),
  });
  if (shouldTraverseCatalogNode(current)) {
    const children = await listCatalogChildren(
      current.id,
      'folder immediately before deletion',
    );
    if (children.length > 0) {
      throw new Error(`resource-delete accepts only empty folders: ${current.id}`);
    }
  }
  const deleted = await rmi('CatalogService', 'deleteCatalogElement', [resourceId]);
  if (deleted.retCode !== 0) throw new Error('resource deletion failed');
  const after = await listCatalogChildren(parentId, 'resource parent after deletion');
  if (after.some((node) => node.id === resourceId)) {
    throw new Error(`deleted resource is still visible: ${resourceId}`);
  }
  const deletedProbe = await rmi('CatalogService', 'getCatalogElementById', [resourceId]);
  if (deletedProbe.retCode === 0 && deletedProbe.result?.id === resourceId) {
    throw new Error(`deleted resource still exists outside its confirmed parent: ${resourceId}`);
  }
  safeOutput({
    ok: true,
    deleted: true,
    legacy: authorization.legacy,
    id: resourceId,
    name: resource.name,
    alias: resource.alias,
  });
}



// Walk the import tree to locate the personal acquisition space under 可导入数据库.
async function locatePersonalFolder() {
  const currentUser = await rmi('AIextRemoteService', 'getCurrentUserName', [], 15000);
  if (currentUser.retCode !== 0 || !currentUser.result) {
    throw new Error('cannot resolve the authenticated Smartbi user');
  }
  const requireUnique = (nodes, predicate, label) => {
    const matches = nodes.filter(predicate);
    if (matches.length === 0) throw new Error(`${label} not found`);
    if (matches.length > 1) throw new Error(`${label} is ambiguous`);
    return matches[0];
  };

  const schemas = await listCatalogChildren('DS.input', 'import data source');
  const schema = requireUnique(
    schemas,
    (node) => node.type === 'SCHEMA',
    '可导入数据库 schema',
  );
  const schemaChildren = await listCatalogChildren(schema.id, 'import schema');
  const space = requireUnique(
    schemaChildren,
    (node) => (
      isKnownCatalogFolder(node)
      && (node.alias === '数据采集空间' || node.name === '数据采集空间')
    ),
    '数据采集空间',
  );
  const account = String(currentUser.result);
  const spaceChildren = await listCatalogChildren(space.id, 'acquisition space');
  const personal = requireUnique(
    spaceChildren,
    (node) => (
      isKnownCatalogFolder(node)
      && (String(node.alias || '') === account || String(node.name || '') === account)
    ),
    'authenticated personal acquisition folder',
  );
  return {
    dsId: 'DS.input',
    schemaId: schema.name,
    bindingSchemaId: schema.id,
    catalog: schema.name,
    folderId: personal.id,
  };
}

function makeImportTableTarget(folder, logicalName, existing = null) {
  if (existing) {
    const parsed = parseImportedTableId(existing.id);
    if (parsed.dataSourceId !== folder.dsId) {
      throw new Error('existing import target is outside the personal import data source');
    }
    if (String(logicalName).toLocaleLowerCase() !== parsed.tableName.toLocaleLowerCase()) {
      throw new Error(
        'replacement of a table whose alias differs from its physical name is unsupported',
      );
    }
    return Object.freeze({
      logicalName,
      physicalName: parsed.tableName,
      dataSourceId: folder.dsId,
      tableId: existing.id,
      tableName: parsed.tableName,
    });
  }
  const physicalName = logicalName.toLocaleLowerCase();
  return Object.freeze({
    logicalName,
    physicalName,
    dataSourceId: folder.dsId,
    tableId: `TAB.${folder.catalog}.${folder.schemaId}.null.${physicalName}`,
    tableName: physicalName,
  });
}

function matchingImportTargets(children, target) {
  const expectedId = target.tableId.toLocaleLowerCase();
  const expectedPhysical = target.physicalName.toLocaleLowerCase();
  const expectedLogical = target.logicalName.toLocaleLowerCase();
  return children.filter((node) => (
    String(node.id || '').toLocaleLowerCase() === expectedId
    || String(node.name || '').toLocaleLowerCase() === expectedPhysical
    || String(node.alias || '').toLocaleLowerCase() === expectedLogical
  ));
}

async function dataPackageResponse(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label} returned a non-JSON response`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${label} returned an unsupported response shape`);
  }
  if (payload.retCode !== 0) {
    const code = Number.isSafeInteger(payload.retCode) ? payload.retCode : 'unknown';
    throw new Error(`${label} failed (retCode=${code})`);
  }
  return payload;
}

async function cleanupUploadedImport(clientId) {
  if (!clientId) return;
  try {
    await fetch(`${BASE_URL}/DataPackageServlet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: cookieHeader(),
      },
      body: new URLSearchParams({ action: 'DELETE_FILE', clientId }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {}
}

async function localImportDigest(filePath) {
  try {
    const [{ createReadStream }, { createHash }] = await Promise.all([
      import('node:fs'),
      import('node:crypto'),
    ]);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
  } catch {
    throw new Error('cannot read local upload file');
  }
}

async function prepareLocalImport(source, previewRows) {
  if (!Number.isSafeInteger(previewRows) || previewRows < 1 || previewRows > 1000) {
    throw new Error('previewRows must be an integer between 1 and 1000');
  }
  const { openAsBlob } = await import('node:fs');
  if (typeof openAsBlob !== 'function') {
    throw new Error('this Node.js runtime does not support file-backed upload blobs');
  }
  const sourceDigest = await localImportDigest(source.filePath);
  let fileBlob;
  try {
    fileBlob = await openAsBlob(source.filePath);
  } catch {
    throw new Error('cannot open local upload file');
  }
  const form = new FormData();
  form.append('action', 'UPLOAD_FILE');
  form.append('file', fileBlob, source.fileName);
  const uploaded = await dataPackageResponse(
    await fetch(`${BASE_URL}/DataPackageServlet`, {
      method: 'POST',
      headers: { Cookie: cookieHeader() },
      body: form,
      signal: AbortSignal.timeout(120000),
    }),
    'file upload',
  );
  const clientId = uploaded.result?.clientId;
  if (typeof clientId !== 'string' || !clientId) {
    throw new Error('file upload did not return a client id');
  }
  try {
    const worksheet = resolveWorksheetSelection(source, uploaded.result?.sheetNames);
    const preview = await dataPackageResponse(
      await fetch(`${BASE_URL}/DataPackageServlet`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Cookie: cookieHeader(),
        },
        body: new URLSearchParams({
          action: 'GET_PREVIEW_DATA',
          clientId,
          previewRows: String(previewRows),
          sheetIndex: String(worksheet.index),
        }),
        signal: AbortSignal.timeout(120000),
      }),
      'file preview',
    );
    const validatedPreview = validateImportPreview(preview.result);
    if (await localImportDigest(source.filePath) !== sourceDigest) {
      throw new Error('local import file changed while it was being uploaded');
    }
    return Object.freeze({
      clientId,
      worksheet,
      preview: validatedPreview,
      sourceDigest,
    });
  } catch (error) {
    await cleanupUploadedImport(clientId);
    throw error;
  }
}

async function waitForTerminalImport(clientId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const status = await rmi('DataPackageModule', 'getImportStatus', [clientId]);
    if (status.retCode !== 0) {
      const code = Number.isSafeInteger(status.retCode) ? status.retCode : 'unknown';
      throw new Error(`import status check failed (retCode=${code})`);
    }
    if (!status.result || typeof status.result !== 'object' || Array.isArray(status.result)) {
      throw new Error('import status check returned an unsupported response shape');
    }
    if (status.result.retCode === 0) return status.result;
    if (Object.hasOwn(status.result, 'retCode')) {
      const code = Number.isSafeInteger(status.result.retCode)
        ? status.result.retCode
        : 'unknown';
      throw new Error(`import reached a terminal error (retCode=${code})`);
    }
  }
  throw new Error('import did not reach terminal success within 5 minutes');
}

async function insertPreparedImport(prepared, source, folder, target) {
  const settings = [{
    createTable: true,
    sheetIndex: String(prepared.worksheet.index),
    headerRowIndex: 0,
    fieldTypeList: prepared.preview.fieldTypes,
    dsId: folder.dsId,
    schemaId: folder.schemaId,
    catalog: folder.catalog,
    folderId: folder.folderId,
    tableName: target.logicalName,
    tableAlias: target.logicalName,
    fieldAliasList: prepared.preview.fieldAliases,
    fieldNameList: prepared.preview.fieldNames,
    importType: 'REPLACE',
    keepUniqueData: true,
    fileName: source.fileName,
    primaryKeyIndexs: [],
  }];
  await dataPackageResponse(
    await fetch(`${BASE_URL}/DataPackageServlet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: cookieHeader(),
      },
      body: new URLSearchParams({
        action: 'INSERT_DATA',
        clientId: prepared.clientId,
        settings: JSON.stringify(settings),
      }),
      signal: AbortSignal.timeout(120000),
    }),
    'file import',
  );
  const terminalStatus = await waitForTerminalImport(prepared.clientId);
  return Object.freeze({
    terminalStatus,
    rowCounts: importRowCountReceipt(prepared.preview.previewCount, terminalStatus),
  });
}

function rememberCleanupId(journal, key, resourceId) {
  if (resourceId && !journal[key].includes(resourceId)) journal[key].push(resourceId);
}

async function captureCreatedImportResource(folder, target, beforeIds, journal) {
  const children = await listCatalogChildren(
    folder.folderId,
    'personal acquisition folder after import',
  );
  const candidates = matchingImportTargets(children, target).filter((node) => (
    !beforeIds.has(node.id)
    && node.type === 'BASETABLE'
    && (hasNamespace(node.name) || hasNamespace(node.alias))
    && (node.alias || node.name) === target.logicalName
  ));
  if (candidates.length === 1) {
    rememberCleanupId(journal, 'createdIds', candidates[0].id);
    return candidates[0];
  }
  return null;
}

function assertImportTableIdentity(reopened, target, label) {
  const reopenedDataSourceId = reopened?.dataSource?.id ?? reopened?.dataSourceId ?? null;
  if (
    String(reopened?.originId || '').toLocaleLowerCase() !== target.tableId.toLocaleLowerCase()
    || String(reopened?.name || '').toLocaleLowerCase() !== target.physicalName.toLocaleLowerCase()
    || (reopenedDataSourceId != null && reopenedDataSourceId !== target.dataSourceId)
  ) {
    throw new Error(`${label} physical table identity or placement check failed`);
  }
  return reopened;
}

async function reopenImportedTable(folder, target, expectedSchema, beforeIds, journal) {
  const children = await listCatalogChildren(
    folder.folderId,
    'personal acquisition folder import postcondition',
  );
  const matches = matchingImportTargets(children, target);
  if (matches.length !== 1) {
    throw new Error(
      `import placement postcondition failed: expected one direct table, found ${matches.length}`,
    );
  }
  const node = matches[0];
  if (!beforeIds.has(node.id)) rememberCleanupId(journal, 'createdIds', node.id);
  if (node.type !== 'BASETABLE') {
    throw new Error('import placement postcondition failed: reopened resource is not a BASETABLE');
  }
  if (String(node.id).toLocaleLowerCase() !== target.tableId.toLocaleLowerCase()) {
    throw new Error('import physical table id postcondition failed');
  }
  if (String(node.name || '').toLocaleLowerCase() !== target.physicalName.toLocaleLowerCase()) {
    throw new Error('import physical table name postcondition failed');
  }
  if ((node.alias || node.name) !== target.logicalName) {
    throw new Error('import exact table alias postcondition failed');
  }
  const reopened = await smartbixApi('datasets/table', {
    method: 'POST',
    body: {
      dataSourceId: target.dataSourceId,
      tableId: target.tableId,
      tableName: target.tableName,
    },
  });
  assertImportTableIdentity(reopened, target, 'reopened import');
  const schema = assertImportedSchemaMatches(expectedSchema, reopened.fields, target.logicalName);
  return Object.freeze({
    node: Object.freeze({
      id: node.id,
      name: node.name,
      alias: node.alias,
      type: node.type,
    }),
    schema: Object.freeze(schema),
  });
}

async function importAndVerifyLocalFile({
  source,
  folder,
  target,
  previewRows,
  beforeIds,
  journal,
  compatibleWith = null,
  expectedSourceDigest = null,
}) {
  let prepared = null;
  try {
    prepared = await prepareLocalImport(source, previewRows);
    if (expectedSourceDigest && prepared.sourceDigest !== expectedSourceDigest) {
      throw new Error('replacement source file changed after the staging table was proven');
    }
    if (compatibleWith) {
      assertReplacementSchemaCompatible(
        compatibleWith,
        prepared.preview.schema,
        target.logicalName,
      );
    }
    const inserted = await insertPreparedImport(prepared, source, folder, target);
    const reopened = await reopenImportedTable(
      folder,
      target,
      prepared.preview.schema,
      beforeIds,
      journal,
    );
    return Object.freeze({
      ...reopened,
      worksheet: prepared.worksheet,
      preview: prepared.preview,
      sourceDigest: prepared.sourceDigest,
      rowCounts: inserted.rowCounts,
      terminalSuccess: true,
    });
  } catch (error) {
    try {
      await captureCreatedImportResource(folder, target, beforeIds, journal);
    } catch {}
    throw error;
  } finally {
    await cleanupUploadedImport(prepared?.clientId);
  }
}

async function deleteCreatedImportResource(folder, target, journal) {
  const children = await listCatalogChildren(
    folder.folderId,
    'personal acquisition folder before import cleanup',
  );
  const candidates = children.filter((node) => (
    journal.createdIds.includes(node.id)
    && !journal.cleanedIds.includes(node.id)
    && matchingImportTargets([node], target).length === 1
  ));
  if (candidates.length === 0) return false;
  if (candidates.length !== 1) {
    throw new Error('refusing ambiguous cleanup of invocation-created import resources');
  }
  const resource = candidates[0];
  const resourceId = resource.id;
  if (
    resource.type !== 'BASETABLE'
    || !(hasNamespace(resource.name) || hasNamespace(resource.alias))
    || (resource.alias || resource.name) !== target.logicalName
  ) {
    throw new Error(`refusing cleanup for an unproven import resource: ${resourceId}`);
  }
  await assertCatalogPermission(resourceId, 'DELETE', 'import cleanup');
  const deleted = await rmi('CatalogService', 'deleteCatalogElement', [resourceId]);
  if (deleted.retCode !== 0) {
    throw new Error(`import cleanup failed (retCode=${deleted.retCode}) for ${resourceId}`);
  }
  const after = await listCatalogChildren(
    folder.folderId,
    'personal acquisition folder after import cleanup',
  );
  if (after.some((node) => node.id === resourceId)) {
    throw new Error(`import cleanup postcondition failed for ${resourceId}`);
  }
  rememberCleanupId(journal, 'cleanedIds', resourceId);
  return true;
}

function assertReplacementCountConsistency(staging, target) {
  if (
    staging.worksheet.name !== target.worksheet.name
    || staging.worksheet.index !== target.worksheet.index
    || staging.worksheet.sheetCount !== target.worksheet.sheetCount
  ) {
    throw new Error('replacement worksheet postcondition failed: selected sheet changed');
  }
  if (staging.rowCounts.preview.value !== target.rowCounts.preview.value) {
    throw new Error('replacement row-count postcondition failed: preview counts changed');
  }
  const stagedAuthoritative = staging.rowCounts.authoritative;
  const targetAuthoritative = target.rowCounts.authoritative;
  if (
    stagedAuthoritative.available
    && targetAuthoritative.available
    && stagedAuthoritative.value !== targetAuthoritative.value
  ) {
    throw new Error('replacement row-count postcondition failed: terminal counts changed');
  }
}

// Upload a nonempty local CSV/TXT/XLS/XLSX and import it into the personal acquisition folder.
async function cmdUpload(
  filePath,
  tableName,
  {
    previewRows = 30,
    worksheet = null,
    replace = false,
    sourceProvenance = null,
    confirmTargetName = null,
  } = {},
) {
  if (!filePath) {
    throw new Error(
      'upload requires <localFile> [tableName] [--worksheet <exactWorksheetName>] [--replace]',
    );
  }
  if (replace && !confirmTargetName) {
    throw new Error('upload --replace requires --confirm-target <exactExistingTableName>');
  }
  classifyLocalImportSource({ filePath, worksheet });
  let stats;
  try {
    stats = lstatSync(filePath, { throwIfNoEntry: false });
  } catch {
    throw new Error('cannot inspect local upload file');
  }
  const source = planLocalImportSource({
    filePath,
    worksheet,
    isFile: stats?.isFile() === true,
    size: stats?.size,
  });
  const base = tableName || source.fileName.replace(/\.[^.]+$/, '');
  if (!String(base).trim()) throw new Error('resolved table name is empty');
  const requestedTable = applyTableNamespace(base);
  if (!requestedTable || !hasNamespace(requestedTable)) {
    throw new Error('resolved table name does not retain the configured namespace');
  }

  await ensureSession();
  const folder = await locatePersonalFolder();
  const initialChildren = await listCatalogChildren(
    folder.folderId,
    'personal acquisition folder before import',
  );
  const requestedTarget = makeImportTableTarget(folder, requestedTable);
  const matches = matchingImportTargets(initialChildren, requestedTarget);
  if (matches.length > 1) {
    throw new Error(`import target is ambiguous in the personal acquisition folder: ${requestedTable}`);
  }
  const existing = matches[0] || null;
  if (existing && !replace) {
    throw new Error(`table already exists; pass --replace to replace the owned table: ${requestedTable}`);
  }
  if (existing && existing.type !== 'BASETABLE') {
    throw new Error('refusing to replace a personal acquisition resource that is not a BASETABLE');
  }
  if (existing && !(hasNamespace(existing.name) || hasNamespace(existing.alias))) {
    throw new Error(`refusing to replace non-namespaced table: ${existing.alias || existing.name}`);
  }
  if (existing && replace) assertExactResourceConfirmation(existing, confirmTargetName);

  const targetLogicalName = existing ? (existing.alias || existing.name) : requestedTable;
  const target = makeImportTableTarget(folder, targetLogicalName, existing);
  let staging = null;
  if (replace) {
    const stagingName = applyTableNamespace(
      `import_stage_${randomBytes(6).toString('hex')}`,
    );
    if (!stagingName || !hasNamespace(stagingName)) {
      throw new Error('replacement staging name does not retain the configured namespace');
    }
    staging = makeImportTableTarget(folder, stagingName);
    if (
      staging.tableId.toLocaleLowerCase() === target.tableId.toLocaleLowerCase()
      || matchingImportTargets(initialChildren, staging).length > 0
    ) {
      throw new Error('could not reserve a distinct namespaced replacement staging table');
    }
  }
  const mutation = planImportMutation({
    replace,
    existing,
    target,
    staging,
  });
  const journal = {
    createdIds: [],
    cleanedIds: [],
    preservedIds: [],
  };
  const initialIds = new Set(initialChildren.map((node) => node.id));
  let finalResult;

  if (mutation.mode === 'replace') {
    const existingTable = await smartbixApi('datasets/table', {
      method: 'POST',
      body: {
        dataSourceId: target.dataSourceId,
        tableId: target.tableId,
        tableName: target.tableName,
      },
    });
    assertImportTableIdentity(existingTable, target, 'existing replacement target');
    assertCompleteImportSchema(existingTable?.fields, target.logicalName);
    let staged;
    try {
      staged = await importAndVerifyLocalFile({
        source,
        folder,
        target: staging,
        previewRows,
        beforeIds: initialIds,
        journal,
        compatibleWith: existingTable?.fields,
      });
    } catch (error) {
      try {
        await deleteCreatedImportResource(folder, staging, journal);
      } catch (cleanupError) {
        throw new Error(
          `${sanitizeErrorMessage(error)}; staging cleanup failed: `
          + sanitizeErrorMessage(cleanupError),
        );
      }
      throw error;
    }

    const beforeTargetReplace = new Set(
      (await listCatalogChildren(
        folder.folderId,
        'personal acquisition folder before target replacement',
      )).map((node) => node.id),
    );
    try {
      finalResult = await importAndVerifyLocalFile({
        source,
        folder,
        target,
        previewRows,
        beforeIds: beforeTargetReplace,
        journal,
        compatibleWith: staged.schema,
        expectedSourceDigest: staged.sourceDigest,
      });
      assertReplacementCountConsistency(staged, finalResult);
    } catch (error) {
      let recoveryCleanupError = null;
      try {
        await deleteCreatedImportResource(folder, target, journal);
      } catch (cleanupError) {
        recoveryCleanupError = cleanupError;
      }
      rememberCleanupId(journal, 'preservedIds', staged.node.id);
      throw new Error(
        `${sanitizeErrorMessage(error)}; proven staging table preserved for recovery: `
        + staged.node.id
        + (recoveryCleanupError
          ? `; invocation-created target cleanup failed: ${sanitizeErrorMessage(recoveryCleanupError)}`
          : ''),
      );
    }
    await deleteCreatedImportResource(folder, staging, journal);
  } else {
    try {
      finalResult = await importAndVerifyLocalFile({
        source,
        folder,
        target,
        previewRows,
        beforeIds: initialIds,
        journal,
      });
    } catch (error) {
      try {
        await deleteCreatedImportResource(folder, target, journal);
      } catch (cleanupError) {
        throw new Error(
          `${sanitizeErrorMessage(error)}; created-table cleanup failed: `
          + sanitizeErrorMessage(cleanupError),
        );
      }
      throw error;
    }
  }

  safeOutput({
    ok: true,
    replaced: mutation.mode === 'replace',
    import: {
      source: 'local-file',
      format: source.format,
      worksheet: {
        name: finalResult.worksheet.name,
        index: finalResult.worksheet.index,
        workbookSheetCount: finalResult.worksheet.sheetCount,
        explicitlyRequested: finalResult.worksheet.explicitlyRequested,
      },
      terminalSuccess: finalResult.terminalSuccess,
      sourceIntegrity: {
        stableDuringUpload: true,
        matchedProvenStagingContent: mutation.mode === 'replace' ? true : null,
      },
    },
    table: {
      ...finalResult.node,
      physicalName: target.physicalName,
      dataSourceId: target.dataSourceId,
    },
    schema: finalResult.schema,
    rowCounts: finalResult.rowCounts,
    postcondition: {
      directPersonalPlacement: true,
      exactLogicalName: true,
      physicalTableReopened: true,
      orderedNameTypeSchema: true,
    },
    provenance: sourceProvenance || {
      kind: 'local-file-only',
      publicUrlDeclared: false,
      remoteSourceFetched: false,
    },
    cleanup: {
      createdByInvocation: journal.createdIds,
      deletedAfterProof: journal.cleanedIds,
      preservedForRecovery: journal.preservedIds,
    },
  });
}

async function cmdUploadArgs(argsList) {
  let replace = false;
  let sourceUrl = null;
  let worksheet = null;
  let confirmTargetName = null;
  const positional = [];
  for (let index = 0; index < argsList.length; index += 1) {
    const argument = argsList[index];
    if (argument === '--replace') {
      if (replace) throw new Error('upload accepts --replace only once');
      replace = true;
      continue;
    }
    if (argument === '--source-url') {
      if (sourceUrl != null) throw new Error('upload accepts --source-url only once');
      sourceUrl = argsList[index + 1];
      if (!sourceUrl || sourceUrl.startsWith('--')) {
        throw new Error('--source-url requires a public provenance URL');
      }
      index += 1;
      continue;
    }
    if (argument === '--worksheet') {
      if (worksheet != null) throw new Error('upload accepts --worksheet only once');
      worksheet = argsList[index + 1];
      if (!worksheet || worksheet.startsWith('--')) {
        throw new Error('--worksheet requires the exact worksheet name');
      }
      index += 1;
      continue;
    }
    if (argument === '--confirm-target') {
      if (confirmTargetName != null) {
        throw new Error('upload accepts --confirm-target only once');
      }
      confirmTargetName = argsList[index + 1];
      if (!confirmTargetName || confirmTargetName.startsWith('--')) {
        throw new Error('--confirm-target requires the exact existing table name');
      }
      index += 1;
      continue;
    }
    if (['--encoding', '--delimiter'].includes(argument)) {
      throw new Error(
        `${argument} is unsupported because no captured live import contract exists for it`,
      );
    }
    if (argument.startsWith('--')) throw new Error(`unknown upload option: ${argument}`);
    positional.push(argument);
  }
  if (positional.length < 1 || positional.length > 2) {
    throw new Error(
      'upload usage: <localFile> [tableName] [--worksheet <exactWorksheetName>] '
      + '[--replace --confirm-target <exactName>] [--source-url <publicProvenanceUrl>]',
    );
  }
  if (confirmTargetName && !replace) {
    throw new Error('--confirm-target is valid only with --replace');
  }
  if (replace && !confirmTargetName) {
    throw new Error('upload --replace requires --confirm-target <exactExistingTableName>');
  }
  classifyLocalImportSource({ filePath: positional[0], worksheet });
  let sourceProvenance = null;
  if (PLATFORM_PROFILE) {
    await assertCompetitionUploadSource(PLATFORM_PROFILE, sourceUrl);
    sourceProvenance = {
      kind: 'declared-public-url',
      validatedPublic: true,
      provenanceOnly: true,
      persistedByImport: false,
      remoteSourceFetched: false,
    };
  } else if (sourceUrl != null) {
    throw new Error(
      '--source-url is not a remote import source and is accepted only as required '
      + 'competition-2026 provenance metadata',
    );
  }
  await cmdUpload(positional[0], positional[1], {
    replace,
    worksheet,
    sourceProvenance,
    confirmTargetName,
  });
}

function parseImportedTableId(tableId) {
  const parsed = parseImportedTableReference(tableId);
  return {
    dataSourceId: parsed.dataSourceId,
    schemaId: parsed.schemaId,
    tableName: parsed.physicalTableName,
  };
}

function parseEtlTargetReference(graph) {
  const targets = (graph?.nodes || []).filter((node) => (
    node?.type === 'JDBC_DATATARGER_OVERWRITE'
    || node?.name === 'JDBC_DATATARGER_OVERWRITE'
  ));
  if (targets.length !== 1) {
    throw new Error(`ETL must contain exactly one materialized target; found ${targets.length}`);
  }
  const target = targets[0];
  const config = (target.configs || []).find((item) => item.name === 'jdbcTarget');
  if (!config?.value) throw new Error('ETL materialized target has no jdbcTarget configuration');
  let value;
  try {
    value = typeof config.value === 'string' ? JSON.parse(config.value) : config.value;
  } catch {
    throw new Error('ETL materialized target configuration is not valid JSON');
  }
  const physicalTableName = String(value?.tableId || '').trim();
  const schemaSuffix = String(value?.schemaId || '').replace(/^SCHEMA\./, '');
  const importedTableId = target.smartbiCliTargetTableId
    || (physicalTableName && schemaSuffix ? `TAB.${schemaSuffix}.${physicalTableName}` : null);
  if (!value?.datasourceId || !physicalTableName || !importedTableId) {
    throw new Error('ETL materialized target configuration is incomplete');
  }
  return {
    nodeId: target.id,
    dataSourceId: value.datasourceId,
    schemaId: value.schemaId,
    physicalTableName,
    tableId: importedTableId,
  };
}

async function assertCompetitionModelLineage({
  parentId,
  dataSourceId,
  tableId,
  tableName,
  sourceFlowId,
}) {
  if (!PLATFORM_PROFILE) return null;
  if (!sourceFlowId) {
    throw new Error('competition model-create requires --etl-flow <ownedFlowId>');
  }
  const source = normalizeModelSourceReference({ dataSourceId, tableId, tableName });
  const { processDag, graph } = await loadEtlFlow(sourceFlowId, { requireOwned: true });
  if (processDag.id !== sourceFlowId) {
    throw new Error('competition source ETL id changed while verifying model lineage');
  }
  assertCompetitionEtlGraph(PLATFORM_PROFILE, graph);
  await assertCompetitionResourceDirectChild(parentId, sourceFlowId, 'source ETL');
  const target = parseEtlTargetReference(graph);
  if (
    target.dataSourceId !== source.dataSource
    || target.schemaId !== source.schema
    || target.tableId !== source.tableId
    || target.physicalTableName !== source.table
  ) {
    throw new Error(
      `competition model source does not exactly match ETL target tuple: ${sourceFlowId}`,
    );
  }
  const instanceId = String(processDag.currentInstanceId || '').trim();
  if (!instanceId) throw new Error(`competition source ETL has no current run: ${sourceFlowId}`);
  const flowState = await smartbixApi(
    `datamining/flowstate/${encodeURIComponent(instanceId)}`,
  );
  const currentRun = assertCurrentEtlRunEvidence(processDag, graph, flowState, {
    tableId: source.tableId,
    dataSourceId: source.dataSource,
    physicalTableName: source.table,
  });
  const inbound = (graph.links || []).filter((link) => link.to === currentRun.target.nodeId);
  if (inbound.length !== 1) {
    throw new Error(`competition source ETL target must have one inbound link; found ${inbound.length}`);
  }
  const previewNode = (graph.nodes || []).find((node) => node.id === inbound[0].from);
  const previewPortId = inbound[0].inputPortId;
  if (!previewNode?.id || !previewPortId) {
    throw new Error(`competition source ETL has no previewable terminal port: ${sourceFlowId}`);
  }
  const previewResult = await smartbixApi(
    `miningnode/portresult/${encodeURIComponent(`${previewNode.id}-${instanceId}`)}/`
    + `${encodeURIComponent(previewPortId)}/csv`,
  );
  const preview = summarizePortResult(previewResult);
  if (!preview.available || !Number.isInteger(preview.rowCount) || preview.rowCountComplete !== true) {
    throw new Error(`competition source ETL current run has no complete terminal preview: ${sourceFlowId}`);
  }
  return {
    flowId: processDag.id,
    flowName: processDag.name,
    currentInstanceId: currentRun.instanceId,
    target: {
      dataSource: source.dataSource,
      schema: source.schema,
      table: source.table,
      tableId: source.tableId,
    },
    terminalPreview: {
      rowCount: preview.rowCount,
      fieldCount: preview.featureCount,
      complete: preview.rowCountComplete,
    },
  };
}

async function loadCompetitionModelTrainingEvidence({
  model,
  parentId,
  sourceFlowId,
  validatorCount,
}) {
  if (!PLATFORM_PROFILE) return null;
  if (!sourceFlowId) {
    throw new Error('competition aichat-graph-build requires --etl-flow <ownedFlowId>');
  }
  await assertCompetitionResourceDirectChild(parentId, sourceFlowId, 'source ETL');
  const { processDag, graph } = await loadEtlFlow(sourceFlowId, { requireOwned: true });
  if (processDag.id !== sourceFlowId) {
    throw new Error('model source ETL id changed while verifying training-count provenance');
  }
  assertCompetitionEtlGraph(PLATFORM_PROFILE, graph);
  const target = parseEtlTargetReference(graph);
  const modelViews = (model.views || []).filter(Boolean);
  if (modelViews.length !== 1) {
    throw new Error(
      `competition AIChat training-count provenance requires exactly one model source; found ${modelViews.length}`,
    );
  }
  const modelView = modelViews[0];
  const normalizeEvidenceId = (value) => String(value || '').toLowerCase();
  const modelDataSourceId = normalizeEvidenceId(
    modelView.define?.dataSource || modelView.dataSource,
  );
  const targetDataSourceId = normalizeEvidenceId(target.dataSourceId);
  const modelTableIds = new Set(
    [modelView.define?.tableId, modelView.define?.tableName, modelView.name]
      .map(normalizeEvidenceId)
      .filter(Boolean),
  );
  const targetTableIds = [target.tableId, target.physicalTableName]
    .map(normalizeEvidenceId)
    .filter(Boolean);
  if (
    !modelDataSourceId
    || modelDataSourceId !== targetDataSourceId
    || !targetTableIds.some((tableId) => modelTableIds.has(tableId))
  ) {
    throw new Error('model source does not exactly match the confirmed ETL materialized target');
  }

  const instanceId = String(processDag.currentInstanceId || '').trim();
  if (!instanceId) {
    throw new Error(`model source ETL has no current completed instance: ${sourceFlowId}`);
  }
  const state = await smartbixApi(`datamining/flowstate/${encodeURIComponent(instanceId)}`);
  const currentRun = assertCurrentEtlRunEvidence(processDag, graph, state, target);
  const inbound = (graph.links || []).filter((link) => link.to === currentRun.target.nodeId);
  if (inbound.length !== 1) {
    throw new Error(`model source ETL target must have one inbound link; found ${inbound.length}`);
  }
  const previewNode = (graph.nodes || []).find((node) => node.id === inbound[0].from);
  const previewPortId = inbound[0].inputPortId || previewNode?.outputs?.[0]?.id;
  if (!previewNode?.id || !previewPortId) {
    throw new Error(`model source ETL has no previewable terminal port: ${sourceFlowId}`);
  }
  const previewResult = await smartbixApi(
    `miningnode/portresult/${encodeURIComponent(`${previewNode.id}-${instanceId}`)}/${encodeURIComponent(previewPortId)}/csv`,
  );
  const preview = summarizePortResult(previewResult);
  if (
    !preview.available
    || !Number.isInteger(preview.rowCount)
    || preview.rowCountComplete !== true
  ) {
    throw new Error(`model source ETL current run did not report a complete row count: ${sourceFlowId}`);
  }
  const targetMetadata = await smartbixApi(
    `miningdatasource/table?tableId=${encodeURIComponent(target.tableId)}`,
  );
  requireNamespacedResource(targetMetadata, 'materialized ETL target table');
  return verifyAichatTrainingCountProvenance({
    validatorCount,
    etlRunCount: preview.rowCount,
    etlFlowId: sourceFlowId,
    currentInstanceId: instanceId,
    targetTableId: target.tableId,
    currentEtlRunVerified: true,
    etlCountComplete: true,
    etlCountSource: preview.rowCountSource,
    independentTargetVerified: true,
  });
}

function instantiateEtlNode(template, x, y) {
  const node = structuredClone(template);
  node.id = resourceId();
  node.type ||= node.name;
  node.inputs = (node.inputs || []).map((port) => ({ ...port, id: resourceId() }));
  node.outputs = (node.outputs || []).map((port) => ({ ...port, id: resourceId() }));
  node.needCache = false;
  node.state = 'INITED';
  node.x = x;
  node.y = y;
  return node;
}

function connectEtlNodes(left, right, options = {}) {
  return createEtlLink(left, right, options);
}

async function cmdEtlCreateArgs(argsList) {
  const { positional, confirmation } = parseExactConfirmationArgs(argsList, 'etl-create');
  if (positional.length < 4 || positional.length > 6) {
    throw new Error(
      'etl-create requires <parentId> <sourceTableId> <targetTableId> <name> '
      + '[rowNumber|-] [description] --confirm-target <exactTargetName>',
    );
  }
  await cmdEtlCreate(
    positional[0],
    positional[1],
    positional[2],
    positional[3],
    positional[4],
    positional[5],
    confirmation,
  );
}

async function cmdEtlCreate(
  parentId,
  sourceTableId,
  targetTableId,
  requestedName,
  rowNumber = '-',
  description = '',
  confirmTargetName = null,
) {
  if (![parentId, sourceTableId, targetTableId, requestedName].every(Boolean)) {
    throw new Error(
      'etl-create requires <parentId> <sourceTableId> <targetTableId> <name> '
      + '[rowNumber|-] [description] --confirm-target <exactTargetName>',
    );
  }
  assertDistinctEtlTableIds([sourceTableId], targetTableId);
  const addRowNumber = rowNumber !== '-';
  if (addRowNumber && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rowNumber)) {
    throw new Error(`invalid row-number column name: ${rowNumber}`);
  }

  await assertOwnedCatalogParent(parentId);
  await ensureSession();
  const personalFolder = await locatePersonalFolder();
  const [sourceMeta, targetMeta, rawNodeCatalog, personalChildren] = await Promise.all([
    smartbixApi(`miningdatasource/table?tableId=${encodeURIComponent(sourceTableId)}`),
    smartbixApi(`miningdatasource/table?tableId=${encodeURIComponent(targetTableId)}`),
    smartbixApi('datamining/nodes'),
    listCatalogChildren(personalFolder.folderId, 'personal acquisition folder'),
  ]);
  if (!hasNamespace(sourceMeta?.alias || sourceMeta?.name)) {
    throw new Error(`refusing to read non-namespaced source table: ${sourceMeta?.alias || sourceTableId}`);
  }
  if (!hasNamespace(targetMeta?.alias || targetMeta?.name)) {
    throw new Error(`refusing to overwrite non-namespaced target table: ${targetMeta?.alias || targetTableId}`);
  }
  assertExactResourceConfirmation(targetMeta, confirmTargetName);
  const sourceRef = parseImportedTableId(sourceTableId);
  const targetRef = parseImportedTableId(targetTableId);
  assertCompetitionEtlTableBindings(PLATFORM_PROFILE, {
    sources: [{ tableId: sourceTableId, ...sourceRef, physicalTableName: sourceRef.tableName }],
    target: { tableId: targetTableId, ...targetRef, physicalTableName: targetRef.tableName },
    personalFolder,
    personalChildren,
  });

  const nodeCatalog = normalizeEtlNodeCatalog(rawNodeCatalog);
  const sourceTemplate = nodeCatalog.defaultOptions.find((node) => node.name === 'JDBC_DATASOURCE');
  const rowNumberTemplate = nodeCatalog.defaultOptions.find((node) => node.name === 'DATAPREPARE_ROW_NUMBER');
  if (!sourceTemplate || (addRowNumber && !rowNumberTemplate)) {
    throw new Error('required ETL node templates are unavailable');
  }
  assertVerifiedEtlTemplate(sourceTemplate, 'create');
  if (rowNumberTemplate) assertVerifiedEtlTemplate(rowNumberTemplate, 'create');

  let source = instantiateEtlNode(sourceTemplate, 350, 50);
  source.alias = sourceMeta.alias || sourceMeta.name;
  source = configureEtlNode(source, sourceTemplate, {
    jdbc: JSON.stringify({
      datasourceId: sourceRef.dataSourceId,
      schemaId: sourceRef.schemaId,
      tableData: {
        id: sourceTableId,
        schema: sourceMeta.schema ?? null,
        name: sourceMeta.name || sourceRef.tableName,
        alias: sourceMeta.alias || sourceMeta.name || sourceRef.tableName,
        desc: sourceMeta.desc || sourceMeta.alias || sourceMeta.name || sourceRef.tableName,
        type: sourceMeta.type ?? null,
        extended: sourceMeta.extended ?? null,
      },
      advancedSettings: '# 读取数据批次大小\n# QUERY_JDBC_FETCHSIZE=5000',
      tableId: sourceTableId,
    }),
  }).node;

  const tempDag = await smartbixApi('dataprocess/jdbcDataTargetDag', {
    method: 'POST',
    body: {
      id: null,
      name: null,
      alias: '未命名',
      cache: false,
      smallBatch: false,
      desc: null,
      createdDate: null,
      lastModifiedDate: null,
      runningInfo: { dagState: null, costTime: null },
      define: null,
      targetTableId,
    },
  });
  if (!tempDag?.id || !tempDag?.define) {
    throw new Error('target-node template creation returned an incomplete contract');
  }
  const targetGraph = normalizeEtlGraph(JSON.parse(tempDag.define));
  const target = targetGraph.nodes.find((node) => node.type === 'JDBC_DATATARGER_OVERWRITE');
  if (!target) throw new Error('target-node template contains no overwrite node');
  assertVerifiedEtlTemplate(target, 'create');
  target.state = 'INITED';
  target.smartbiCliTargetTableId = targetTableId;

  const nodes = [source];
  if (addRowNumber) {
    const rowNode = instantiateEtlNode(rowNumberTemplate, 470, 50);
    const configured = configureEtlNode(rowNode, rowNumberTemplate, { name: rowNumber });
    configured.node.smartbiCliKey = 'row_number';
    nodes.push(configured.node);
  }
  target.x = 350 + (nodes.length * 120);
  target.y = 50;
  nodes.push(target);
  const links = [];
  for (let index = 1; index < nodes.length; index += 1) {
    links.push(connectEtlNodes(nodes[index - 1], nodes[index]));
  }

  const name = applyNamespace(requestedName);
  const processDag = {
    ...tempDag,
    id: tempDag.id,
    pid: parentId,
    name,
    alias: name,
    desc: description,
    cache: true,
    smallBatch: false,
    state: 'INITED',
    currentInstanceId: null,
    runningInfo: { dagState: 'INITED', costTime: 0 },
    define: JSON.stringify(normalizeEtlGraph({
      version: { editor: 'HORIZONTAL' },
      nodes,
      links,
      top: 10,
      left: 37,
    })),
  };
  const createdGraph = assertExecutableEtlGraph(JSON.parse(processDag.define));
  const createdBindings = extractEtlTableBindings(createdGraph);
  if (createdBindings.sources.length !== 1 || createdBindings.targets.length !== 1) {
    throw new Error('created ETL graph did not preserve its exact source and target bindings');
  }
  const saved = await smartbixApi('dataprocess/processflowdefine/define', {
    method: 'POST',
    body: {
      processDag,
      dagRemark: null,
      toSaveTempDag: true,
      cover: false,
    },
  });
  const flowId = saved.id || tempDag.id;
  const verified = await loadEtlFlow(flowId, { requireOwned: true });
  if (verified.processDag.pid !== parentId || verified.processDag.name !== name) {
    throw new Error('created ETL flow was not reopened at the exact requested placement and name');
  }
  assertEtlGraphPersisted(JSON.parse(processDag.define), verified.graph);
  safeOutput({
    ok: true,
    id: flowId,
    name: verified.processDag.name,
    source: { id: sourceTableId, name: sourceMeta.alias || sourceMeta.name },
    target: { id: targetTableId, name: targetMeta.alias || targetMeta.name },
    rowNumber: addRowNumber ? rowNumber : null,
    nodeCount: verified.graph.nodes?.length || 0,
    linkCount: verified.graph.links?.length || 0,
  });
}

async function cmdEtlUnionCreateArgs(argsList) {
  const { positional, confirmation } = parseExactConfirmationArgs(argsList, 'etl-union-create');
  if (positional.length < 4) {
    throw new Error(
      'etl-union-create requires <parentId> <targetTableId> <name> '
      + '<sourceTableIdsJson> [description] --confirm-target <exactTargetName>',
    );
  }
  await cmdEtlUnionCreate(
    positional[0],
    positional[1],
    positional[2],
    positional[3],
    positional.slice(4).join(' '),
    confirmation,
  );
}
async function cmdEtlUnionCreate(
  parentId,
  targetTableId,
  requestedName,
  sourceTableIdsJson,
  description = '',
  confirmTargetName = null,
) {
  if (![parentId, targetTableId, requestedName, sourceTableIdsJson].every(Boolean)) {
    throw new Error(
      'etl-union-create requires <parentId> <targetTableId> <name> '
      + '<sourceTableIdsJson> [description] --confirm-target <exactTargetName>',
    );
  }
  assertCompetitionUnionAllowed(PLATFORM_PROFILE);
  const sourceTableIds = JSON.parse(sourceTableIdsJson);
  if (!Array.isArray(sourceTableIds) || sourceTableIds.length < 2) {
    throw new Error('etl-union-create requires an array of at least 2 source table ids');
  }
  assertDistinctEtlTableIds(sourceTableIds, targetTableId);
  await assertOwnedCatalogParent(parentId);
  await ensureSession();
  const personalFolder = await locatePersonalFolder();
  const targetRef = parseImportedTableId(targetTableId);
  const [sourceMetas, targetMeta, targetTable, rawNodeCatalog, personalChildren] = await Promise.all([
    Promise.all(sourceTableIds.map(async (tableId) => {
      const tableRef = parseImportedTableId(tableId);
      const [sourceMeta, table] = await Promise.all([
        smartbixApi(`miningdatasource/table?tableId=${encodeURIComponent(tableId)}`),
        smartbixApi('datasets/table', {
          method: 'POST',
          body: {
            dataSourceId: tableRef.dataSourceId,
            tableId,
            tableName: tableRef.tableName,
          },
        }),
      ]);
      return { ...sourceMeta, fields: table.fields || [] };
    })),
    smartbixApi(`miningdatasource/table?tableId=${encodeURIComponent(targetTableId)}`),
    smartbixApi('datasets/table', {
      method: 'POST',
      body: {
        dataSourceId: targetRef.dataSourceId,
        tableId: targetTableId,
        tableName: targetRef.tableName,
      },
    }),
    smartbixApi('datamining/nodes'),
    listCatalogChildren(personalFolder.folderId, 'personal acquisition folder'),
  ]);
  for (let index = 0; index < sourceMetas.length; index += 1) {
    if (!hasNamespace(sourceMetas[index]?.alias || sourceMetas[index]?.name)) {
      throw new Error(`refusing to read non-namespaced source table: ${sourceTableIds[index]}`);
    }
  }
  if (!hasNamespace(targetMeta?.alias || targetMeta?.name)) {
    throw new Error(`refusing to overwrite non-namespaced target table: ${targetTableId}`);
  }
  assertExactResourceConfirmation(targetMeta, confirmTargetName);
  assertCompetitionEtlTableBindings(PLATFORM_PROFILE, {
    sources: sourceTableIds.map((tableId) => {
      const sourceRef = parseImportedTableId(tableId);
      return { tableId, ...sourceRef, physicalTableName: sourceRef.tableName };
    }),
    target: { tableId: targetTableId, ...targetRef, physicalTableName: targetRef.tableName },
    personalFolder,
    personalChildren,
  });
  const nodeCatalog = normalizeEtlNodeCatalog(rawNodeCatalog);
  const sourceTemplate = nodeCatalog.defaultOptions.find((node) => node.name === 'JDBC_DATASOURCE');
  const unionTemplate = nodeCatalog.defaultOptions.find((node) => node.name === 'UNION_ALL');
  if (!sourceTemplate || !unionTemplate || unionTemplate.inputs.length < sourceTableIds.length) {
    throw new Error('required JDBC source or UNION_ALL node template is unavailable');
  }
  assertVerifiedEtlTemplate(sourceTemplate, 'create');
  assertVerifiedEtlTemplate(unionTemplate, 'create');
  const sources = sourceMetas.map((sourceMeta, index) => {
    const tableId = sourceTableIds[index];
    const sourceRef = parseImportedTableId(tableId);
    let source = instantiateEtlNode(sourceTemplate, 350, 50 + (index * 120));
    source.alias = sourceMeta.alias || sourceMeta.name;
    source = configureEtlNode(source, sourceTemplate, {
      jdbc: JSON.stringify({
        datasourceId: sourceRef.dataSourceId,
        schemaId: sourceRef.schemaId,
        tableData: {
          id: tableId,
          schema: sourceMeta.schema ?? null,
          name: sourceMeta.name || sourceRef.tableName,
          alias: sourceMeta.alias || sourceMeta.name || sourceRef.tableName,
          desc: sourceMeta.desc || sourceMeta.alias || sourceMeta.name || sourceRef.tableName,
          type: sourceMeta.type ?? null,
          extended: sourceMeta.extended ?? null,
        },
        advancedSettings: '# 读取数据批次大小\n# QUERY_JDBC_FETCHSIZE=5000',
        tableId,
      }),
    }).node;
    return source;
  });
  const canonicalFields = sourceMetas[0].fields || [];
  normalizeEtlSchema(canonicalFields, 'union source schema 0');
  for (let index = 1; index < sourceMetas.length; index += 1) {
    assertEtlSchemasIdentical(canonicalFields, sourceMetas[index].fields || [], {
      expectedLabel: 'union source schema 0',
      actualLabel: `union source schema ${index}`,
    });
  }
  assertEtlSchemasIdentical(canonicalFields, targetTable?.fields || [], {
    expectedLabel: 'union output schema',
    actualLabel: 'union overwrite target schema',
  });
  const canonicalNames = canonicalFields.map((field) => field.name);
  let union = instantiateEtlNode(unionTemplate, 540, 50 + ((sources.length - 1) * 60));
  union.smartbiCliKey = 'decision_master_union';
  const inputColumns = sourceMetas.map((meta) => meta.fields || []);
  const mappedInputs = inputColumns.map((fields) => fields.map((field) => ({ ...field, tag: 'name' })));
  const tableData = canonicalFields.map((field, fieldIndex) => {
    const row = {
      output: field.name,
      dataType: field.dataType,
      tag: 'name',
      index: fieldIndex,
    };
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      row[`input${sourceIndex + 1}`] = field.name;
    }
    return row;
  });
  const columns = [
    { key: 'output', label: '输出列' },
    ...sources.map((source, index) => ({
      key: `input${index + 1}`,
      label: source.alias,
      options: canonicalNames,
      columns: inputColumns[index],
    })),
  ];
  union = configureEtlNode(union, unionTemplate, {
    unionAll: JSON.stringify({
      tableData: JSON.stringify(tableData),
      columns: JSON.stringify(columns),
      outputColumn: JSON.stringify(canonicalFields.map((field) => ({ ...field, tag: 'name' }))),
      inputColumns: JSON.stringify(inputColumns),
      unionAllData: JSON.stringify([
        JSON.stringify(canonicalFields.map((field) => ({ ...field, tag: 'name' }))),
        ...mappedInputs.map((fields) => JSON.stringify(fields)),
      ]),
      recordOperateType: 'byName',
    }),
    type: 'unionAll',
  }).node;
  const tempDag = await smartbixApi('dataprocess/jdbcDataTargetDag', {
    method: 'POST',
    body: {
      id: null,
      name: null,
      alias: '未命名',
      cache: false,
      smallBatch: false,
      desc: null,
      createdDate: null,
      lastModifiedDate: null,
      runningInfo: { dagState: null, costTime: null },
      define: null,
      targetTableId,
    },
  });
  if (!tempDag?.id || !tempDag?.define) {
    throw new Error('target-node template creation returned an incomplete contract');
  }
  const targetGraph = normalizeEtlGraph(JSON.parse(tempDag.define));
  const target = targetGraph.nodes.find((node) => node.type === 'JDBC_DATATARGER_OVERWRITE');
  if (!target) throw new Error('target-node template contains no overwrite node');
  assertVerifiedEtlTemplate(target, 'create');
  target.state = 'INITED';
  target.smartbiCliTargetTableId = targetTableId;
  target.x = 730;
  target.y = union.y;
  const nodes = [...sources, union, target];
  const links = sources.map((source, index) => (
    connectEtlNodes(source, union, { rightPortIndex: index })
  ));
  links.push(connectEtlNodes(union, target));
  const name = applyNamespace(requestedName);
  const processDag = {
    ...tempDag,
    pid: parentId,
    name,
    alias: name,
    desc: description,
    cache: true,
    smallBatch: false,
    state: 'INITED',
    currentInstanceId: null,
    runningInfo: { dagState: 'INITED', costTime: 0 },
    define: JSON.stringify(normalizeEtlGraph({
      version: { editor: 'HORIZONTAL' },
      nodes,
      links,
      top: 10,
      left: 37,
    })),
  };
  const createdGraph = assertExecutableEtlGraph(JSON.parse(processDag.define));
  const createdBindings = extractEtlTableBindings(createdGraph);
  if (
    createdBindings.sources.length !== sourceTableIds.length
    || createdBindings.targets.length !== 1
  ) {
    throw new Error('created union ETL graph did not preserve its exact source and target bindings');
  }
  const saved = await smartbixApi('dataprocess/processflowdefine/define', {
    method: 'POST',
    body: {
      processDag,
      dagRemark: null,
      toSaveTempDag: true,
      cover: false,
    },
  });
  const flowId = saved.id || tempDag.id;
  const verified = await loadEtlFlow(flowId, { requireOwned: true });
  if (verified.processDag.pid !== parentId || verified.processDag.name !== name) {
    throw new Error('created union ETL flow was not reopened at the exact requested placement and name');
  }
  assertEtlGraphPersisted(JSON.parse(processDag.define), verified.graph);
  safeOutput({
    ok: true,
    id: flowId,
    name: verified.processDag.name,
    sources: sourceTableIds.map((id, index) => ({
      id,
      name: sourceMetas[index].alias || sourceMetas[index].name,
    })),
    target: { id: targetTableId, name: targetMeta.alias || targetMeta.name },
    nodeCount: verified.graph.nodes?.length || 0,
    linkCount: verified.graph.links?.length || 0,
  });
}

async function loadEtlFlow(flowId, { requireOwned = false } = {}) {
  if (!flowId) throw new Error('flow id is required');
  await ensureSession();
  const wrapper = await smartbixApi(`datamining/flow/${encodeURIComponent(flowId)}/no`);
  const processDag = wrapper?.processDag;
  if (!processDag?.define || (processDag.id && processDag.id !== flowId)) {
    throw new Error(`ETL flow not found, mismatched, or incomplete: ${flowId}`);
  }
  if (requireOwned && !hasNamespace(processDag.name)) {
    throw new Error(`refusing to modify or run non-namespaced ETL flow: ${processDag.name}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(processDag.define);
  } catch {
    throw new Error(`ETL flow definition is not valid JSON: ${flowId}`);
  }
  return { wrapper, processDag, graph: normalizeEtlGraph(parsed) };
}

async function saveEtlGraph(processDag, graph, { definitionChanged = true } = {}) {
  if (definitionChanged && processDag.currentInstanceId) {
    const currentState = await smartbixApi(
      `datamining/flowstate/${encodeURIComponent(processDag.currentInstanceId)}`,
    );
    if (!isEtlTerminalState(currentState?.state)) {
      throw new Error('refusing to change an ETL definition while its current instance is non-terminal');
    }
  }
  const nextDag = prepareEtlProcessDag(processDag, graph, { definitionChanged });
  const saved = await smartbixApi('dataprocess/processflowdefine/define', {
    method: 'POST',
    body: {
      processDag: nextDag,
      dagRemark: null,
      toSaveTempDag: false,
      cover: false,
    },
  });
  const flowId = saved?.id || nextDag.id;
  if (!flowId) throw new Error('ETL graph save returned no flow id');
  const verified = await loadEtlFlow(flowId, { requireOwned: true });
  if (
    (nextDag.id && verified.processDag.id !== nextDag.id)
    || (nextDag.pid && verified.processDag.pid !== nextDag.pid)
    || verified.processDag.name !== nextDag.name
    || (nextDag.alias != null && verified.processDag.alias !== nextDag.alias)
  ) {
    throw new Error(`ETL graph save changed the resource identity or placement: ${flowId}`);
  }
  assertEtlGraphPersisted(JSON.parse(nextDag.define), verified.graph);
  assertEtlProcessDagMetadataPreserved(nextDag, verified.processDag);
  if (definitionChanged && verified.processDag.currentInstanceId) {
    throw new Error(`ETL definition save retained stale run identity: ${flowId}`);
  }
  if (
    !definitionChanged
    && String(verified.processDag.currentInstanceId || '') !== String(processDag.currentInstanceId || '')
  ) {
    throw new Error(`ETL metadata save changed the current run identity: ${flowId}`);
  }
  return verified;
}

async function cmdEtlDescribeArgs(argsList) {
  const { positional, confirmation } = parseExactConfirmationArgs(
    argsList,
    'etl-describe',
    '--confirm-name',
    { required: false },
  );
  if (positional.length < 2 || !confirmation) {
    throw new Error(
      'etl-describe requires <flowId> <natural-language description> --confirm-name <exactFlowName>',
    );
  }
  await cmdEtlDescribe(positional[0], positional.slice(1).join(' '), confirmation);
}

async function cmdEtlDescribe(flowId, description, confirmFlowName = null) {
  const text = String(description || '').trim();
  if (!flowId || !text) {
    throw new Error(
      'etl-describe requires <flowId> <natural-language description> --confirm-name <exactFlowName>',
    );
  }
  const { processDag, graph } = await loadEtlFlow(flowId, { requireOwned: true });
  assertExactResourceConfirmation(processDag, confirmFlowName);
  const previousInstanceId = processDag.currentInstanceId || null;
  const verified = await saveEtlGraph({ ...processDag, desc: text }, graph, {
    definitionChanged: false,
  });
  if (verified.processDag.desc !== text) {
    throw new Error(`ETL description update was not persisted: ${flowId}`);
  }
  if ((verified.processDag.currentInstanceId || null) !== previousInstanceId) {
    throw new Error(`ETL description update invalidated current run identity: ${flowId}`);
  }
  safeOutput({
    ok: true,
    id: flowId,
    name: verified.processDag.name,
    description: verified.processDag.desc,
    currentInstanceId: verified.processDag.currentInstanceId || null,
  });
}

async function cmdEtlNodeList(keyword = '') {
  await ensureSession();
  const catalog = normalizeEtlNodeCatalog(await smartbixApi('datamining/nodes'));
  const normalized = String(keyword).toLocaleLowerCase();
  const nodes = catalog.defaultOptions.filter((node) => (
    !normalized
    || node.name.toLocaleLowerCase().includes(normalized)
    || String(node.alias || '').toLocaleLowerCase().includes(normalized)
  ));
  safeOutput({
    ok: true,
    count: nodes.length,
    nodes: nodes.map(describeEtlNodeTemplate),
  });
}


async function cmdEtlInsertArgs(argsList) {
  const { positional, confirmation } = parseExactConfirmationArgs(
    argsList,
    'etl-insert',
    '--confirm-name',
    { required: false },
  );
  if (positional.length < 2 || positional.length > 4 || !confirmation) {
    throw new Error(
      'etl-insert requires <flowId> <nodeName> [configJson] [instanceKey] '
      + '--confirm-name <exactFlowName>',
    );
  }
  await cmdEtlInsert(
    positional[0],
    positional[1],
    positional[2],
    positional[3],
    confirmation,
  );
}

async function cmdEtlInsert(
  flowId,
  nodeName,
  configJson = '{}',
  instanceKey = nodeName,
  confirmFlowName = null,
) {
  if (!flowId || !nodeName) {
    throw new Error(
      'etl-insert requires <flowId> <nodeName> [configJson] [instanceKey] '
      + '--confirm-name <exactFlowName>',
    );
  }
  const configValues = JSON.parse(configJson);
  if (!instanceKey || typeof instanceKey !== 'string') {
    throw new Error('etl-insert instanceKey must be a non-empty string');
  }
  const loaded = await loadEtlFlow(flowId, { requireOwned: true });
  assertExactResourceConfirmation(loaded.processDag, confirmFlowName);
  const { processDag } = loaded;
  let { graph } = loaded;
  const catalog = normalizeEtlNodeCatalog(await smartbixApi('datamining/nodes'));
  const template = catalog.defaultOptions.find((node) => node.name === nodeName);
  if (!template) throw new Error(`ETL node template not found: ${nodeName}`);
  assertVerifiedEtlTemplate(template, 'insert');

  let node = graph.nodes.find((item) => item.smartbiCliKey === instanceKey);
  let changed = false;
  if (node) {
    if (node.name !== nodeName) {
      throw new Error(`ETL instance key ${instanceKey} already belongs to ${node.name}`);
    }
    const configured = configureEtlNode(
      node,
      template,
      configValues,
      node.smartbiCliConfiguredKeys || [],
    );
    node = configured.node;
    changed = configured.changed;
    if (changed) {
      node.state = 'INITED';
      graph = {
        ...graph,
        nodes: graph.nodes.map((candidate) => candidate.id === node.id ? node : candidate),
      };
    }
  } else {
    const terminals = graph.nodes.filter((candidate) => candidate.outputs.length === 0);
    if (terminals.length !== 1) {
      throw new Error(`ETL must have one zero-output terminal; found ${terminals.length}`);
    }
    node = instantiateEtlNode(template, 0, 0);
    const configured = configureEtlNode(node, template, configValues);
    node = { ...configured.node, smartbiCliKey: instanceKey };
    positionEtlNodeBeforeTarget(node, terminals[0]);
    graph = spliceUnaryBeforeTerminal(graph, node).graph;
    changed = true;
  }

  graph = assertExecutableEtlGraph(graph);
  const bindingCheck = extractEtlTableBindings(graph);
  if (bindingCheck.targets.length !== 1) throw new Error('ETL mutation lost its overwrite target');
  assertDistinctEtlTableIds(
    bindingCheck.sources.map((source) => source.tableId),
    bindingCheck.targets[0].tableId,
  );
  assertCompetitionEtlGraph(PLATFORM_PROFILE, graph);
  const verified = changed
    ? await saveEtlGraph(processDag, graph, { definitionChanged: true })
    : loaded;
  const persistedNode = verified.graph.nodes.find((candidate) => candidate.id === node.id);
  if (!persistedNode) throw new Error(`ETL inserted node was not persisted: ${node.id}`);
  safeOutput({
    ok: true,
    changed,
    flowId: verified.processDag.id || processDag.id,
    flowName: verified.processDag.name || processDag.name,
    node: {
      id: persistedNode.id,
      name: persistedNode.name,
      alias: persistedNode.alias,
      instanceKey,
      configuredKeys: persistedNode.smartbiCliConfiguredKeys || [],
      configs: Object.fromEntries(
        (persistedNode.configs || []).map((config) => [config.name, config.value]),
      ),
    },
  });
}

async function cmdEtlOutputDatasetArgs(argsList) {
  const { positional, confirmation } = parseExactConfirmationArgs(
    argsList,
    'etl-output-dataset',
    '--confirm-name',
    { required: false },
  );
  if (positional.length !== 2 || !confirmation) {
    throw new Error(
      'etl-output-dataset requires <flowId> <datasetName> --confirm-name <exactFlowName>',
    );
  }
  await cmdEtlOutputDataset(positional[0], positional[1], confirmation);
}

async function cmdEtlOutputDataset(flowId, requestedName, confirmFlowName = null) {
  if (!flowId || !requestedName) {
    throw new Error(
      'etl-output-dataset requires <flowId> <datasetName> --confirm-name <exactFlowName>',
    );
  }
  assertCompetitionEtlOutputMutationAllowed(PLATFORM_PROFILE);
  const loaded = await loadEtlFlow(flowId, { requireOwned: true });
  assertExactResourceConfirmation(loaded.processDag, confirmFlowName);
  const { processDag } = loaded;
  let { graph } = loaded;
  const targets = graph.nodes.filter((item) => item.outputs.length === 0);
  if (targets.length !== 1) {
    throw new Error(`ETL must have one terminal target; found ${targets.length}`);
  }
  const target = targets[0];
  if (!['JDBC_DATATARGER_OVERWRITE', 'SMARTBI_DATASET_OUTPUT'].includes(target.name)) {
    throw new Error(`ETL terminal effect is not supported for output mutation: ${target.name}`);
  }
  const inbound = graph.links.filter((link) => link.to === target.id);
  if (inbound.length !== 1) {
    throw new Error(`ETL terminal target must have one inbound link; found ${inbound.length}`);
  }
  const tableName = applyNamespace(requestedName);
  const catalog = normalizeEtlNodeCatalog(await smartbixApi('datamining/nodes'));
  const template = catalog.defaultOptions.find((item) => item.name === 'SMARTBI_DATASET_OUTPUT');
  if (!template) throw new Error('SMARTBI_DATASET_OUTPUT template is unavailable');
  assertVerifiedEtlTemplate(template, 'configure');

  let changed = false;
  let output = target;
  if (target.name === 'SMARTBI_DATASET_OUTPUT') {
    const configured = configureEtlNode(target, template, { tableName });
    output = configured.node;
    changed = configured.changed;
    if (changed) {
      output.state = 'INITED';
      graph = {
        ...graph,
        nodes: graph.nodes.map((node) => node.id === output.id ? output : node),
      };
    }
  } else {
    output = instantiateEtlNode(template, Number(target.x || 0), Number(target.y || 0));
    output = configureEtlNode(output, template, { tableName }).node;
    output.smartbiCliKey = 'materialized_dataset_output';
    const previousLink = inbound[0];
    graph = {
      ...graph,
      nodes: graph.nodes.filter((item) => item.id !== target.id).concat(output),
      links: graph.links.filter((link) => link !== previousLink).concat({
        ...previousLink,
        to: output.id,
        outputPortId: output.inputs[0].id,
      }),
    };
    changed = true;
  }
  graph = assertExecutableEtlGraph(graph, { allowDatasetOutput: true });
  const verified = changed
    ? await saveEtlGraph(processDag, graph, { definitionChanged: true })
    : loaded;
  const persistedOutput = verified.graph.nodes.find((node) => node.id === output.id);
  if (!persistedOutput) throw new Error(`ETL dataset output was not persisted: ${output.id}`);
  safeOutput({
    ok: true,
    changed,
    flowId: verified.processDag.id || processDag.id,
    flowName: verified.processDag.name || processDag.name,
    output: {
      id: persistedOutput.id,
      name: persistedOutput.name,
      alias: persistedOutput.alias,
      tableName,
    },
  });
}

async function cmdEtlGet(flowId) {
  const { processDag, graph } = await loadEtlFlow(flowId);
  const bindings = extractEtlTableBindings(graph);
  safeOutput({
    ok: true,
    id: processDag.id,
    name: processDag.name,
    description: processDag.desc || '',
    state: processDag.state,
    currentInstanceId: processDag.currentInstanceId || null,
    version: graph.version || null,
    sources: bindings.sources,
    targets: bindings.targets,
    nodes: graph.nodes.map((node) => ({
      ...describeEtlNodeTemplate(node),
      id: node.id,
      state: node.state,
      x: node.x,
      y: node.y,
      instanceKey: node.smartbiCliKey || null,
      configuredKeys: node.smartbiCliConfiguredKeys || [],
    })),
    links: graph.links.map(sanitizeEtlContractValue),
  });
}

function summarizePortResult(result) {
  return summarizeEtlPortResult(result);
}

async function cmdEtlRunArgs(argsList) {
  const { positional, confirmation } = parseExactConfirmationArgs(
    argsList,
    'etl-run',
    '--confirm-target',
    { required: false },
  );
  if (positional.length !== 1 || !confirmation) {
    throw new Error('etl-run requires <flowId> --confirm-target <exactTargetName>');
  }
  await cmdEtlRun(positional[0], confirmation);
}

async function loadVerifiedEtlTableEvidence(binding, label) {
  const parsed = parseImportedTableId(binding.tableId);
  const [metadata, table] = await Promise.all([
    smartbixApi(`miningdatasource/table?tableId=${encodeURIComponent(binding.tableId)}`),
    smartbixApi('datasets/table', {
      method: 'POST',
      body: {
        dataSourceId: binding.dataSourceId,
        tableId: binding.tableId,
        tableName: parsed.tableName,
      },
    }),
  ]);
  requireNamespacedResource(metadata, label);
  if (
    metadata.id
    && String(metadata.id).toLocaleLowerCase() !== String(binding.tableId).toLocaleLowerCase()
  ) {
    throw new Error(`${label} reopened with a different table identity`);
  }
  return {
    binding,
    metadata,
    table,
    schema: normalizeEtlSchema(table?.fields || [], `${label} schema`),
  };
}

async function cmdEtlRun(flowId, confirmTargetName = null) {
  const loaded = await loadEtlFlow(flowId, { requireOwned: true });
  const { processDag } = loaded;
  const graph = assertExecutableEtlGraph(loaded.graph);
  const liveCatalog = normalizeEtlNodeCatalog(await smartbixApi('datamining/nodes'));
  for (const node of graph.nodes) {
    if (node.name === 'JDBC_DATATARGER_OVERWRITE') continue;
    const template = liveCatalog.defaultOptions.find((candidate) => candidate.name === node.name);
    if (!template) throw new Error(`persisted ETL node has no current live template: ${node.name}`);
    assertVerifiedEtlTemplate(template, 'execute');
    const checked = configureEtlNode(
      node,
      template,
      {},
      node.smartbiCliConfiguredKeys || [],
    );
    if (checked.changed) {
      throw new Error(`persisted ETL node contract is stale and must be explicitly resaved: ${node.name}`);
    }
  }
  assertCompetitionEtlGraph(PLATFORM_PROFILE, graph);
  if (!processDag.pid) throw new Error('ETL flow has no persisted catalog parent');
  await assertOwnedCatalogParent(processDag.pid);
  await assertCompetitionResourceDirectChild(processDag.pid, processDag.id, 'ETL flow');

  const { sources, targets } = extractEtlTableBindings(graph);
  if (targets.length !== 1) {
    throw new Error(`ETL run requires exactly one persisted overwrite target; found ${targets.length}`);
  }
  const [targetBinding] = targets;
  if (!confirmTargetName) {
    throw new Error('etl-run requires --confirm-target <exactTargetName> for materialized overwrite');
  }
  const personalFolder = await locatePersonalFolder();
  const personalChildren = await listCatalogChildren(
    personalFolder.folderId,
    'personal acquisition folder',
  );
  assertCompetitionEtlTableBindings(PLATFORM_PROFILE, {
    sources,
    target: targetBinding,
    personalFolder,
    personalChildren,
  });
  const [sourceEvidenceBefore, targetEvidenceBefore] = await Promise.all([
    Promise.all(sources.map((source, index) => (
      loadVerifiedEtlTableEvidence(source, `ETL source table ${index}`)
    ))),
    loadVerifiedEtlTableEvidence(targetBinding, 'materialized ETL target table'),
  ]);
  assertExactResourceConfirmation(targetEvidenceBefore.metadata, confirmTargetName);

  if (processDag.currentInstanceId) {
    const priorState = await smartbixApi(
      `datamining/flowstate/${encodeURIComponent(processDag.currentInstanceId)}`,
    );
    if (!isEtlTerminalState(priorState?.state)) {
      throw new Error(`ETL flow already has a non-terminal current instance: ${processDag.currentInstanceId}`);
    }
    const current = await loadEtlFlow(flowId, { requireOwned: true });
    assertEtlGraphPersisted(graph, current.graph);
    if (current.processDag.currentInstanceId !== processDag.currentInstanceId) {
      throw new Error('ETL current instance changed during run preflight');
    }
  }

  const runDag = {
    ...processDag,
    cache: String(processDag.cache) === 'true',
    smallBatch: String(processDag.smallBatch) === 'true',
    state: null,
    nodeStates: null,
    flowRunInfo: null,
    dagRemark: null,
    dagParam: null,
    priority: null,
    dagId: null,
    define: JSON.stringify(graph),
    endTime: null,
    startTime: null,
    runningInfo: {
      ...(processDag.runningInfo && typeof processDag.runningInfo === 'object'
        ? processDag.runningInfo
        : {}),
      dagState: processDag.state || 'INITED',
      costTime: 0,
    },
  };
  const started = await smartbixApi('datamining/processflowdefine', {
    method: 'POST',
    body: { processDag: runDag, dagRemark: null, useCache: false },
    timeoutMs: 120000,
  });
  const instanceId = String(started?.id || '').trim();
  if (!instanceId) throw new Error('ETL run did not return an instance id');

  let state;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    state = await smartbixApi(`datamining/flowstate/${encodeURIComponent(instanceId)}`);
    if (isEtlTerminalState(state?.state)) break;
  }
  if (!state || !isEtlTerminalState(state.state)) {
    throw new Error(`ETL run timed out with an unresolved instance: ${instanceId}`);
  }

  const completed = await loadEtlFlow(flowId, { requireOwned: true });
  assertEtlGraphPersisted(graph, completed.graph);
  if (completed.processDag.currentInstanceId !== instanceId) {
    throw new Error('ETL terminal result is not the flow current instance');
  }
  const currentRun = assertCurrentEtlRunEvidence(
    completed.processDag,
    completed.graph,
    state,
    targetBinding,
  );

  const targetNode = completed.graph.nodes.find((node) => node.id === targetBinding.nodeId);
  const inbound = completed.graph.links.filter((link) => link.to === targetNode?.id);
  if (!targetNode || inbound.length !== 1) {
    throw new Error(`materialized ETL target must have one inbound link; found ${inbound.length}`);
  }
  const previewNode = completed.graph.nodes.find((node) => node.id === inbound[0].from);
  const previewPortId = inbound[0].inputPortId;
  if (
    !previewNode?.id
    || !previewNode.outputs.some((port) => port.id === previewPortId)
  ) {
    throw new Error('materialized ETL target has no verified terminal preview port');
  }
  const previewResult = await smartbixApi(
    `miningnode/portresult/${encodeURIComponent(`${previewNode.id}-${instanceId}`)}/${encodeURIComponent(previewPortId)}/csv`,
  );
  const preview = summarizePortResult(previewResult);
  if (!preview.available || !preview.schemaAvailable || !Number.isInteger(preview.rowCount)) {
    throw new Error('ETL completed without a verifiable terminal row and typed-field preview');
  }

  const refreshedChildren = await listCatalogChildren(
    personalFolder.folderId,
    'personal acquisition folder after ETL run',
  );
  assertCompetitionEtlTableBindings(PLATFORM_PROFILE, {
    sources,
    target: targetBinding,
    personalFolder,
    personalChildren: refreshedChildren,
  });
  const [sourceEvidenceAfter, targetEvidenceAfter] = await Promise.all([
    Promise.all(sources.map((source, index) => (
      loadVerifiedEtlTableEvidence(source, `reopened ETL source table ${index}`)
    ))),
    loadVerifiedEtlTableEvidence(targetBinding, 'reopened materialized ETL target table'),
  ]);
  assertExactResourceConfirmation(targetEvidenceAfter.metadata, confirmTargetName);
  for (let index = 0; index < sourceEvidenceBefore.length; index += 1) {
    assertEtlSchemasIdentical(
      sourceEvidenceBefore[index].schema,
      sourceEvidenceAfter[index].schema,
      {
        expectedLabel: `ETL source ${index} preflight schema`,
        actualLabel: `ETL source ${index} reopened schema`,
      },
    );
  }
  assertEtlSchemasIdentical(targetEvidenceBefore.schema, targetEvidenceAfter.schema, {
    expectedLabel: 'ETL target preflight schema',
    actualLabel: 'ETL target reopened schema',
  });
  const targetSchema = assertEtlSchemasIdentical(preview.schema, targetEvidenceAfter.schema, {
    expectedLabel: 'ETL terminal output schema',
    actualLabel: 'ETL target reopened schema',
  });

  const materializedTarget = {
    id: targetBinding.tableId,
    name: targetEvidenceAfter.metadata.alias || targetEvidenceAfter.metadata.name,
    fieldCount: targetSchema.length,
    fields: targetSchema,
    terminalPreviewRowCount: preview.rowCount,
    terminalPreviewRowCountComplete: preview.rowCountComplete,
    schemaVerified: true,
    reopened: true,
    reconciled: false,
    reconciliationEvidence: 'unavailable-no-authoritative-reopened-target-row-count',
  };

  safeOutput({
    ok: true,
    flowId: completed.processDag.id,
    flowName: completed.processDag.name,
    instanceId: currentRun.instanceId,
    state: state.state,
    nodes: currentRun.nodeStates.map((node) => ({
      id: node.id,
      name: node.name,
      alias: node.alias,
      state: node.state,
      tip: node.tip,
    })),
    preview,
    materializedTarget,
  });
}

async function cmdEtlRowNumberArgs(argsList) {
  const { positional, confirmation } = parseExactConfirmationArgs(
    argsList,
    'etl-row-number',
    '--confirm-name',
    { required: false },
  );
  if (positional.length < 1 || positional.length > 2 || !confirmation) {
    throw new Error(
      'etl-row-number requires <flowId> [column] --confirm-name <exactFlowName>',
    );
  }
  await cmdEtlRowNumber(positional[0], positional[1], confirmation);
}

async function cmdEtlRowNumber(
  flowId,
  columnName = 'row_number',
  confirmFlowName = null,
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(columnName)) {
    throw new Error(`invalid row-number column name: ${columnName}`);
  }
  const loaded = await loadEtlFlow(flowId, { requireOwned: true });
  assertExactResourceConfirmation(loaded.processDag, confirmFlowName);
  const { processDag } = loaded;
  let { graph } = loaded;
  const catalog = normalizeEtlNodeCatalog(await smartbixApi('datamining/nodes'));
  const template = catalog.defaultOptions.find((item) => item.name === 'DATAPREPARE_ROW_NUMBER');
  if (!template) throw new Error('DATAPREPARE_ROW_NUMBER live template is unavailable');
  assertVerifiedEtlTemplate(template, 'insert');
  const existing = graph.nodes.filter((item) => item.name === 'DATAPREPARE_ROW_NUMBER');
  if (existing.length > 1) throw new Error(`ETL contains multiple row-number nodes: ${existing.length}`);
  let [node] = existing;
  let changed = false;

  if (node) {
    const configured = configureEtlNode(
      node,
      template,
      { name: columnName },
      node.smartbiCliConfiguredKeys || [],
    );
    node = configured.node;
    changed = configured.changed;
    if (changed) {
      node.state = 'INITED';
      graph = {
        ...graph,
        nodes: graph.nodes.map((candidate) => candidate.id === node.id ? node : candidate),
      };
    }
  } else {
    const terminals = graph.nodes.filter((candidate) => candidate.outputs.length === 0);
    if (terminals.length !== 1) {
      throw new Error(`ETL must have one zero-output terminal; found ${terminals.length}`);
    }
    node = instantiateEtlNode(template, 0, 0);
    node = configureEtlNode(node, template, { name: columnName }).node;
    node.smartbiCliKey = 'row_number';
    positionEtlNodeBeforeTarget(node, terminals[0]);
    graph = spliceUnaryBeforeTerminal(graph, node).graph;
    changed = true;
  }

  graph = assertExecutableEtlGraph(graph);
  const bindingCheck = extractEtlTableBindings(graph);
  if (bindingCheck.targets.length !== 1) throw new Error('ETL mutation lost its overwrite target');
  assertDistinctEtlTableIds(
    bindingCheck.sources.map((source) => source.tableId),
    bindingCheck.targets[0].tableId,
  );
  assertCompetitionEtlGraph(PLATFORM_PROFILE, graph);
  const verified = changed
    ? await saveEtlGraph(processDag, graph, { definitionChanged: true })
    : loaded;
  const persisted = verified.graph.nodes.find((candidate) => candidate.id === node.id);
  if (!persisted) throw new Error(`ETL row-number node was not persisted: ${node.id}`);
  safeOutput({
    ok: true,
    changed,
    flowId: verified.processDag.id || processDag.id,
    flowName: verified.processDag.name || processDag.name,
    nodeId: persisted.id,
    column: columnName,
    configuredKeys: persisted.smartbiCliConfiguredKeys || [],
  });
}

function safeOutput(value) {
  writeFileSync(1, `${JSON.stringify(value)}\n`);
}

// ---- Playwright fallback (UI-only operations) ----

function isConfiguredSmartbiPage(page, { workspace = false } = {}) {
  try {
    const candidate = new URL(page.url());
    const base = new URL(BASE_URL);
    if (candidate.origin !== base.origin) return false;
    return workspace
      ? candidate.pathname === `${base.pathname}/index.jsp`
      : (
        candidate.pathname === base.pathname
        || candidate.pathname.startsWith(`${base.pathname}/`)
      );
  } catch {
    return false;
  }
}

async function connect() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 10_000 });
  const contexts = browser.contexts().filter(
    (candidate) => candidate.pages().some((page) => isConfiguredSmartbiPage(page)),
  );
  if (contexts.length !== 1) {
    throw new Error(`expected exactly one Smartbi browser context; found ${contexts.length}`);
  }
  return { browser, context: contexts[0] };
}

function workspacePage(context) {
  return context.pages().find((page) => isConfiguredSmartbiPage(page, { workspace: true }));
}

async function loadOwnedCatalogResource(resourceId, expectedTypes = []) {
  if (!resourceId) throw new Error('resource id is required');
  await ensureSession();
  const response = await rmi('CatalogService', 'getCatalogElementById', [resourceId]);
  const resource = response.result;
  if (response.retCode !== 0 || !resource?.id) {
    throw new Error(`catalog resource not found: ${resourceId}`);
  }
  if (!hasNamespace(resource.name || resource.alias)) {
    throw new Error(`refusing to open non-namespaced resource: ${resource.alias || resource.name}`);
  }
  if (expectedTypes.length > 0 && !expectedTypes.includes(resource.type)) {
    throw new Error(`unexpected resource type ${resource.type}; expected ${expectedTypes.join(', ')}`);
  }
  return resource;
}

async function openOwnedResourcePage(resourceId, expectedTypes = []) {
  const resource = await loadOwnedCatalogResource(resourceId, expectedTypes);
  const { context } = await connect();
  const page = await context.newPage();
  await page.goto(
    `${BASE_URL}/openresource.jsp?resid=${encodeURIComponent(resourceId)}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 },
  );
  if ((await page.locator('body').innerText()).includes('欢迎登录')) {
    await page.close();
    throw new Error('headed browser login required');
  }
  return { page, resource };
}

async function cmdUiOpen(resourceId) {
  if (!resourceId) throw new Error('ui-open requires <resourceId>');
  const { page, resource } = await openOwnedResourcePage(resourceId);
  await page.waitForFunction(() => !location.href.includes('/openresource.jsp'), null, { timeout: 60000 });
  safeOutput({
    ok: true,
    id: resource.id,
    name: resource.name,
    type: resource.type,
    title: await page.title(),
    url: page.url(),
  });
}

async function cmdUiDashboardCheck(resourceId) {
  if (!resourceId) throw new Error('ui-dashboard-check requires <resourceId>');
  const { page, resource } = await openOwnedResourcePage(resourceId, ['SMARTBIX_PAGE']);
  await page.waitForFunction(() => location.href.includes('/smartbix/'), null, { timeout: 60000 });
  await page.locator('canvas, svg').first().waitFor({ state: 'visible', timeout: 60000 });
  const title = await page.title();
  const text = (await page.locator('body').innerText()).trim();
  const chartCount = await page.locator('canvas, svg').count();
  if (chartCount === 0 || !text) throw new Error(`dashboard did not render: ${resourceId}`);
  safeOutput({
    ok: true,
    id: resource.id,
    name: resource.name,
    title,
    chartCount,
    text: text.slice(0, 500),
    url: page.url(),
  });
}


async function cmdNav(moduleName) {
  const MODULES = new Set(['数据门户', '数据连接', '数据准备', '分析展现', 'AIChat', 'Agent', '数据挖掘', '运维设置']);
  if (!MODULES.has(moduleName)) throw new Error(`Unsupported module: ${moduleName}`);
  assertCompetitionGenericAccess(PLATFORM_PROFILE, { kind: 'nav', moduleName });
  const { context } = await connect();
  const workspace = workspacePage(context);
  if (!workspace) throw new Error(`Smartbi workspace not found. Open ${LOGIN_URL}`);
  const navigation = workspace.locator('li.sidebar-menu-container')
    .filter({ hasText: new RegExp(`^\\s*${moduleName}\\s*$`) });
  const count = await navigation.count();
  if (count !== 1) throw new Error(`Expected one sidebar module ${moduleName}, found ${count}`);
  await navigation.click({ force: true, noWaitAfter: true });
  safeOutput({ state: 'module', module: moduleName, url: workspace.url() });
}

// ---- setup / config ----
// First-run guided configuration: account/password file + naming preference.
// Usage:
//   smartbi.mjs setup --interactive
//   smartbi.mjs setup --profile competition-2026 --school-name <name>
function parseSetupArgs(argsList) {
  const options = {};
  const valuedOptions = new Set([
    '--base-url',
    '--cred-file',
    '--namespace',
    '--naming',
    '--profile',
    '--school-name',
  ]);
  for (let index = 0; index < argsList.length; index += 1) {
    const argument = argsList[index];
    if (argument === '--interactive') {
      options.interactive = true;
      continue;
    }
    if (!valuedOptions.has(argument)) {
      throw new Error(`unknown setup option: ${argument}`);
    }
    const value = argsList[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function normalizeNaming(mode, value) {
  return normalizeNamingConfig(mode, value, { maxLength: MAX_TABLE_NAME });
}

function validateCredentialsFile(path) {
  parseCredentials(readPrivateCredentialFile(path));
}

async function persistSetup(saved) {
  assertCredentialTransport(saved.baseUrl);
  validateCredentialsFile(saved.credFile);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
  safeOutput({
    action: 'setup_done',
    message: 'Credentials and naming preference configured. Secrets were not emitted.',
    configFile: CONFIG_FILE,
    saved,
    next: 'node scripts/smartbi.mjs health',
  });
}

async function promptLine(label, defaultValue = '') {
  const { createInterface } = await import('node:readline/promises');
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await reader.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    reader.close();
  }
}

async function promptSecret(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('interactive password entry requires a TTY');
  }
  process.stdout.write(`${label}: `);
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const wasRaw = Boolean(input.isRaw);
    let secret = '';
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.off('data', onData);
      input.off('error', onError);
      input.off('end', onEnd);
      try {
        input.setRawMode(wasRaw);
      } finally {
        input.pause();
        process.stdout.write('\n');
      }
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onEnd = () => fail(new Error('password input ended before submission'));
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          fail(new Error('setup cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(secret);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          secret = secret.slice(0, -1);
          continue;
        }
        if (character >= ' ') secret += character;
      }
    };
    try {
      input.setEncoding('utf8');
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
      input.once('error', onError);
      input.once('end', onEnd);
    } catch (error) {
      fail(error);
    }
  });
}

async function runInteractiveSetup() {
  const baseUrl = normalizeBaseUrl(
    await promptLine('Smartbi Vision base URL', BASE_URL),
  );
  const account = await promptLine('Smartbi login account');
  const password = await promptSecret('Smartbi login password (hidden)');
  if (!account || !password) throw new Error('account and password are required');

  const mode = await promptLine('Artifact naming mode (prefix or suffix)', NAMING_MODE);
  const suggested = mode === 'suffix' ? '_TEAM' : 'TEAM_';
  const naming = normalizeNaming(mode, await promptLine('Namespace marker', suggested));
  const profileId = await promptLine(
    'Platform profile (general or competition-2026)',
    PLATFORM_PROFILE?.id || 'general',
  );
  const schoolName = profileId === 'competition-2026'
    ? await promptLine('School name', PLATFORM_PROFILE?.schoolName || '')
    : null;
  const platformProfile = normalizePlatformProfile(
    profileId === 'general' ? null : { id: profileId, schoolName },
    baseUrl,
  );
  const credentialsPath = join(homedir(), '.config', 'smartbi-platform', 'credentials.txt');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, `${account}\n${password}\n`, { mode: 0o600 });
  chmodSync(credentialsPath, 0o600);
  await persistSetup({
    baseUrl,
    credFile: credentialsPath,
    naming,
    platformProfile: platformProfile
      ? { id: platformProfile.id, schoolName: platformProfile.schoolName }
      : null,
  });
}

async function cmdSetup(argsList) {
  const options = parseSetupArgs(argsList);
  const interactive = options.interactive
    || (argsList.length === 0 && process.stdin.isTTY && process.stdout.isTTY);
  if (STARTUP_ERROR && !interactive && argsList.length === 0) throw STARTUP_ERROR;
  if (interactive) {
    await runInteractiveSetup();
    return;
  }

  const current = {
    baseUrl: BASE_URL,
    credFile: CRED_FILE,
    naming: { mode: NAMING_MODE, value: NAMESPACE },
    platformProfile: PLATFORM_PROFILE
      ? { id: PLATFORM_PROFILE.id, schoolName: PLATFORM_PROFILE.schoolName }
      : null,
  };
  if (
    !options['base-url']
    && !options['cred-file']
    && !options.namespace
    && !options.naming
    && !options.profile
    && !options['school-name']
  ) {
    safeOutput({
      action: 'setup_needed',
      message: 'First-run setup: configure the Smartbi tenant, login account/password, and prefix or suffix naming.',
      current,
      configFile: CONFIG_FILE,
      commands: [
        'node scripts/smartbi.mjs setup --interactive',
        'node scripts/smartbi.mjs setup --base-url https://host/smartbi/vision --cred-file /path/to/credentials.txt --namespace TEAM_ --naming prefix',
        'node scripts/smartbi.mjs setup --base-url https://host/smartbi/vision --cred-file /path/to/credentials.txt --namespace _TEAM --naming suffix',
        'node scripts/smartbi.mjs setup --profile competition-2026 --school-name <school>',
      ],
    });
    return;
  }

  const baseUrl = normalizeBaseUrl(options['base-url'] || CONFIG.baseUrl || current.baseUrl);
  const profile = normalizePlatformProfile(
    options.profile || options['school-name']
      ? {
          id: options.profile || CONFIG.platformProfile?.id,
          schoolName: options['school-name'] || CONFIG.platformProfile?.schoolName,
        }
      : CONFIG.platformProfile,
    baseUrl,
  );
  const saved = {
    baseUrl,
    credFile: options['cred-file'] || CONFIG.credFile || current.credFile,
    naming: normalizeNaming(
      options.naming || CONFIG.naming?.mode || current.naming.mode,
      options.namespace || CONFIG.naming?.value || current.naming.value,
    ),
    platformProfile: profile ? { id: profile.id, schoolName: profile.schoolName } : null,
  };
  await persistSetup(saved);
}

async function cmdConfig() {
  safeOutput({
    configFile: CONFIG_FILE,
    baseUrl: BASE_URL,
    cdpUrl: CDP_DISPLAY_URL,
    credFile: CRED_FILE,
    codecCacheFile: CODEC_CACHE_FILE,
    naming: { mode: NAMING_MODE, value: NAMESPACE },
    platformProfile: PLATFORM_PROFILE,
    example: applyNamespace('survey_demo'),
    alreadyNamespacedExample: applyNamespace(
      NAMING_MODE === 'suffix' ? `survey_demo${NAMESPACE}` : `${NAMESPACE}survey_demo`,
    ),
    envOverrides: [
      'SMARTBI_CONFIG_FILE',
      'SMARTBI_BASE_URL',
      'SMARTBI_CDP_URL',
      'SMARTBI_ALLOW_REMOTE_CDP',
      'SMARTBI_CRED_FILE',
      'SMARTBI_PLAYWRIGHT_PATH',
      'SMARTBI_BROWSER_PATH',
      'SMARTBI_CODEC_CACHE_FILE',
      'SMARTBI_NAMESPACE',
      'SMARTBI_NAMING',
      'SMARTBI_PLATFORM_PROFILE',
      'SMARTBI_SCHOOL_NAME',
    ],
  });
}

async function cmdCodecStatus(argsList) {
  if (argsList.some((argument) => argument !== '--refresh')) {
    throw new Error('codec-status accepts only [--refresh]');
  }
  await ensureTransportCodec({ refresh: argsList.includes('--refresh') });
  safeOutput({ baseUrl: BASE_URL, ...transportCodec.status() });
}

async function cmdDoctor(argsList) {
  if (argsList.some((argument) => argument !== '--require-browser')) {
    throw new Error('doctor accepts only [--require-browser]');
  }
  const report = await inspectEnvironment({ cdpUrl: CDP_URL });
  if (!report.readiness.apiCore) {
    throw new Error(`Node.js ${report.node.minimumMajor}+ is required`);
  }
  if (argsList.includes('--require-browser') && !report.readiness.browserFallback) {
    throw new Error('browser fallback is not ready; run scripts/install.sh --install-playwright');
  }
  safeOutput({
    ...report,
    cdp: { ...report.cdp, url: CDP_DISPLAY_URL },
  });
}

// ---- main ----
const [,, command, ...args] = process.argv;
try {
  if (STARTUP_ERROR && command !== 'setup') throw STARTUP_ERROR;
  switch (command) {
    case 'login': await cmdLogin(); break;
    case 'health': await cmdHealth(); break;
    case 'invoke': await cmdInvoke(args[0], args[1], args[2]); break;
    case 'api-get': await cmdApiGet(args[0]); break;
    case 'api-post': await cmdApiPost(args[0], args[1]); break;
    case 'plain-get': await cmdPlainGet(args[0]); break;
    case 'plain-post': await cmdPlainPost(args[0], args[1]); break;
    case 'model-get': await cmdModelGet(args[0]); break;
    case 'model-create': await cmdModelCreateArgs(args); break;
    case 'model-create-relational': await cmdModelCreateRelational(args[0], args[1], args[2], args.slice(3).join(' ')); break;
    case 'model-hierarchy-add': await cmdModelHierarchyAddArgs(args); break;
    case 'model-calc-measure-add': await cmdModelCalcMeasureAddArgs(args); break;
    case 'model-clone': await cmdModelClone(args[0], args[1], args[2], args[3]); break;
    case 'analysis-get': await cmdAnalysisGet(args[0]); break;
    case 'analysis-create': await cmdAnalysisCreate(args[0], args[1], args[2], args[3], args[4], args[5]); break;
    case 'analysis-create-hierarchy': await cmdAnalysisCreateHierarchy(args[0], args[1], args[2], args[3], args[4], args.slice(5).join(' ')); break;
    case 'analysis-repair': await cmdAnalysisRepairArgs(args); break;
    case 'analysis-run': await cmdAnalysisRun(args[0]); break;
    case 'analysis-profile': await cmdAnalysisProfile(args[0], args[1]); break;
    case 'analysis-clone': await cmdAnalysisClone(args[0], args[1], args[2], args[3]); break;
    case 'dashboard-get': await cmdDashboardGet(args[0]); break;
    case 'dashboard-create-multi': await cmdDashboardCreateMulti(args[0], args[1], args[2], args[3], args.slice(4).join(' ')); break;
    case 'dashboard-create-interactive': await cmdDashboardCreateInteractive(args[0], args[1], args[2], args[3], args.slice(4).join(' ')); break;
    case 'dashboard-jump-add': await cmdDashboardJumpAddArgs(args); break;
    case 'dashboard-repair-multi': await cmdDashboardRepairMultiArgs(args); break;
    case 'dashboard-create': await cmdDashboardCreate(args[0], args[1], args[2], args[3], args[4], args[5]); break;
    case 'dashboard-clone': await cmdDashboardClone(args[0], args[1], args[2], args[3]); break;
    case 'aichat-query': await cmdAichat(parseAichatRunArgs(args, {
      command: 'aichat-query',
      mode: 'query',
    })); break;
    case 'aichat-report': await cmdAichat(parseAichatRunArgs(args, {
      command: 'aichat-report',
      mode: 'report',
    })); break;
    case 'aichat-export': await cmdAichat(parseAichatExportArgs(args)); break;
    case 'aichat-graph-list': await cmdAichatGraphList(args.join(' ')); break;
    case 'aichat-graph-fields': await cmdAichatGraphFields(args[0]); break;
    case 'aichat-graph-status': await cmdAichatGraphStatus(args[0]); break;
    case 'aichat-graph-build': await cmdAichatGraphBuildArgs(args); break;
    case 'agent-get': await cmdAgentGet(args[0]); break;
    case 'catalog-audit': await cmdCatalogAudit(args[0]); break;
    case 'agent-create': await cmdAgentCreate(args[0], args[1], args[2], args[3], args[4]); break;
    case 'agent-run': await cmdAgentRunArgs(args); break;
    case 'agent-deploy': await cmdAgentDeployArgs(args); break;
    case 'tree': await cmdTree(args[0]); break;
    case 'competition-home': await cmdCompetitionHome(args); break;
    case 'folder-create': await cmdFolderCreate(args[0], args[1], args.slice(2).join(' ')); break;
    case 'resource-rename': await cmdResourceRename(args); break;
    case 'resource-move': await cmdResourceMove(args); break;
    case 'resource-copy': await cmdResourceCopy(args); break;
    case 'resource-delete': await cmdResourceDelete(parseResourceDeleteArgs(args)); break;
    case 'upload': await cmdUploadArgs(args); break;
    case 'etl-describe': await cmdEtlDescribeArgs(args); break;
    case 'etl-create': await cmdEtlCreateArgs(args); break;
    case 'etl-union-create': await cmdEtlUnionCreateArgs(args); break;
    case 'etl-node-list': await cmdEtlNodeList(args.join(' ')); break;
    case 'etl-insert': await cmdEtlInsertArgs(args); break;
    case 'etl-output-dataset': await cmdEtlOutputDatasetArgs(args); break;
    case 'etl-get': await cmdEtlGet(args[0]); break;
    case 'etl-run': await cmdEtlRunArgs(args); break;
    case 'etl-row-number': await cmdEtlRowNumberArgs(args); break;
    case 'nav': await cmdNav(args[0]); break;
    case 'ui-open': await cmdUiOpen(args[0]); break;
    case 'ui-dashboard-check': await cmdUiDashboardCheck(args[0]); break;
    case 'setup': await cmdSetup(args); break;
    case 'config': await cmdConfig(); break;
    case 'codec-status': await cmdCodecStatus(args); break;
    case 'doctor': await cmdDoctor(args); break;
    case 'manuals': safeOutput({
      javaApi: 'https://wiki.smartbi.com.cn/api/javaapi/index.html',
      clientConnectorApi: 'https://wiki.smartbi.com.cn/api/javaapi/smartbi/sdk/ClientConnector.html',
      catalogApi: 'https://wiki.smartbi.com.cn/api/javaapi/smartbi/sdk/service/catalog/CatalogService.html',
      insightApi: 'https://wiki.smartbi.com.cn/api/javaapi/smartbi/sdk/service/insight/ClientInsightService.html',
      pageApi: 'https://wiki.smartbi.com.cn/api/javaapi/smartbix/sdk/page/service/PageService.html',
      quickStart: 'https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=111897106',
      competition: 'https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168628225',
      financialCollection: 'https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168629240',
      orderRiskWarning: 'https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168629228',
    }); break;
    default:
      throw new Error(
        `Unknown command: ${command}\nusage: smartbi.mjs <setup|doctor|login|health|config|codec-status|invoke|api-get|api-post|plain-get|plain-post|tree|catalog-audit|competition-home|folder-create|resource-rename|resource-move|resource-copy|resource-delete|upload|etl-node-list|etl-create|etl-union-create|etl-describe|etl-insert|etl-output-dataset|etl-get|etl-run|etl-row-number|model-get|model-create|model-create-relational|model-hierarchy-add|model-calc-measure-add|model-clone|analysis-get|analysis-create|analysis-create-hierarchy|analysis-repair|analysis-run|analysis-profile|analysis-clone|dashboard-get|dashboard-create|dashboard-create-multi|dashboard-create-interactive|dashboard-jump-add|dashboard-repair-multi|dashboard-clone|aichat-graph-list|aichat-graph-status|aichat-graph-fields|aichat-graph-build|aichat-query|aichat-report|aichat-export|agent-get|agent-create|agent-run|agent-deploy|nav|ui-open|ui-dashboard-check|manuals>`
        + '\nupload: <localFile> [tableName] [--worksheet <exactWorksheetName>] '
        + '[--replace --confirm-target <exactName>] [--source-url <publicProvenanceUrl>] '
        + '(local CSV/TXT/XLS/XLSX only; --source-url is competition-profile provenance and is never fetched)'
        + '\netl-describe: <flowId> <description> --confirm-name <exactFlowName>'
        + '\netl-insert: <flowId> <nodeName> [configJson] [instanceKey] '
        + '--confirm-name <exactFlowName>'
        + '\netl-output-dataset: <flowId> <datasetName> --confirm-name <exactFlowName>'
        + '\netl-row-number: <flowId> [column] --confirm-name <exactFlowName>'
        + '\netl-run: <flowId> --confirm-target <exactTargetName>'
        + '\naichat-query: <modelId> [--llm-id <exactId>] [--] <prompt>'
        + '\naichat-report: <modelId> [--llm-id <exactId>] [--] <prompt>'
        + '\naichat-export: <modelId> <absolutePrivateEnvelopePath> --mode <query|report> '
        + '[--llm-id <exactId>] [--overwrite --confirm-path <exactPath>] [--] <prompt>'
        + '\nmodel-create: <parentId> <dataSourceId> <tableId> <tableName> <name> '
        + '[description] --measures <jsonArray> [--etl-flow <flowId>]'
        + '\nmodel-create-relational: <parentId> <name> <specJson> [description]'
        + '\nmodel-create-relational specJson: {"tables":[{"dataSourceId":"...","tableId":"...",'
        + '"tableName":"...","measures":[{"field":"...","aggregator":"...",'
        + '"alias":"...","format":"...","businessDefinition":"..."}]}],'
        + '"relations":[{"from":0,"to":1,"fromField":"...","toField":"...",'
        + '"confirmed":true,"grain":"...","linkType":"...","cardinalityType":"...",'
        + '"filterDirection":"...","assumeReferentialIntegrity":"..."}]}'
        + '\nmodel-hierarchy-add: <modelId> <hierarchyName> <levelSpecJson> '
        + '[description] --confirm-name <exactModelName>'
        + '\nmodel-calc-measure-add: <modelId> <measureName> <specJson> '
        + '[description] --confirm-name <exactModelName>'
        + '\nagent-run: <agentId> <question> --confirm-name <exactAgentName>'
        + '\nagent-deploy: <agentId> --confirm-name <exactAgentName>',
      );
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: sanitizeErrorMessage(error) })}\n`);
  process.exit(1);
}
