import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { AICHAT_RESULT_ENVELOPE_FORMAT } from './aichat-query.mjs';

const MAX_EXPORT_BYTES = 4 * 1024 * 1024;
const REPOSITORY_MARKERS = ['.git', '.hg', '.svn'];

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function repositoryRoot(start) {
  let current = start;
  while (true) {
    if (REPOSITORY_MARKERS.some((marker) => lstatIfPresent(join(current, marker)))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function assertRegularDestination(path, description) {
  const info = lstatIfPresent(path);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${description} must be a regular non-symlink file`);
  }
  return info;
}

export function assertPrivateAichatExportDestination(
  outputPath,
  {
    skillDir,
    overwrite = false,
    confirmPath = null,
  } = {},
) {
  if (
    typeof outputPath !== 'string'
    || !outputPath.trim()
    || /[\u0000-\u001f\u007f]/.test(outputPath)
  ) {
    throw new Error('AIChat export requires a valid destination path');
  }
  if (!isAbsolute(outputPath)) {
    throw new Error('AIChat export destination must be an absolute private path');
  }
  if (typeof skillDir !== 'string' || !skillDir) {
    throw new Error('AIChat export safety requires the skill directory');
  }
  if (overwrite && confirmPath !== outputPath) {
    throw new Error('AIChat export overwrite requires exact --confirm-path equality');
  }
  if (!overwrite && confirmPath) {
    throw new Error('AIChat export confirmation is valid only for overwrite');
  }

  const requestedAbsolute = resolve(outputPath);
  const requestedParent = dirname(requestedAbsolute);
  const parentInfo = lstatIfPresent(requestedParent);
  if (!parentInfo) throw new Error('AIChat export parent directory does not exist');
  if (!parentInfo.isDirectory() && !parentInfo.isSymbolicLink()) {
    throw new Error('AIChat export parent is not a directory');
  }
  const realParent = realpathSync(requestedParent);
  const realParentInfo = statSync(realParent);
  if (!realParentInfo.isDirectory()) throw new Error('AIChat export parent is not a directory');
  if ((realParentInfo.mode & 0o077) !== 0) {
    throw new Error('AIChat export parent directory must be private (no group/world permissions)');
  }
  if (typeof process.getuid === 'function' && realParentInfo.uid !== process.getuid()) {
    throw new Error('AIChat export parent directory is not owned by the current principal');
  }

  const targetPath = join(realParent, basename(requestedAbsolute));
  const realSkillDir = realpathSync(skillDir);
  if (isWithin(realSkillDir, targetPath)) {
    throw new Error('AIChat evidence cannot be exported inside the skill directory');
  }
  const repoRoot = repositoryRoot(realParent);
  if (repoRoot && isWithin(repoRoot, targetPath)) {
    throw new Error('AIChat evidence cannot be exported inside a repository');
  }

  const existing = assertRegularDestination(targetPath, 'AIChat export destination');
  if (existing && !overwrite) {
    throw new Error('AIChat export destination already exists; use --overwrite with exact --confirm-path');
  }
  return {
    targetPath,
    directory: realParent,
    basename: basename(targetPath),
    overwrite,
    existed: Boolean(existing),
  };
}

function hasSubstantiveEnvelopeArtifact(envelope) {
  const artifacts = envelope?.artifacts;
  if (typeof artifacts?.answer === 'string' && artifacts.answer.trim()) return true;
  if (
    Array.isArray(artifacts?.tables)
    && artifacts.tables.some((table) => (
      Number.isSafeInteger(table?.rowCount)
      && table.rowCount > 0
      && Array.isArray(table.rows)
      && table.rows.length === table.rowCount
    ))
  ) {
    return true;
  }
  return Array.isArray(artifacts?.files) && artifacts.files.some((file) => (
    Number.isSafeInteger(file?.size)
    && file.size > 0
    && Boolean(file.name || file.display)
  ));
}

function assertExportableEnvelope(envelope) {
  if (
    envelope?.format !== AICHAT_RESULT_ENVELOPE_FORMAT
    || !['query', 'report'].includes(envelope?.mode)
    || envelope?.generation?.state !== 'completed'
    || envelope?.generation?.transportCompleted !== true
    || envelope?.generation?.artifactPresent !== true
    || envelope?.generation?.generated !== true
    || !hasSubstantiveEnvelopeArtifact(envelope)
  ) {
    throw new Error('refusing to export a failed or empty AIChat result');
  }
  if (
    envelope?.validation?.validated !== false
    || envelope?.validation?.reconciliation !== 'not-performed'
  ) {
    throw new Error('refusing an unsupported AIChat validation or reconciliation claim');
  }
}

function removeTemporary(path) {
  try {
    const info = lstatIfPresent(path);
    if (info?.isFile() && !info.isSymbolicLink()) unlinkSync(path);
  } catch {
    // The primary operation error remains authoritative; the private temp name is unreported.
  }
}

export function writePrivateAichatEnvelope({
  outputPath,
  envelope,
  skillDir,
  overwrite = false,
  confirmPath = null,
}) {
  assertExportableEnvelope(envelope);
  const destination = assertPrivateAichatExportDestination(outputPath, {
    skillDir,
    overwrite,
    confirmPath,
  });
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const content = Buffer.from(serialized, 'utf8');
  if (content.byteLength > MAX_EXPORT_BYTES) {
    throw new Error(`AIChat export envelope exceeds ${MAX_EXPORT_BYTES} bytes`);
  }

  const temporaryPath = join(
    destination.directory,
    `.${destination.basename}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor = null;
  let published = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(descriptor, content);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    if (destination.overwrite && destination.existed) {
      const current = assertRegularDestination(destination.targetPath, 'AIChat export destination');
      if (!current) {
        throw new Error('AIChat export destination changed before overwrite');
      }
      renameSync(temporaryPath, destination.targetPath);
      published = true;
    } else {
      linkSync(temporaryPath, destination.targetPath);
      published = true;
      unlinkSync(temporaryPath);
    }
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the primary write error.
      }
    }
    removeTemporary(temporaryPath);
    if (error?.code === 'EEXIST') {
      throw new Error('AIChat export destination already exists; no data was overwritten');
    }
    throw error;
  }
  if (!published) throw new Error('AIChat export was not published');

  const savedInfo = assertRegularDestination(destination.targetPath, 'saved AIChat export');
  if (!savedInfo) throw new Error('saved AIChat export is missing');
  if ((savedInfo.mode & 0o777) !== 0o600) {
    throw new Error('saved AIChat export permissions are not 0600');
  }
  const reopened = readFileSync(destination.targetPath);
  if (!reopened.equals(content)) {
    throw new Error('saved AIChat export did not reopen with the expected content');
  }

  return {
    ok: true,
    saved: true,
    reopened: true,
    format: envelope.format,
    mode: envelope.mode,
    file: destination.basename,
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    generation: { generated: true },
    validation: envelope.validation,
    permissions: '0600',
    overwritten: destination.existed,
  };
}
