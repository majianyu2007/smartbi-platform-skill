import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisBindingSnapshot,
  assertAnalysisBindings,
  assertAnalysisQueryResult,
  assertSavedAnalysisEquivalent,
  assertSimpleAnalysisRepairable,
  patchSimpleAnalysisDefinition,
  remapAnalysisPortlets,
  resolveAnalysisResource,
} from '../scripts/analysis-definition.mjs';

function dimension(id = 'field-region') {
  return {
    id,
    name: 'region',
    alias: 'Region',
    label: 'Region',
    desc: 'Region',
    showName: 'Region',
    type: 'FIELD',
  };
}

function measure(id = 'measure-count') {
  return {
    id,
    name: 'respondent_count',
    alias: 'Respondents',
    label: 'Respondents',
    desc: 'Respondents',
    showName: 'Respondents',
    type: 'MEASURE',
    aggregate: 'DISTINCT_COUNT',
    originAggregate: 'DISTINCT_COUNT',
  };
}

function simpleReport() {
  return {
    id: 'analysis-source',
    name: 'TEAM_analysis',
    alias: 'TEAM_analysis',
    desc: 'Original description',
    define: {
      reportSetting: {
        refresh: { interval: 30 },
        tableHeader: { text: 'Preserve header' },
        tableFooter: { text: 'Preserve footer' },
      },
      portlets: [{
        id: 'portlet-table',
        name: 'Original table',
        type: 'CROSS_TABLE',
        extended: {
          dataSource: { id: 'TEAM_model', type: 'AUGMENTED' },
          fields: {
            rows: [dimension()],
            cols: [{ id: 'MEASURE_GROUP_NAME', type: 'MEASURE_GROUP_NAME' }],
            measures: [measure()],
          },
          sortSetting: { row: { sorts: [] }, col: { sorts: [] } },
          viewState: { groupOrderByState: null },
          preservedSetting: { width: 42 },
        },
      }],
      privateDataset: { folders: [], fields: [] },
    },
  };
}

test('already-namespaced measure resolution selects the exact requested measure', () => {
  const measures = [
    { id: 'm-first', name: 'first', alias: 'TEAM_first' },
    { id: 'm-requested', name: 'requested', alias: 'TEAM_requested' },
  ];
  const resolved = resolveAnalysisResource(measures, 'TEAM_requested', {
    kind: 'analysis measure',
    namespacedRequested: 'TEAM_requested',
  });
  assert.equal(resolved.id, 'm-requested');
  assert.throws(
    () => resolveAnalysisResource([
      { id: 'same', name: 'one', alias: 'One' },
      { id: 'other', name: 'same', alias: 'Two' },
    ], 'same', { kind: 'analysis field' }),
    /must resolve exactly once.*matches=2/,
  );
});

test('analysis query results reject error envelopes, malformed responses, and empty data', () => {
  assert.throws(() => assertAnalysisQueryResult(null), /malformed response/);
  assert.throws(
    () => assertAnalysisQueryResult({ retCode: 9, rowMap: { one: [1] }, columns: ['value'] }),
    /retCode 9/,
  );
  assert.throws(
    () => assertAnalysisQueryResult({ rowMap: {}, columns: ['value'] }),
    /returned no rows/,
  );
  assert.throws(
    () => assertAnalysisQueryResult({ rowMap: { one: [] }, columns: [] }),
    /returned no columns/,
  );
  assert.throws(
    () => assertAnalysisQueryResult({ rowMap: { one: [null] }, columns: ['value'] }),
    /returned no data cells/,
  );
  assert.deepEqual(assertAnalysisQueryResult({
    rowMap: { north: [0], south: [4] },
    columns: [{ label: 'Respondents' }],
    gridData: { rowsCount: 2, data: [[0], [4]] },
  }), {
    total: null,
    rowCount: 2,
    rowKeys: ['north', 'south'],
    columns: ['Respondents'],
  });
});

test('simple analysis repair patches bindings and labels while preserving the surrounding definition', () => {
  const original = simpleReport();
  const repaired = patchSimpleAnalysisDefinition(original, {
    row: dimension('field-age'),
    measure: measure('measure-weight'),
    rowLabel: 'Age group',
    measureLabel: 'Weighted population',
    description: 'Updated analysis',
  });
  assert.equal(repaired.define.reportSetting.tableHeader.text, 'Preserve header');
  assert.equal(repaired.define.reportSetting.tableFooter.text, 'Preserve footer');
  assert.deepEqual(
    repaired.define.portlets[0].extended.fields.cols,
    original.define.portlets[0].extended.fields.cols,
  );
  assert.deepEqual(
    repaired.define.portlets[0].extended.preservedSetting,
    original.define.portlets[0].extended.preservedSetting,
  );
  assert.equal(repaired.define.portlets[0].extended.fields.rows[0].id, 'field-age');
  assert.equal(repaired.define.portlets[0].extended.fields.rows[0].label, 'Age group');
  assert.equal(repaired.define.portlets[0].extended.fields.measures[0].id, 'measure-weight');
  assert.equal(repaired.define.portlets[0].extended.fields.measures[0].label, 'Weighted population');
  assert.equal(original.define.portlets[0].extended.fields.rows[0].id, 'field-region');

  const expectedBindings = analysisBindingSnapshot(repaired);
  assert.doesNotThrow(() => assertAnalysisBindings(repaired, expectedBindings));
  const drifted = structuredClone(repaired);
  drifted.define.portlets[0].extended.fields.measures[0].id = 'wrong-measure';
  assert.throws(
    () => assertAnalysisBindings(drifted, expectedBindings),
    /bindings do not match/,
  );
});

test('analysis repair fails closed on multi-portlet, filtered, private-calculation, and sorted definitions', () => {
  const multi = simpleReport();
  multi.define.portlets.push({ id: 'notes', type: 'TEXT' });
  assert.throws(() => assertSimpleAnalysisRepairable(multi), /exactly one CROSS_TABLE/);

  const filtered = simpleReport();
  filtered.define.portlets[0].extended.fields.filters = [{ id: 'filter' }];
  assert.throws(() => assertSimpleAnalysisRepairable(filtered), /refuses filtered/);

  const calculated = simpleReport();
  calculated.define.privateDataset.fields.push({ id: 'private-calc' });
  assert.throws(() => assertSimpleAnalysisRepairable(calculated), /private calculated/);

  const sorted = simpleReport();
  sorted.define.portlets[0].extended.sortSetting.row.sorts.push({ fieldId: 'field-region' });
  assert.throws(() => assertSimpleAnalysisRepairable(sorted), /refuses sorted or grouped/);
});

test('analysis clone remaps every portlet ID reference including object keys', () => {
  const source = simpleReport();
  source.define.portlets.push({
    id: 'portlet-filter',
    type: 'FILTER_PANEL',
    extended: {
      appliesTo: 'portlet-table',
      referenceMap: { 'portlet-table': ['portlet-filter'] },
    },
  });
  const ids = ['clone-table', 'clone-filter'];
  const { report: remapped } = remapAnalysisPortlets(source, () => ids.shift());
  assert.deepEqual(remapped.define.portlets.map((portlet) => portlet.id), [
    'clone-table',
    'clone-filter',
  ]);
  assert.equal(remapped.define.portlets[1].extended.appliesTo, 'clone-table');
  assert.deepEqual(remapped.define.portlets[1].extended.referenceMap, {
    'clone-table': ['clone-filter'],
  });
});

test('saved-analysis equivalence rejects reopened definition drift', () => {
  const expected = simpleReport();
  assert.doesNotThrow(() => assertSavedAnalysisEquivalent(expected, structuredClone(expected)));
  const drifted = structuredClone(expected);
  drifted.define.portlets[0].extended.fields.rows[0].id = 'other-field';
  assert.throws(
    () => assertSavedAnalysisEquivalent(expected, drifted),
    /definition does not match/,
  );
});
