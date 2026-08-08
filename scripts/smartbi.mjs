#!/usr/bin/env node
// Smartbi Insight V11 AI-operable tool.
// Primary mode: direct HTTP API (reverse-engineered RMI protocol + DataPackageServlet).
// Fallback mode: Playwright over CDP for UI-only operations (dashboard editing etc).
//
// Protocol notes (reverse-engineered from frontend bundles, verified live):
//   * All business calls: POST /smartbi/vision/RMIServlet
//     body: encode=<ReplaceCoder.encode(encodeURIComponent(className)+"+"+encodeURIComponent(methodName)+"+"+encodeURIComponent(JSON.stringify(params)))>
//     response: encoded JSON {retCode, result, detail, succeeded}; retCode===0 means success.
//   * ReplaceCoder: per-character substitution table (involutive), see CODE_ARRAY below.
//   * File import chain (DataPackageServlet, form-encoded except upload):
//       UPLOAD_FILE (multipart: action + file) -> {clientId, sheetNames}
//       GET_PREVIEW_DATA&clientId&previewRows&sheetIndex -> {rowCount, datas, fieldTypeList, fieldNameList, fieldAliasList}
//       INSERT_DATA&clientId&settings=<JSON> -> import
//       poll: RMI DataPackageModule.getImportStatus(clientId)
//
// Resource naming: our projects MUST be prefixed TEAM_ (shared tenant; never touch others').

import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, '..');
const CONFIG_FILE = process.env.SMARTBI_CONFIG_FILE || join(SKILL_DIR, 'config.json');

// ---- config: credentials + naming preference ----
// Config file (config.json in skill dir, gitignored) is written by `setup`.
// Environment variables always take precedence over the config file.
function loadConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return { __error: String(e.message || e) };
  }
}
const CONFIG = loadConfig();

const CDP_URL = process.env.SMARTBI_CDP_URL || 'http://127.0.0.1:9222';
const BASE_URL = process.env.SMARTBI_BASE_URL || 'https://smartbi.example.com/smartbi/vision';
const LOGIN_URL = `${BASE_URL}/index.jsp`;
const CRED_FILE = process.env.SMARTBI_CRED_FILE
  || CONFIG.credFile
  || join(homedir(), '.config', 'smartbi-platform', 'credentials.txt');

// Naming preference: prefix (default) or suffix, value configurable.
// e.g. prefix "TEAM_" -> TEAM_survey_demo ; suffix "_TEAM" -> survey_demo_TEAM
const NAMING_MODE = process.env.SMARTBI_NAMING || CONFIG.naming?.mode || 'prefix';
const NAMESPACE = process.env.SMARTBI_NAMESPACE || CONFIG.naming?.value || 'TEAM_';
const MAX_TABLE_NAME = 30; // server truncates longer names

function applyNamespace(base) {
  const value = String(NAMESPACE || '');
  const source = String(base || '');
  const alreadyNamespaced = NAMING_MODE === 'suffix'
    ? source.endsWith(value)
    : source.startsWith(value);
  if (alreadyNamespaced) return source.slice(0, MAX_TABLE_NAME);

  const name = NAMING_MODE === 'suffix' ? `${source}${value}` : `${value}${source}`;
  if (name.length > MAX_TABLE_NAME) {
    // Prefer keeping the namespace marker; trim only the resource name.
    if (NAMING_MODE === 'suffix') return `${source.slice(0, MAX_TABLE_NAME - value.length)}${value}`;
    return `${value}${source.slice(0, MAX_TABLE_NAME - value.length)}`;
  }
  return name;
}

function hasNamespace(name) {
  const source = String(name || '');
  const value = String(NAMESPACE || '');
  return NAMING_MODE === 'suffix' ? source.endsWith(value) : source.startsWith(value);
}

// ---- ReplaceCoder table (verbatim from vision/js/freequery/common/codeutil/ReplaceCoder.js) ----
const CODE_ARRAY = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,80,0,0,0,47,0,110,65,69,115,43,0,102,113,37,55,49,117,78,75,74,77,57,39,109,123,0,0,0,0,0,0,79,86,116,84,97,120,72,114,99,118,108,56,70,51,111,76,89,106,87,42,122,90,33,66,41,85,93,0,91,0,121,0,40,126,105,104,112,95,45,73,82,46,71,83,100,54,119,53,48,52,68,107,81,103,98,67,50,88,58,0,0,101,0];
const ENCODE_MAP = {};
const DECODE_MAP = {};
for (let i = 0; i < CODE_ARRAY.length; i += 1) {
  const codePoint = CODE_ARRAY[i];
  if (codePoint) {
    const source = String.fromCharCode(i);
    const encoded = String.fromCharCode(codePoint);
    ENCODE_MAP[source] = encoded;
    DECODE_MAP[source] = encoded;
  }
}
DECODE_MAP['/'] = '/';
DECODE_MAP['%'] = '%';

const replaceEncode = (data) => String(data).split('').map((character) => ENCODE_MAP[character] || character).join('');
const replaceDecode = (data) => String(data).split('').map((character) => DECODE_MAP[character] || character).join('');

function parseTransportJson(text) {
  const knownKeys = new Set([
    'id', 'originId', 'name', 'alias', 'fields', 'views', 'nodes', 'dataSource',
    'retCode', 'result', 'detail', 'succeeded', 'success', 'report', 'macros',
    'processDag', 'define', 'columns', 'rowMap', 'hierarchyFieldMap', 'total',
  ]);
  const parsed = [];
  const candidates = [...new Set([String(text), replaceDecode(text), replaceEncode(text)])];
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

const encodeRmi = (className, methodName, paramsArray) => {
  const paramsStr = JSON.stringify(paramsArray);
  const raw = encodeURIComponent(className) + '+' + encodeURIComponent(methodName) + '+' + encodeURIComponent(paramsStr);
  return 'encode=' + replaceEncode(raw);
};

async function rmi(className, methodName, params = [], timeoutMs = 60000) {
  const res = await fetch(`${BASE_URL}/RMIServlet`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'If-Modified-Since': '0',
      'Cookie': cookieHeader(),
    },
    body: encodeRmi(className, methodName, params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  grabCookies(res);
  const text = await res.text();
  try {
    return { status: res.status, ...parseTransportJson(text) };
  } catch {
    return { status: res.status, retCode: 'PARSE_ERROR', result: text.slice(0, 400) };
  }
}

const SMARTBIX_API = `${BASE_URL.replace(/\/vision\/?$/, '')}/smartbix/api`;

function isAuthenticationFailure(status, responseUrl, text, parsed = null) {
  if ([401, 403, 406].includes(status)) return true;
  if (String(responseUrl || '').includes('/login.jsp')) return true;
  if (parsed?.code === 'REDIRECT_TO_SMARTBI') return true;
  const sample = String(text || '').slice(0, 1000);
  return sample.includes('REDIRECT_TO_SMARTBI')
    || (sample.includes('/smartbi/vision/login.jsp') && sample.includes('<html'));
}

async function smartbixApi(
  path,
  { method = 'GET', body, timeoutMs = 60000, retryAuth = true } = {},
) {
  if (jar.size === 0) await ensureSession();
  const headers = {
    'Accept': 'application/json, text/plain, */*; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'If-Modified-Since': '0',
    'SMX-Encode': 'encode',
    'Cookie': cookieHeader(),
  };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json;charset=UTF-8';
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    payload = replaceEncode(raw);
  }
  const res = await fetch(`${SMARTBIX_API}/${String(path).replace(/^\/+/, '')}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  grabCookies(res);
  const text = await res.text();
  let parsed;
  try {
    parsed = parseTransportJson(text);
  } catch {
    if (isAuthenticationFailure(res.status, res.url, text) && retryAuth) {
      jar.clear();
      await ensureSession();
      return smartbixApi(path, { method, body, timeoutMs, retryAuth: false });
    }
    if (res.ok) return text;
    throw new Error(`Smartbix API returned non-JSON (${res.status} ${path}): ${text.slice(0, 240)}`);
  }
  if (isAuthenticationFailure(res.status, res.url, text, parsed) && retryAuth) {
    jar.clear();
    await ensureSession();
    return smartbixApi(path, { method, body, timeoutMs, retryAuth: false });
  }
  if (!res.ok) throw new Error(`Smartbix API failed (${res.status} ${path}): ${JSON.stringify(parsed)}`);
  return parsed;
}

const SMARTBI_ROOT = BASE_URL.replace(/\/vision\/?$/, '');

async function plainJsonRequest(path, {
  method = 'POST',
  body,
  accept = 'application/json, text/plain, */*',
  timeoutMs = 120000,
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
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  grabCookies(response);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  if (isAuthenticationFailure(response.status, response.url, text, parsed) && retryAuth) {
    jar.clear();
    await ensureSession();
    return plainJsonRequest(path, {
      method, body, accept, timeoutMs, retryAuth: false,
    });
  }
  if (!response.ok) {
    throw new Error(`Smartbi API failed (${response.status} ${path}): ${text.slice(0, 500)}`);
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
function loadCredentials() {
  const [user, pass] = readFileSync(CRED_FILE, 'utf8').split(/\r?\n/);
  if (!user || !pass) throw new Error(`credentials file incomplete: ${CRED_FILE}`);
  return { user, pass };
}

async function ensureSession() {
  if (jar.size === 0) {
    await fetch(LOGIN_URL, { headers: { Cookie: cookieHeader() } }).then(grabCookies);
  }
  // probe; re-login if needed
  const probe = await rmi('AIextRemoteService', 'getCurrentUserName', [], 15000);
  if (probe.retCode === 0) {
    return probe;
  }
  const { user, pass } = loadCredentials();
  const login = await rmi('UserService', 'login', [user, pass]);
  if (login.retCode !== 0) throw new Error(`login failed: ${JSON.stringify(login)}`);
  return login;
}

async function cmdLogin() {
  const { user, pass } = loadCredentials();
  const login = await rmi('UserService', 'login', [user, pass]);
  safeOutput({ state: login.retCode === 0 ? 'authenticated' : 'failed', retCode: login.retCode });
}

async function cmdHealth() {
  const login = await ensureSession();
  const probe = await rmi('AIextRemoteService', 'getCurrentUserName', [], 15000);
  safeOutput({
    state: probe.retCode === 0 ? 'workspace' : 'auth_required',
    retCode: probe.retCode,
    login: login.retCode,
  });
}

function assertReadOnlyRmi(className, methodName) {
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

function assertSafeGenericPath(path, { post = false } = {}) {
  let normalized;
  try {
    normalized = decodeURIComponent(String(path)).toLowerCase();
  } catch {
    throw new Error('API path contains invalid percent encoding');
  }
  if (/(^|\/)(create|delete|remove|update|save|insert|deploy|publish|offline|train|build|run|stop|force|clear|copy|move|upload|import|login|logout)([/_.?=-]|$)/i.test(normalized)) {
    throw new Error(`generic API replay refuses a mutating path: ${path}`);
  }
  if (
    post
    && normalized !== 'datasets/table'
    && !normalized.startsWith('adhocanalysis/data/')
    && !/(^|\/)(get|list|search|query|preview|status|check|validate|inspect|resolve|lookup|field)([/_.?=-]|$)/i.test(normalized)
  ) {
    throw new Error(`generic POST only permits read-only discovery/query paths: ${path}`);
  }
}

async function cmdInvoke(className, methodName, paramsJson) {
  if (!className || !methodName) throw new Error('invoke requires <class> <method> [json]');
  assertReadOnlyRmi(className, methodName);
  const params = paramsJson ? JSON.parse(paramsJson) : [];
  await ensureSession();
  const ret = await rmi(className, methodName, params);
  safeOutput(ret);
}

async function cmdApiGet(path) {
  if (!path || /^https?:/i.test(path) || String(path).includes('..')) {
    throw new Error('api-get requires a relative Smartbix API path');
  }
  assertSafeGenericPath(path);
  await ensureSession();
  safeOutput(await smartbixApi(path));
}

async function cmdApiPost(path, bodyJson = '{}') {
  if (!path || /^https?:/i.test(path) || String(path).includes('..')) {
    throw new Error('api-post requires a relative Smartbix API path');
  }
  assertSafeGenericPath(path, { post: true });
  await ensureSession();
  safeOutput(await smartbixApi(path, { method: 'POST', body: JSON.parse(bodyJson) }));
}

async function cmdPlainGet(path) {
  if (!path || /^https?:/i.test(path) || String(path).includes('..')) {
    throw new Error('plain-get requires a relative Smartbi root API path');
  }
  assertSafeGenericPath(path);
  await ensureSession();
  safeOutput(await plainJsonRequest(path, { method: 'GET' }));
}

async function cmdPlainPost(path, bodyJson = '{}') {
  if (!path || /^https?:/i.test(path) || String(path).includes('..')) {
    throw new Error('plain-post requires a relative Smartbi root API path');
  }
  assertSafeGenericPath(path, { post: true });
  await ensureSession();
  safeOutput(await plainJsonRequest(path, { body: JSON.parse(bodyJson) }));
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

function buildSingleTableModel(table, requestedName, description = '') {
  if (!table?.fields?.length || !table?.dataSource?.id || !table?.originId) {
    throw new Error(`table metadata is incomplete; keys=${Object.keys(table || {}).join(',')} dataSourceKeys=${Object.keys(table?.dataSource || {}).join(',')} originId=${Boolean(table?.originId)} fields=${table?.fields?.length || 0}`);
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
    id: field.id,
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
  const numericTypes = new Set([
    'BYTE', 'SHORT', 'SMALLINT', 'INTEGER', 'INT', 'LONG', 'BIGINT',
    'FLOAT', 'DOUBLE', 'DECIMAL', 'BIGDECIMAL', 'NUMBER',
  ]);
  const numericFields = table.fields.filter((field) => numericTypes.has(String(field.dataType).toUpperCase()));
  const measures = numericFields.map((field, order) => {
    const sourceType = String(field.dataType).toUpperCase();
    const valueType = ['BYTE', 'SHORT', 'SMALLINT', 'INTEGER', 'INT', 'LONG'].includes(sourceType)
      ? 'BIGINT'
      : sourceType;
    return {
      id: `${field.id}_${Date.now() + order}`,
      name: `${field.name}_m`,
      aliasFromDb: field.alias || field.name,
      descFromDb: null,
      useFromDb: false,
      valueType,
      dataFormat: field.dataFormat || '',
      sqlColumnName: null,
      maskingRule: null,
      viewId,
      viewAlias: null,
      visible: 1,
      aggregator: 'sum',
      refDataSetFieldId: field.id,
      transformRule: null,
      extended: null,
      resType: null,
      desc: null,
      alias: field.alias || field.name,
      creatorId: null,
      type: 'MEASURE',
      level: 0,
      order,
      parentId: 'measure',
      group: 'MEASURE',
      children: [],
    };
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
    aggregatorTypes: [
      'SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'DISTINCT_COUNT', 'NONE',
      'FIRST_MEMBER', 'LAST_MEMBER', 'STDDEV_POP', 'STDDEV_SAMP',
      'VAR_POP', 'VAR_SAMP', 'ATTR',
    ],
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

async function loadModel(modelId) {
  if (!modelId) throw new Error('model id is required');
  await ensureSession();
  const model = await smartbixApi(`augmentedDataSet/${encodeURIComponent(modelId)}`);
  if (!model?.id || !model?.name) throw new Error(`model not found or incomplete: ${modelId}`);
  return model;
}

function requireNamespacedResource(resource, kind) {
  const name = resource?.alias || resource?.name;
  if (!resource || !hasNamespace(name)) {
    throw new Error(`refusing to use non-namespaced ${kind}: ${name || 'unknown'}`);
  }
  return resource;
}

async function cmdModelGet(modelId) {
  safeOutput(requireNamespacedResource(await loadModel(modelId), 'model'));
}

async function cmdModelCreate(parentId, dataSourceId, tableId, tableName, requestedName, description = '') {
  if (![parentId, dataSourceId, tableId, tableName, requestedName].every(Boolean)) {
    throw new Error('model-create requires <parentId> <dataSourceId> <tableId> <tableName> <name> [description]');
  }
  await assertOwnedCatalogParent(parentId);
  await ensureSession();
  const table = await smartbixApi('datasets/table', {
    method: 'POST',
    body: { dataSourceId, tableId, tableName },
  });
  requireNamespacedResource(table, 'source table');
  if (!table.dataSource?.id) {
    table.dataSource = { id: dataSourceId, type: { name: table.dataType || null } };
  }
  const model = buildSingleTableModel(table, requestedName, description);
  const result = await smartbixApi(`augmentedDataSet/${encodeURIComponent(parentId)}`, {
    method: 'POST',
    body: model,
  });
  const createdId = createdResourceId(result, model.id);
  const saved = await smartbixApi(`augmentedDataSet/${encodeURIComponent(createdId)}`);
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    fieldCount: saved.fields?.length || 0,
    measureCount: saved.measures?.length || 0,
    viewCount: saved.views?.length || 0,
  });
}

async function cmdModelClone(parentId, sourceModelId, requestedName, description = '') {
  if (![parentId, sourceModelId, requestedName].every(Boolean)) {
    throw new Error('model-clone requires <parentId> <sourceModelId> <name> [description]');
  }
  await assertOwnedCatalogParent(parentId);
  const source = await loadModel(sourceModelId);
  requireNamespacedResource(source, 'source model');
  const replacements = new Map([[source.id, resourceId()]]);
  for (const view of source.views || []) replacements.set(view.id, resourceId());
  const model = replaceExactStrings(source, replacements);
  model.id = replacements.get(source.id);
  model.name = model.alias = applyNamespace(requestedName);
  model.desc = description || source.desc || '';
  model._extendProps = { ...(model._extendProps || {}), batchId: resourceId() };
  const result = await smartbixApi(`augmentedDataSet/${encodeURIComponent(parentId)}`, {
    method: 'POST',
    body: model,
  });
  const createdId = createdResourceId(result, model.id);
  const saved = await smartbixApi(`augmentedDataSet/${encodeURIComponent(createdId)}`);
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    fieldCount: saved.fields?.length || 0,
    measureCount: saved.measures?.length || 0,
    viewCount: saved.views?.length || 0,
  });
}

async function loadAnalysis(analysisId) {
  if (!analysisId) throw new Error('analysis id is required');
  await ensureSession();
  const wrapper = await smartbixApi(`adhocanalysis/getReport/${encodeURIComponent(analysisId)}`);
  if (!wrapper?.report?.id) throw new Error(`analysis not found or incomplete: ${analysisId}`);
  return wrapper;
}
async function cmdAnalysisGet(analysisId) {
  const wrapper = await loadAnalysis(analysisId);
  requireNamespacedResource(wrapper.report, 'analysis');
  safeOutput(wrapper);
}

function buildAnalysisQuery(report) {
  const portlet = report?.define?.portlets?.find((item) => item.type === 'CROSS_TABLE');
  if (!portlet?.extended?.dataSource || !portlet?.extended?.fields) {
    throw new Error('analysis has no runnable CROSS_TABLE portlet');
  }
  const extended = portlet.extended;
  return {
    queryBatchId: resourceId(),
    queryType: 'PORTLET_CROSS_TABLE',
    clientId: resourceId(),
    dataSource: extended.dataSource,
    pagination: { num: 0, size: 100 },
    calculateTotalRowCount: false,
    conditionRelation: { relation: 'AND', childNodes: [] },
    queryFields: extended.fields,
    privateDataset: report.define.privateDataset || { folders: [], fields: [] },
    colSubtotalPosition: 'right',
    groupOrderByState: extended.viewState?.groupOrderByState || null,
    useAdvancedSort: true,
    querySortSetting: {
      rowSorts: extended.sortSetting?.row?.sorts || [],
      colSorts: extended.sortSetting?.col?.sorts || [],
    },
    tableHeader: report.define.reportSetting?.tableHeader || null,
    tableFooter: report.define.reportSetting?.tableFooter || null,
  };
}

function qualifyModelResource(modelId, type, id) {
  const source = String(id || '');
  return source.startsWith('AUGMENTED_DATASET_')
    ? source
    : `AUGMENTED_DATASET_${type}.${modelId}.${source}`;
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
  const aggregate = String(measure.aggregator || 'sum').toUpperCase();
  return {
    id: qualifyModelResource(model.id, 'MEASURE', measure.id),
    name: measure.name,
    alias: measure.alias || measure.name,
    desc: measure.desc || '',
    label: measure.alias || measure.name,
    type: 'MEASURE',
    dataType: measure.valueType,
    fieldType: 'MEASURE',
    hierarchy: 'MEASURE',
    group: 'MEASURE',
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
    refDataSetFieldId: measure.refDataSetFieldId
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

function buildAnalysisReport(model, rowFieldName, measureFieldName, requestedName, description = '') {
  const dimensionField = (model.fields || []).find(
    (field) => field.name === rowFieldName || field.alias === rowFieldName,
  );
  if (!dimensionField) throw new Error(`dimension field not found: ${rowFieldName}`);
  const modelMeasure = (model.measures || []).find(
    (measure) => measure.name === measureFieldName || measure.alias === measureFieldName,
  );
  if (!modelMeasure) throw new Error(`measure not found: ${measureFieldName}`);
  const dimension = analysisDimension(model, dimensionField);
  const measure = analysisMeasure(model, modelMeasure);
  const dataSource = { id: model.id, type: 'AUGMENTED' };
  const sortSetting = { row: { sorts: [] }, col: { sorts: [] } };
  return {
    name: applyNamespace(requestedName),
    alias: applyNamespace(requestedName),
    desc: description,
    define: {
      reportSetting: { refresh: {}, tableHeader: null, tableFooter: null },
      portlets: [
        {
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
        },
        {
          id: resourceId(),
          name: 'filterPanel',
          type: 'FILTER_PANEL',
          extended: {
            children: [],
            impactMap: {},
            whereConditionalRelation: {},
            havingConditionalRelation: {},
            setting: {},
            sortSetting,
            dataSource,
          },
        },
      ],
      privateDataset: { folders: [], fields: [] },
    },
  };
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
  const model = await loadModel(modelId);
  requireNamespacedResource(model, 'model');
  const report = buildAnalysisReport(
    model,
    rowFieldName,
    measureFieldName,
    requestedName,
    description,
  );
  const result = await smartbixApi(
    `adhocanalysis/createReport?pid=${encodeURIComponent(parentId)}`,
    { method: 'POST', body: report },
  );
  const createdId = createdResourceId(result);
  if (!createdId) throw new Error(`analysis create returned no id: ${JSON.stringify(result)}`);
  const saved = await loadAnalysis(createdId);
  const queryResult = await smartbixApi(`adhocanalysis/data/${encodeURIComponent(createdId)}`, {
    method: 'POST',
    body: buildAnalysisQuery(saved.report),
    timeoutMs: 120000,
  });
  safeOutput({
    ok: true,
    id: saved.report.id,
    name: saved.report.name,
    rowField: rowFieldName,
    measure: measureFieldName,
    validation: {
      total: queryResult.total ?? null,
      rowKeys: Object.keys(queryResult.rowMap || {}),
      columns: (queryResult.columns || []).filter(Boolean).map((column) => column.label || column.value),
    },
  });
}

async function cmdAnalysisRun(analysisId) {
  const { report } = await loadAnalysis(analysisId);
  requireNamespacedResource(report, 'analysis');
  const result = await smartbixApi(`adhocanalysis/data/${encodeURIComponent(analysisId)}`, {
    method: 'POST',
    body: buildAnalysisQuery(report),
    timeoutMs: 120000,
  });
  safeOutput({ ok: true, analysisId, name: report.name, result });
}

async function cmdAnalysisClone(parentId, sourceAnalysisId, requestedName, description = '') {
  if (![parentId, sourceAnalysisId, requestedName].every(Boolean)) {
    throw new Error('analysis-clone requires <parentId> <sourceAnalysisId> <name> [description]');
  }
  await assertOwnedCatalogParent(parentId);
  const { report: source } = await loadAnalysis(sourceAnalysisId);
  requireNamespacedResource(source, 'source analysis');
  const report = structuredClone(source);
  delete report.id;
  delete report.creatorId;
  report.name = report.alias = applyNamespace(requestedName);
  report.desc = description || source.desc || '';
  for (const portlet of report.define?.portlets || []) portlet.id = resourceId();
  const result = await smartbixApi(
    `adhocanalysis/createReport?pid=${encodeURIComponent(parentId)}`,
    { method: 'POST', body: report },
  );
  const createdId = createdResourceId(result);
  if (!createdId) throw new Error(`analysis create returned no id: ${JSON.stringify(result)}`);
  const saved = await loadAnalysis(createdId);
  safeOutput({
    ok: true,
    id: saved.report.id,
    name: saved.report.name,
    portletCount: saved.report.define?.portlets?.length || 0,
  });
}

function dashboardDimension(model, field) {
  const parentId = model.nodes?.find((node) => node.id === field.id)?.parentId
    || `AUGMENTED_DATASET_FOLDER.${model.id}.${field.viewId}`;
  return {
    id: qualifyModelResource(model.id, 'FIELD', field.id),
    alias: field.alias || field.name,
    label: field.alias || field.name,
    label0: field.alias || field.name,
    showName: null,
    aggregatedCalcField: false,
    aggregate: 'NONE',
    originAggregate: null,
    orderBy: null,
    orderBySettings: null,
    align: null,
    dataFormat: null,
    orderPriority: 0,
    subtotal: null,
    group: 'DIMENSION',
    dataType: field.valueType,
    type: 'FIELD',
    fieldType: 'DIMENSION',
    uniqueId: resourceId(),
    parentId,
    parentNodeName: null,
    order: model.nodes?.find((node) => node.id === field.id)?.order || 0,
    name: field.name,
    originalDataType: field.originalDataType || null,
    businessCaliber: field.businessCaliber || null,
    fieldLabelStatus: { aggregate: '' },
  };
}

function dashboardMeasure(model, measure) {
  const aggregate = String(measure.aggregator || 'sum').toUpperCase();
  const parentId = model.nodes?.find((node) => node.id === measure.id)?.parentId
    || `AUGMENTED_DATASET_FOLDER.${model.id}.measure`;
  return {
    id: qualifyModelResource(model.id, 'MEASURE', measure.id),
    alias: measure.alias || measure.name,
    label: measure.alias || measure.name,
    label0: measure.alias || measure.name,
    showName: null,
    aggregatedCalcField: false,
    aggregate,
    originAggregate: aggregate,
    orderBy: null,
    orderBySettings: null,
    align: null,
    dataFormat: null,
    orderPriority: 0,
    subtotal: null,
    group: 'MEASURE',
    dataType: measure.valueType,
    type: 'MEASURE',
    fieldType: 'MEASURE',
    uniqueId: resourceId(),
    parentId,
    parentNodeName: null,
    order: model.nodes?.find((node) => node.id === measure.id)?.order || 0,
    name: measure.name,
    originalDataType: measure.valueType,
    businessCaliber: measure.businessCaliber || null,
    refDataSetFieldId: measure.refDataSetFieldId
      ? qualifyModelResource(model.id, 'FIELD', measure.refDataSetFieldId)
      : null,
    fieldLabelStatus: { aggregate },
  };
}

function buildBarDashboard(model, dimensionName, measureName, requestedName, chartTitle) {
  const field = (model.fields || []).find(
    (item) => item.name === dimensionName || item.alias === dimensionName,
  );
  if (!field) throw new Error(`dashboard dimension field not found: ${dimensionName}`);
  const measure = (model.measures || []).find(
    (item) => item.name === measureName || item.alias === measureName,
  );
  if (!measure) throw new Error(`dashboard measure not found: ${measureName}`);
  const pageId = resourceId();
  const portletId = resourceId();
  const name = applyNamespace(requestedName);
  return {
    id: pageId,
    name,
    alias: name,
    desc: chartTitle || `${measureName} by ${dimensionName}`,
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
                  type: 'ECHARTS_BAR',
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
        name: String(Date.now()),
        type: 'ECHARTS_BAR',
        displayMode: 'ECHARTS_BAR',
        style: null,
        macros: [],
        extended: {
          asFilter: false,
          title: { text: chartTitle || `${measureName} by ${dimensionName}` },
          datasetIds: [model.id],
          fields: {
            cols: [dashboardDimension(model, field)],
            rows: [dashboardMeasure(model, measure)],
            filters: [],
          },
          markFieldGroups: { GLOBAL_MARK: {} },
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
          table: {},
          chartDefine: {
            tooltip: {},
            seriesConfig: { global: { label: {}, stack: false } },
            xAxis: { axisLabel: {} },
            yAxis: { axisLabel: {} },
          },
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
  const model = await loadModel(modelId);
  requireNamespacedResource(model, 'model');
  const dashboard = buildBarDashboard(
    model,
    dimensionName,
    measureName,
    requestedName,
    chartTitle,
  );
  const result = await smartbixApi(
    `pages/beans/create?pid=${encodeURIComponent(parentId)}`,
    { method: 'POST', body: dashboard },
  );
  const createdId = createdResourceId(result, dashboard.id);
  const saved = await loadDashboard(createdId);
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    model: { id: model.id, name: model.name },
    portletCount: saved.define?.portlets?.length || 0,
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
  const source = await loadDashboard(sourceDashboardId);
  requireNamespacedResource(source, 'source dashboard');
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
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    portletCount: saved.define?.portlets?.length || 0,
  });
}

function parseAichatStream(text) {
  const messages = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      messages.push(JSON.parse(line.slice(5)));
    } catch {
      // Ignore malformed incremental frames; later frames carry the complete artifact.
    }
  }
  const artifacts = new Map();
  let state = null;
  for (const message of messages) {
    const result = message.result;
    if (result?.kind === 'artifact-update' && result.artifact?.artifactId) {
      artifacts.set(result.artifact.artifactId, result.artifact);
    }
    if (result?.kind === 'status-update' && result.taskId === message.id) {
      state = result.status?.state || state;
    }
  }
  const answers = [];
  const tables = [];
  const files = [];
  for (const artifact of artifacts.values()) {
    const mimeType = artifact.metadata?.mimeType;
    for (const part of artifact.parts || []) {
      if (part.kind === 'text' && part.text && mimeType === 'text/plain') answers.push(part.text);
      if (part.kind === 'data' && Array.isArray(part.data) && mimeType === 'json/table') {
        tables.push({ title: artifact.metadata?.title || null, rows: part.data });
      }
      if (part.kind === 'file' && part.file) {
        files.push({
          name: part.file.name || null,
          display: part.file.display?.split('/').pop() || null,
          mimeType: part.file.mimeType || null,
          size: part.file.size ?? null,
        });
      }
    }
  }
  return {
    ok: state === 'completed',
    state,
    answer: answers.at(-1) || null,
    tables: [...new Map(tables.map((table) => [JSON.stringify(table), table])).values()],
    files: [...new Map(files.map((file) => [JSON.stringify(file), file])).values()],
    eventCount: messages.length,
  };
}

async function cmdAichat(modelId, question, { report = false, outputPath = null } = {}) {
  if (!modelId || !question) {
    throw new Error(`${report ? 'aichat-report' : 'aichat-query'} requires <modelId> <prompt>`);
  }
  const model = await loadModel(modelId);
  requireNamespacedResource(model, 'model');
  const llmConfig = await plainJsonRequest('cgi/aichat-llm-config/list-llm-config', {
    body: { filterOption: { keyword: '' } },
  });
  const llmId = llmConfig?.result?.find((item) => item.isDefault)?.id || llmConfig?.result?.[0]?.id;
  if (!llmId) throw new Error('AIChat has no available LLM configuration');
  const skillsResponse = await plainJsonRequest('sdk/cgi/v1/aichat/skill/get-skill-items', { body: undefined });
  const wanted = new Set([
    'SKILL_BUILTIN_DATA_MODEL_OR_REPORT_FETCH',
    ...(report ? ['SKILL_BUILTIN_NO_TEMPLATE_REPORT', 'SKILL_BUILTIN_TEMPLATE_REPORT'] : []),
  ]);
  const skills = (skillsResponse?.result || [])
    .filter((item) => wanted.has(item.id))
    .map((item) => ({ id: item.id, name: item.alias || item.name, type: item.type }));
  const conversationId = shortId();
  const taskId = shortId(6);
  const payload = {
    jsonRpcStreamReq: {
      jsonrpc: '2.0',
      method: 'message/stream',
      params: {
        message: {
          messageId: shortId(6),
          kind: 'message',
          role: 'user',
          metadata: {
            agentId: 'customagent_AGENT_DATA_INSIGHT_ASSISTANT',
            convId: conversationId,
            datasets: [{ id: model.id, type: 'AUGMENTED_DATASET', name: model.name }],
            queryGridData: true,
            params: [
              { singleRound: false },
              { use_personal_knowledge: false },
              { reports: [] },
              { projectId: '' },
              { project_desc: '' },
              {},
              { webSearch: false },
              { crossDatasetQuery: true },
              { uploadFile: false },
              { need_inquiry: true },
              { is_recommend_dataset: false },
              { LLMConfigId: llmId },
              { skills },
            ],
          },
          parts: [
            { kind: 'text', text: question },
            { kind: 'knowledge', knowledge: '[]' },
          ],
        },
      },
      id: taskId,
    },
  };
  const stream = await plainJsonRequest('sdk/api/v1/aichat/conv/query-rpc', {
    body: payload,
    accept: 'text/event-stream',
    timeoutMs: 300000,
  });
  const parsed = parseAichatStream(stream);
  const output = {
    ...parsed,
    conversationId,
    model: { id: model.id, name: model.name },
    mode: report ? 'report' : 'query',
  };
  if (outputPath) {
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    safeOutput({
      ok: output.ok,
      state: output.state,
      mode: output.mode,
      path: outputPath,
      tableCount: output.tables.length,
      fileCount: output.files.length,
      eventCount: output.eventCount,
    });
    return;
  }
  safeOutput(output);
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
    throw new Error(`${operation} failed: ${response.message || response.error || JSON.stringify(response)}`);
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

function parseGraphExtended(node) {
  if (!node?.extended) return {};
  try {
    return typeof node.extended === 'string' ? JSON.parse(node.extended) : node.extended;
  } catch {
    return {};
  }
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
  return graphResult(response, 'list model graphs') || [];
}

async function loadOwnedGraphModel(modelId) {
  const model = await loadModel(modelId);
  if (!hasNamespace(model.name)) {
    throw new Error(`refusing to modify non-namespaced model graph: ${model.name}`);
  }
  return model;
}

async function loadAichatGraphFields(modelId) {
  const model = await loadOwnedGraphModel(modelId);
  const response = await plainJsonRequest(
    `cgi/aichat-train/get-resource-field-tree/${encodeURIComponent(model.id)}`,
    { body: { fieldTreeOption: { filterTypes: AICHAT_GRAPH_FILTER_TYPES } } },
  );
  const tree = graphResult(response, 'load model graph fields');
  if (!tree) throw new Error(`model graph field tree is unavailable: ${model.name}`);
  return { model, tree, fields: collectGraphFields(tree) };
}

async function cmdAichatGraphList(keyword = '') {
  const nodes = (await listAichatGraphNodes(keyword)).filter((node) => hasNamespace(node.name));
  safeOutput({
    ok: true,
    count: nodes.length,
    graphs: nodes.map((node) => {
      const extended = parseGraphExtended(node);
      return {
        id: node.id,
        name: node.name,
        type: node.type,
        path: node.path || null,
        status: extended.status || node.status || node.lastBuildStatus || 'NOTBUILD',
        updateTime: extended.updateTime || node.lastModifiedDate || null,
        duration: extended.duration ?? null,
        fieldCount: extended.trainOption?.fields?.length || 0,
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
    fieldCount: fields.length,
    fields,
  });
}

async function cmdAichatGraphStatus(modelId) {
  if (!modelId) throw new Error('aichat-graph-status requires <modelId>');
  const model = await loadOwnedGraphModel(modelId);
  const node = (await listAichatGraphNodes(model.name)).find((item) => item.id === model.id);
  if (!node) {
    safeOutput({ ok: true, id: model.id, name: model.name, status: 'NOTBUILD', fieldCount: 0 });
    return;
  }
  const extended = parseGraphExtended(node);
  safeOutput({
    ok: true,
    id: node.id,
    name: node.name,
    status: extended.status || node.status || node.lastBuildStatus || 'NOTBUILD',
    updateTime: extended.updateTime || node.lastModifiedDate || null,
    duration: extended.duration ?? null,
    fields: extended.trainOption?.fields || [],
  });
}

function resolveGraphFields(fields, selectors) {
  return selectors.map((selector) => {
    const normalized = selector.toLocaleLowerCase();
    const matches = fields.filter((field) => (
      field.id === selector
      || field.name?.toLocaleLowerCase() === normalized
      || field.alias?.toLocaleLowerCase() === normalized
    ));
    if (matches.length === 0) throw new Error(`model graph field not found: ${selector}`);
    if (matches.length > 1) {
      throw new Error(`model graph field is ambiguous: ${selector}; use the exact field id`);
    }
    return matches[0];
  });
}

async function cmdAichatGraphBuild(modelId, fieldSelectorsCsv) {
  if (!modelId || !fieldSelectorsCsv) {
    throw new Error('aichat-graph-build requires <modelId> <fieldNameOrId,...>');
  }
  const selectors = [...new Set(
    String(fieldSelectorsCsv).split(',').map((value) => value.trim()).filter(Boolean),
  )];
  if (selectors.length === 0) throw new Error('aichat-graph-build requires at least one field');
  const { model, fields } = await loadAichatGraphFields(modelId);
  const selected = resolveGraphFields(fields, selectors);
  const fieldIds = selected.map((field) => field.id);
  const existing = (await listAichatGraphNodes(model.name)).find((item) => item.id === model.id);
  const existingExtended = parseGraphExtended(existing);
  const existingFields = existingExtended.trainOption?.fields || [];
  if (
    existingExtended.status === 'SUCCESS'
    && fieldIds.length === existingFields.length
    && fieldIds.every((id) => existingFields.includes(id))
  ) {
    safeOutput({
      ok: true,
      id: model.id,
      name: model.name,
      status: 'SUCCESS',
      reused: true,
      fields: selected,
    });
    return;
  }
  const validation = graphResult(
    await plainJsonRequest(
      `cgi/aichat-train/validate_field_data_count/${encodeURIComponent(model.id)}`,
      { body: { fieldIds } },
    ),
    'validate model graph fields',
  );
  if (!validation?.valid) {
    throw new Error(`model graph field validation failed: ${validation?.message || 'unknown reason'}`);
  }
  const trainResult = graphResult(
    await plainJsonRequest(
      `cgi/aichat-train/train-resource/${encodeURIComponent(model.id)}`,
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
  if (!trainResult) throw new Error('model graph build was not accepted');
  const deadline = Date.now() + 300000;
  let node;
  let extended = {};
  while (Date.now() < deadline) {
    node = (await listAichatGraphNodes(model.name)).find((item) => item.id === model.id);
    extended = parseGraphExtended(node);
    const status = extended.status || node?.status || node?.lastBuildStatus;
    if (status === 'SUCCESS') break;
    if (status === 'FAILED') {
      throw new Error(`model graph build failed: ${extended.exceptionMessage || 'unknown reason'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const status = extended.status || node?.status || node?.lastBuildStatus || 'PENDING';
  if (status !== 'SUCCESS') throw new Error(`model graph build timed out with status ${status}`);
  safeOutput({
    ok: true,
    id: model.id,
    name: model.name,
    status,
    reused: false,
    updateTime: extended.updateTime || node?.lastModifiedDate || null,
    duration: extended.duration ?? null,
    fields: selected,
  });
}

async function loadAgent(agentId, requireOwned = false) {
  if (!agentId) throw new Error('agent id is required');
  await ensureSession();
  const agent = await smartbixApi(`dataagent/graph/${encodeURIComponent(agentId)}`);
  if (!agent?.id) throw new Error(`Agent not found or incomplete: ${agentId}`);
  if (requireOwned && !hasNamespace(agent.name)) {
    throw new Error(`refusing to modify or run non-namespaced Agent: ${agent.name}`);
  }
  return {
    ...agent,
    define: typeof agent.define === 'string' ? JSON.parse(agent.define) : agent.define,
    params: typeof agent.params === 'string' ? JSON.parse(agent.params) : agent.params,
    setting: typeof agent.setting === 'string' ? JSON.parse(agent.setting) : agent.setting,
  };
}

function setAgentConfig(node, name, value) {
  const config = node.configs?.find((item) => item.name === name);
  if (!config) throw new Error(`${node.name} template is missing config: ${name}`);
  config.value = value;
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
  const findTemplate = (name) => catalog?.basic?.find((item) => item.name === name);
  const templates = ['StartNode', 'LLM', 'FinishNode'].map(findTemplate);
  if (templates.some((template) => !template)) {
    throw new Error('Agent node catalog does not contain StartNode, LLM, and FinishNode');
  }

  const start = instantiateAgentNode(templates[0], 0, '#5E9F76');
  const llm = instantiateAgentNode(templates[1], 290, '#3F99E7');
  const finish = instantiateAgentNode(templates[2], 580, '#5E9F76');
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

  return {
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
}

async function cmdAgentGet(agentId) {
  const agent = await loadAgent(agentId);
  const deployment = await smartbixApi(`dataagent/deploy/agent/${encodeURIComponent(agent.id)}`);
  safeOutput({
    ...agent,
    deployed: Array.isArray(deployment) && deployment.length > 0,
    deployment,
  });
}

async function cmdAgentCreate(
  parentId,
  requestedName,
  description = '',
  systemPrompt = '你是数据分析助手。仅基于已提供的数据和上下文回答，区分事实、推断与建议；不编造指标或因果结论。',
  userPrompt = '请回答以下用户问题，并给出可核验的分析：{{question}}',
) {
  if (!parentId || !requestedName) {
    throw new Error('agent-create requires <parentId> <name> [description] [systemPrompt] [userPrompt]');
  }
  await assertOwnedCatalogParent(parentId, { allowAgentRoot: true });
  await ensureSession();
  const name = applyNamespace(requestedName);
  const define = await buildBasicAgent(systemPrompt, userPrompt);
  const body = {
    id: null,
    name,
    alias: name,
    desc: description,
    define: JSON.stringify(define),
    params: JSON.stringify({ sysParam: [], customParam: [] }),
  };
  const result = await smartbixApi(`dataagent/graph/create/${encodeURIComponent(parentId)}`, {
    method: 'POST',
    body,
  });
  const id = createdResourceId(result);
  if (!id) throw new Error(`Agent create returned no id: ${JSON.stringify(result)}`);
  const saved = await loadAgent(id, true);
  safeOutput({
    ok: true,
    id: saved.id,
    name: saved.name,
    nodeCount: saved.define?.nodes?.length || 0,
    linkCount: saved.define?.links?.length || 0,
  });
}

async function cmdAgentRun(agentId, question) {
  if (!agentId || !question) throw new Error('agent-run requires <agentId> <question>');
  const agent = await loadAgent(agentId, true);
  const instanceId = resourceId();
  await smartbixApi('dataagent/test/flow', {
    method: 'POST',
    body: {
      query: question,
      queryType: `customagent_${agent.id}`,
      currentInstanceId: instanceId,
      flowId: agent.id,
      convId: instanceId,
    },
  });

  let state = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    state = await smartbixApi(`dataagent/flow/nodestate/${encodeURIComponent(instanceId)}`);
    if (['FINISH', 'ERROR', 'FAILED', 'KILLED', 'STOP'].includes(state?.state)) break;
  }
  if (!state || !['FINISH', 'ERROR', 'FAILED', 'KILLED', 'STOP'].includes(state.state)) {
    throw new Error(`Agent run timed out: ${instanceId}`);
  }

  const outputs = [];
  for (const node of state.nodeStates || []) {
    if (node.name !== 'LLM') continue;
    const values = await smartbixApi(`dataagent/output/${encodeURIComponent(node.id)}`);
    for (const item of Array.isArray(values) ? values : []) {
      if (item?.value?.result_content) {
        outputs.push({
          nodeId: node.id,
          node: node.alias || node.name,
          content: item.value.result_content,
          inputTokens: item.value.input_tokens ?? null,
          outputTokens: item.value.output_tokens ?? null,
        });
      }
    }
  }
  safeOutput({
    ok: state.state === 'FINISH',
    id: instanceId,
    agent: { id: agent.id, name: agent.name },
    state: state.state,
    answer: outputs.at(-1)?.content || null,
    outputs,
    nodeStates: state.nodeStates,
  });
}

async function cmdAgentDeploy(agentId) {
  const agent = await loadAgent(agentId, true);
  let deployment = await smartbixApi(`dataagent/deploy/agent/${encodeURIComponent(agent.id)}`);
  if (!Array.isArray(deployment) || deployment.length === 0) {
    await smartbixApi('dataagent/relation/create', {
      method: 'POST',
      body: { id: null, agentId: agent.id, resId: null },
    });
    deployment = await smartbixApi(`dataagent/deploy/agent/${encodeURIComponent(agent.id)}`);
  }
  if (!Array.isArray(deployment) || deployment.length === 0) {
    throw new Error(`Agent deployment was not persisted: ${agent.id}`);
  }
  safeOutput({ ok: true, id: agent.id, name: agent.name, deployed: true, deployment });
}


async function cmdTree(rootId) {
  await ensureSession();
  const id = rootId || '';
  const ret = await rmi('CatalogService', 'getChildElements', [id]);
  if (ret.retCode !== 0) { safeOutput({ error: ret }); return; }
  const nodes = (ret.result || []).map((n) => ({
    id: n.id, name: n.name, alias: n.alias, type: n.type, hasChild: n.hasChild,
  }));
  safeOutput({ parent: id, nodes });
}

async function assertOwnedCatalogParent(
  parentId,
  { allowSelfRoot = false, allowAgentRoot = false } = {},
) {
  await ensureSession();
  const rootResponse = await rmi('CatalogService', 'getChildElements', ['']);
  const selfRoot = (rootResponse.result || []).find((node) => node.type === 'SELF_TREENODE');
  if (rootResponse.retCode !== 0 || !selfRoot?.id) {
    throw new Error('cannot resolve the current personal workspace root');
  }
  const agentRootId = `SELF_AGENT_GRAPHS_${String(selfRoot.id).replace(/^SELF_/, '')}`;
  if (allowSelfRoot && parentId === selfRoot.id) return selfRoot;
  if (allowAgentRoot && parentId === agentRootId) {
    const agentRoot = await rmi('CatalogService', 'getCatalogElementById', [agentRootId]);
    if (agentRoot.retCode === 0 && agentRoot.result?.id) return agentRoot.result;
  }
  const parentResponse = await rmi('CatalogService', 'getCatalogElementById', [parentId]);
  const parent = parentResponse.result;
  if (
    parentResponse.retCode !== 0
    || !parent?.id
    || !['DEFAULT_TREENODE', 'SELF_TREENODE'].includes(parent.type)
    || !hasNamespace(parent.name || parent.alias)
  ) {
    throw new Error(`refusing a non-owned catalog parent: ${parentId}`);
  }
  const pathResponse = await rmi('CatalogService', 'getCatalogElementPath', [parentId]);
  const ownedRoots = new Set([selfRoot.id]);
  if (allowAgentRoot) ownedRoots.add(agentRootId);
  if (
    pathResponse.retCode !== 0
    || !(pathResponse.result || []).some((node) => ownedRoots.has(node.id))
  ) {
    throw new Error(`catalog parent is outside the current personal workspace: ${parentId}`);
  }
  return parent;
}


async function cmdFolderCreate(parentId, requestedName, description = '') {
  if (!parentId || !requestedName) {
    throw new Error('folder-create requires <parentId> <name> [description]');
  }
  await assertOwnedCatalogParent(parentId, { allowSelfRoot: true, allowAgentRoot: true });
  const name = applyNamespace(requestedName);
  const existingResult = await rmi('CatalogService', 'getChildElements', [parentId]);
  if (existingResult.retCode !== 0) {
    throw new Error(`cannot list folder parent: ${JSON.stringify(existingResult)}`);
  }
  const existing = (existingResult.result || []).find((node) => (
    ['DEFAULT_TREENODE', 'SELF_TREENODE'].includes(node.type)
    && (node.name === name || node.alias === name)
  ));
  if (existing) {
    if (!hasNamespace(existing.name || existing.alias)) {
      throw new Error(`refusing to reuse non-namespaced folder: ${existing.alias || existing.name}`);
    }
    safeOutput({ ok: true, created: false, id: existing.id, name: existing.name, alias: existing.alias });
    return;
  }
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
    throw new Error(`folder creation failed: ${JSON.stringify(created)}`);
  }
  const savedResult = await rmi('CatalogService', 'getChildElements', [parentId]);
  const saved = (savedResult.result || []).find((node) => node.id === created.result.id);
  if (!saved || !hasNamespace(saved.name || saved.alias)) {
    throw new Error(`created folder was not visible or owned: ${created.result.id}`);
  }
  safeOutput({ ok: true, created: true, id: saved.id, name: saved.name, alias: saved.alias });
}

async function cmdResourceDelete(parentId, resourceId) {
  if (!parentId || !resourceId) {
    throw new Error('resource-delete requires <parentId> <resourceId>');
  }
  await assertOwnedCatalogParent(parentId, { allowSelfRoot: true, allowAgentRoot: true });
  const before = await rmi('CatalogService', 'getChildElements', [parentId]);
  if (before.retCode !== 0) throw new Error(`cannot list resource parent: ${JSON.stringify(before)}`);
  const resource = (before.result || []).find((node) => node.id === resourceId);
  if (!resource) throw new Error(`resource is not a direct child of the supplied parent: ${resourceId}`);
  if (!hasNamespace(resource.name || resource.alias)) {
    throw new Error(`refusing to delete non-namespaced resource: ${resource.alias || resource.name}`);
  }
  const purview = await rmi('CatalogService', 'isCatalogElementAccessible', [resourceId, 'DELETE']);
  if (purview.retCode !== 0 || purview.result !== true) {
    throw new Error(`delete permission denied: ${resourceId}`);
  }
  const deleted = await rmi('CatalogService', 'deleteCatalogElement', [resourceId]);
  if (deleted.retCode !== 0) throw new Error(`resource deletion failed: ${JSON.stringify(deleted)}`);
  const after = await rmi('CatalogService', 'getChildElements', [parentId]);
  if ((after.result || []).some((node) => node.id === resourceId)) {
    throw new Error(`deleted resource is still visible: ${resourceId}`);
  }
  safeOutput({ ok: true, deleted: true, id: resourceId, name: resource.name, alias: resource.alias });
}



// Walk the import tree to locate the personal acquisition space under 可导入数据库.
async function locatePersonalFolder() {
  const currentUser = await rmi('AIextRemoteService', 'getCurrentUserName', [], 15000);
  if (currentUser.retCode !== 0 || !currentUser.result) {
    throw new Error('cannot resolve the authenticated Smartbi user');
  }
  const dsKids = await rmi('CatalogService', 'getChildElements', ['DS.input']);
  if (dsKids.retCode !== 0) throw new Error('cannot list the import data source');
  const schema = (dsKids.result || []).find((node) => node.type === 'SCHEMA');
  if (!schema) throw new Error('可导入数据库 schema not found');
  const schemaKids = await rmi('CatalogService', 'getChildElements', [schema.id]);
  if (schemaKids.retCode !== 0) throw new Error('cannot list the import schema');
  const space = (schemaKids.result || []).find((node) => node.alias === '数据采集空间');
  if (!space) throw new Error('数据采集空间 not found');
  const spaceKids = await rmi('CatalogService', 'getChildElements', [space.id]);
  if (spaceKids.retCode !== 0) throw new Error('cannot list the acquisition space');
  const account = String(currentUser.result);
  const personal = (spaceKids.result || []).find((node) => (
    String(node.alias || '') === account || String(node.name || '') === account
  ));
  if (!personal) throw new Error('authenticated personal acquisition folder not found');
  return {
    dsId: 'DS.input',
    schemaId: schema.name,
    catalog: schema.name,
    folderId: personal.id,
  };
}

// Upload a local CSV/TXT/XLSX and import as a new table named <namespace><name>
// (namespace configurable: prefix or suffix). Returns table info after import.
async function cmdUpload(
  filePath,
  tableName,
  { previewRows = 30, sheetIndex = 0, replace = false } = {},
) {
  if (!filePath) throw new Error('upload requires <file> [tableName] [--replace]');
  const stats = (await import('node:fs')).statSync(filePath);
  if (!stats.isFile()) throw new Error(`not a file: ${filePath}`);
  if (!/\.(csv|txt|xlsx|xls)$/i.test(filePath)) {
    throw new Error('upload supports CSV, TXT, XLSX, or XLS files');
  }
  const base = tableName || filePath.split('/').pop().replace(/\.[^.]+$/, '');
  const table = applyNamespace(base);
  if (!table) throw new Error('resolved table name is empty');

  await ensureSession();
  const folder = await locatePersonalFolder();
  const physicalTable = table.toLowerCase();
  const tableRef = {
    dataSourceId: folder.dsId,
    tableId: `TAB.${folder.catalog}.${folder.schemaId}.null.${physicalTable}`,
    tableName: physicalTable,
  };
  const existingResponse = await rmi('CatalogService', 'getChildElements', [folder.folderId]);
  if (existingResponse.retCode !== 0) throw new Error('cannot inspect the personal acquisition folder');
  const existing = (existingResponse.result || []).find((node) => (
    String(node.id || '').toLocaleLowerCase() === tableRef.tableId.toLocaleLowerCase()
    || String(node.name || '').toLocaleLowerCase() === physicalTable
    || String(node.alias || '').toLocaleLowerCase() === table.toLocaleLowerCase()
  ));
  if (existing && !replace) {
    throw new Error(`table already exists; pass --replace to overwrite the owned table: ${table}`);
  }
  if (existing && !hasNamespace(existing.alias || existing.name)) {
    throw new Error(`refusing to replace non-namespaced table: ${existing.alias || existing.name}`);
  }

  const form = new FormData();
  form.append('action', 'UPLOAD_FILE');
  const { Blob } = await import('node:buffer');
  form.append('file', new Blob([readFileSync(filePath)]), filePath.split('/').pop());
  const uploaded = await fetch(`${BASE_URL}/DataPackageServlet`, {
    method: 'POST',
    headers: { Cookie: cookieHeader() },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const uploadJson = await uploaded.json();
  if (uploadJson.retCode !== 0) throw new Error(`upload failed: ${JSON.stringify(uploadJson)}`);
  const { clientId } = uploadJson.result || {};
  if (!clientId) throw new Error('upload did not return a client id');

  try {
    const preview = await fetch(`${BASE_URL}/DataPackageServlet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: cookieHeader(),
      },
      body: `action=GET_PREVIEW_DATA&clientId=${clientId}&previewRows=${previewRows}&sheetIndex=${sheetIndex}`,
      signal: AbortSignal.timeout(120000),
    });
    const previewJson = await preview.json();
    if (previewJson.retCode !== 0) {
      throw new Error(`preview failed: ${JSON.stringify(previewJson)}`);
    }
    const {
      fieldTypeList,
      fieldNameList,
      fieldAliasList,
      datas,
      rowCount,
    } = previewJson.result || {};
    const header = Array.isArray(datas?.[0]) ? datas[0] : null;
    const resolvedFieldNames = Array.isArray(fieldNameList) && fieldNameList.length > 0
      ? fieldNameList
      : (header || []).map((value) => String(value));
    if (
      resolvedFieldNames.length === 0
      || !Array.isArray(fieldTypeList)
      || fieldTypeList.length !== resolvedFieldNames.length
    ) {
      throw new Error(
        `preview field contract mismatch: names=${resolvedFieldNames.length}, `
        + `types=${fieldTypeList?.length || 0}`,
      );
    }

    const settings = [{
      createTable: true,
      sheetIndex: String(sheetIndex),
      headerRowIndex: 0,
      fieldTypeList,
      dsId: folder.dsId,
      schemaId: folder.schemaId,
      catalog: folder.catalog,
      folderId: folder.folderId,
      tableName: table,
      tableAlias: table,
      fieldAliasList: fieldAliasList || resolvedFieldNames,
      fieldNameList: resolvedFieldNames,
      importType: 'REPLACE',
      keepUniqueData: true,
      fileName: filePath.split('/').pop(),
      primaryKeyIndexs: [],
    }];
    const inserted = await fetch(`${BASE_URL}/DataPackageServlet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: cookieHeader(),
      },
      body: `action=INSERT_DATA&clientId=${clientId}&settings=${encodeURIComponent(JSON.stringify(settings))}`,
      signal: AbortSignal.timeout(120000),
    });
    const insertJson = await inserted.json();
    if (insertJson.retCode !== 0) throw new Error(`insert failed: ${JSON.stringify(insertJson)}`);

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const status = await rmi('DataPackageModule', 'getImportStatus', [clientId]);
      if (status.retCode !== 0 || !status.result) continue;
      if (status.result.retCode === 0) {
        safeOutput({
          ok: true,
          table,
          tableRef,
          rows: Math.max(0, Number(status.result.rowCount ?? rowCount ?? 1) - 1),
          fields: resolvedFieldNames,
          replaced: Boolean(existing),
        });
        return;
      }
      if (status.result.retCode !== undefined) {
        throw new Error(`import status error: ${JSON.stringify(status.result)}`);
      }
    }
    throw new Error('import status was not confirmed within 5 minutes');
  } catch (error) {
    try {
      await fetch(`${BASE_URL}/DataPackageServlet`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Cookie: cookieHeader(),
        },
        body: `action=DELETE_FILE&clientId=${encodeURIComponent(clientId)}`,
        signal: AbortSignal.timeout(30000),
      });
    } catch {}
    throw error;
  }
}

async function cmdUploadArgs(argsList) {
  const unknown = argsList.filter((value) => value.startsWith('--') && value !== '--replace');
  if (unknown.length > 0) throw new Error(`unknown upload option: ${unknown[0]}`);
  const replace = argsList.includes('--replace');
  const positional = argsList.filter((value) => value !== '--replace');
  if (positional.length > 2) throw new Error('upload accepts only <file> [tableName] [--replace]');
  await cmdUpload(positional[0], positional[1], { replace });
}

function parseImportedTableId(tableId) {
  const parts = String(tableId || '').split('.');
  if (parts.length < 5 || parts[0] !== 'TAB') {
    throw new Error(`expected an imported table id such as TAB.input.input.null.table_name: ${tableId}`);
  }
  const [, catalog, schema, nullMarker, ...tableNameParts] = parts;
  return {
    dataSourceId: `DS.${catalog}`,
    schemaId: `SCHEMA.${catalog}.${schema}.${nullMarker}`,
    tableName: tableNameParts.join('.'),
  };
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

function connectEtlNodes(left, right) {
  if (!left.outputs?.[0]?.id || !right.inputs?.[0]?.id) {
    throw new Error(`cannot connect ETL nodes ${left.alias || left.name} -> ${right.alias || right.name}`);
  }
  return {
    from: left.id,
    to: right.id,
    inputPortId: left.outputs[0].id,
    outputPortId: right.inputs[0].id,
  };
}

async function cmdEtlCreate(
  parentId,
  sourceTableId,
  targetTableId,
  requestedName,
  rowNumber = '-',
  description = '',
) {
  if (![parentId, sourceTableId, targetTableId, requestedName].every(Boolean)) {
    throw new Error(
      'etl-create requires <parentId> <sourceTableId> <targetTableId> <name> [rowNumber|-] [description]',
    );
  }
  const addRowNumber = rowNumber !== '-';
  if (addRowNumber && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rowNumber)) {
    throw new Error(`invalid row-number column name: ${rowNumber}`);
  }

  await assertOwnedCatalogParent(parentId);
  await ensureSession();
  const [sourceMeta, targetMeta, nodeCatalog] = await Promise.all([
    smartbixApi(`miningdatasource/table?tableId=${encodeURIComponent(sourceTableId)}`),
    smartbixApi(`miningdatasource/table?tableId=${encodeURIComponent(targetTableId)}`),
    smartbixApi('datamining/nodes'),
  ]);
  if (!hasNamespace(sourceMeta?.alias || sourceMeta?.name)) {
    throw new Error(`refusing to read non-namespaced source table: ${sourceMeta?.alias || sourceTableId}`);
  }
  if (!hasNamespace(targetMeta?.alias || targetMeta?.name)) {
    throw new Error(`refusing to overwrite non-namespaced target table: ${targetMeta?.alias || targetTableId}`);
  }

  const templates = nodeCatalog.defaultOptions || [];
  const sourceTemplate = templates.find((node) => node.name === 'JDBC_DATASOURCE');
  const rowNumberTemplate = templates.find((node) => node.name === 'DATAPREPARE_ROW_NUMBER');
  if (!sourceTemplate || (addRowNumber && !rowNumberTemplate)) {
    throw new Error('required ETL node templates are unavailable');
  }

  const sourceRef = parseImportedTableId(sourceTableId);
  const source = instantiateEtlNode(sourceTemplate, 350, 50);
  source.alias = sourceMeta.alias || sourceMeta.name;
  const jdbc = source.configs?.find((config) => config.name === 'jdbc');
  if (!jdbc) throw new Error('JDBC source template has no jdbc config');
  jdbc.value = JSON.stringify({
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
  });

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
    throw new Error(`target-node template creation failed: ${JSON.stringify(tempDag)}`);
  }
  const targetGraph = JSON.parse(tempDag.define);
  const target = targetGraph.nodes?.find((node) => node.type === 'JDBC_DATATARGER_OVERWRITE');
  if (!target) throw new Error('target-node template contains no overwrite node');
  target.state = 'INITED';

  const nodes = [source];
  if (addRowNumber) {
    const rowNode = instantiateEtlNode(rowNumberTemplate, 470, 50);
    const nameConfig = rowNode.configs?.find((config) => config.name === 'name');
    if (!nameConfig) throw new Error('row-number template has no name config');
    nameConfig.value = rowNumber;
    nodes.push(rowNode);
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
    define: JSON.stringify({
      version: { editor: 'HORIZONTAL' },
      nodes,
      links,
      top: 10,
      left: 37,
    }),
  };
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

async function loadEtlFlow(flowId, { requireOwned = false } = {}) {
  if (!flowId) throw new Error('flow id is required');
  await ensureSession();
  const wrapper = await smartbixApi(`datamining/flow/${encodeURIComponent(flowId)}/no`);
  const processDag = wrapper.processDag;
  if (!processDag?.define) throw new Error(`ETL flow not found or incomplete: ${flowId}`);
  if (requireOwned && !hasNamespace(processDag.name)) {
    throw new Error(`refusing to modify or run non-namespaced ETL flow: ${processDag.name}`);
  }
  return { wrapper, processDag, graph: JSON.parse(processDag.define) };
}

async function saveEtlGraph(processDag, graph) {
  processDag.define = JSON.stringify(graph);
  processDag.state = 'INITED';
  return smartbixApi('dataprocess/processflowdefine/define', {
    method: 'POST',
    body: {
      processDag: {
        id: processDag.id,
        name: processDag.name,
        alias: processDag.alias,
        cache: processDag.cache,
        smallBatch: processDag.smallBatch,
        desc: processDag.desc,
        createdDate: processDag.createdDate,
        lastModifiedDate: processDag.lastModifiedDate,
        runningInfo: { dagState: 'INITED', costTime: 0 },
        subDefine: processDag.subDefine,
        define: processDag.define,
        currentInstanceId: processDag.currentInstanceId,
        param: processDag.param,
        callerId: processDag.callerId,
        state: processDag.state,
      },
      dagRemark: null,
      toSaveTempDag: false,
      cover: false,
    },
  });
}

async function cmdEtlNodeList(keyword = '') {
  await ensureSession();
  const catalog = await smartbixApi('datamining/nodes');
  const normalized = String(keyword).toLocaleLowerCase();
  const nodes = (catalog.defaultOptions || []).filter((node) => (
    !normalized
    || node.name?.toLocaleLowerCase().includes(normalized)
    || node.alias?.toLocaleLowerCase().includes(normalized)
  ));
  safeOutput({
    ok: true,
    count: nodes.length,
    nodes: nodes.map((node) => ({
      name: node.name,
      alias: node.alias,
      inputCount: node.inputs?.length || 0,
      outputCount: node.outputs?.length || 0,
      configs: (node.configs || []).map((config) => ({
        name: config.name,
        label: config.label || config.lable || null,
        type: config.type || null,
        required: Boolean(config.required),
        defaultValue: config.value ?? null,
      })),
    })),
  });
}

function applyEtlNodeConfigs(node, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('ETL node config must be a JSON object');
  }
  const known = new Map((node.configs || []).map((config) => [config.name, config]));
  for (const [name, value] of Object.entries(values)) {
    const config = known.get(name);
    if (!config) {
      throw new Error(`ETL node ${node.name} has no config named ${name}`);
    }
    config.value = value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
  }
}

async function cmdEtlInsert(flowId, nodeName, configJson = '{}', instanceKey = nodeName) {
  if (!flowId || !nodeName) {
    throw new Error('etl-insert requires <flowId> <nodeName> [configJson] [instanceKey]');
  }
  const configValues = JSON.parse(configJson);
  const { processDag, graph } = await loadEtlFlow(flowId, { requireOwned: true });
  const catalog = await smartbixApi('datamining/nodes');
  graph.nodes ||= [];
  graph.links ||= [];
  const template = (catalog.defaultOptions || []).find((node) => node.name === nodeName);
  if (!template) throw new Error(`ETL node template not found: ${nodeName}`);
  if (template.inputs?.length !== 1 || template.outputs?.length !== 1) {
    throw new Error(
      `etl-insert supports unary transforms only; ${nodeName} has `
      + `${template.inputs?.length || 0} inputs and ${template.outputs?.length || 0} outputs`,
    );
  }

  let node = graph.nodes.find((item) => item.smartbiCliKey === instanceKey);
  let changed = false;
  if (node) {
    if (node.name !== nodeName) {
      throw new Error(`ETL instance key ${instanceKey} already belongs to ${node.name}`);
    }
    const before = JSON.stringify(node.configs || []);
    applyEtlNodeConfigs(node, configValues);
    changed = before !== JSON.stringify(node.configs || []);
    if (changed) node.state = 'INITED';
  } else {
    const targets = graph.nodes.filter((item) => (
      (item.inputs?.length || 0) > 0 && (item.outputs?.length || 0) === 0
    ));
    const inbound = targets.length === 1
      ? graph.links.filter((link) => link.to === targets[0].id)
      : [];
    if (targets.length !== 1 || inbound.length !== 1) {
      throw new Error(
        `ETL must have one terminal target with one inbound link; found `
        + `${targets.length} targets and ${inbound.length} inbound links`,
      );
    }
    const target = targets[0];
    const previousLink = inbound[0];
    node = instantiateEtlNode(
      template,
      Math.max(0, Number(target.x || 0) - 120),
      Number(target.y || 0),
    );
    node.smartbiCliKey = instanceKey;
    applyEtlNodeConfigs(node, configValues);
    target.x = Number(target.x || 0) + 120;
    target.state = 'INITED';
    graph.nodes.push(node);
    graph.links = graph.links.filter((link) => link !== previousLink);
    graph.links.push(
      {
        from: previousLink.from,
        to: node.id,
        inputPortId: previousLink.inputPortId,
        outputPortId: node.inputs[0].id,
      },
      {
        from: node.id,
        to: target.id,
        inputPortId: node.outputs[0].id,
        outputPortId: previousLink.outputPortId,
      },
    );
    changed = true;
  }

  const saved = changed ? await saveEtlGraph(processDag, graph) : processDag;
  safeOutput({
    ok: true,
    changed,
    flowId: saved.id || processDag.id,
    flowName: saved.name || processDag.name,
    node: {
      id: node.id,
      name: node.name,
      alias: node.alias,
      instanceKey,
      configs: Object.fromEntries((node.configs || []).map((config) => [config.name, config.value])),
    },
  });
}

async function cmdEtlGet(flowId) {
  const { processDag, graph } = await loadEtlFlow(flowId);
  safeOutput({
    ok: true,
    id: processDag.id,
    name: processDag.name,
    state: processDag.state,
    currentInstanceId: processDag.currentInstanceId,
    nodes: (graph.nodes || []).map((node) => ({
      id: node.id,
      name: node.name,
      alias: node.alias,
      state: node.state,
      inputs: (node.inputs || []).map((port) => port.id),
      outputs: (node.outputs || []).map((port) => port.id),
    })),
    links: graph.links || [],
  });
}

function summarizePortResult(result) {
  const features = Array.isArray(result?.features) ? result.features : [];
  const csv = result?.csv;
  return {
    featureCount: features.length,
    fields: features.map((feature) => feature.alias || feature.name).filter(Boolean),
    rowCount: Array.isArray(csv) ? csv.length : null,
    available: Boolean(features.length || csv),
  };
}

async function cmdEtlRun(flowId) {
  const { processDag, graph } = await loadEtlFlow(flowId, { requireOwned: true });
  const runDag = {
    id: processDag.id,
    name: processDag.name,
    alias: processDag.alias,
    cache: String(processDag.cache) === 'true',
    desc: processDag.desc,
    state: null,
    createdDate: processDag.createdDate,
    lastModifiedDate: processDag.lastModifiedDate,
    nodeStates: null,
    flowRunInfo: null,
    path: processDag.path,
    dagRemark: null,
    dagParam: null,
    smallBatch: String(processDag.smallBatch) === 'true',
    priority: null,
    dagId: null,
    define: processDag.define,
    endTime: null,
    startTime: null,
    runningInfo: { dagState: processDag.state || 'INITED', costTime: 0 },
    currentInstanceId: processDag.currentInstanceId,
    param: processDag.param,
    callerId: processDag.callerId,
  };
  const started = await smartbixApi('datamining/processflowdefine', {
    method: 'POST',
    body: { processDag: runDag, dagRemark: null, useCache: false },
    timeoutMs: 120000,
  });
  const instanceId = started.id;
  if (!instanceId) throw new Error(`ETL run did not return an instance id: ${JSON.stringify(started)}`);

  let state;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    state = await smartbixApi(`datamining/flowstate/${encodeURIComponent(instanceId)}`);
    if (['FINISH', 'ERROR', 'FAILED', 'KILLED'].includes(state.state)) break;
  }
  if (!state || !['FINISH', 'ERROR', 'FAILED', 'KILLED'].includes(state.state)) {
    throw new Error(`ETL run timed out: ${instanceId}`);
  }

  const fromIds = new Set((graph.links || []).map((link) => link.from));
  const terminalNodes = (graph.nodes || []).filter((node) => !fromIds.has(node.id));
  let preview = null;
  if (state.state === 'FINISH' && terminalNodes.length === 1 && terminalNodes[0].outputs?.[0]?.id) {
    const node = terminalNodes[0];
    try {
      const result = await smartbixApi(
        `miningnode/portresult/${encodeURIComponent(`${node.id}-${instanceId}`)}/${encodeURIComponent(node.outputs[0].id)}/csv`,
      );
      preview = summarizePortResult(result);
    } catch {
      preview = { available: false };
    }
  }

  safeOutput({
    ok: state.state === 'FINISH',
    flowId: processDag.id,
    flowName: processDag.name,
    instanceId,
    state: state.state,
    nodes: (state.nodeStates || []).map((node) => ({
      id: node.id,
      name: node.name,
      alias: node.alias,
      state: node.state,
      tip: node.tip,
    })),
    preview,
  });
}

async function cmdEtlRowNumber(flowId, columnName = 'row_number') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(columnName)) {
    throw new Error(`invalid row-number column name: ${columnName}`);
  }
  const { processDag, graph } = await loadEtlFlow(flowId, { requireOwned: true });
  graph.nodes ||= [];
  graph.links ||= [];
  let node = graph.nodes.find((item) => item.name === 'DATAPREPARE_ROW_NUMBER');
  let changed = false;

  if (node) {
    const config = node.configs?.find((item) => item.name === 'name');
    if (!config) throw new Error('existing row-number node has no name config');
    changed = config.value !== columnName;
    config.value = columnName;
    if (changed) node.state = 'INITED';
  } else {
    const fromIds = new Set(graph.links.map((link) => link.from));
    const sinks = graph.nodes.filter((item) => !fromIds.has(item.id));
    if (sinks.length !== 1 || !sinks[0].outputs?.[0]?.id) {
      throw new Error(`ETL must have exactly one connectable sink; found ${sinks.length}`);
    }
    const sink = sinks[0];
    node = {
      id: randomBytes(16).toString('hex'),
      name: 'DATAPREPARE_ROW_NUMBER',
      type: 'DATAPREPARE_ROW_NUMBER',
      alias: '增加序列号',
      configs: [{
        name: 'name',
        lable: '序列列名称',
        type: 'string',
        desc: '请输入新增序列号的名称，不能含有：空格,;{}()\\n\\t=等字符。',
        required: true,
        typeOptions: null,
        options: null,
        value: columnName,
        isHidden: null,
        disable: null,
        control: { controlType: 'SxMiningInput', controlProps: { type: 'text', rows: 1 } },
        extra: null,
        iframeUrl: null,
      }],
      combineConfigs: [],
      path: null,
      inputs: [{ id: randomBytes(16).toString('hex'), order: 0, types: ['DATASET'] }],
      outputs: [{ id: randomBytes(16).toString('hex'), order: 0, types: ['DATASET'] }],
      isCompatible: null,
      noOutputData: null,
      isSource: null,
      desc: null,
      needCache: false,
      state: 'INITED',
      nodeIcon: 'sx-tree-node__mining-icon icon-16 sx-icon-Append-ID-columns',
      expand: null,
      extended: null,
      nodeDefine: null,
      x: Number(sink.x || 0) + 120,
      y: Number(sink.y || 0),
    };
    graph.nodes.push(node);
    graph.links.push({
      from: sink.id,
      to: node.id,
      inputPortId: sink.outputs[0].id,
      outputPortId: node.inputs[0].id,
    });
    changed = true;
  }

  const saved = changed ? await saveEtlGraph(processDag, graph) : processDag;
  safeOutput({
    ok: true,
    changed,
    flowId: saved.id || processDag.id,
    flowName: saved.name || processDag.name,
    nodeId: node.id,
    column: columnName,
  });
}

function safeOutput(value) {
  writeFileSync(1, `${JSON.stringify(value)}\n`);
}

// ---- Playwright fallback (UI-only operations) ----
async function loadPlaywright() {
  try { return await import('playwright'); } catch (bareImportError) {
    const fallback = join(homedir(), '.local/share/omp-playwright/node_modules/playwright/index.mjs');
    try { return await import(pathToFileURL(fallback).href); }
    catch (fallbackError) {
      throw new Error(`Playwright unavailable: ${bareImportError.message}; ${fallbackError.message}`);
    }
  }
}

async function connect() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 10_000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error('No Chrome context found');
  return { browser, context };
}

function workspacePage(context) {
  return context.pages().find((page) => page.url().includes('/smartbi/vision/index.jsp'));
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
//   smartbi.mjs setup --cred-file <path> --namespace <value> --naming prefix|suffix
function parseSetupArgs(argsList) {
  const options = {};
  for (let index = 0; index < argsList.length; index += 1) {
    const argument = argsList[index];
    if (argument === '--interactive') {
      options.interactive = true;
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`unexpected setup argument: ${argument}`);
    const value = argsList[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function normalizeNaming(mode, value) {
  if (mode !== 'prefix' && mode !== 'suffix') {
    throw new Error(`invalid naming mode: ${mode} (use prefix or suffix)`);
  }
  const normalized = String(value || '').replace(/[^\w.-]/g, '');
  if (!normalized) throw new Error('namespace value must not be empty');
  return { mode, value: normalized };
}

function validateCredentialsFile(path) {
  if (!existsSync(path)) throw new Error(`credentials file not found: ${path}`);
  const [account, password] = readFileSync(path, 'utf8').split(/\r?\n/);
  if (!account || !password) {
    throw new Error(`credentials file must contain account on line 1 and password on line 2: ${path}`);
  }
}

async function persistSetup(saved) {
  validateCredentialsFile(saved.credFile);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
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
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('setup cancelled'));
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
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function runInteractiveSetup() {
  const account = await promptLine('Smartbi login account');
  const password = await promptSecret('Smartbi login password (hidden)');
  if (!account || !password) throw new Error('account and password are required');

  const mode = await promptLine('Artifact naming mode (prefix or suffix)', NAMING_MODE);
  const suggested = mode === 'suffix' ? '_TEAM' : 'TEAM_';
  const naming = normalizeNaming(mode, await promptLine('Namespace marker', suggested));
  const credentialsPath = join(homedir(), '.config', 'smartbi-platform', 'credentials.txt');
  const { writeFileSync, mkdirSync, chmodSync } = await import('node:fs');
  mkdirSync(dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, `${account}\n${password}\n`, { mode: 0o600 });
  chmodSync(credentialsPath, 0o600);
  await persistSetup({ credFile: credentialsPath, naming });
}

async function cmdSetup(argsList) {
  const options = parseSetupArgs(argsList);
  if (options.interactive || (argsList.length === 0 && process.stdin.isTTY && process.stdout.isTTY)) {
    await runInteractiveSetup();
    return;
  }

  const current = { credFile: CRED_FILE, naming: { mode: NAMING_MODE, value: NAMESPACE } };
  if (!options['cred-file'] && !options.namespace && !options.naming) {
    safeOutput({
      action: 'setup_needed',
      message: 'First-run setup: configure login account/password and prefix or suffix naming.',
      current,
      configFile: CONFIG_FILE,
      commands: [
        'node scripts/smartbi.mjs setup --interactive',
        'node scripts/smartbi.mjs setup --cred-file /path/to/credentials.txt --namespace TEAM_ --naming prefix',
        'node scripts/smartbi.mjs setup --cred-file /path/to/credentials.txt --namespace _TEAM --naming suffix',
      ],
    });
    return;
  }

  const saved = {
    credFile: options['cred-file'] || CONFIG.credFile || current.credFile,
    naming: normalizeNaming(
      options.naming || CONFIG.naming?.mode || current.naming.mode,
      options.namespace || CONFIG.naming?.value || current.naming.value,
    ),
  };
  await persistSetup(saved);
}

async function cmdConfig() {
  safeOutput({
    configFile: CONFIG_FILE,
    credFile: CRED_FILE,
    naming: { mode: NAMING_MODE, value: NAMESPACE },
    example: applyNamespace('survey_demo'),
    alreadyNamespacedExample: applyNamespace(
      NAMING_MODE === 'suffix' ? `survey_demo${NAMESPACE}` : `${NAMESPACE}survey_demo`,
    ),
    envOverrides: ['SMARTBI_CONFIG_FILE', 'SMARTBI_CRED_FILE', 'SMARTBI_NAMESPACE', 'SMARTBI_NAMING'],
  });
}

// ---- main ----
const [,, command, ...args] = process.argv;
try {
  switch (command) {
    case 'login': await cmdLogin(); break;
    case 'health': await cmdHealth(); break;
    case 'invoke': await cmdInvoke(args[0], args[1], args[2]); break;
    case 'api-get': await cmdApiGet(args[0]); break;
    case 'api-post': await cmdApiPost(args[0], args[1]); break;
    case 'plain-get': await cmdPlainGet(args[0]); break;
    case 'plain-post': await cmdPlainPost(args[0], args[1]); break;
    case 'model-get': await cmdModelGet(args[0]); break;
    case 'model-create': await cmdModelCreate(args[0], args[1], args[2], args[3], args[4], args[5]); break;
    case 'model-clone': await cmdModelClone(args[0], args[1], args[2], args[3]); break;
    case 'analysis-get': await cmdAnalysisGet(args[0]); break;
    case 'analysis-create': await cmdAnalysisCreate(args[0], args[1], args[2], args[3], args[4], args[5]); break;
    case 'analysis-run': await cmdAnalysisRun(args[0]); break;
    case 'analysis-clone': await cmdAnalysisClone(args[0], args[1], args[2], args[3]); break;
    case 'dashboard-get': await cmdDashboardGet(args[0]); break;
    case 'dashboard-create': await cmdDashboardCreate(args[0], args[1], args[2], args[3], args[4], args[5]); break;
    case 'dashboard-clone': await cmdDashboardClone(args[0], args[1], args[2], args[3]); break;
    case 'aichat-query': await cmdAichat(args[0], args.slice(1).join(' ')); break;
    case 'aichat-report': await cmdAichat(args[0], args.slice(1).join(' '), { report: true }); break;
    case 'aichat-export': await cmdAichat(args[0], args.slice(2).join(' '), { report: true, outputPath: args[1] }); break;
    case 'aichat-graph-list': await cmdAichatGraphList(args.join(' ')); break;
    case 'aichat-graph-fields': await cmdAichatGraphFields(args[0]); break;
    case 'aichat-graph-status': await cmdAichatGraphStatus(args[0]); break;
    case 'aichat-graph-build': await cmdAichatGraphBuild(args[0], args[1]); break;
    case 'agent-get': await cmdAgentGet(args[0]); break;
    case 'agent-create': await cmdAgentCreate(args[0], args[1], args[2], args[3], args[4]); break;
    case 'agent-run': await cmdAgentRun(args[0], args.slice(1).join(' ')); break;
    case 'agent-deploy': await cmdAgentDeploy(args[0]); break;
    case 'tree': await cmdTree(args[0]); break;
    case 'folder-create': await cmdFolderCreate(args[0], args[1], args.slice(2).join(' ')); break;
    case 'resource-delete': await cmdResourceDelete(args[0], args[1]); break;
    case 'upload': await cmdUploadArgs(args); break;
    case 'etl-create': await cmdEtlCreate(args[0], args[1], args[2], args[3], args[4], args[5]); break;
    case 'etl-node-list': await cmdEtlNodeList(args.join(' ')); break;
    case 'etl-insert': await cmdEtlInsert(args[0], args[1], args[2], args[3]); break;
    case 'etl-get': await cmdEtlGet(args[0]); break;
    case 'etl-run': await cmdEtlRun(args[0]); break;
    case 'etl-row-number': await cmdEtlRowNumber(args[0], args[1]); break;
    case 'nav': await cmdNav(args[0]); break;
    case 'ui-open': await cmdUiOpen(args[0]); break;
    case 'ui-dashboard-check': await cmdUiDashboardCheck(args[0]); break;
    case 'setup': await cmdSetup(args); break;
    case 'config': await cmdConfig(); break;
    case 'manuals': safeOutput({
      quickStart: 'https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=111897106',
      competition: 'https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168628225',
      higherEducation: 'https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168628227',
      financialCollection: 'https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168629240',
      orderRiskWarning: 'https://wiki.smartbi.com.cn/pages/viewpage.action?pageId=168629228',
    }); break;
    default:
      throw new Error(`Unknown command: ${command}\nusage: smartbi.mjs <setup|login|health|config|invoke|api-get|api-post|plain-get|plain-post|tree|folder-create|resource-delete|upload|etl-node-list|etl-create|etl-insert|etl-get|etl-run|etl-row-number|model-get|model-create|model-clone|analysis-get|analysis-create|analysis-run|analysis-clone|dashboard-get|dashboard-create|dashboard-clone|aichat-graph-list|aichat-graph-fields|aichat-graph-status|aichat-graph-build|aichat-query|aichat-report|aichat-export|agent-get|agent-create|agent-run|agent-deploy|nav|ui-open|ui-dashboard-check|manuals> ...`);
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exit(1);
}
