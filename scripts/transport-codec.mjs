import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const CACHE_SCHEMA_VERSION = 1;
const ALGORITHMS = ['SF1', 'SF2', 'SF3'];

export const FALLBACK_CODE_ARRAY = Object.freeze([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 80, 0, 0, 0, 47, 0, 110, 65, 69, 115, 43, 0, 102, 113, 37,
  55, 49, 117, 78, 75, 74, 77, 57, 39, 109, 123, 0, 0, 0, 0, 0,
  0, 79, 86, 116, 84, 97, 120, 72, 114, 99, 118, 108, 56, 70, 51, 111,
  76, 89, 106, 87, 42, 122, 90, 33, 66, 41, 85, 93, 0, 91, 0, 121,
  0, 40, 126, 105, 104, 112, 95, 45, 73, 82, 46, 71, 83, 100, 54, 119,
  53, 48, 52, 68, 107, 81, 103, 98, 67, 50, 88, 58, 0, 0, 101, 0,
]);

const FALLBACK_HEX = Object.freeze({
  prefix: '0x',
  suffix: 'x9',
  charCodes: Object.freeze([
    33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
    58, 59, 60, 61, 62, 63, 64, 91, 92, 93, 94, 95, 96, 120, 123,
    124, 125, 126,
  ]),
});

const BUNDLES = Object.freeze({
  handler: 'vision/js/freequery/common/codeutil/CodeHandler.js',
  replace: 'vision/js/freequery/common/codeutil/ReplaceCoder.js',
  hexadecimal: 'vision/js/freequery/common/codeutil/HexadecimalCoder.js',
  reserve: 'vision/js/freequery/common/codeutil/ReserveCoder.js',
});

function extractNumericArray(source, property) {
  const pattern = new RegExp(`(?:this\\.)?${property}\\s*=\\s*\\[([^\\]]+)\\]`);
  const match = String(source).match(pattern);
  if (!match) throw new Error(`cannot locate ${property} in frontend bundle`);
  const values = match[1].split(',').map((token) => {
    const value = token.trim();
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(value)) {
      throw new Error(`${property} contains a non-numeric token`);
    }
    return Number(value);
  });
  if (values.length === 0) throw new Error(`${property} is empty`);
  return values;
}

export function parseReplaceCoderSource(source) {
  return extractNumericArray(source, 'codeArray');
}

export function parseHexadecimalCoderSource(source) {
  const text = String(source);
  const prefix = text.match(/(?:this\.)?PRFIX_CHAR\s*=\s*["']([^"']+)["']/)?.[1];
  const suffix = text.match(/(?:this\.)?SUFFIX_CHAR\s*=\s*["']([^"']+)["']/)?.[1];
  if (!prefix || !suffix) throw new Error('cannot locate hexadecimal coder delimiters');
  const charCodes = extractNumericArray(text, 'CHAR_CODE_LIST');
  validateHexConfig({ prefix, suffix, charCodes });
  return { prefix, suffix, charCodes };
}

function validateCodeArray(codeArray) {
  if (!Array.isArray(codeArray) || codeArray.length < 127 || codeArray.length > 65536) {
    throw new Error('ReplaceCoder codeArray has an invalid length');
  }
  let mapped = 0;
  const targets = new Set();
  for (let index = 0; index < codeArray.length; index += 1) {
    const target = codeArray[index];
    if (!Number.isInteger(target) || target < 0 || target > 65535) {
      throw new Error(`ReplaceCoder codeArray has an invalid value at ${index}`);
    }
    if (target === 0) continue;
    mapped += 1;
    if (target >= codeArray.length || codeArray[target] === 0) {
      throw new Error(`ReplaceCoder mapping leaves its active domain at ${index}`);
    }
    if (targets.has(target)) {
      throw new Error(`ReplaceCoder mapping has a duplicate target at ${index}`);
    }
    targets.add(target);
  }
  if (mapped < 60) throw new Error('ReplaceCoder codeArray is implausibly sparse');
  return mapped;
}

function validateHexConfig(hex) {
  if (!hex || typeof hex.prefix !== 'string' || typeof hex.suffix !== 'string') {
    throw new Error('HexadecimalCoder delimiters are invalid');
  }
  if (!hex.prefix || !hex.suffix || hex.prefix === hex.suffix) {
    throw new Error('HexadecimalCoder delimiters are ambiguous');
  }
  if (!Array.isArray(hex.charCodes) || hex.charCodes.length === 0) {
    throw new Error('HexadecimalCoder character list is invalid');
  }
  const unique = new Set();
  for (const value of hex.charCodes) {
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
      throw new Error('HexadecimalCoder character list contains an invalid value');
    }
    unique.add(value);
  }
  if (unique.size !== hex.charCodes.length) {
    throw new Error('HexadecimalCoder character list contains duplicates');
  }
}

function buildReplaceCodec(codeArray) {
  const entryCount = validateCodeArray(codeArray);
  const encodeMap = new Map();
  const decodeMap = new Map();
  for (let index = 0; index < codeArray.length; index += 1) {
    const target = codeArray[index];
    if (!target) continue;
    const source = String.fromCharCode(index);
    const encoded = String.fromCharCode(target);
    encodeMap.set(source, encoded);
    decodeMap.set(source, encoded);
  }
  decodeMap.set('/', '/');
  decodeMap.set('%', '%');
  const encode = (data) => [...String(data)]
    .map((character) => encodeMap.get(character) || character)
    .join('');
  const decode = (data) => [...String(data)]
    .map((character) => decodeMap.get(character) || character)
    .join('');
  const sample = 'Class+method+[{"field":"value_123"}]';
  if (encode(sample) === sample || decode(sample) === sample) {
    throw new Error('ReplaceCoder mapping does not transform the validation sample');
  }
  return { encode, decode, entryCount };
}

function buildHexCodec(replaceCodec, hex) {
  validateHexConfig(hex);
  const specialToHex = new Map();
  const hexToSpecial = new Map();
  for (const codePoint of hex.charCodes) {
    const character = String.fromCharCode(codePoint);
    const encoded = `${hex.prefix}${codePoint.toString(16)}${hex.suffix}`;
    specialToHex.set(character, encoded);
    hexToSpecial.set(encoded, character);
  }
  const encodeHex = (data) => [...String(data)]
    .map((character) => specialToHex.get(character) || character)
    .join('');
  const decodeHex = (data) => {
    const source = String(data);
    const output = [];
    let cursor = 0;
    while (cursor < source.length) {
      const begin = source.indexOf(hex.prefix, cursor);
      if (begin < 0) {
        output.push(source.slice(cursor));
        break;
      }
      output.push(source.slice(cursor, begin));
      const end = source.indexOf(hex.suffix, begin + hex.prefix.length);
      if (end < 0) {
        output.push(source.slice(begin));
        break;
      }
      const token = source.slice(begin, end + hex.suffix.length);
      output.push(hexToSpecial.get(token) || token);
      cursor = end + hex.suffix.length;
    }
    return output.join('');
  };
  return {
    encode: (data) => encodeHex(replaceCodec.encode(data)),
    decode: (data) => replaceCodec.decode(decodeHex(data)),
  };
}

function buildAlgorithms(codeArray, hex) {
  const replace = buildReplaceCodec(codeArray);
  const hexadecimal = buildHexCodec(replace, hex);
  const identity = { encode: (data) => String(data), decode: (data) => String(data) };
  return {
    entryCount: replace.entryCount,
    adapters: new Map([
      ['SF1', Object.freeze({ algorithm: 'SF1', encode: replace.encode, decode: replace.decode })],
      ['SF2', Object.freeze({ algorithm: 'SF2', encode: hexadecimal.encode, decode: hexadecimal.decode })],
      ['SF3', Object.freeze({ algorithm: 'SF3', encode: identity.encode, decode: identity.decode })],
    ]),
  };
}

function sourceCompletedAt(source) {
  return String(source).match(/FileCompleted\s+([^\r\n*]+)/)?.[1]?.trim() || null;
}

function hashSources(sources) {
  const hash = createHash('sha256');
  for (const name of Object.keys(sources).sort()) {
    hash.update(name);
    hash.update('\0');
    hash.update(sources[name]);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function conciseError(error) {
  return String(error?.message || error).replace(/\s+/g, ' ').slice(0, 240);
}

export function createTransportCodec({
  baseUrl,
  cacheFile,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
}) {
  if (!baseUrl || !cacheFile || typeof fetchImpl !== 'function') {
    throw new Error('createTransportCodec requires baseUrl, cacheFile, and fetch');
  }

  let prepared = false;
  let selectedAlgorithm = null;
  let source = 'uninitialized';
  let fingerprint = null;
  let discoveredAt = null;
  let completedAt = {};
  let warning = null;
  let cacheError = null;
  let cacheRecord = null;
  let codeArray = [...FALLBACK_CODE_ARRAY];
  let hex = { ...FALLBACK_HEX, charCodes: [...FALLBACK_HEX.charCodes] };
  let built = buildAlgorithms(codeArray, hex);

  function applyDefinition(definition, sourceName) {
    codeArray = [...definition.codeArray];
    hex = {
      prefix: definition.hex.prefix,
      suffix: definition.hex.suffix,
      charCodes: [...definition.hex.charCodes],
    };
    built = buildAlgorithms(codeArray, hex);
    source = sourceName;
    fingerprint = definition.fingerprint || null;
    discoveredAt = definition.discoveredAt || null;
    completedAt = definition.completedAt || {};
    selectedAlgorithm = ALGORITHMS.includes(definition.algorithm)
      ? definition.algorithm
      : null;
  }

  function readCache() {
    if (!existsSync(cacheFile)) return null;
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (cached.schemaVersion !== CACHE_SCHEMA_VERSION || cached.baseUrl !== baseUrl) return null;
      validateCodeArray(cached.codeArray);
      validateHexConfig(cached.hex);
      return cached;
    } catch (error) {
      cacheError = conciseError(error);
      return null;
    }
  }

  function persistCache() {
    if (!cacheRecord) return;
    const record = {
      ...cacheRecord,
      algorithm: selectedAlgorithm,
      verifiedAt: selectedAlgorithm ? now() : cacheRecord.verifiedAt || null,
    };
    const temporary = `${cacheFile}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, cacheFile);
      cacheRecord = record;
      cacheError = null;
    } catch (error) {
      cacheError = conciseError(error);
      try { rmSync(temporary, { force: true }); } catch {}
    }
  }

  async function fetchBundle(path, force) {
    const response = await fetchImpl(`${baseUrl}/gbk.jsp?name=${path}&l=zh_CN`, {
      headers: {
        Accept: 'text/javascript, application/javascript, text/plain, */*',
        'Cache-Control': force ? 'no-cache' : 'max-age=0',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`frontend bundle returned HTTP ${response.status}`);
    return response.text();
  }

  async function discoverLive(force) {
    const entries = await Promise.all(Object.entries(BUNDLES).map(async ([name, path]) => (
      [name, await fetchBundle(path, force)]
    )));
    const sources = Object.fromEntries(entries);
    if (!/ReplaceCoder/.test(sources.handler) || !/getSystemCoder/.test(sources.handler)) {
      throw new Error('CodeHandler bundle does not expose the expected coder registry');
    }
    if (!/return\s+data/.test(sources.reserve)) {
      throw new Error('ReserveCoder bundle is not the expected identity coder');
    }
    const liveCodeArray = parseReplaceCoderSource(sources.replace);
    const liveHex = parseHexadecimalCoderSource(sources.hexadecimal);
    validateCodeArray(liveCodeArray);
    validateHexConfig(liveHex);
    const definition = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      baseUrl,
      fingerprint: hashSources(sources),
      discoveredAt: now(),
      completedAt: Object.fromEntries(
        Object.entries(sources).map(([name, text]) => [name, sourceCompletedAt(text)]),
      ),
      codeArray: liveCodeArray,
      hex: liveHex,
      algorithm: null,
      verifiedAt: null,
    };
    return definition;
  }

  async function prepare({ force = false } = {}) {
    if (prepared && !force) return status();
    const cached = readCache();
    warning = null;
    try {
      const live = await discoverLive(force);
      if (cached?.fingerprint === live.fingerprint) {
        cacheRecord = { ...cached, discoveredAt: live.discoveredAt, completedAt: live.completedAt };
        applyDefinition(cacheRecord, 'cache-validated');
      } else {
        cacheRecord = live;
        applyDefinition(live, 'live');
      }
      persistCache();
    } catch (error) {
      warning = conciseError(error);
      if (cached) {
        cacheRecord = cached;
        applyDefinition(cached, 'cache-offline');
      } else {
        cacheRecord = null;
        applyDefinition({
          codeArray: FALLBACK_CODE_ARRAY,
          hex: FALLBACK_HEX,
          fingerprint: null,
          discoveredAt: null,
          completedAt: {},
          algorithm: null,
        }, 'fallback');
      }
    }
    prepared = true;
    return status();
  }

  async function negotiate(probe) {
    await prepare();
    if (selectedAlgorithm) {
      const cachedAdapter = built.adapters.get(selectedAlgorithm);
      try {
        if (await probe(cachedAdapter)) return status();
      } catch {}
      selectedAlgorithm = null;
    }
    const failures = [];
    for (const name of ALGORITHMS) {
      const adapter = built.adapters.get(name);
      try {
        if (await probe(adapter)) {
          selectedAlgorithm = name;
          persistCache();
          return status();
        }
        failures.push(`${name}: rejected`);
      } catch (error) {
        failures.push(`${name}: ${conciseError(error)}`);
      }
    }
    throw new Error(`unable to negotiate Smartbi transport coder (${failures.join('; ')})`);
  }

  async function refresh() {
    prepared = false;
    selectedAlgorithm = null;
    await prepare({ force: true });
    return status();
  }

  function currentAdapter() {
    if (!prepared) throw new Error('transport codec is not prepared');
    if (!selectedAlgorithm) throw new Error('transport codec is not negotiated');
    return built.adapters.get(selectedAlgorithm);
  }

  function status() {
    return {
      source,
      algorithm: selectedAlgorithm,
      fingerprint,
      entryCount: built.entryCount,
      discoveredAt,
      completedAt,
      cacheFile,
      warning,
      cacheError,
    };
  }

  return Object.freeze({
    prepare,
    negotiate,
    refresh,
    encode: (data) => currentAdapter().encode(data),
    decode: (data) => currentAdapter().decode(data),
    status,
  });
}
