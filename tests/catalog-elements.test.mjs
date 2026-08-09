import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatalogElements } from '../scripts/catalog-elements.mjs';

const first = { id: 'one', name: 'One' };
const second = { id: 'two', name: 'Two' };

test('normalizes Smartbi catalog list response variants', () => {
  assert.deepEqual(normalizeCatalogElements({ retCode: 0, result: [first, second] }), [first, second]);
  assert.deepEqual(normalizeCatalogElements({ retCode: 0, result: { items: [first] } }), [first]);
  assert.deepEqual(normalizeCatalogElements({ retCode: 0, result: { nodes: [second] } }), [second]);
  assert.deepEqual(normalizeCatalogElements({ retCode: 0, result: first }), [first]);
  assert.deepEqual(normalizeCatalogElements({ retCode: 0, result: { 0: first, 1: second } }), [first, second]);
});

test('treats null and empty-object catalog results as empty lists', () => {
  assert.deepEqual(normalizeCatalogElements({ retCode: 0, result: null }), []);
  assert.deepEqual(normalizeCatalogElements({ retCode: 0, result: {} }), []);
});

test('rejects failed or malformed catalog responses', () => {
  assert.throws(
    () => normalizeCatalogElements({ retCode: 1, result: null }, 'resource parent'),
    /cannot list resource parent/,
  );
  assert.throws(
    () => normalizeCatalogElements({ retCode: 0, result: { unexpected: true } }),
    /unexpected catalog children result/,
  );
});
