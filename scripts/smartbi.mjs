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
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, '..');
const CONFIG_FILE = join(SKILL_DIR, 'config.json');

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
  || '/Users/user/Desktop/Smartbi/smartbi-example-credentials.txt';

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

// ---- ReplaceCoder table (verbatim from vision/js/freequery/common/codeutil/ReplaceCoder.js) ----
const CODE_ARRAY = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,80,0,0,0,47,0,110,65,69,115,43,0,102,113,37,55,49,117,78,75,74,77,57,39,109,123,0,0,0,0,0,0,79,86,116,84,97,120,72,114,99,118,108,56,70,51,111,76,89,106,87,42,122,90,33,66,41,85,93,0,91,0,121,0,40,126,105,104,112,95,45,73,82,46,71,83,100,54,119,53,48,52,68,107,81,103,98,67,50,88,58,0,0,101,0];
const ENCODE_MAP = {};
const DECODE_MAP = {};
for (let i = 0; i < CODE_ARRAY.length; i++) {
  const c = CODE_ARRAY[i];
  if (c) {
    const ic = String.fromCharCode(i);
    DECODE_MAP[ic] = ENCODE_MAP[ic] = String.fromCharCode(c);
  }
}
DECODE_MAP['/'] = '/';
DECODE_MAP['%'] = '%';

const replaceEncode = (d) => String(d).split('').map((ch) => ENCODE_MAP[ch] || ch).join('');
const replaceDecode = (d) => String(d).split('').map((ch) => DECODE_MAP[ch] || ch).join('');

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
  const decoded = replaceDecode(text);
  let json;
  try { json = JSON.parse(decoded); } catch { json = { retCode: 'PARSE_ERROR', result: decoded.slice(0, 400) }; }
  return { status: res.status, ...json };
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
  const { user } = loadCredentials();
  const login = await rmi('UserService', 'login', [user, loadCredentials().pass]);
  safeOutput({ state: login.retCode === 0 ? 'authenticated' : 'failed', retCode: login.retCode, result: login.result, user });
}

async function cmdHealth() {
  const login = await ensureSession();
  const probe = await rmi('AIextRemoteService', 'getCurrentUserName', [], 15000);
  safeOutput({ state: probe.retCode === 0 ? 'workspace' : 'auth_required', retCode: probe.retCode, login: login.retCode, user: probe.result || null });
}

async function cmdInvoke(className, methodName, paramsJson) {
  const params = paramsJson ? JSON.parse(paramsJson) : [];
  const ret = await rmi(className, methodName, params);
  safeOutput(ret);
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

// Walk the import tree to locate the personal acquisition space under 可导入数据库.
async function locatePersonalFolder() {
  // DS.input -> SCHEMA -> 数据采集空间 -> <personal node>
  const dsKids = await rmi('CatalogService', 'getChildElements', ['DS.input']);
  const schema = (dsKids.result || []).find((n) => n.type === 'SCHEMA');
  if (!schema) throw new Error('可导入数据库 schema not found');
  const schemaKids = await rmi('CatalogService', 'getChildElements', [schema.id]);
  const space = (schemaKids.result || []).find((n) => n.alias === '数据采集空间');
  if (!space) throw new Error('数据采集空间 not found');
  const spaceKids = await rmi('CatalogService', 'getChildElements', [space.id]);
  // our personal node is the one matching the logged-in user's account number
  const me = (spaceKids.result || []).find((n) => /^\d{6,}$/.test(n.alias || ''));
  if (!me) throw new Error('personal acquisition folder not found');
  return { dsId: 'DS.input', schemaId: schema.name, catalog: schema.name, folderId: me.id, folderAlias: me.alias };
}

// Upload a local CSV/TXT/XLSX and import as a new table named <namespace><name>
// (namespace configurable: prefix or suffix). Returns table info after import.
async function cmdUpload(filePath, tableName, { previewRows = 30, sheetIndex = 0 } = {}) {
  const stats = (await import('node:fs')).statSync(filePath);
  if (!stats.isFile()) throw new Error(`not a file: ${filePath}`);
  const base = tableName || filePath.split('/').pop().replace(/\.[^.]+$/, '');
  const table = applyNamespace(base);
  if (table.length > MAX_TABLE_NAME) {
    console.warn(`table name truncated to ${table.length} chars: ${table}`);
  }

  await ensureSession();
  const folder = await locatePersonalFolder();

  // 1. upload (multipart)
  const { Blob } = await import('node:buffer');
  const form = new FormData();
  form.append('action', 'UPLOAD_FILE');
  form.append('file', new Blob([readFileSync(filePath)]), filePath.split('/').pop());
  const up = await fetch(`${BASE_URL}/DataPackageServlet`, {
    method: 'POST',
    headers: { Cookie: cookieHeader() },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const upJson = await up.json();
  if (upJson.retCode !== 0) throw new Error(`upload failed: ${JSON.stringify(upJson)}`);
  const { clientId, sheetNames } = upJson.result;
  console.warn(`uploaded: clientId=${clientId} sheets=${JSON.stringify(sheetNames)}`);

  // 2. preview to learn column types
  const prev = await fetch(`${BASE_URL}/DataPackageServlet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Cookie: cookieHeader() },
    body: `action=GET_PREVIEW_DATA&clientId=${clientId}&previewRows=${previewRows}&sheetIndex=${sheetIndex}`,
  });
  const prevJson = await prev.json();
  if (prevJson.retCode !== 0) throw new Error(`preview failed: ${JSON.stringify(prevJson)}`);
  const { fieldTypeList, fieldNameList, fieldAliasList, rowCount } = prevJson.result;

  // 3. import
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
    fieldAliasList: fieldAliasList || fieldNameList,
    fieldNameList,
    importType: 'REPLACE',
    keepUniqueData: true,
    fileName: filePath.split('/').pop(),
    primaryKeyIndexs: [],
  }];
  const ins = await fetch(`${BASE_URL}/DataPackageServlet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Cookie: cookieHeader() },
    body: `action=INSERT_DATA&clientId=${clientId}&settings=${encodeURIComponent(JSON.stringify(settings))}`,
  });
  const insJson = await ins.json();
  if (insJson.retCode !== 0) throw new Error(`insert failed: ${JSON.stringify(insJson)}`);

  // 4. poll import status
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await rmi('DataPackageModule', 'getImportStatus', [clientId]);
    if (st.retCode === 0 && st.result) {
      const r = st.result;
      if (r.retCode === 0) {
        safeOutput({ ok: true, table, rows: r.rowCount ?? rowCount, clientId, folder: folder.folderAlias });
        return;
      }
      if (r.retCode !== undefined && r.retCode !== 0) {
        throw new Error(`import status error: ${JSON.stringify(r)}`);
      }
    }
  }
  safeOutput({ ok: true, table, clientId, note: 'import submitted, status not confirmed within 5min' });
}

function safeOutput(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
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
// First-run guided configuration: credentials file + naming preference.
// Usage: smartbi.mjs setup [--cred-file <path>] [--namespace <value>] [--naming prefix|suffix]
async function cmdSetup(argsList) {
  const opts = {};
  for (let i = 0; i < argsList.length; i += 2) {
    if (argsList[i].startsWith('--')) opts[argsList[i].slice(2)] = argsList[i + 1];
  }
  const current = { credFile: CRED_FILE, naming: { mode: NAMING_MODE, value: NAMESPACE } };

  if (!opts['cred-file'] && !opts['namespace'] && !opts['naming']) {
    // Interactive guidance: print current state + instructions (safe output).
    safeOutput({
      action: 'setup_needed',
      message: 'First-run setup: configure credentials and naming preference.',
      current,
      configFile: CONFIG_FILE,
      commands: [
        'node scripts/smartbi.mjs setup --cred-file /path/to/credentials.txt',
        'node scripts/smartbi.mjs setup --namespace TEAM_ --naming prefix',
        'node scripts/smartbi.mjs setup --namespace _MYTEAM --naming suffix',
      ],
    });
    return;
  }

  const saved = {
    credFile: opts['cred-file'] || CONFIG.credFile || current.credFile,
    naming: {
      mode: opts['naming'] || CONFIG.naming?.mode || current.naming.mode,
      value: opts['namespace'] || CONFIG.naming?.value || current.naming.value,
    },
  };
  if (saved.naming.mode !== 'prefix' && saved.naming.mode !== 'suffix') {
    throw new Error(`invalid naming mode: ${saved.naming.mode} (use prefix or suffix)`);
  }
  // sanitize namespace: keep only safe chars
  saved.naming.value = saved.naming.value.replace(/[^\w.-]/g, '');
  if (!saved.naming.value) throw new Error('namespace value must not be empty');

  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2) + '\n');
  safeOutput({
    action: 'setup_done',
    message: 'Configuration saved. Environment variables (SMARTBI_CRED_FILE, SMARTBI_NAMESPACE, SMARTBI_NAMING) override this file.',
    configFile: CONFIG_FILE,
    saved,
    next: 'node scripts/smartbi.mjs health',
  });
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
    envOverrides: ['SMARTBI_CRED_FILE', 'SMARTBI_NAMESPACE', 'SMARTBI_NAMING'],
  });
}

// ---- main ----
const [,, command, ...args] = process.argv;
try {
  switch (command) {
    case 'login': await cmdLogin(); break;
    case 'health': await cmdHealth(); break;
    case 'invoke': await cmdInvoke(args[0], args[1], args[2]); break;
    case 'tree': await cmdTree(args[0]); break;
    case 'upload': await cmdUpload(args[0], args[1]); break;
    case 'nav': await cmdNav(args[0]); break;
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
      throw new Error(`Unknown command: ${command}\nusage: smartbi.mjs <setup|login|health|config|invoke|tree|upload|nav|manuals> ...`);
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exit(1);
}
