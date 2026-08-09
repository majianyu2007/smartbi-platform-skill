import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PROFILE_IDS = new Set(['general', 'competition-2026']);
const COMPETITION_HOST = 'tiaozhanbei.cloud.smartbi.com.cn';

export const COMPETITION_2026_PROFILE_ID = 'competition-2026';

function cleanRequiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} must not be empty`);
  if (text.length > 100) throw new Error(`${label} must not exceed 100 characters`);
  return text;
}

export function normalizePlatformProfile(value, baseUrl) {
  if (value == null || value === '' || value === 'general') return null;
  const input = typeof value === 'string' ? { id: value } : value;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('platform profile must be a profile id or object');
  }
  const id = cleanRequiredText(input.id, 'platform profile id');
  if (!PROFILE_IDS.has(id)) throw new Error(`unsupported platform profile: ${id}`);
  if (id === 'general') return null;

  const url = new URL(baseUrl);
  if (url.hostname !== COMPETITION_HOST) {
    throw new Error(`platform profile ${id} requires host ${COMPETITION_HOST}`);
  }
  const schoolName = cleanRequiredText(input.schoolName, 'school name');
  return Object.freeze({
    id,
    schoolName,
    resourceFolderName: `${schoolName}-2026“揭榜挂帅”挑战杯擂台赛`,
    tenantHost: COMPETITION_HOST,
    dataImportLocation: 'personal-acquisition-folder',
    aichatTrainingLimit: 10_000,
    forbidAgent: true,
    forbidThirdPartyData: true,
  });
}

export function isCompetitionFolder(profile, resource) {
  if (!profile || profile.id !== COMPETITION_2026_PROFILE_ID || !resource) return false;
  return resource.name === profile.resourceFolderName || resource.alias === profile.resourceFolderName;
}

export function assertCompetitionTrainingCount(profile, validation) {
  if (!profile || profile.id !== COMPETITION_2026_PROFILE_ID) return null;
  const countKeys = new Set(['dataCount', 'count', 'total', 'fieldDataCount', 'rowCount']);
  const queue = [{ value: validation, depth: 0 }];
  const counts = [];
  while (queue.length > 0) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || depth > 3) continue;
    for (const [key, candidate] of Object.entries(value)) {
      if (countKeys.has(key) && (typeof candidate === 'number' || typeof candidate === 'string')) {
        const parsed = Number(candidate);
        if (Number.isFinite(parsed) && parsed >= 0) counts.push(parsed);
      }
      if (candidate && typeof candidate === 'object') {
        queue.push({ value: candidate, depth: depth + 1 });
      }
    }
  }
  if (counts.length === 0) {
    throw new Error('AIChat training validation did not report a usable record count');
  }
  const count = Math.max(...counts);
  if (count > profile.aichatTrainingLimit) {
    throw new Error(
      `AIChat training count ${count} exceeds competition limit ${profile.aichatTrainingLimit}`,
    );
  }
  return count;
}

export function assertCompetitionCatalogDestination(
  profile,
  {
    personalRootId,
    parent,
    path = [],
    personalChildren = [],
  },
) {
  if (!profile || profile.id !== COMPETITION_2026_PROFILE_ID) return null;
  const competitionRoot = personalChildren.find((node) => isCompetitionFolder(profile, node));
  if (!competitionRoot?.id) {
    throw new Error(
      `competition resource folder is missing; run competition-home --create first: ${profile.resourceFolderName}`,
    );
  }
  if (competitionRoot.id === personalRootId) {
    throw new Error('competition resource folder must be a direct child of the personal workspace');
  }
  if (
    parent?.id !== competitionRoot.id
    && !path.some((node) => node?.id === competitionRoot.id)
  ) {
    throw new Error(
      `competition resource destination must be the competition folder or its descendant: ${parent?.id || '(missing)'}`,
    );
  }
  return competitionRoot;
}

export function assertCompetitionSameCandidateParent(profile, {
  parentId,
  resourceId,
  children = [],
  label = 'source resource',
}) {
  if (!profile || profile.id !== COMPETITION_2026_PROFILE_ID) return;
  if (!parentId || !resourceId || !children.some((child) => child?.id === resourceId)) {
    throw new Error(
      `competition ${label} must be a direct child of the same candidate folder: ${parentId}`,
    );
  }
}
const NON_MEANINGFUL_ETL_NODES = new Set([
  'JDBC_DATASOURCE',
  'JDBC_DATATARGER_OVERWRITE',
  'DATAPREPARE_ROW_NUMBER',
  'SMARTBI_DATASET_OUTPUT',
]);

const SUPPORTED_COMPETITION_TRANSFORM = /(?:FILTER|MAPPING|DERIVE|COLUMN|DEDUP|DISTINCT|CLEAN|SELECT|AGGREGAT|GROUP|PIVOT|SORT|ORDER|REPLACE|FILL|CAST|TYPE|RENAME|META|SAMPLE)/;

function parseConfiguredValue(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function hasSubstantiveValue(value) {
  const parsed = parseConfiguredValue(value);
  if (parsed === null || parsed === undefined || parsed === '') return false;
  if (Array.isArray(parsed)) return parsed.length > 0 && parsed.some(hasSubstantiveValue);
  if (typeof parsed === 'object') {
    return Object.values(parsed).some(hasSubstantiveValue);
  }
  if (typeof parsed === 'string') {
    return !/^(?:true|false|1\s*=\s*1|\*)$/i.test(parsed.trim());
  }
  return true;
}

function isMeaningfulCompetitionTransform(node) {
  const nodeType = String(node?.name || node?.type || '').toUpperCase();
  if (!SUPPORTED_COMPETITION_TRANSFORM.test(nodeType)) return false;
  const configuredKeys = Array.isArray(node?.smartbiCliConfiguredKeys)
    ? node.smartbiCliConfiguredKeys
    : [];
  if (configuredKeys.length === 0) return false;
  const configs = new Map((node.configs || []).map((config) => [config.name, config.value]));
  if (!configuredKeys.every((key) => configs.has(key) && hasSubstantiveValue(configs.get(key)))) {
    return false;
  }
  if (nodeType === 'DATAPREPARE_SAMPLE') {
    const fraction = Number(parseConfiguredValue(configs.get('fraction')));
    return Number.isFinite(fraction) && fraction > 0 && fraction < 1;
  }
  return true;
}

export function assertCompetitionEtlGraph(profile, graph) {
  if (!profile || profile.id !== COMPETITION_2026_PROFILE_ID) return;
  const transforms = (graph?.nodes || []).filter((node) => (
    !NON_MEANINGFUL_ETL_NODES.has(node?.name)
    && !NON_MEANINGFUL_ETL_NODES.has(node?.type)
  ));
  const unsupported = transforms.filter((node) => !isMeaningfulCompetitionTransform(node));
  if (transforms.length === 0 || unsupported.length > 0) {
    throw new Error(
      'competition ETL requires at least one supported, explicitly configured material transformation; '
      + `invalid nodes: ${unsupported.map((node) => node?.alias || node?.name || node?.id).join(',') || 'none'}`,
    );
  }
}

export function assertCompetitionUnionAllowed(profile) {
  if (profile?.id === COMPETITION_2026_PROFILE_ID) {
    throw new Error('competition candidate datasets must not be unioned or appended');
  }
}

export function assertProfileAllowsAgent(profile) {
  if (profile?.forbidAgent) {
    throw new Error(`Agent is prohibited by platform profile ${profile.id}; use AIChat instead`);
  }
}

function isNonPublicAddressLiteral(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (version === 6) {
    if (host.startsWith('::ffff:')) {
      return isNonPublicAddressLiteral(host.slice('::ffff:'.length));
    }
    return host === '::'
      || host === '::1'
      || /^f[cd]/.test(host)
      || /^fe[89ab]/.test(host);
  }
  if (
    !host.includes('.')
    || /\.(?:local|internal|home|lan|localdomain|test|invalid|example)$/.test(host)
  ) return true;
  return false;
}

export async function assertCompetitionUploadSource(
  profile,
  sourceUrl,
  { lookup = dnsLookup } = {},
) {
  if (!profile?.forbidThirdPartyData) return null;
  const text = cleanRequiredText(sourceUrl, 'competition public dataset source URL');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('competition public dataset source URL must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('competition public dataset source URL must be a public HTTP(S) URL');
  }
  const host = parsed.hostname.toLowerCase();
  if (isNonPublicAddressLiteral(host)) {
    throw new Error('competition public dataset source URL must not use a local or private host');
  }
  if (!isIP(host)) {
    let records;
    try {
      records = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new Error('competition public dataset source hostname could not be resolved');
    }
    if (
      !Array.isArray(records)
      || records.length === 0
      || records.some((record) => isNonPublicAddressLiteral(record?.address))
    ) {
      throw new Error('competition public dataset source hostname must resolve only to public addresses');
    }
  }
  return parsed.toString();
}
