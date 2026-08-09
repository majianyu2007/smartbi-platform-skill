import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditAnalysisPresentation,
  improveAnalysisPresentation,
} from '../scripts/analysis-presentation.mjs';

function reportFixture() {
  return {
    id: 'analysis-id',
    name: 'TEAM_CONTEXT_ANALYSIS',
    desc: '',
    define: {
      portlets: [
        {
          id: 'table-id',
          name: '表格',
          type: 'CROSS_TABLE',
          extended: {
            fields: {
              rows: [{ name: 'context_group', alias: 'context_group', label: 'context_group' }],
              cols: [{ name: 'MEASURE_GROUP_NAME', label: '度量名称' }],
              measures: [{ name: 'quality_pass_flag_m', alias: 'quality_pass_flag', label: 'quality_pass_flag' }],
            },
          },
        },
        {
          id: 'empty-filter-id',
          name: 'filterPanel',
          type: 'FILTER_PANEL',
          extended: { children: [], setting: {} },
        },
      ],
    },
  };
}

test('flags empty filter panels and technical field labels', () => {
  const audit = auditAnalysisPresentation(reportFixture());
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.issues.sort(), [
    'empty filter panel',
    'measure label is technical',
    'row label is technical',
  ]);
});

test('removes empty filter panels and applies explicit business labels', () => {
  const repaired = improveAnalysisPresentation(reportFixture(), {
    rowLabel: '种族/族裔分组',
    measureLabel: '合格分析单元数',
    description: 'NSDUH 独立情境覆盖分析',
  });

  assert.equal(repaired.desc, 'NSDUH 独立情境覆盖分析');
  assert.deepEqual(repaired.define.portlets.map(({ type }) => type), ['CROSS_TABLE']);
  assert.equal(repaired.define.portlets[0].name, 'NSDUH 独立情境覆盖分析');
  assert.equal(repaired.define.portlets[0].extended.fields.rows[0].alias, '种族/族裔分组');
  assert.equal(repaired.define.portlets[0].extended.fields.rows[0].label, '种族/族裔分组');
  assert.equal(repaired.define.portlets[0].extended.fields.measures[0].alias, '合格分析单元数');
  assert.equal(repaired.define.portlets[0].extended.fields.measures[0].label, '合格分析单元数');
  assert.deepEqual(auditAnalysisPresentation(repaired), { ok: true, issues: [] });
});

test('keeps a configured filter panel', () => {
  const report = reportFixture();
  report.define.portlets[1].extended.children.push({ id: 'filter-field' });
  const repaired = improveAnalysisPresentation(report, {
    rowLabel: '分析情境',
    measureLabel: '合格分析单元数',
  });
  assert.equal(repaired.define.portlets.length, 2);
});
