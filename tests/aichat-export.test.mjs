import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertPrivateAichatExportDestination,
  writePrivateAichatEnvelope,
} from '../scripts/aichat-export.mjs';
import { AICHAT_RESULT_ENVELOPE_FORMAT } from '../scripts/aichat-query.mjs';

function completedEnvelope(mode = 'report') {
  return {
    format: AICHAT_RESULT_ENVELOPE_FORMAT,
    mode,
    generation: {
      state: 'completed',
      transportCompleted: true,
      artifactPresent: true,
      generated: true,
    },
    validation: {
      validated: false,
      reconciliation: 'not-performed',
    },
    artifacts: {
      answer: 'generated, not validated',
      texts: [],
      tables: [],
      files: [],
    },
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'smartbi-aichat-export-'));
  chmodSync(root, 0o700);
  const skillDir = join(root, 'skill');
  mkdirSync(skillDir, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, skillDir };
}

test('writes a private envelope atomically, reopens it, and reports 0600', (t) => {
  const { root, skillDir } = fixture(t);
  const outputPath = join(root, 'report-envelope.json');
  const receipt = writePrivateAichatEnvelope({
    outputPath,
    envelope: completedEnvelope('report'),
    skillDir,
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.saved, true);
  assert.equal(receipt.reopened, true);
  assert.equal(receipt.mode, 'report');
  assert.equal(receipt.file, 'report-envelope.json');
  assert.equal(receipt.permissions, '0600');
  assert.equal((lstatSync(outputPath).mode & 0o777), 0o600);
  assert.equal(JSON.parse(readFileSync(outputPath, 'utf8')).validation.validated, false);
  assert.equal('path' in receipt, false);
});

test('never overwrites without exact path confirmation', (t) => {
  const { root, skillDir } = fixture(t);
  const outputPath = join(root, 'query-envelope.json');
  writePrivateAichatEnvelope({
    outputPath,
    envelope: completedEnvelope('query'),
    skillDir,
  });
  assert.throws(
    () => writePrivateAichatEnvelope({
      outputPath,
      envelope: completedEnvelope('query'),
      skillDir,
    }),
    /already exists/,
  );
  assert.throws(
    () => writePrivateAichatEnvelope({
      outputPath,
      envelope: completedEnvelope('query'),
      skillDir,
      overwrite: true,
      confirmPath: `${outputPath}.wrong`,
    }),
    /exact --confirm-path equality/,
  );
  const receipt = writePrivateAichatEnvelope({
    outputPath,
    envelope: completedEnvelope('query'),
    skillDir,
    overwrite: true,
    confirmPath: outputPath,
  });
  assert.equal(receipt.overwritten, true);
  assert.equal(receipt.mode, 'query');
});

test('rejects skill/repository destinations, public parents, and symlink files', (t) => {
  const { root, skillDir } = fixture(t);
  assert.throws(
    () => assertPrivateAichatExportDestination('relative.json', { skillDir }),
    /absolute private path/,
  );
  assert.throws(
    () => assertPrivateAichatExportDestination(join(skillDir, 'evidence.json'), { skillDir }),
    /inside the skill directory/,
  );

  const repository = join(root, 'repository');
  mkdirSync(repository, { mode: 0o700 });
  mkdirSync(join(repository, '.git'), { mode: 0o700 });
  assert.throws(
    () => assertPrivateAichatExportDestination(join(repository, 'evidence.json'), { skillDir }),
    /inside a repository/,
  );

  const publicParent = join(root, 'public');
  mkdirSync(publicParent, { mode: 0o755 });
  assert.throws(
    () => assertPrivateAichatExportDestination(join(publicParent, 'evidence.json'), { skillDir }),
    /must be private/,
  );

  const regular = join(root, 'regular.json');
  const link = join(root, 'link.json');
  writeFileSync(regular, '{}', { mode: 0o600 });
  symlinkSync(regular, link);
  assert.throws(
    () => assertPrivateAichatExportDestination(link, {
      skillDir,
      overwrite: true,
      confirmPath: link,
    }),
    /regular non-symlink file/,
  );
});

test('failed or empty generations are rejected before any path is written', (t) => {
  const { root, skillDir } = fixture(t);
  const outputPath = join(root, 'must-not-exist.json');
  const failed = completedEnvelope();
  failed.generation.generated = false;
  failed.generation.artifactPresent = false;
  assert.throws(
    () => writePrivateAichatEnvelope({ outputPath, envelope: failed, skillDir }),
    /refusing to export a failed or empty AIChat result/,
  );
  assert.equal(existsSync(outputPath), false);
  const unsupportedClaimPath = join(root, 'unsupported-validation.json');
  const unsupportedClaim = completedEnvelope();
  unsupportedClaim.validation = { validated: true, reconciliation: 'completed' };
  assert.throws(
    () => writePrivateAichatEnvelope({
      outputPath: unsupportedClaimPath,
      envelope: unsupportedClaim,
      skillDir,
    }),
    /unsupported AIChat validation or reconciliation claim/,
  );
  assert.equal(existsSync(unsupportedClaimPath), false);
  const existingPath = join(root, 'existing.json');
  writeFileSync(existingPath, 'keep', { mode: 0o600 });
  assert.throws(
    () => writePrivateAichatEnvelope({
      outputPath: existingPath,
      envelope: failed,
      skillDir,
      overwrite: true,
      confirmPath: existingPath,
    }),
    /refusing to export a failed or empty AIChat result/,
  );
  assert.equal(readFileSync(existingPath, 'utf8'), 'keep');
});
