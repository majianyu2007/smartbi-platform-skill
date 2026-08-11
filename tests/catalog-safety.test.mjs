import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyNamespaceMarker,
  assertCatalogPlacementCompatible,
  assertContiguousOwnedFolderChain,
  assertCopyTargetOutsideSource,
  createImmutableCatalogCopyManifest,
  normalizeNamingConfig,
  shouldTraverseCatalogNode,
} from '../scripts/catalog-safety.mjs';

const naming = normalizeNamingConfig('prefix', 'TEAM_', { maxLength: 30 });
const isOwned = (node) => String(node.name || '').startsWith(naming.value)
  || String(node.alias || '').startsWith(naming.value);

const rootFolder = {
  id: 'folder',
  parentSourceId: null,
  name: 'TEAM_folder',
  alias: 'TEAM_folder',
  type: 'DEFAULT_TREENODE',
};

test('copy cycle guard rejects the source and every descendant target', () => {
  assert.throws(
    () => assertCopyTargetOutsideSource({
      sourceId: 'folder',
      targetParentId: 'folder',
      targetPath: [{ id: 'folder' }],
    }),
    /into itself or its descendant/,
  );
  assert.throws(
    () => assertCopyTargetOutsideSource({
      sourceId: 'folder',
      targetParentId: 'deep-child',
      targetPath: [{ id: 'SELF' }, { id: 'folder' }, { id: 'child' }, { id: 'deep-child' }],
    }),
    /into itself or its descendant/,
  );
});

test('copy manifest rejects a foreign descendant before execution', () => {
  assert.throws(
    () => createImmutableCatalogCopyManifest({
      sourceId: rootFolder.id,
      targetParentId: 'target',
      targetPath: [{ id: 'SELF' }, { id: 'target' }],
      isOwned,
      entries: [
        rootFolder,
        {
          id: 'foreign-child',
          parentSourceId: rootFolder.id,
          name: 'OTHER_report',
          alias: 'OTHER_report',
          type: 'SMARTBIX_PAGE',
        },
      ],
    }),
    /non-namespaced descendant: foreign-child/,
  );
});

test('copy manifest is a frozen connected snapshot', () => {
  const manifest = createImmutableCatalogCopyManifest({
    sourceId: rootFolder.id,
    targetParentId: 'target',
    targetPath: [{ id: 'SELF' }, { id: 'target' }],
    isOwned,
    entries: [
      rootFolder,
      {
        id: 'child',
        parentSourceId: rootFolder.id,
        name: 'TEAM_report',
        alias: 'TEAM_report',
        type: 'SMARTBIX_PAGE',
        detail: { desc: 'snapshot' },
      },
    ],
  });
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.entries), true);
  assert.equal(Object.isFrozen(manifest.entries[1].detail), true);
  assert.throws(() => { manifest.entries[1].detail.desc = 'changed'; }, TypeError);
});

test('suffix truncation trims only the descriptive portion', () => {
  const suffix = normalizeNamingConfig('suffix', '_TEAM', { maxLength: 30 });
  const alreadyNamespaced = `${'descriptive'.repeat(5)}_TEAM`;
  const resolved = applyNamespaceMarker(alreadyNamespaced, suffix, { maxLength: 30 });
  assert.equal(resolved.length, 30);
  assert.equal(resolved.endsWith('_TEAM'), true);
  assert.equal(resolved, `${alreadyNamespaced.slice(0, 25)}_TEAM`);
  assert.equal(
    applyNamespaceMarker('descriptive'.repeat(5), suffix, { maxLength: 30 }),
    resolved,
  );
});

test('effective naming config rejects markers that cannot fit', () => {
  assert.throws(
    () => normalizeNamingConfig('suffix', 'x'.repeat(30), { maxLength: 30 }),
    /shorter than 30/,
  );
  assert.throws(
    () => normalizeNamingConfig('sideways', 'TEAM_', { maxLength: 30 }),
    /invalid naming mode/,
  );
});

test('owned parent chain must remain contiguous from its domain root', () => {
  const self = { id: 'SELF', type: 'SELF_TREENODE', name: 'My workspace' };
  const team = { id: 'team', type: 'DEFAULT_TREENODE', name: 'TEAM_candidate' };
  const generated = {
    id: 'generated',
    type: 'AUGMENTED_DATASET_FOLDER',
    name: 'fields',
  };
  const context = assertContiguousOwnedFolderChain({
    parent: generated,
    path: [self, team, generated],
    rootId: self.id,
    domain: 'workspace',
    isOwned,
  });
  assert.equal(context.domain, 'workspace');
  assert.deepEqual(context.path.map((node) => node.id), ['SELF', 'team', 'generated']);

  const foreign = { id: 'foreign', type: 'DEFAULT_TREENODE', name: 'OTHER_candidate' };
  assert.throws(
    () => assertContiguousOwnedFolderChain({
      parent: team,
      path: [self, foreign, team],
      rootId: self.id,
      domain: 'workspace',
      isOwned,
    }),
    /crosses a non-owned folder: foreign/,
  );
});

test('move and copy placement stays in one compatible catalog domain', () => {
  const resource = { id: 'report', type: 'SMARTBIX_PAGE' };
  const source = {
    parent: { id: 'source', type: 'DEFAULT_TREENODE' },
    domain: 'workspace',
    isDomainRoot: false,
  };
  assert.throws(
    () => assertCatalogPlacementCompatible({
      resource,
      source,
      target: {
        parent: { id: 'agent', type: 'SELF_TREENODE' },
        domain: 'agent',
        isDomainRoot: true,
      },
      operation: 'resource-copy',
    }),
    /cannot cross catalog domains/,
  );
  assert.throws(
    () => assertCatalogPlacementCompatible({
      resource,
      source,
      target: {
        parent: { id: 'model-fields', type: 'AUGMENTED_DATASET_FOLDER' },
        domain: 'workspace',
        isDomainRoot: false,
      },
      operation: 'resource-move',
    }),
    /cannot place resources under AUGMENTED_DATASET_FOLDER/,
  );
});

test('known folder types remain traversable without hasChild', () => {
  assert.equal(shouldTraverseCatalogNode({ type: 'DEFAULT_TREENODE' }), true);
  assert.equal(shouldTraverseCatalogNode({ type: 'AUGMENTED_DATASET_FOLDER' }), true);
  assert.equal(shouldTraverseCatalogNode({ type: 'SMARTBIX_PAGE' }), false);
});
