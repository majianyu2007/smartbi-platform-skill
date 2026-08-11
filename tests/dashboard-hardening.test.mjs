import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDashboardModelResource,
  serializeDashboardResource,
} from '../scripts/dashboard-model.mjs';
import {
  assertCompatibleDashboardDataTypes,
  assertFilterImpactsVisualization,
  assertInteractiveDashboardPersisted,
  assertJumpRulePersisted,
  locateDashboardPortletField,
  parseDashboardJumpSpec,
  parseInteractiveDashboardSpec,
  resolveDashboardPortletReference,
} from '../scripts/dashboard-interactions.mjs';
import {
  assertDashboardRepairable,
  assertSavedDashboardMatchesDefinition,
} from '../scripts/dashboard-verification.mjs';

function modelFixture() {
  return {
    id: 'model',
    views: [
      { id: 'view-1', name: 'orders', alias: 'Orders' },
      { id: 'view-2', name: 'returns', alias: 'Returns' },
    ],
    fields: [
      {
        id: 'field-1',
        name: 'category',
        alias: 'Category',
        viewId: 'view-1',
        valueType: 'STRING',
        dataFormat: '',
      },
      {
        id: 'field-2',
        name: 'category',
        alias: 'Category',
        viewId: 'view-2',
        valueType: 'STRING',
        dataFormat: '',
      },
    ],
    measures: [{
      id: 'measure-1',
      name: 'amount',
      alias: 'Amount',
      valueType: 'DOUBLE',
      aggregator: 'sum',
      refDataSetFieldId: 'amount-field',
    }],
    calcMeasures: [{
      id: 'calc-1',
      name: 'margin_rate',
      alias: 'Margin rate',
      valueType: 'DOUBLE',
      aggregator: null,
      refDataSetFieldId: 'must-not-survive',
    }],
    levels: [],
    nodes: [
      { id: 'field-1', parentId: 'view-1', order: 0 },
      { id: 'field-2', parentId: 'view-2', order: 0 },
      { id: 'measure-1', parentId: 'measure', order: 0 },
      { id: 'calc-1', parentId: 'measure', order: 1 },
    ],
  };
}

function chartPortlet(id) {
  return {
    id,
    name: id,
    type: 'ECHARTS_BAR',
    displayMode: 'ECHARTS_BAR',
    style: null,
    macros: [],
    extended: {
      asFilter: false,
      fields: { cols: [], rows: [], filters: [], marks: [] },
      viewState: {},
      pagination: {},
      sortSetting: { row: { sorts: [] }, col: { sorts: [] } },
    },
    invalidField: null,
  };
}

function filterPortlet(targets = ['target']) {
  return {
    id: 'filter',
    name: 'filter',
    type: 'FILTER_LIST',
    displayMode: null,
    style: null,
    macros: [],
    extended: {
      asFilter: false,
      fields: {
        filters: [{
          id: 'AUGMENTED_DATASET_FIELD.model.category',
          name: 'category',
          label: 'Category',
          dataType: 'STRING',
        }],
      },
      filterSelectType: 'MULTIPLE',
      dataType: 'STRING',
      filterOp: 'EQUALS',
      impactWidgets: targets,
      providerName: 'AUGMENTED',
      impactReportsType: 'filterCustom',
      filtersOrder: ['AUGMENTED_DATASET_FIELD.model.category'],
      filterListType: 'SINGLE',
      columnNum: 3,
      defaultValueSetting: { defaultType: 'ALL' },
    },
    invalidField: null,
  };
}

function repairableDashboard() {
  return {
    id: 'dashboard',
    desc: 'before',
    define: {
      portlets: [chartPortlet('chart')],
      containers: [],
      datasetRelations: null,
      privateDatasets: [],
      pageOptions: {},
      globalExtended: {},
      pageThemeDefine: {
        version: '1',
        page: {},
        portlet: {},
        chart: {},
        table: {},
        filter: {},
        indicator: {},
      },
      themeStyleOptions: null,
      refresh: { systemOpenRefresh: true, systemFilterChangeRefresh: true },
      macros: [],
      activeDevice: 'default',
      devices: {
        default: {
          layout: {
            type: 'FREE',
            define: {
              floats: {
                1: {
                  id: '1',
                  portletId: 'chart',
                  type: 'ECHARTS_BAR',
                  left: 0,
                  top: 0,
                  width: 600,
                  height: 320,
                  'z-index': 1000,
                },
              },
              table: { direction: 'vertical', slots: [] },
            },
            size: { width: 1280, height: 720, scaleType: 'FIT_WIDTH' },
          },
        },
      },
    },
    editDefine: {
      rulerLineConfigs: [{ layoutId: 'default', state: 'show', lines: [] }],
    },
  };
}

test('resolves qualified resources exactly and rejects ambiguous bare names', () => {
  const model = modelFixture();
  assert.throws(
    () => resolveDashboardModelResource(model, 'Category', 'dimension'),
    /selector is ambiguous/,
  );
  assert.equal(
    resolveDashboardModelResource(model, 'orders.Category', 'dimension').resource.id,
    'field-1',
  );
  assert.equal(
    resolveDashboardModelResource(
      model,
      'AUGMENTED_DATASET_FIELD.model.field-2',
      'dimension',
    ).resource.id,
    'field-2',
  );
});

test('serializes calculated measures without inventing an aggregation', () => {
  const measure = serializeDashboardResource(
    modelFixture(),
    'AUGMENTED_DATASET_CALC_MEASURE.model.calc-1',
    'measure',
    null,
    () => 'unique',
  );
  assert.equal(measure.type, 'CALC_MEASURE');
  assert.equal(measure.group, 'CALC_MEASURE');
  assert.equal(measure.aggregate, null);
  assert.equal(measure.originAggregate, null);
  assert.equal(Object.hasOwn(measure, 'refDataSetFieldId'), false);
});

test('rejects ambiguous persisted portlet field names even within one slot', () => {
  const portlet = chartPortlet('chart');
  portlet.extended.fields.cols = [
    { id: 'field-1', name: 'category', alias: 'Category', dataType: 'STRING' },
    { id: 'field-2', name: 'category', alias: 'Category', dataType: 'STRING' },
  ];
  assert.throws(
    () => locateDashboardPortletField(portlet, 'Category', 'cols'),
    /field selector is ambiguous/,
  );
  assert.equal(locateDashboardPortletField(portlet, 'field-2', 'cols').field.id, 'field-2');
});

test('rejects duplicate linkage sources and unsupported filter contracts before creation', () => {
  const charts = [{ type: 'ECHARTS_BAR' }, { type: 'ECHARTS_BAR' }];
  assert.throws(
    () => parseInteractiveDashboardSpec({
      charts,
      filter: { field: 'category' },
      linkage: [
        { source: 0, targets: [1] },
        { source: 0, targets: [1] },
      ],
    }),
    /source 0 is duplicated/,
  );
  assert.throws(
    () => parseInteractiveDashboardSpec({
      charts,
      filter: { field: 'category', columnNum: 0 },
      linkage: [{ source: 0, targets: [1] }],
    }),
    /columnNum must be an integer from 1 to 12/,
  );
  assert.throws(
    () => parseInteractiveDashboardSpec({
      charts,
      filter: { field: 'category', defaultValue: 'x' },
      linkage: [{ source: 0, targets: [1] }],
    }),
    /unsupported key.*defaultValue/,
  );
});

test('verifies exact filter targets and linkage complements after reopen', () => {
  const source = chartPortlet('source');
  source.extended.asFilter = true;
  source.extended.impactReportsType = 'custom';
  source.extended.ignoreFilters = ['source', 'other', 'filter'];
  source.extended.warnImpacts = [];
  const filter = filterPortlet(['target']);
  const saved = {
    define: {
      portlets: [source, chartPortlet('target'), chartPortlet('other'), filter],
    },
  };
  const interaction = {
    filter: { portlet: filter, targetPortletIds: ['target'] },
    linkages: [{
      source: 0,
      sourcePortletId: 'source',
      targetPortletIds: ['target'],
      ignorePortletIds: ['source', 'other', 'filter'],
    }],
  };
  assert.doesNotThrow(() => assertInteractiveDashboardPersisted(saved, interaction));

  for (const mutate of [
    (candidate) => { candidate.define.portlets[3].extended.filterSelectType = 'SINGLE'; },
    (candidate) => { candidate.define.portlets[3].extended.defaultValueSetting.defaultType = 'FIRST'; },
    (candidate) => {
      candidate.define.portlets[3].extended.fields.filters[0].id = 'wrong-field';
    },
  ]) {
    const changedMetadata = structuredClone(saved);
    mutate(changedMetadata);
    assert.throws(
      () => assertInteractiveDashboardPersisted(changedMetadata, interaction),
      /filter metadata.*persistence mismatch/,
    );
  }

  const broadened = structuredClone(saved);
  broadened.define.portlets[0].extended.ignoreFilters = ['source', 'filter'];
  assert.throws(
    () => assertInteractiveDashboardPersisted(broadened, interaction),
    /target set mismatch/,
  );

  const missingTarget = structuredClone(saved);
  missingTarget.define.portlets = missingTarget.define.portlets.filter(({ id }) => id !== 'target');
  assert.throws(
    () => assertInteractiveDashboardPersisted(missingTarget, interaction),
    /target does not exist after reopen/,
  );
});

test('uses stable jump portlet ids and rejects ambiguous index resolution', () => {
  const portlets = [chartPortlet('chart'), { id: 'text', type: 'TEXT', extended: {} }];
  assert.equal(
    resolveDashboardPortletReference(portlets, {
      portletId: 'chart',
      kind: 'visualization',
      label: 'jump source',
    }).id,
    'chart',
  );
  assert.throws(
    () => resolveDashboardPortletReference(portlets, {
      index: 0,
      kind: 'visualization',
      label: 'jump source',
    }),
    /index resolution is ambiguous/,
  );
});

test('parses only complete supported jump specs', () => {
  const spec = parseDashboardJumpSpec({
    field: 'category',
    targetField: 'category',
    sourcePortletId: 'chart',
    targetFilterPortletId: 'filter',
    openType: 'DIALOG',
  });
  assert.equal(spec.sourcePortletId, 'chart');
  assert.equal(spec.targetFilterPortletId, 'filter');
  assert.throws(
    () => parseDashboardJumpSpec({
      field: 'category',
      sourcePortletId: 'chart',
      targetFilterPortletId: 'filter',
      width: 1200,
    }),
    /unsupported key.*width/,
  );
  assert.throws(
    () => parseDashboardJumpSpec({
      field: 'category',
      targetFilterPortletId: 'filter',
    }),
    /requires exactly one of sourcePortletId or sourceChart/,
  );
});

test('rejects jump field type mismatches', () => {
  assert.equal(assertCompatibleDashboardDataTypes('INTEGER', 'DOUBLE'), 'NUMBER');
  assert.throws(
    () => assertCompatibleDashboardDataTypes('STRING', 'INTEGER'),
    /data types are incompatible/,
  );
});

test('requires jump target filters to impact one existing visualization', () => {
  const chart = chartPortlet('target');
  const filter = filterPortlet([]);
  const dashboard = { define: { portlets: [chart, filter] } };
  assert.throws(
    () => assertFilterImpactsVisualization(dashboard, filter),
    /has no impacted target/,
  );
  filter.extended.impactWidgets = ['missing'];
  assert.throws(
    () => assertFilterImpactsVisualization(dashboard, filter),
    /does not resolve to one portlet/,
  );
  filter.extended.impactWidgets = ['target', 'target'];
  assert.throws(
    () => assertFilterImpactsVisualization(dashboard, filter),
    /duplicate impacted targets/,
  );
  filter.extended.impactWidgets = ['target'];
  assert.deepEqual(assertFilterImpactsVisualization(dashboard, filter), ['target']);
});

test('compares every authored jump-rule field', () => {
  const expected = {
    name: 'jump',
    disabled: false,
    source: { trigger: 'RIGHT_CLICK', fieldIds: [] },
    target: {
      pageId: 'target',
      openType: 'DIALOG',
      url: 'http://',
      title: 'Target',
      width: 900,
      height: 600,
      providerName: 'SMARTBIX_PAGE',
      dialogSize: {
        unit: '%',
        widthRate: 72,
        heightRate: 72,
        width: 900,
        height: 600,
      },
    },
    jumpType: '',
    method: 'post',
    params: [{
      sourceFieldIds: ['source', 'field;cols;0'],
      paramType: 'select',
      targetFieldIds: ['filter', 'target;filters;0'],
    }],
    urlParams: [{ paramName: '', paramType: 'value', paramValues: '' }],
  };
  assert.doesNotThrow(() => assertJumpRulePersisted(structuredClone(expected), expected));
  const changed = structuredClone(expected);
  changed.target.openType = 'NEW_TAB';
  assert.throws(() => assertJumpRulePersisted(changed, expected), /openType differs/);
});

test('repair refuses metadata it cannot preserve without mutating the source', () => {
  const source = repairableDashboard();
  const snapshot = structuredClone(source);
  assert.doesNotThrow(() => assertDashboardRepairable(source));

  const interactive = structuredClone(source);
  interactive.define.portlets[0].extended.jumpRules = [{ name: 'must survive' }];
  assert.throws(() => assertDashboardRepairable(interactive), /unsupported chart metadata/);
  assert.deepEqual(source, snapshot);

  const conditional = structuredClone(source);
  conditional.define.portlets[0].extended.chartDefine = {
    seriesConfig: { global: { conditionalRules: [] } },
  };
  assert.throws(
    () => assertDashboardRepairable(conditional),
    /contains unsupported key.*conditionalRules/,
  );

  const withFilter = structuredClone(source);
  withFilter.define.portlets.push(filterPortlet());
  assert.throws(() => assertDashboardRepairable(withFilter), /non-chart or unsupported portlets/);
});

test('deep-compares saved chart bindings and layout instead of counts', () => {
  const expected = repairableDashboard();
  const saved = structuredClone(expected);
  assert.doesNotThrow(() => assertSavedDashboardMatchesDefinition(saved, expected));

  saved.define.portlets[0].extended.fields.cols.push({
    id: 'field',
    name: 'category',
    label: 'Category',
  });
  assert.throws(
    () => assertSavedDashboardMatchesDefinition(saved, expected),
    /dashboard definition persistence mismatch/,
  );

  const moved = structuredClone(expected);
  moved.define.devices.default.layout.define.floats[1].width = 599;
  assert.throws(
    () => assertSavedDashboardMatchesDefinition(moved, expected),
    /dashboard definition persistence mismatch/,
  );
});
