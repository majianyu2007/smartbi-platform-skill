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
