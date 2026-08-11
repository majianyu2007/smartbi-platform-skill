import test from 'node:test';
import assert from 'node:assert/strict';
import { auditDashboardPresentation } from '../scripts/dashboard-presentation.mjs';

function dashboardFixture() {
  return {
    define: {
      devices: {
        default: {
          layout: {
            define: {
              floats: {
                1: { portletId: 'chart-1', left: 0, top: 0, width: 600, height: 320 },
              },
            },
          },
        },
      },
      portlets: [{
        id: 'chart-1',
        type: 'ECHARTS_BAR',
        displayMode: 'ECHARTS_BAR',
        extended: {
          title: { text: '指标覆盖' },
          fields: {
            cols: [{ name: 'metric_name', label: '指标名称' }],
            rows: [{ name: 'quality_pass_flag_m', label: '合格分析单元数' }],
          },
          chartDefine: {
            xAxis: { name: '指标名称' },
            yAxis: { name: '单元数' },
          },
        },
      }],
    },
  };
}

test('accepts a chart with visible title, business labels, axes, and layout', () => {
  const audit = auditDashboardPresentation(dashboardFixture(), 1);
  assert.equal(audit.ok, true);
  assert.equal(audit.chartCount, 1);
  assert.deepEqual(audit.issues, []);
});

test('flags missing axis labels and orphaned chart layout', () => {
  const dashboard = dashboardFixture();
  dashboard.define.portlets[0].extended.chartDefine.yAxis.name = '';
  dashboard.define.devices.default.layout.define.floats = {};
  const audit = auditDashboardPresentation(dashboard, 1);
  assert.equal(audit.ok, false);
  assert.match(audit.issues.join('\n'), /y-axis title/);
  assert.match(audit.issues.join('\n'), /layout slot/);
});


test('accepts mark-only pie fields without irrelevant cartesian axes', () => {
  const dashboard = dashboardFixture();
  const portlet = dashboard.define.portlets[0];
  portlet.type = 'ECHARTS_PIE__DONUT';
  portlet.displayMode = 'ECHARTS_PIE__DONUT';
  portlet.extended.fields = { cols: [], rows: [], filters: [] };
  portlet.extended.markFieldGroups = {
    GLOBAL_MARK: {
      color: [{ name: 'category', label: '类别' }],
      angle: [{ name: 'value_m', label: '数量' }],
    },
  };
  portlet.extended.chartDefine = { legend: {} };
  const audit = auditDashboardPresentation(dashboard, 1);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.issues, []);
});

test('flags a missing chart-type-specific required slot', () => {
  const dashboard = dashboardFixture();
  const portlet = dashboard.define.portlets[0];
  portlet.type = 'ECHARTS_PIE';
  portlet.displayMode = 'ECHARTS_PIE';
  portlet.extended.fields = { cols: [], rows: [], filters: [] };
  portlet.extended.markFieldGroups = {
    GLOBAL_MARK: {
      color: [{ name: 'category', label: '类别' }],
      angle: [],
    },
  };
  portlet.extended.chartDefine = {};
  const audit = auditDashboardPresentation(dashboard, 1);
  assert.equal(audit.ok, false);
  assert.match(audit.issues.join('\n'), /slot angle/);
});

test('audits mixed ECharts and TABLE_CROSS visualizations', () => {
  const dashboard = dashboardFixture();
  dashboard.define.devices.default.layout.define.floats[2] = {
    portletId: 'table-1',
    left: 0,
    top: 344,
    width: 600,
    height: 320,
  };
  dashboard.define.devices.default.layout.size = { width: 1280, height: 720 };
  dashboard.define.portlets.push({
    id: 'table-1',
    type: 'TABLE_CROSS',
    displayMode: null,
    extended: {
      title: { text: '明细汇总' },
      fields: {
        cols: [{ name: 'MEASURE_GROUP_NAME', label: '度量名称' }],
        rows: [{ name: 'record_id', label: '记录编号' }],
      },
      fieldGroup: {
        measures: [{
          id: 'AUGMENTED_DATASET_CALC_MEASURE.model.score',
          name: 'score',
          label: '综合得分',
          type: 'CALC_MEASURE',
          group: 'CALC_MEASURE',
          aggregate: null,
          originAggregate: null,
        }],
      },
    },
  });
  const audit = auditDashboardPresentation(dashboard, 2);
  assert.equal(audit.ok, true);
  assert.equal(audit.chartCount, 2);
  assert.equal(audit.charts[1].type, 'TABLE_CROSS');
  assert.equal(audit.charts[1].slots.measureGroup[0].type, 'CALC_MEASURE');
  dashboard.define.portlets[1].extended.fieldGroup.measures[0].aggregate = 'SUM';
  const invalidCalc = auditDashboardPresentation(dashboard, 2);
  assert.equal(invalidCalc.ok, false);
  assert.match(invalidCalc.issues.join('\n'), /invalid aggregation metadata/);
});