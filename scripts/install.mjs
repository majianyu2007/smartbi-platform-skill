#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_NODE_MAJOR = 20;
export const RECOMMENDED_PLAYWRIGHT_VERSION = '1.62.1';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(SCRIPT_DIR);

export function parseNodeMajor(version) {
  const match = String(version || '').replace(/^v/, '').match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function playwrightLocation(source, root) {
  const normalizedRoot = resolve(root);
  return {
    source,
    root: normalizedRoot,
    modulePath: join(normalizedRoot, 'index.mjs'),
    packageFile: join(normalizedRoot, 'package.json'),
  };
}

export function playwrightCandidates({
  env = process.env,
  homeDir = homedir(),
  skillDir = SKILL_DIR,
} = {}) {
  const candidates = [];
  if (env.SMARTBI_PLAYWRIGHT_PATH) {
    const explicit = resolve(env.SMARTBI_PLAYWRIGHT_PATH);
    if (/\.(?:mjs|js)$/i.test(explicit)) {
      candidates.push({
        source: 'environment',
        root: dirname(explicit),
        modulePath: explicit,
        packageFile: join(dirname(explicit), 'package.json'),
      });
    } else {
      candidates.push(playwrightLocation('environment', explicit));
    }
  }
  candidates.push(
    playwrightLocation('skill-local', join(skillDir, 'node_modules', 'playwright')),
    playwrightLocation(
      'smartbi-managed',
      join(homeDir, '.local', 'share', 'smartbi-platform', 'playwright', 'node_modules', 'playwright'),
    ),
    playwrightLocation(
      'omp-bundled',
      join(homeDir, '.local', 'share', 'omp-playwright', 'node_modules', 'playwright'),
    ),
  );
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.modulePath)) return false;
    seen.add(candidate.modulePath);
    return true;
  });
}

function readPackageVersion(packageFile) {
  try {
    return JSON.parse(readFileSync(packageFile, 'utf8')).version || null;
  } catch {
    return null;
  }
}

export async function resolvePlaywright(options = {}) {
  const attempts = [];
  for (const candidate of playwrightCandidates(options)) {
    if (!existsSync(candidate.modulePath)) {
      attempts.push(`${candidate.source}: not found`);
      continue;
    }
    try {
      const module = await import(pathToFileURL(candidate.modulePath).href);
      return {
        found: true,
        source: candidate.source,
        modulePath: candidate.modulePath,
        version: readPackageVersion(candidate.packageFile),
        module,
        attempts,
      };
    } catch (error) {
      attempts.push(`${candidate.source}: ${error.code || error.message}`);
    }
  }
  try {
    const module = await import('playwright');
    return {
      found: true,
      source: 'node-resolution',
      modulePath: 'playwright',
      version: null,
      module,
      attempts,
    };
  } catch (error) {
    attempts.push(`node-resolution: ${error.code || error.message}`);
  }
  return {
    found: false,
    source: null,
    modulePath: null,
    version: null,
    module: null,
    attempts,
  };
}

export async function loadPlaywright(options = {}) {
  const resolved = await resolvePlaywright(options);
  if (!resolved.found) {
    throw new Error(
      `Playwright unavailable. Run scripts/install.sh --install-playwright. Attempts: ${resolved.attempts.join('; ')}`,
    );
  }
  return resolved.module;
}

function commandVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout || result.stderr).trim() || null;
}

export function browserCandidates({
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
} = {}) {
  const explicit = env.SMARTBI_BROWSER_PATH ? [resolve(env.SMARTBI_BROWSER_PATH)] : [];
  if (platform === 'darwin') {
    return [
      ...explicit,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(homeDir, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  if (platform === 'win32') {
    return [
      ...explicit,
      env.PROGRAMFILES && join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env['PROGRAMFILES(X86)'] && join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter(Boolean);
  }
  return [
    ...explicit,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
}

async function inspectCdp(cdpUrl) {
  try {
    const response = await fetch(`${String(cdpUrl).replace(/\/$/, '')}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return { reachable: false, status: response.status, browser: null };
    const payload = await response.json();
    return {
      reachable: Boolean(payload.webSocketDebuggerUrl),
      status: response.status,
      browser: payload.Browser || null,
    };
  } catch {
    return { reachable: false, status: null, browser: null };
  }
}

export async function inspectEnvironment({
  env = process.env,
  homeDir = homedir(),
  skillDir = SKILL_DIR,
  platform = process.platform,
  arch = process.arch,
  cdpUrl = env.SMARTBI_CDP_URL || 'http://127.0.0.1:9222',
} = {}) {
  const major = parseNodeMajor(process.versions.node);
  const playwright = await resolvePlaywright({ env, homeDir, skillDir });
  let bundledBrowser = null;
  if (playwright.found) {
    try {
      const executablePath = playwright.module.chromium.executablePath();
      bundledBrowser = {
        path: executablePath,
        present: Boolean(executablePath && existsSync(executablePath)),
      };
    } catch {
      bundledBrowser = { path: null, present: false };
    }
  }
  const systemBrowserPath = browserCandidates({ env, homeDir, platform }).find(
    (candidate) => candidate && existsSync(candidate),
  ) || null;
  const cdp = await inspectCdp(cdpUrl);
  const npmVersion = commandVersion('npm');
  const nodeSupported = major !== null && major >= MIN_NODE_MAJOR;
  const browserAvailable = cdp.reachable || Boolean(systemBrowserPath) || Boolean(bundledBrowser?.present);
  const browserFallbackReady = nodeSupported && playwright.found && browserAvailable;
  const recommendations = [];
  if (!nodeSupported) {
    recommendations.push(`Install Node.js ${MIN_NODE_MAJOR}+ before using the Skill.`);
  }
  if (!playwright.found) {
    recommendations.push('Playwright is optional for API-only use; install it for UI fallback with scripts/install.sh --install-playwright.');
  }
  if (playwright.found && !browserAvailable) {
    recommendations.push('Install Chrome/Chromium, or run scripts/install.sh --install-playwright --with-browser.');
  }
  if (playwright.found && browserAvailable && !cdp.reachable) {
    recommendations.push('Browser fallback is installed but no CDP browser is running; start headed Chrome only when a UI fallback is needed.');
  }

  return {
    platform: { os: platform, arch },
    node: {
      required: true,
      minimumMajor: MIN_NODE_MAJOR,
      version: process.versions.node,
      executable: process.execPath,
      supported: nodeSupported,
      needsInstall: !nodeSupported,
    },
    npm: {
      version: npmVersion,
      available: Boolean(npmVersion),
      requiredOnlyForInstall: true,
    },
    playwright: {
      requiredForCore: false,
      requiredForBrowserFallback: true,
      found: playwright.found,
      source: playwright.source,
      version: playwright.version,
      modulePath: playwright.modulePath,
      needsInstall: !playwright.found,
    },
    browser: {
      systemPath: systemBrowserPath,
      bundled: bundledBrowser,
      available: browserAvailable,
      needsInstall: !browserAvailable,
    },
    cdp: { url: cdpUrl, ...cdp },
    readiness: {
      apiCore: nodeSupported,
      browserFallback: browserFallbackReady,
    },
    recommendations,
  };
}

export async function installManagedPlaywright({
  env = process.env,
  homeDir = homedir(),
  skillDir = SKILL_DIR,
  withBrowser = false,
} = {}) {
  const existing = await resolvePlaywright({ env, homeDir, skillDir });
  if (existing.found) {
    let browserPresent = browserCandidates({ env, homeDir, platform: process.platform })
      .some((candidate) => candidate && existsSync(candidate));
    try {
      browserPresent ||= existsSync(existing.module.chromium.executablePath());
    } catch {}
    if (!withBrowser || browserPresent) {
      return {
        action: 'reused',
        source: existing.source,
        version: existing.version,
        modulePath: existing.modulePath,
        withBrowser: browserPresent,
      };
    }
  }
  const npmVersion = commandVersion('npm');
  if (!npmVersion) throw new Error('npm is required to install Playwright');
  const installRoot = join(homeDir, '.local', 'share', 'smartbi-platform', 'playwright');
  mkdirSync(installRoot, { recursive: true });
  const install = spawnSync('npm', [
    'install',
    '--prefix', installRoot,
    '--no-save',
    '--no-audit',
    '--no-fund',
    `playwright@${RECOMMENDED_PLAYWRIGHT_VERSION}`,
  ], {
    encoding: 'utf8',
    env: {
      ...env,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    },
  });
  if (install.status !== 0) {
    throw new Error(`Playwright installation failed: ${String(install.stderr || install.stdout).trim().slice(0, 500)}`);
  }
  if (withBrowser) {
    const cli = join(installRoot, 'node_modules', 'playwright', 'cli.js');
    const browserInstall = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
      encoding: 'utf8',
      env,
    });
    if (browserInstall.status !== 0) {
      throw new Error(`Chromium installation failed: ${String(browserInstall.stderr || browserInstall.stdout).trim().slice(0, 500)}`);
    }
  }
  const installed = await resolvePlaywright({
    env: {
      ...env,
      SMARTBI_PLAYWRIGHT_PATH: join(installRoot, 'node_modules', 'playwright'),
    },
    homeDir,
    skillDir,
  });
  if (!installed.found) throw new Error('Playwright install completed but the module could not be loaded');
  return {
    action: 'installed',
    source: installed.source,
    version: installed.version,
    modulePath: installed.modulePath,
    withBrowser,
  };
}

function formatReport(report) {
  const lines = [
    'Smartbi Skill environment',
    `Node.js: ${report.node.version} (${report.node.supported ? 'supported' : `requires ${report.node.minimumMajor}+`})`,
    `npm: ${report.npm.available ? report.npm.version : 'not found'}`,
    `Playwright: ${report.playwright.found ? `${report.playwright.version || 'version unknown'} via ${report.playwright.source}` : 'not found (optional for API-only use)'}`,
    `Browser: ${report.browser.available ? report.browser.systemPath || report.browser.bundled?.path || 'running over CDP' : 'not found'}`,
    `CDP: ${report.cdp.reachable ? `reachable (${report.cdp.browser || 'browser'})` : 'not running'}`,
    `API core ready: ${report.readiness.apiCore ? 'yes' : 'no'}`,
    `Browser fallback ready: ${report.readiness.browserFallback ? 'yes' : 'no'}`,
  ];
  if (report.recommendations.length > 0) {
    lines.push('Recommendations:', ...report.recommendations.map((item) => `- ${item}`));
  }
  return `${lines.join('\n')}\n`;
}

function printHelp() {
  process.stdout.write(`Usage: scripts/install.sh [options]\n\nOptions:\n  --check               inspect without installing (default)\n  --install-playwright  install Playwright only when none is reusable\n  --with-browser        also install Playwright Chromium\n  --require-browser     fail if the UI fallback is not ready\n  --json                emit machine-readable JSON\n  --help                show this help\n`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const known = new Set([
    '--check', '--install-playwright', '--with-browser', '--require-browser', '--json', '--help',
  ]);
  const unknown = [...args].filter((argument) => !known.has(argument));
  if (unknown.length > 0) throw new Error(`unknown installer option: ${unknown.join(', ')}`);
  if (args.has('--help')) {
    printHelp();
    return;
  }
  let installation = null;
  if (args.has('--install-playwright') || args.has('--with-browser')) {
    installation = await installManagedPlaywright({ withBrowser: args.has('--with-browser') });
  }
  const report = await inspectEnvironment();
  const output = installation ? { installation, ...report } : report;
  if (args.has('--json')) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(formatReport(output));
  if (!report.readiness.apiCore || (args.has('--require-browser') && !report.readiness.browserFallback)) {
    process.exitCode = 1;
  }
}

const invokedAsScript = process.argv[1]
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}
