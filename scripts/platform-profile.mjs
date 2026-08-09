const PROFILE_IDS = new Set(['general', 'competition-2026']);
const COMPETITION_HOST = 'tiaozhanbei.cloud.smartbi.com.cn';
const DEFAULT_SCHOOL_NAME = '西北农林科技大学';

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
  const schoolName = cleanRequiredText(input.schoolName || DEFAULT_SCHOOL_NAME, 'school name');
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
  if (!profile || profile.id !== COMPETITION_2026_PROFILE_ID) return;
  const countKeys = new Set(['dataCount', 'count', 'total', 'fieldDataCount', 'rowCount']);
  const queue = [{ value: validation, depth: 0 }];
  let count = null;
  while (queue.length > 0 && count == null) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || depth > 3) continue;
    for (const [key, candidate] of Object.entries(value)) {
      if (countKeys.has(key) && (typeof candidate === 'number' || typeof candidate === 'string')) {
        const parsed = Number(candidate);
        if (Number.isFinite(parsed)) {
          count = parsed;
          break;
        }
      }
      if (candidate && typeof candidate === 'object') {
        queue.push({ value: candidate, depth: depth + 1 });
      }
    }
  }
  if (count != null && count > profile.aichatTrainingLimit) {
    throw new Error(
      `AIChat training count ${count} exceeds competition limit ${profile.aichatTrainingLimit}`,
    );
  }
}

export function assertProfileAllowsAgent(profile) {
  if (profile?.forbidAgent) {
    throw new Error(`Agent is prohibited by platform profile ${profile.id}; use AIChat instead`);
  }
}

export function assertCompetitionUploadSource(profile, sourceUrl) {
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
  if (
    host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error('competition public dataset source URL must not use a local or private host');
  }
  return parsed.toString();
}
