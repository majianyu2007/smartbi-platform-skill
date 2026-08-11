import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCompleteImportSchema,
  assertImportedSchemaMatches,
  assertReplacementSchemaCompatible,
  replacementSchemaDiff,
} from '../scripts/import-schema.mjs';

test('replacement accepts the same ordered fields case-insensitively', () => {
  const result = assertReplacementSchemaCompatible(
    [
      { name: 'city_cn', dataType: 'STRING' },
      { name: 'estimate_value', dataType: 'DOUBLE' },
    ],
    [
      { name: 'CITY_CN', dataType: 'string' },
      { name: 'Estimate_Value', dataType: 'double' },
    ],
    'TEAM_focus',
  );
  assert.equal(result.compatible, true);
});

test('replacement rejects a newly added field instead of silently dropping it', () => {
  assert.throws(
    () => assertReplacementSchemaCompatible(
      [
        { name: 'city_cn', dataType: 'STRING' },
        { name: 'estimate_value', dataType: 'DOUBLE' },
      ],
      [
        { name: 'city_cn', dataType: 'STRING' },
        { name: 'estimate_value', dataType: 'DOUBLE' },
        { name: 'estimated_per_1000', dataType: 'DOUBLE' },
      ],
      'TEAM_focus',
    ),
    /refusing schema-changing replacement.*added=estimated_per_1000.*Delete the owned table/s,
  );
});

test('replacement rejects removed and reordered fields', () => {
  const diff = replacementSchemaDiff(
    [
      { name: 'city_cn', dataType: 'STRING' },
      { name: 'estimate_value', dataType: 'DOUBLE' },
    ],
    [
      { name: 'estimate_value', dataType: 'DOUBLE' },
      { name: 'city_cn', dataType: 'STRING' },
    ],
  );
  assert.equal(diff.compatible, false);
  assert.equal(diff.reordered, true);
  assert.deepEqual(diff.existing, ['city_cn', 'estimate_value']);
  assert.deepEqual(diff.incoming, ['estimate_value', 'city_cn']);
  assert.throws(
    () => assertReplacementSchemaCompatible(
      [
        { name: 'city_cn', dataType: 'STRING' },
        { name: 'estimate_value', dataType: 'DOUBLE' },
      ],
      [{ name: 'city_cn', dataType: 'STRING' }],
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

test('replacement fails closed when either schema omits field types', () => {
  assert.throws(
    () => assertReplacementSchemaCompatible(
      [{ name: 'city_cn' }],
      [{ name: 'city_cn', dataType: 'STRING' }],
      'TEAM_focus',
    ),
    /existing-types-unavailable=city_cn/,
  );
  assert.throws(
    () => assertCompleteImportSchema([{ name: 'city_cn' }], 'TEAM_focus'),
    /schema is incomplete.*existing-types-unavailable=city_cn/,
  );
});

test('reopened imported schema must preserve ordered normalized names and types', () => {
  assert.deepEqual(
    assertImportedSchemaMatches(
      [
        { name: 'City_CN', dataType: 'string' },
        { name: 'Estimate_Value', dataType: 'double' },
      ],
      [
        { name: 'city_cn', dataType: 'STRING' },
        { name: 'estimate_value', dataType: 'DOUBLE' },
      ],
      'TEAM_focus',
    ),
    [
      { name: 'city_cn', type: 'STRING' },
      { name: 'estimate_value', type: 'DOUBLE' },
    ],
  );
  assert.throws(
    () => assertImportedSchemaMatches(
      [
        { name: 'city_cn', dataType: 'STRING' },
        { name: 'estimate_value', dataType: 'DOUBLE' },
      ],
      [
        { name: 'estimate_value', dataType: 'DOUBLE' },
        { name: 'city_cn', dataType: 'STRING' },
      ],
      'TEAM_focus',
    ),
    /schema postcondition failed.*column-order-changed/,
  );
});
