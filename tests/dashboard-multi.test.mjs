import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardGrid, normalizeDashboardCharts } from '../scripts/dashboard-multi.mjs';

const charts = [
  { dimension: 'age', measure: 'risk', title: 'Risk by age' },
  { dimension: 'sex', measure: 'risk', title: 'Risk by sex' },
  { dimension: 'grade', measure: 'bullying', title: 'Bullying by grade' },
  { dimension: 'age', measure: 'support', title: 'Support by age' },
];

test('normalizes four independent dashboard chart definitions', () => {
  assert.deepEqual(normalizeDashboardCharts(JSON.stringify(charts)), charts);
});

test('lays four charts out as a non-overlapping two-by-two grid', () => {
  const layout = dashboardGrid(charts);
  assert.equal(layout.charts.length, 4);
  assert.equal(Object.keys(layout.floats).length, 4);
  assert.deepEqual(
    Object.values(layout.floats).map(({ left, top }) => [left, top]),
    [[0, 0], [624, 0], [0, 344], [624, 344]],
  );
  assert.equal(layout.canvas.width, 1280);
  assert.equal(layout.canvas.height, 720);
});

test('rejects one-chart dashboards and incomplete chart definitions', () => {
  assert.throws(
    () => normalizeDashboardCharts([charts[0]]),
    /requires 2-8 chart definitions/,
  );
  assert.throws(
    () => normalizeDashboardCharts([{ dimension: 'age', measure: '' }, charts[1]]),
    /requires dimension, measure, and title/,
  );
});
