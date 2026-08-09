import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCompetitionCatalogDestination,
  assertCompetitionEtlGraph,
  assertCompetitionSameCandidateParent,
  assertCompetitionTrainingCount,
  assertCompetitionUnionAllowed,
  assertCompetitionUploadSource,
  assertProfileAllowsAgent,
  COMPETITION_2026_PROFILE_ID,
  isCompetitionFolder,
  normalizePlatformProfile,
} from '../scripts/platform-profile.mjs';

const competitionBaseUrl = 'https://tiaozhanbei.cloud.smartbi.com.cn/smartbi/vision';

test('platform profile is opt-in even on the competition tenant', () => {
  assert.equal(normalizePlatformProfile(null, competitionBaseUrl), null);
  assert.equal(normalizePlatformProfile({ id: 'general' }, competitionBaseUrl), null);
});

test('competition profile derives the official resource folder and limits', () => {
  const profile = normalizePlatformProfile({
    id: COMPETITION_2026_PROFILE_ID,
    schoolName: '示例大学',
  }, competitionBaseUrl);

  assert.equal(profile.resourceFolderName, '示例大学-2026“揭榜挂帅”挑战杯擂台赛');
  assert.equal(profile.dataImportLocation, 'personal-acquisition-folder');
  assert.equal(profile.aichatTrainingLimit, 10000);
  assert.equal(profile.forbidAgent, true);
  assert.equal(profile.forbidThirdPartyData, true);
  assert.equal(isCompetitionFolder(profile, { name: profile.resourceFolderName }), true);
  assert.equal(isCompetitionFolder(profile, { alias: `TEAM_${profile.resourceFolderName}` }), false);
});

test('competition profile rejects another tenant host', () => {
  assert.throws(
    () => normalizePlatformProfile(
      { id: COMPETITION_2026_PROFILE_ID, schoolName: '示例大学' },
      'https://portable.example.test/smartbi/vision',
    ),
    /requires host tiaozhanbei\.cloud\.smartbi\.com\.cn/,
  );
});

test('competition profile requires an explicit school name', () => {
  assert.throws(
    () => normalizePlatformProfile(COMPETITION_2026_PROFILE_ID, competitionBaseUrl),
    /school name must not be empty/,
  );
});

test('competition training guard accepts counts through the limit', () => {
  const profile = normalizePlatformProfile({
    id: COMPETITION_2026_PROFILE_ID,
    schoolName: '示例大学',
  }, competitionBaseUrl);

  assert.doesNotThrow(() => assertCompetitionTrainingCount(profile, { dataCount: 10000 }));
  assert.doesNotThrow(() => assertCompetitionTrainingCount(profile, { result: { total: 9999 } }));
  assert.throws(
    () => assertCompetitionTrainingCount(profile, { rowCount: 10001 }),
    /exceeds competition limit 10000/,
  );
});

test('competition training guard fails closed and checks every reported count', () => {
  const profile = normalizePlatformProfile({
    id: COMPETITION_2026_PROFILE_ID,
    schoolName: '示例大学',
  }, competitionBaseUrl);
  assert.throws(
    () => assertCompetitionTrainingCount(profile, { valid: true }),
    /did not report a usable record count/,
  );
  assert.throws(
    () => assertCompetitionTrainingCount(profile, {
      count: 10,
      nested: { rowCount: 10_001 },
    }),
    /training count 10001 exceeds competition limit 10000/,
  );
});


test('competition profile blocks Agent and requires a publicly resolved upload source', async () => {
  const profile = normalizePlatformProfile({
    id: COMPETITION_2026_PROFILE_ID,
    schoolName: '示例大学',
  }, competitionBaseUrl);
  assert.throws(() => assertProfileAllowsAgent(profile), /Agent is prohibited/);
  assert.doesNotThrow(() => assertProfileAllowsAgent(null));
  await assert.rejects(
    () => assertCompetitionUploadSource(profile, null),
    /dataset source URL must not be empty/,
  );
  await assert.rejects(
    () => assertCompetitionUploadSource(profile, 'http://127.0.0.1/data.csv'),
    /must not use a local or private host/,
  );
  assert.equal(
    await assertCompetitionUploadSource(
      profile,
      'https://www.cdc.gov/healthyyouth/data/yrbs/',
      { lookup: async () => [{ address: '8.8.8.8' }] },
    ),
    'https://www.cdc.gov/healthyyouth/data/yrbs/',
  );
});

test('competition source guard rejects private literals and private DNS answers', async () => {
  const profile = normalizePlatformProfile({
    id: COMPETITION_2026_PROFILE_ID,
    schoolName: '示例大学',
  }, competitionBaseUrl);
  for (const source of [
    'http://169.254.1.2/data.csv',
    'http://[fc00::1]/data.csv',
    'http://[fe80::1]/data.csv',
    'http://intranet.local/data.csv',
  ]) {
    await assert.rejects(
      () => assertCompetitionUploadSource(profile, source),
      /must not use a local or private host/,
    );
  }
  await assert.rejects(
    () => assertCompetitionUploadSource(
      profile,
      'https://data.example.org/source.csv',
      { lookup: async () => [{ address: '10.0.0.8' }] },
    ),
    /must resolve only to public addresses/,
  );
  await assert.rejects(
    () => assertCompetitionUploadSource(
      profile,
      'https://data.example.org/source.csv',
      { lookup: async () => { throw new Error('not found'); } },
    ),
    /could not be resolved/,
  );
});

test('competition catalog destination accepts only the exact root or descendants', () => {
  const profile = normalizePlatformProfile({
    id: COMPETITION_2026_PROFILE_ID,
    schoolName: '示例大学',
  }, competitionBaseUrl);
  const competitionRoot = { id: 'competition', name: profile.resourceFolderName };
  assert.equal(
    assertCompetitionCatalogDestination(profile, {
      personalRootId: 'self',
      parent: competitionRoot,
      path: [{ id: 'self' }],
      personalChildren: [competitionRoot],
    }).id,
    'competition',
  );
  assert.doesNotThrow(() => assertCompetitionCatalogDestination(profile, {
    personalRootId: 'self',
    parent: { id: 'candidate', name: 'TEAM_candidate' },
    path: [{ id: 'self' }, competitionRoot],
    personalChildren: [competitionRoot],
  }));
  assert.throws(
    () => assertCompetitionCatalogDestination(profile, {
      personalRootId: 'self',
      parent: { id: 'sibling', name: 'TEAM_sibling' },
      path: [{ id: 'self' }],
      personalChildren: [competitionRoot],
    }),
    /must be the competition folder or its descendant/,
  );
});

test('competition artifacts must consume resources from the same candidate folder', () => {
  const profile = normalizePlatformProfile({
    id: COMPETITION_2026_PROFILE_ID,
    schoolName: '示例大学',
  }, competitionBaseUrl);
  assert.doesNotThrow(() => assertCompetitionSameCandidateParent(profile, {
    parentId: 'candidate-a',
    resourceId: 'model-a',
    children: [{ id: 'model-a' }],
    label: 'model',
  }));
  assert.throws(
    () => assertCompetitionSameCandidateParent(profile, {
      parentId: 'candidate-b',
      resourceId: 'model-a',
      children: [{ id: 'model-b' }],
      label: 'model',
    }),
    /direct child of the same candidate folder/,
  );
});

test('competition ETL rejects unions and non-material transformations', () => {
  const profile = normalizePlatformProfile({
    id: COMPETITION_2026_PROFILE_ID,
    schoolName: '示例大学',
  }, competitionBaseUrl);
  assert.throws(() => assertCompetitionUnionAllowed(profile), /must not be unioned/);
  assert.throws(
    () => assertCompetitionEtlGraph(profile, {
      nodes: [
        { name: 'JDBC_DATASOURCE' },
        { name: 'DATAPREPARE_ROW_NUMBER' },
        { type: 'JDBC_DATATARGER_OVERWRITE' },
      ],
    }),
    /supported, explicitly configured material transformation/,
  );
  assert.doesNotThrow(() => assertCompetitionEtlGraph(profile, {
    nodes: [
      { name: 'JDBC_DATASOURCE' },
      {
        name: 'DATAPREPARE_FILTERING_MAPPING_V3',
        smartbiCliConfiguredKeys: ['condition'],
        configs: [{ name: 'condition', value: 'age >= 18' }],
      },
      { type: 'JDBC_DATATARGER_OVERWRITE' },
    ],
  }));
  assert.throws(
    () => assertCompetitionEtlGraph(profile, {
      nodes: [{
        name: 'DATAPREPARE_SAMPLE',
        smartbiCliConfiguredKeys: ['fraction'],
        configs: [{ name: 'fraction', value: '1' }],
      }],
    }),
    /supported, explicitly configured material transformation/,
  );
  assert.throws(
    () => assertCompetitionEtlGraph(profile, {
      nodes: [{
        name: 'DATAPREPARE_CUSTOM_NOOP',
        smartbiCliConfiguredKeys: ['value'],
        configs: [{ name: 'value', value: 'anything' }],
      }],
    }),
    /supported, explicitly configured material transformation/,
  );
});