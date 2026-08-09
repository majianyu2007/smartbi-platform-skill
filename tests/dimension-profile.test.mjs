import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDimensionKeys } from '../scripts/dimension-profile.mjs';

test('rejects a one-category chart dimension', () => {
  assert.deepEqual(summarizeDimensionKeys(['Four-city historical school sample']), {
    categoryCount: 1,
    blankCategoryCount: 0,
    usableCategoryCount: 1,
    usableForChart: false,
  });
});

test('counts blank buckets separately from usable chart categories', () => {
  assert.deepEqual(summarizeDimensionKeys(['Female', 'Male', '--', 'Unknown']), {
    categoryCount: 4,
    blankCategoryCount: 2,
    usableCategoryCount: 2,
    usableForChart: true,
  });
});
