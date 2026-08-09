import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DELETION_PARENT_KINDS,
  authorizeResourceDeletion,
  parseResourceDeleteArgs,
} from '../scripts/deletion-guard.mjs';

const table = {
  id: 'TAB.input.input.null.legacy_table',
  name: 'legacy_table',
  alias: 'Legacy Table',
  type: 'BASETABLE',
};

test('resource-delete parser accepts one exact-name confirmation', () => {
  assert.deepEqual(
    parseResourceDeleteArgs(['parent', 'resource', '--confirm-name', 'Legacy Table']),
    { parentId: 'parent', resourceId: 'resource', confirmName: 'Legacy Table' },
  );
  assert.throws(
    () => parseResourceDeleteArgs(['parent', 'resource']),
    /requires --confirm-name/,
  );
});

test('resource-delete parser rejects malformed confirmation options', () => {
  assert.throws(() => parseResourceDeleteArgs([]), /requires <parentId> <resourceId>/);
  assert.throws(
    () => parseResourceDeleteArgs(['parent', 'resource', '--confirm-name']),
    /requires an exact resource name/,
  );
  assert.throws(
    () => parseResourceDeleteArgs(['parent', 'resource', '--unknown']),
    /unknown resource-delete option/,
  );
  assert.throws(
    () => parseResourceDeleteArgs([
      'parent', 'resource', '--confirm-name', 'first', '--confirm-name', 'second',
    ]),
    /accepts --confirm-name only once/,
  );
});

test('namespaced resource deletion requires an exact confirmed name', () => {
  for (const parentKind of Object.values(DELETION_PARENT_KINDS)) {
    assert.throws(
      () => authorizeResourceDeletion({ resource: table, isNamespaced: true, parentKind }),
      /requires --confirm-name/,
    );
    assert.deepEqual(
      authorizeResourceDeletion({
        resource: table,
        isNamespaced: true,
        parentKind,
        confirmName: 'Legacy Table',
      }),
      { legacy: false, confirmedName: 'Legacy Table' },
    );
  }
});

test('legacy deletion requires an exact personal-table name', () => {
  assert.throws(
    () => authorizeResourceDeletion({
      resource: table,
      isNamespaced: false,
      parentKind: DELETION_PARENT_KINDS.PERSONAL_ACQUISITION,
    }),
    /requires --confirm-name/,
  );
  assert.throws(
    () => authorizeResourceDeletion({
      resource: table,
      isNamespaced: false,
      parentKind: DELETION_PARENT_KINDS.PERSONAL_ACQUISITION,
      confirmName: 'wrong table',
    }),
    /does not match/,
  );
  assert.deepEqual(
    authorizeResourceDeletion({
      resource: table,
      isNamespaced: false,
      parentKind: DELETION_PARENT_KINDS.PERSONAL_ACQUISITION,
      confirmName: 'Legacy Table',
    }),
    { legacy: true, confirmedName: 'Legacy Table' },
  );
});

test('legacy confirmation never authorizes shared catalog resources', () => {
  assert.throws(
    () => authorizeResourceDeletion({
      resource: table,
      isNamespaced: false,
      parentKind: DELETION_PARENT_KINDS.OWNED_CATALOG,
      confirmName: 'Legacy Table',
    }),
    /refusing to delete non-namespaced resource/,
  );
  assert.throws(
    () => authorizeResourceDeletion({
      resource: { ...table, type: 'SMARTBIX_PAGE' },
      isNamespaced: false,
      parentKind: DELETION_PARENT_KINDS.PERSONAL_ACQUISITION,
      confirmName: 'Legacy Table',
    }),
    /refusing to delete non-namespaced resource/,
  );
});
