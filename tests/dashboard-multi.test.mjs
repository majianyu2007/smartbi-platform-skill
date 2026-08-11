import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chartTypeContract,
  DASHBOARD_CHART_TYPES,
  dashboardGrid,
  normalizeDashboardCharts,
} from '../scripts/dashboard-multi.mjs';

const barCharts = [
  { dimension: 'age', measure: 'risk', title: 'Risk by age' },
  { dimension: 'sex', measure: 'risk', title: 'Risk by sex' },
  { dimension: 'grade', measure: 'bullying', title: 'Bullying by grade' },
  { dimension: 'context_group', measure: 'quality_pass_flag', title: 'Quality by context' },
];

function validChart(type) {
  const dimensions = ['category', 'category2', 'category3'];
  const measures = ['value', 'value2', 'value3'];
  if (type.startsWith('ECHARTS_GAUGE')) {
    return { type, measures: [measures[0]], title: type };
  }
  if (type === 'ECHARTS_SCATTER') {
    return { type, dimensions: [dimensions[0]], measures, title: type };
  }
  if (type === 'ECHARTS_SCATTER__LARGE') {
    return { type, dimensions: [dimensions[0]], measures: measures.slice(0, 2), title: type };
  }
  if (type === 'ECHARTS_MAP_SCATTER') {
    return { type, dimensions, measures: [measures[0]], title: type };
  }
  if (type === 'ECHARTS_MAP_SCATTER__LARGE') {
    return { type, dimensions, title: type };
  }
  if (['ECHARTS_MAP_HEATMAP', 'ECHARTS_HEATMAP'].includes(type)) {
    return { type, dimensions: dimensions.slice(0, 2), measures: [measures[0]], title: type };
  }
  if (type === 'ECHARTS_GRAPH') {
    return { type, dimensions, measures: measures.slice(0, 2), title: type };
  }
  if (type === 'ECHARTS_SANKEY') {
    return { type, dimensions: dimensions.slice(0, 2), measures: [measures[0]], title: type };
  }
  if (type === 'ECHARTS_COMBINATION__DUAL') {
    return { type, dimensions: [dimensions[0]], measures: measures.slice(0, 2), title: type };
  }
  return { type, dimensions: [dimensions[0]], measures: [measures[0]], title: type };
}

test('normalizes legacy dimension and measure chart definitions', () => {
  const normalized = normalizeDashboardCharts(JSON.stringify(barCharts));
  assert.equal(normalized.length, 4);
  assert.equal(normalized[0].type, 'ECHARTS_BAR');
  assert.deepEqual(normalized[0].dimensions, ['age']);
  assert.deepEqual(normalized[0].measures, ['risk']);
  assert.deepEqual(normalized[0].slots.cols, ['age']);
  assert.deepEqual(normalized[0].slots.rows, ['risk']);
  assert.equal(normalized[0].dimensionLabel, 'age');
  assert.equal(normalized[0].measureLabel, 'risk');
});

test('normalizes every live Smartbi chart type against its field-slot contract', () => {
  const normalized = normalizeDashboardCharts(DASHBOARD_CHART_TYPES.map(validChart));
  assert.equal(normalized.length, DASHBOARD_CHART_TYPES.length);
  normalized.forEach((chart) => {
    const contract = chartTypeContract(chart.type);
    Object.entries(contract.slots).forEach(([slot, rule]) => {
      const count = chart.slots[slot].length;
      assert.ok(
        count >= rule.min && count <= rule.max,
        `${chart.type}.${slot} received ${count}`,
      );
    });
  });
});

test('supports mark-only pie fields without cartesian axis metadata', () => {
  const [chart] = normalizeDashboardCharts([{
    type: 'ECHARTS_PIE__DONUT',
    dimension: 'category',
    measure: 'value',
    title: 'Share by category',
  }]);
  assert.deepEqual(chart.slots.color, ['category']);
  assert.deepEqual(chart.slots.angle, ['value']);
});

test('normalizes cross-table detail fields', () => {
  const [table] = normalizeDashboardCharts([{
    type: 'TABLE_CROSS',
    dimensions: ['record_id', 'category', 'segment'],
    measures: ['amount', 'score'],
    title: 'Record details',
  }]);
  assert.deepEqual(table.slots.rows, ['record_id', 'category', 'segment']);
  assert.deepEqual(table.slots.cols, []);
  assert.deepEqual(table.slots.measureGroup, ['amount', 'score']);
  assert.deepEqual(table.measures, ['amount', 'score']);
  assert.equal(table.displayMode, null);
});

test('rejects chart types with incomplete required field slots', () => {
  assert.throws(
    () => normalizeDashboardCharts([{
      type: 'ECHARTS_SCATTER',
      dimension: 'category',
      measure: 'value',
      title: 'Incomplete scatter',
    }]),
    /slot rows requires exactly 1 field/,
  );
  assert.throws(
    () => normalizeDashboardCharts([{
      type: 'ECHARTS_COMBINATION__DUAL',
      dimension: 'category',
      measure: 'value',
      title: 'Incomplete dual-axis chart',
    }]),
    /slot rows requires 2-many field/,
  );
});

test('rejects unknown chart types and unsupported field slots', () => {
  assert.throws(
    () => normalizeDashboardCharts([{ ...barCharts[0], type: 'ECHARTS_UNKNOWN' }]),
    /unsupported dashboard chart type/,
  );
  assert.throws(
    () => normalizeDashboardCharts([{ ...barCharts[0], slots: { longitude: 'x' } }]),
    /unsupported field slot/,
  );
});

test('rejects unknown keys, forbidden slots, unbound fields, and contradictory display modes', () => {
  assert.throws(
    () => normalizeDashboardCharts([{ ...barCharts[0], conditionalFormatting: [] }]),
    /unsupported key/,
  );
  assert.throws(
    () => normalizeDashboardCharts([{ ...barCharts[0], slots: { size: ['risk'] } }]),
    /unsupported field slot: size/,
  );
  assert.throws(
    () => normalizeDashboardCharts([{
      type: 'ECHARTS_BAR',
      dimensions: ['age', 'unused'],
      measures: ['risk'],
      slots: { cols: ['age'], rows: ['risk'] },
      title: 'Unbound field',
    }]),
    /declares an unbound field: unused/,
  );
  assert.throws(
    () => normalizeDashboardCharts([{ ...barCharts[0], displayMode: 'ECHARTS_PIE' }]),
    /displayMode must be ECHARTS_BAR/,
  );
});

test('lays charts out in a readable two-column grid', () => {
  const layout = dashboardGrid(barCharts);
  assert.equal(layout.charts.length, 4);
  assert.equal(Object.keys(layout.floats).length, 4);
  assert.deepEqual(
    Object.values(layout.floats).map(({ left, top }) => [left, top]),
    [[0, 0], [624, 0], [0, 344], [624, 344]],
  );
  assert.equal(layout.canvas.width, 1280);
  assert.equal(layout.canvas.height, 720);
});

test('requires one to thirty-two charts', () => {
  assert.throws(() => normalizeDashboardCharts([]), /requires 1-32/);
  assert.equal(
    normalizeDashboardCharts(Array.from({ length: 32 }, () => barCharts[0])).length,
    32,
  );
  assert.throws(
    () => normalizeDashboardCharts(Array.from({ length: 33 }, () => barCharts[0])),
    /requires 1-32/,
  );
});
