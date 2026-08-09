import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertReplacementSchemaCompatible,
  replacementSchemaDiff,
} from '../scripts/import-schema.mjs';

test('replacement accepts the same ordered fields case-insensitively', () => {
  const result = assertReplacementSchemaCompatible(
    [{ name: 'city_cn' }, { name: 'estimate_value' }],
    ['CITY_CN', 'Estimate_Value'],
    'TEAM_focus',
  );
  assert.equal(result.compatible, true);
});

test('replacement rejects a newly added field instead of silently dropping it', () => {
  assert.throws(
    () => assertReplacementSchemaCompatible(
      [{ name: 'city_cn' }, { name: 'estimate_value' }],
      ['city_cn', 'estimate_value', 'estimated_per_1000'],
      'TEAM_focus',
    ),
    /refusing schema-changing replacement.*added=estimated_per_1000.*Delete the owned table/s,
  );
});

test('replacement rejects removed and reordered fields', () => {
  assert.deepEqual(
    replacementSchemaDiff(
      [{ name: 'city_cn' }, { name: 'estimate_value' }],
      ['estimate_value', 'city_cn'],
    ),
    {
      compatible: false,
      existing: ['city_cn', 'estimate_value'],
      incoming: ['estimate_value', 'city_cn'],
      added: [],
      removed: [],
      reordered: true,
      typeChanges: [],
    },
  );
  assert.throws(
    () => assertReplacementSchemaCompatible(
      [{ name: 'city_cn' }, { name: 'estimate_value' }],
      ['city_cn'],
      'TEAM_focus',
    ),
    /removed=estimate_value/,
  );
});

test('replacement rejects field type changes', () => {
  assert.throws(
    () => assertReplacementSchemaCompatible(
      [
        { name: 'city_cn', dataType: 'STRING' },
        { name: 'estimate_value', dataType: 'DOUBLE' },
      ],
      [
        { name: 'city_cn', dataType: 'STRING' },
        { name: 'estimate_value', dataType: 'INTEGER' },
      ],
      'TEAM_focus',
    ),
    /type-changed=estimate_value:DOUBLE->INTEGER/,
  );
});
