import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutLinearEtlGraph } from '../scripts/etl-layout.mjs';

test('lays a linear ETL chain out without overlapping nodes', () => {
  const graph = {
    nodes: [
      { id: 'source', x: 350, y: 50 },
      { id: 'target', x: 830, y: 50 },
      { id: 'filter', x: 350, y: 50 },
      { id: 'dedupe', x: 470, y: 50 },
    ],
    links: [
      { from: 'source', to: 'filter' },
      { from: 'filter', to: 'dedupe' },
      { from: 'dedupe', to: 'target' },
    ],
  };
  assert.equal(layoutLinearEtlGraph(graph), true);
  assert.deepEqual(
    Object.fromEntries(graph.nodes.map((node) => [node.id, [node.x, node.y]])),
    { source: [350, 50], target: [770, 50], filter: [490, 50], dedupe: [630, 50] },
  );
  assert.equal(layoutLinearEtlGraph(graph), false);
});

test('leaves branching ETL graphs untouched', () => {
  const graph = {
    nodes: [{ id: 'source' }, { id: 'left' }, { id: 'right' }],
    links: [{ from: 'source', to: 'left' }, { from: 'source', to: 'right' }],
  };
  assert.equal(layoutLinearEtlGraph(graph), false);
});
