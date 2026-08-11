import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertDistinctEtlTableIds,
  assertEtlGraphPersisted,
  assertEtlProcessDagMetadataPreserved,
  assertEtlSchemasIdentical,
  assertEtlTableBindingsAllowed,
  createEtlLink,
  assertVerifiedEtlTemplate,
  configureEtlNode,
  describeEtlNodeTemplate,
  extractEtlTableBindings,
  normalizeEtlGraph,
  normalizeEtlNodeCatalog,
  prepareEtlProcessDag,
  spliceUnaryBeforeTerminal,
} from '../scripts/etl-contracts.mjs';

function port(id, order = 0, types = ['DATASET']) {
  return { id, order, types };
}

function etlNode(name, id, inputs, outputs, configs = []) {
  return {
    id,
    name,
    type: name,
    alias: name,
    inputs,
    outputs,
    configs,
    combineConfigs: [],
    state: 'INITED',
  };
}

function linearGraph() {
  const source = etlNode('JDBC_DATASOURCE', 'source', [], [port('source-out')], [{
    name: 'jdbc',
    type: 'json',
    required: true,
    value: JSON.stringify({
      datasourceId: 'DS.input',
      schemaId: 'SCHEMA.input.input.null',
      tableId: 'TAB.input.input.null.TEAM_source',
      tableData: { id: 'TAB.input.input.null.TEAM_source' },
    }),
  }]);
  const target = etlNode('JDBC_DATATARGER_OVERWRITE', 'target', [port('target-in')], [], [{
    name: 'jdbcTarget',
    type: 'json',
    required: true,
    value: JSON.stringify({
      datasourceId: 'DS.input',
      schemaId: 'SCHEMA.input.input.null',
      tableId: 'TEAM_target',
    }),
  }]);
  target.smartbiCliTargetTableId = 'TAB.input.input.null.TEAM_target';
  return {
    version: { editor: 'HORIZONTAL' },
    nodes: [source, target],
    links: [{
      from: source.id,
      to: target.id,
      inputPortId: 'source-out',
      outputPortId: 'target-in',
      serverRevision: 7,
      fieldMapping: { SITE: 'SITE' },
    }],
  };
}

test('rejects dangling links and cyclic ETL graphs', () => {
  const dangling = linearGraph();
  dangling.links[0].inputPortId = 'missing-port';
  assert.throws(() => normalizeEtlGraph(dangling), /dangling or misowned source port/);

  const left = etlNode('DATAPREPARE_ROW_NUMBER', 'left', [port('left-in')], [port('left-out')]);
  const right = etlNode('DATAPREPARE_ROW_NUMBER', 'right', [port('right-in')], [port('right-out')]);
  assert.throws(() => normalizeEtlGraph({
    nodes: [left, right],
    links: [
      { from: 'left', to: 'right', inputPortId: 'left-out', outputPortId: 'right-in' },
      { from: 'right', to: 'left', inputPortId: 'right-out', outputPortId: 'left-in' },
    ],
  }), /contains a cycle/);
});

test('normalizes ordered ports and exposes the complete safe node contract', () => {
  const catalog = normalizeEtlNodeCatalog({
    revision: 'server-revision',
    defaultOptions: [{
      name: 'DATAPREPARE_SAMPLE',
      alias: 'Sample',
      desc: 'sample rows',
      inputs: [
        { id: 'late', order: 2, types: ['DATASET'], optional: true, cardinality: 'one' },
        { id: 'early', order: 1, types: ['DATASET'], optional: false, cardinality: 'one' },
      ],
      outputs: [port('out')],
      configs: [{
        name: 'fraction',
        label: 'Fraction',
        desc: '0 to 1',
        type: 'number',
        required: true,
        options: [0.25, 0.5],
        typeOptions: { minimum: 0, maximum: 1 },
        control: { controlType: 'input' },
        isHidden: false,
        disable: false,
        extra: { unit: 'ratio' },
        iframeUrl: null,
        value: 0.5,
      }, {
        name: 'password',
        type: 'string',
        value: 'must-not-be-exposed',
      }],
      combineConfigs: [],
    }],
  });

  assert.deepEqual(catalog.defaultOptions[0].inputs.map((item) => item.id), ['early', 'late']);
  const contract = describeEtlNodeTemplate(catalog.defaultOptions[0]);
  assert.equal(contract.inputs[0].cardinality, 'one');
  assert.equal(contract.configs[0].desc, '0 to 1');
  assert.deepEqual(contract.configs[0].typeOptions, { minimum: 0, maximum: 1 });
  assert.deepEqual(contract.configs[0].control, { controlType: 'input' });
  assert.equal(Object.hasOwn(contract.configs[1], 'value'), false);
});
test('selects the first declared compatible port pair rather than array position', () => {
  const left = etlNode('LEFT', 'left', [], [
    port('dataset-out', 2, ['DATASET']),
    port('text-out', 1, ['TEXT']),
  ]);
  const right = etlNode('RIGHT', 'right', [
    port('dataset-in', 2, ['DATASET']),
    port('image-in', 1, ['IMAGE']),
  ], []);
  assert.deepEqual(createEtlLink(left, right), {
    from: 'left',
    to: 'right',
    inputPortId: 'dataset-out',
    outputPortId: 'dataset-in',
  });
});

test('validates live config contracts and merges configured-key provenance', () => {
  const template = etlNode(
    'DATAPREPARE_SAMPLE',
    'template',
    [port('template-in')],
    [port('template-out')],
    [
      { name: 'fraction', type: 'number', required: true, value: '' },
      { name: 'seed', type: 'integer', required: false, value: 1 },
      { name: 'mode', type: 'select', required: true, options: ['random', 'first'], value: 'random' },
    ],
  );
  const saved = structuredClone(template);
  saved.smartbiCliConfiguredKeys = ['seed'];
  const configured = configureEtlNode(saved, template, { fraction: '0.5' });
  assert.deepEqual(configured.configuredKeys, ['fraction', 'seed']);
  assert.equal(configured.node.configs.find((item) => item.name === 'mode').value, 'random');
  assert.throws(() => configureEtlNode(saved, template, {}), /fraction is required/);
  assert.throws(() => configureEtlNode(saved, template, { fraction: 'bad' }), /must be numeric/);
  assert.throws(() => configureEtlNode(saved, template, { unknown: 1 }), /no config named unknown/);
  assert.throws(
    () => configureEtlNode(saved, { ...template, combineConfigs: [{ names: ['fraction', 'mode'] }] }, { fraction: 0.5 }),
    /unsupported combined-config contract/,
  );
  const drifted = structuredClone(saved);
  drifted.outputs[0].types = ['TEXT'];
  assert.throws(
    () => configureEtlNode(drifted, template, { fraction: 0.5 }),
    /live port contract changed/,
  );
});

test('splices a live unary node before a zero-output terminal and preserves link metadata', () => {
  const graph = linearGraph();
  const rowNumber = etlNode(
    'DATAPREPARE_ROW_NUMBER',
    'row-number',
    [port('row-in')],
    [port('row-out')],
    [{ name: 'name', type: 'string', required: true, value: 'row_number' }],
  );
  const result = spliceUnaryBeforeTerminal(graph, rowNumber);
  assert.equal(result.graph.links.length, 2);
  const upstream = result.graph.links.find((link) => link.to === 'row-number');
  const downstream = result.graph.links.find((link) => link.from === 'row-number');
  assert.equal(upstream.serverRevision, 7);
  assert.deepEqual(upstream.fieldMapping, { SITE: 'SITE' });
  assert.equal(upstream.outputPortId, 'row-in');
  assert.equal(downstream.to, 'target');
  assert.equal(downstream.inputPortId, 'row-out');
  assert.doesNotThrow(() => assertEtlGraphPersisted(result.graph, structuredClone(result.graph)));
});

test('schema identity rejects equal-width wrong names, wrong types, and duplicate fields', () => {
  const canonical = [
    { name: 'SITE', dataType: 'varchar' },
    { name: 'Q1', dataType: 'integer' },
  ];
  assert.doesNotThrow(() => assertEtlSchemasIdentical(canonical, [
    { name: 'SITE', dataType: 'VARCHAR' },
    { name: 'Q1', dataType: 'INTEGER' },
  ]));
  assert.throws(() => assertEtlSchemasIdentical(canonical, [
    { name: 'SITE', dataType: 'VARCHAR' },
    { name: 'AGE', dataType: 'INTEGER' },
  ]), /mismatch at ordinal 1/);
  assert.throws(() => assertEtlSchemasIdentical(canonical, [
    { name: 'SITE', dataType: 'VARCHAR' },
    { name: 'Q1', dataType: 'VARCHAR' },
  ]), /mismatch at ordinal 1/);
  assert.throws(() => assertEtlSchemasIdentical(canonical, [
    { name: 'SITE', dataType: 'VARCHAR' },
    { name: 'site', dataType: 'VARCHAR' },
  ]), /duplicate field/);
});

test('definition changes preserve unknown metadata but clear stale run identity', () => {
  const graph = linearGraph();
  graph.nodes[0].state = 'FINISH';
  const originalDefine = JSON.stringify(graph);
  const processDag = {
    id: 'flow',
    name: 'TEAM_flow',
    define: originalDefine,
    state: 'FINISH',
    currentInstanceId: 'stale-instance',
    runningInfo: { dagState: 'FINISH', costTime: 12, serverDetail: 'keep' },
    schedule: { cron: 'captured-server-value' },
    permissionRevision: 9,
  };
  const changed = prepareEtlProcessDag(processDag, graph, { definitionChanged: true });
  assert.equal(changed.currentInstanceId, null);
  assert.equal(changed.state, 'INITED');
  assert.deepEqual(
    JSON.parse(changed.define).nodes.map((node) => node.state),
    ['INITED', 'INITED'],
  );
  assert.deepEqual(changed.schedule, processDag.schedule);
  assert.equal(changed.permissionRevision, 9);
  assert.equal(changed.runningInfo.serverDetail, 'keep');
  assert.doesNotThrow(() => assertEtlProcessDagMetadataPreserved(
    changed,
    { ...changed, lastModifiedDate: 'server-managed' },
  ));
  assert.throws(
    () => assertEtlProcessDagMetadataPreserved(
      changed,
      { ...changed, schedule: { cron: 'changed-by-server' } },
    ),
    /changed metadata field schedule/,
  );

  const metadataOnly = prepareEtlProcessDag(
    { ...processDag, desc: 'new description' },
    graph,
    { definitionChanged: false },
  );
  assert.equal(metadataOnly.currentInstanceId, 'stale-instance');
  assert.equal(metadataOnly.state, 'FINISH');
  assert.equal(metadataOnly.define, originalDefine);
});

test('competition binding policy rejects duplicate, cross-target, and foreign direct-child sources', () => {
  const bindings = extractEtlTableBindings(linearGraph());
  const personalFolder = {
    dsId: 'DS.input',
    bindingSchemaId: 'SCHEMA.input.input.null',
  };
  const personalChildren = [
    { id: 'TAB.input.input.null.TEAM_source' },
    { id: 'TAB.input.input.null.TEAM_target' },
  ];
  assert.doesNotThrow(() => assertEtlTableBindingsAllowed({
    sources: bindings.sources,
    target: bindings.targets[0],
    personalFolder,
    personalChildren,
    competition: true,
  }));
  assert.throws(() => assertEtlTableBindingsAllowed({
    sources: [...bindings.sources, { ...bindings.sources[0], tableId: 'TAB.input.input.null.TEAM_other' }],
    target: bindings.targets[0],
    personalFolder,
    personalChildren: [...personalChildren, { id: 'TAB.input.input.null.TEAM_other' }],
    competition: true,
  }), /exactly one persisted source/);
  assert.throws(() => assertDistinctEtlTableIds(
    ['TAB.input.input.null.TEAM_target'],
    'TAB.input.input.null.TEAM_target',
  ), /source and target table ids must differ/);
  assert.throws(() => assertEtlTableBindingsAllowed({
    sources: [{ ...bindings.sources[0], tableId: 'TAB.input.input.null.FOREIGN' }],
    target: bindings.targets[0],
    personalFolder,
    personalChildren,
    competition: true,
  }), /not a direct child/);
});

test('unsupported node effects fail closed', () => {
  const unsupported = etlNode(
    'CUSTOM_FILTER_PLUGIN',
    'custom',
    [port('custom-in')],
    [port('custom-out')],
  );
  assert.throws(() => assertVerifiedEtlTemplate(unsupported, 'insert'), /effect is not verified/);
  assert.throws(
    () => normalizeEtlNodeCatalog({ defaultOptions: 'unexpected-shape' }),
    /no non-empty defaultOptions array/,
  );
});
