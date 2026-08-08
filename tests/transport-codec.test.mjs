import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FALLBACK_CODE_ARRAY,
  createTransportCodec,
  parseHexadecimalCoderSource,
  parseReplaceCoderSource,
} from '../scripts/transport-codec.mjs';

const BASE_URL = 'https://smartbi.example.test/smartbi/vision';
const HANDLER = `
  jsloader.resolveMany(["freequery.common.codeutil.ReplaceCoder"]);
  CodeHandler.prototype.getSystemCoder=function(){ return this.codersMap.SF1; };
  //FileCompleted 2026-08-09 12:00:00
`;
const REPLACE = `
  ReplaceCoder.prototype.init=function(){this.codeArray=${JSON.stringify(FALLBACK_CODE_ARRAY)};};
  //FileCompleted 2026-08-09 12:00:01
`;
const HEXADECIMAL = `
  HexadecimalCoder.prototype.init=function(){
    this.PRFIX_CHAR="0x";
    this.SUFFIX_CHAR="x9";
    this.CHAR_CODE_LIST=[33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,58,59,60,61,62,63,64,91,92,93,94,95,96,120,123,124,125,126];
  };
  //FileCompleted 2026-08-09 12:00:02
`;
const RESERVE = `
  ReserveCoder.prototype.encode=function(data){return data;};
  //FileCompleted 2026-08-09 12:00:03
`;

function temporaryCache() {
  const root = mkdtempSync(join(tmpdir(), 'smartbi-codec-'));
  return {
    file: join(root, 'transport-codec.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function bundleFetch(overrides = {}) {
  const sources = {
    'vision/js/freequery/common/codeutil/CodeHandler.js': HANDLER,
    'vision/js/freequery/common/codeutil/ReplaceCoder.js': REPLACE,
    'vision/js/freequery/common/codeutil/HexadecimalCoder.js': HEXADECIMAL,
    'vision/js/freequery/common/codeutil/ReserveCoder.js': RESERVE,
    ...overrides,
  };
  return async (url) => {
    const name = new URL(url).searchParams.get('name');
    if (!(name in sources)) return new Response('missing', { status: 404 });
    return new Response(sources[name], {
      status: 200,
      headers: { 'Content-Type': 'text/javascript' },
    });
  };
}

const offlineFetch = async () => {
  throw new Error('offline fixture');
};

test('parses live ReplaceCoder and HexadecimalCoder definitions', () => {
  assert.deepEqual(parseReplaceCoderSource(REPLACE), [...FALLBACK_CODE_ARRAY]);
  assert.deepEqual(parseHexadecimalCoderSource(HEXADECIMAL), {
    prefix: '0x',
    suffix: 'x9',
    charCodes: [
      33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
      58, 59, 60, 61, 62, 63, 64, 91, 92, 93, 94, 95, 96, 120, 123,
      124, 125, 126,
    ],
  });
  assert.throws(() => parseReplaceCoderSource('this.codeArray=[1,"bad"]'));
  assert.throws(() => parseHexadecimalCoderSource('this.CHAR_CODE_LIST=[33]'));
});

test('discovers, fingerprints, negotiates, and privately caches a live coder', async () => {
  const cache = temporaryCache();
  try {
    const codec = createTransportCodec({
      baseUrl: BASE_URL,
      cacheFile: cache.file,
      fetchImpl: bundleFetch(),
      now: () => '2026-08-09T12:00:00.000Z',
    });
    const prepared = await codec.prepare();
    assert.equal(prepared.source, 'live');
    assert.match(prepared.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(prepared.entryCount, 78);

    const attempts = [];
    await codec.negotiate(async (adapter) => {
      attempts.push(adapter.algorithm);
      return adapter.algorithm === 'SF2';
    });
    assert.deepEqual(attempts, ['SF1', 'SF2']);
    assert.equal(codec.status().algorithm, 'SF2');
    assert.notEqual(codec.encode('Class+method'), 'Class+method');

    const cached = JSON.parse(readFileSync(cache.file, 'utf8'));
    assert.equal(cached.baseUrl, BASE_URL);
    assert.equal(cached.algorithm, 'SF2');
    assert.equal(cached.fingerprint, prepared.fingerprint);
    assert.equal(statSync(cache.file).mode & 0o777, 0o600);
  } finally {
    cache.cleanup();
  }
});

test('revalidates a same-version cache and uses it when discovery is offline', async () => {
  const cache = temporaryCache();
  try {
    const live = createTransportCodec({
      baseUrl: BASE_URL,
      cacheFile: cache.file,
      fetchImpl: bundleFetch(),
    });
    await live.prepare();
    await live.negotiate(async (adapter) => adapter.algorithm === 'SF1');

    const validated = createTransportCodec({
      baseUrl: BASE_URL,
      cacheFile: cache.file,
      fetchImpl: bundleFetch(),
    });
    assert.equal((await validated.prepare()).source, 'cache-validated');
    const validatedAttempts = [];
    await validated.negotiate(async (adapter) => {
      validatedAttempts.push(adapter.algorithm);
      return adapter.algorithm === 'SF1';
    });
    assert.deepEqual(validatedAttempts, ['SF1']);

    const offline = createTransportCodec({
      baseUrl: BASE_URL,
      cacheFile: cache.file,
      fetchImpl: offlineFetch,
    });
    const offlineStatus = await offline.prepare();
    assert.equal(offlineStatus.source, 'cache-offline');
    assert.match(offlineStatus.warning, /offline fixture/);
    const offlineAttempts = [];
    await offline.negotiate(async (adapter) => {
      offlineAttempts.push(adapter.algorithm);
      return adapter.algorithm === 'SF1';
    });
    assert.deepEqual(offlineAttempts, ['SF1']);
  } finally {
    cache.cleanup();
  }
});

test('uses the fixed fallback only without a same-tenant cache', async () => {
  const cache = temporaryCache();
  try {
    const codec = createTransportCodec({
      baseUrl: BASE_URL,
      cacheFile: cache.file,
      fetchImpl: offlineFetch,
    });
    const prepared = await codec.prepare();
    assert.equal(prepared.source, 'fallback');
    assert.equal(prepared.fingerprint, null);
    await codec.negotiate(async (adapter) => adapter.algorithm === 'SF1');
    assert.equal(codec.status().algorithm, 'SF1');
  } finally {
    cache.cleanup();
  }
});

test('refresh replaces a cache when frontend resource content changes', async () => {
  const cache = temporaryCache();
  try {
    let revision = 'revision-a';
    const fetchImpl = async (url, options) => {
      const base = bundleFetch({
        'vision/js/freequery/common/codeutil/CodeHandler.js': `${HANDLER}\n//${revision}`,
      });
      return base(url, options);
    };
    const codec = createTransportCodec({ baseUrl: BASE_URL, cacheFile: cache.file, fetchImpl });
    const first = await codec.prepare();
    await codec.negotiate(async (adapter) => adapter.algorithm === 'SF1');
    revision = 'revision-b';
    const second = await codec.refresh();
    assert.equal(second.source, 'live');
    assert.notEqual(second.fingerprint, first.fingerprint);
    assert.equal(second.algorithm, null);
  } finally {
    cache.cleanup();
  }
});
