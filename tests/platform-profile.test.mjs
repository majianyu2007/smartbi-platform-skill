import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCompetitionUploadSource,
  assertProfileAllowsAgent,
  COMPETITION_2026_PROFILE_ID,
  assertCompetitionTrainingCount,
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
    schoolName: '西北农林科技大学',
  }, competitionBaseUrl);

  assert.equal(profile.resourceFolderName, '西北农林科技大学-2026“揭榜挂帅”挑战杯擂台赛');
  assert.equal(profile.dataImportLocation, 'personal-acquisition-folder');
  assert.equal(profile.aichatTrainingLimit, 10000);
  assert.equal(profile.forbidAgent, true);
  assert.equal(profile.forbidThirdPartyData, true);
  assert.equal(isCompetitionFolder(profile, { name: profile.resourceFolderName }), true);
  assert.equal(isCompetitionFolder(profile, { alias: `MJY_${profile.resourceFolderName}` }), false);
});

test('competition profile rejects another tenant host', () => {
  assert.throws(
    () => normalizePlatformProfile(
      { id: COMPETITION_2026_PROFILE_ID, schoolName: '西北农林科技大学' },
      'https://portable.example.test/smartbi/vision',
    ),
    /requires host tiaozhanbei\.cloud\.smartbi\.com\.cn/,
  );
});

test('competition training guard accepts counts through the limit', () => {
  const profile = normalizePlatformProfile({
    id: COMPETITION_2026_PROFILE_ID,
    schoolName: '西北农林科技大学',
  }, competitionBaseUrl);

  assert.doesNotThrow(() => assertCompetitionTrainingCount(profile, { dataCount: 10000 }));
  assert.doesNotThrow(() => assertCompetitionTrainingCount(profile, { result: { total: 9999 } }));
  assert.throws(
    () => assertCompetitionTrainingCount(profile, { rowCount: 10001 }),
    /exceeds competition limit 10000/,
  );
});


test('competition profile blocks Agent and requires a public upload source', () => {
  const profile = normalizePlatformProfile({
    id: COMPETITION_2026_PROFILE_ID,
    schoolName: '西北农林科技大学',
  }, competitionBaseUrl);

  assert.throws(() => assertProfileAllowsAgent(profile), /Agent is prohibited/);
  assert.doesNotThrow(() => assertProfileAllowsAgent(null));
  assert.throws(
    () => assertCompetitionUploadSource(profile, null),
    /dataset source URL must not be empty/,
  );
  assert.throws(
    () => assertCompetitionUploadSource(profile, 'http://127.0.0.1/data.csv'),
    /must not use a local or private host/,
  );
  assert.equal(
    assertCompetitionUploadSource(profile, 'https://www.cdc.gov/healthyyouth/data/yrbs/'),
    'https://www.cdc.gov/healthyyouth/data/yrbs/',
  );
});