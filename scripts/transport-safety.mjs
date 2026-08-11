const CDP_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CONFIG_STRING_FIELDS = [
  'baseUrl',
  'cdpUrl',
  'credFile',
  'codecCacheFile',
];

export function normalizeVisionBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('invalid Smartbi Vision base URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Smartbi Vision base URL must use HTTP(S) without embedded credentials');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  if (!parsed.pathname.endsWith('/vision')) {
    throw new Error('Smartbi Vision base URL must end with /vision');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function assertCredentialTransport(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl || ''));
  } catch {
    throw new Error('credential-backed login requires a valid HTTPS Smartbi base URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('credential-backed login requires HTTPS without embedded credentials');
  }
}

export function parseConfigJson(text) {
  let config;
  try {
    config = JSON.parse(String(text));
  } catch {
    throw new Error('Smartbi configuration is not valid JSON');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Smartbi configuration root must be a JSON object');
  }
  for (const field of CONFIG_STRING_FIELDS) {
    if (config[field] !== undefined && typeof config[field] !== 'string') {
      throw new Error(`Smartbi configuration field ${field} must be a string`);
    }
    if (typeof config[field] === 'string' && !config[field].trim()) {
      throw new Error(`Smartbi configuration field ${field} must not be empty`);
    }
  }
  if (config.naming !== undefined) {
    if (!config.naming || typeof config.naming !== 'object' || Array.isArray(config.naming)) {
      throw new Error('Smartbi configuration field naming must be an object');
    }
    for (const field of ['mode', 'value']) {
      if (typeof config.naming[field] !== 'string') {
        throw new Error(`Smartbi configuration naming.${field} must be a string`);
      }
      if (!config.naming[field].trim()) {
        throw new Error(`Smartbi configuration naming.${field} must not be empty`);
      }
    }
  }
  if (config.platformProfile !== undefined && config.platformProfile !== null) {
    if (typeof config.platformProfile !== 'object' || Array.isArray(config.platformProfile)) {
      throw new Error('Smartbi configuration field platformProfile must be an object or null');
    }
    if (
      typeof config.platformProfile.id !== 'string'
      || !config.platformProfile.id.trim()
    ) {
      throw new Error('Smartbi configuration platformProfile.id must be a non-empty string');
    }
    for (const field of ['id', 'schoolName']) {
      if (
        config.platformProfile[field] !== undefined
        && config.platformProfile[field] !== null
        && typeof config.platformProfile[field] !== 'string'
      ) {
        throw new Error(`Smartbi configuration platformProfile.${field} must be a string`);
      }
    }
    if (
      typeof config.platformProfile.schoolName === 'string'
      && !config.platformProfile.schoolName.trim()
    ) {
      throw new Error('Smartbi configuration platformProfile.schoolName must not be empty');
    }
  }
  return config;
}

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase());
}

export function normalizeCdpUrl(value, { allowRemote = false } = {}) {
  const source = String(value || '');
  if (/[\u0000-\u001f\u007f]/.test(source)) throw new Error('invalid CDP URL');
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error('invalid CDP URL');
  }
  if (!CDP_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('CDP URL must use HTTP(S) or WS(S)');
  }
  if (parsed.username || parsed.password) {
    throw new Error('CDP URL must not contain embedded credentials');
  }
  if (parsed.hash) throw new Error('CDP URL must not contain a fragment');
  const loopback = isLoopbackHostname(parsed.hostname);
  if (!loopback && !allowRemote) {
    throw new Error('remote CDP requires SMARTBI_ALLOW_REMOTE_CDP=1');
  }
  if (!loopback && !['https:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('remote CDP requires HTTPS or WSS');
  }
  return parsed.toString();
}

export function redactCdpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!CDP_PROTOCOLS.has(parsed.protocol)) return '[invalid CDP URL]';
    return parsed.origin;
  } catch {
    return '[invalid CDP URL]';
  }
}

export function assertCredentialFileMetadata(metadata, { effectiveUid } = {}) {
  if (!metadata || typeof metadata.isFile !== 'function' || typeof metadata.isSymbolicLink !== 'function') {
    throw new Error('credentials file metadata is unavailable');
  }
  if (metadata.isSymbolicLink()) throw new Error('credentials file must not be a symbolic link');
  if (!metadata.isFile()) throw new Error('credentials file must be a regular file');
  if (!Number.isInteger(effectiveUid)) {
    throw new Error('credentials file ownership cannot be verified on this platform');
  }
  if (metadata.uid !== effectiveUid) {
    throw new Error('credentials file must be owned by the current user');
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error('credentials file must use mode 0600');
  }
}

export function assertLoginSucceeded(response) {
  if (response?.retCode !== 0 || response.result !== true) {
    throw new Error('Smartbi login was rejected');
  }
  return response;
}

export function assertSessionProbeSucceeded(response) {
  if (
    response?.retCode !== 0
    || typeof response.result !== 'string'
    || !response.result.trim()
  ) {
    throw new Error('Smartbi session verification failed');
  }
  return response;
}

export function nextSmartbixResendState(
  { resendCount = 0, encodeTransport = true } = {},
  { maxResends = 4 } = {},
) {
  if (!Number.isInteger(resendCount) || resendCount < 0) {
    throw new Error('invalid Smartbix resend state');
  }
  if (!Number.isInteger(maxResends) || maxResends < 1) {
    throw new Error('invalid Smartbix resend budget');
  }
  if (resendCount >= maxResends) {
    throw new Error('Smartbix RESEND retry budget exhausted');
  }
  const nextCount = resendCount + 1;
  return {
    resendCount: nextCount,
    // Preserve the prior encoded retries, then spend the final shared retry in raw mode.
    encodeTransport: encodeTransport && nextCount < maxResends,
  };
}

function profileId(profile) {
  return typeof profile === 'string' ? profile : profile?.id;
}

export function assertCompetitionGenericAccess(profile, target = {}) {
  if (profileId(profile) !== 'competition-2026') return;
  if (target.kind === 'nav') {
    if (/agent/i.test(String(target.moduleName || ''))) {
      throw new Error('competition-2026 prohibits Agent navigation');
    }
    return;
  }
  throw new Error('competition-2026 disables generic RMI and API replay');
}

function redactUrl(candidate) {
  try {
    const parsed = new URL(candidate);
    return parsed.origin;
  } catch {
    return '[REDACTED URL]';
  }
}

export function safeHttpError(kind, response, description = 'request failed') {
  const status = Number.isInteger(response?.status) ? response.status : 'unknown';
  let rawContentType = '';
  try {
    rawContentType = response?.headers?.get?.('content-type') || '';
  } catch {}
  const contentType = String(rawContentType || 'unknown')
    .split(';', 1)[0]
    .trim()
    .replace(/[^a-z\d!#$&^_.+\-/]/gi, '')
    .slice(0, 80);
  return new Error(
    `${String(kind || 'HTTP')} ${description} `
    + `(status ${status}; content-type ${contentType || 'unknown'})`,
  );
}

export async function readBoundedResponseText(
  response,
  { maxBytes, label = 'HTTP response' } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('response byte limit must be a positive safe integer');
  }
  const contentLength = response?.headers?.get?.('content-length');
  if (/^\d+$/.test(String(contentLength || '')) && Number(contentLength) > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {}
    throw new Error(`${label} exceeded the ${maxBytes}-byte limit`);
  }
  if (!response?.body) return '';
  if (typeof response.body.getReader !== 'function') {
    throw new Error(`${label} cannot be read with a bounded stream`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        throw new Error(`${label} exceeded the ${maxBytes}-byte limit`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

export function sanitizeErrorMessage(error, { maxLength = 500 } = {}) {
  let message = typeof error === 'string' ? error : error?.message;
  if (typeof message !== 'string' || !message.trim()) message = 'Smartbi operation failed';
  message = message
    .replace(/\b(Basic|Bearer)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]')
    .replace(
      /(["']?(?:account|authorization|cookie|pass(?:word)?|pwd|secret|token|username|userName)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (candidate) => redactUrl(candidate))
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  if (!message) message = 'Smartbi operation failed';
  if (message.length > maxLength) return `${message.slice(0, Math.max(0, maxLength - 1))}…`;
  return message;
}
