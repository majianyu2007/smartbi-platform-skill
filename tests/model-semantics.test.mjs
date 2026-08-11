import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertModelReferenceGraph,
  assertModelBaselineUnchanged,
  assertNoModelCloneResidue,
  assertSavedModelEquivalent,
  assertOnlyModelCollectionsChanged,
  buildExplicitMeasures,
  normalizeMeasureSpecifications,
  normalizeModelSourceTable,
  qualifyModelResource,
  remapModelClone,
  synchronizeModelMeasureNode,
} from '../scripts/model-semantics.mjs';

const SOURCE_REFERENCE = {
  dataSourceId: 'DS.input',
  tableId: 'TAB.input.input.null.team_people',
  tableName: 'team_people',
};

function sourceTable() {
  return {
    id: SOURCE_REFERENCE.tableId,
    originId: SOURCE_REFERENCE.tableId,
    name: SOURCE_REFERENCE.tableName,
    alias: 'TEAM_people',
    schema: 'input',
    dataSource: { id: SOURCE_REFERENCE.dataSourceId, type: { name: 'MYSQL' } },
    fields: [
      { id: 'respondent_id', name: 'respondent_id', alias: 'Respondent ID', dataType: 'BIGINT' },
      { id: 'weight', name: 'weight', alias: 'Survey weight', dataType: 'DOUBLE' },
      { id: 'region', name: 'region', alias: 'Region', dataType: 'STRING' },
    ],
  };
}

function modelFixture({ relational = false } = {}) {
  const modelId = 'model-target';
  const firstViewId = 'view-people';
  const firstSourceFields = sourceTable().fields;
  const firstFields = firstSourceFields.map((field, order) => ({
    id: qualifyModelResource(modelId, 'FIELD', field.id),
    name: field.name,
    alias: field.alias,
    desc: field.alias,
    valueType: field.dataType,
    dataFormat: '',
    viewId: firstViewId,
    referenceFieldId: field.id,
    order,
    parentId: firstViewId,
  }));
  const measures = buildExplicitMeasures({
    modelId,
    viewId: firstViewId,
    sourceFields: firstSourceFields,
    modelFields: firstFields,
    specifications: [{
      field: 'respondent_id',
      aggregator: 'DISTINCT_COUNT',
      alias: 'Respondents',
      businessDefinition: 'Unique submitted respondent identifiers',
    }],
    idFactory: () => 'measure-respondents',
  });
  const views = [{
    id: firstViewId,
    name: 'team_people',
    alias: 'TEAM_people',
    type: 'BASIC_TABLE',
    storeType: 'DIRECT',
    fields: firstSourceFields,
    define: {
      dataSource: 'DS.input',
      schema: 'input',
      tableId: 'TAB.input.input.null.team_people',
      tableName: 'team_people',
    },
  }];
  const fields = [...firstFields];
  const nodes = [
    ...firstFields.map((field) => ({
      ...field,
      type: 'FIELD',
      group: 'DIMENSION',
      children: [],
    })),
    ...measures.map((measure) => ({ ...measure })),
  ];
  const relations = [];
  const positions = [{ viewId: firstViewId, x: 0, y: 0 }];

  if (relational) {
    const secondViewId = 'view-regions';
    const sourceField = { id: 'region_code', name: 'region_code', alias: 'Region code', dataType: 'STRING' };
    const secondField = {
      id: qualifyModelResource(modelId, 'FIELD', sourceField.id),
      name: sourceField.name,
      alias: sourceField.alias,
      desc: sourceField.alias,
      valueType: sourceField.dataType,
      dataFormat: '',
      viewId: secondViewId,
      referenceFieldId: sourceField.id,
      order: fields.length,
      parentId: secondViewId,
    };
    views.push({
      id: secondViewId,
      name: 'team_regions',
      alias: 'TEAM_regions',
      type: 'BASIC_TABLE',
      storeType: 'DIRECT',
      fields: [sourceField],
      define: {
        dataSource: 'DS.input',
        schema: 'input',
        tableId: 'TAB.input.input.null.team_regions',
        tableName: 'team_regions',
      },
    });
    fields.push(secondField);
    nodes.push({ ...secondField, type: 'FIELD', group: 'DIMENSION', children: [] });
    positions.push({ viewId: secondViewId, x: 100, y: 0 });
    relations.push({
      srcViewId: firstViewId,
      destViewId: secondViewId,
      fieldRelations: [{
        srcFieldId: firstFields[2].id,
        destFieldId: secondField.id,
        operator: 'EQUALS',
      }],
      linkType: 'LEFTJOIN',
      cardinalityType: 'MANY2ONE',
      filterDirection: 'SINGLE',
      assumeReferentialIntegrity: 'INCOMPLETENESS',
    });
  }

  return {
    id: modelId,
    name: 'TEAM_model',
    alias: 'TEAM_model',
    desc: 'model',
    storeType: 'DIRECT',
    views,
    fields,
    measures,
    levels: [],
    calcMeasures: [],
    calcMembers: [],
    namedSets: [],
    parameters: [],
    nodes,
    relationGraph: { relations, positions, layouts: [], activeLayout: '0' },
    deletedViews: [],
    preAggregates: [],
    directPartitions: [],
    extractStatus: 'INIT',
    cacheSetting: null,
    _extendProps: { batchId: 'batch-source' },
  };
}

test('numeric identifiers are not measures unless the caller explicitly specifies an aggregator', () => {
  const table = sourceTable();
  assert.deepEqual(normalizeMeasureSpecifications(table.fields, []), []);
  assert.throws(
    () => normalizeMeasureSpecifications(table.fields),
    /explicit measures JSON array is required/,
  );

  const modelField = {
    id: qualifyModelResource('model', 'FIELD', 'respondent_id'),
    viewId: 'view',
    referenceFieldId: 'respondent_id',
  };
  const measures = buildExplicitMeasures({
    modelId: 'model',
    viewId: 'view',
    sourceFields: table.fields,
    modelFields: [modelField],
    specifications: [{ field: 'respondent_id', aggregator: 'SUM' }],
    idFactory: () => 'explicit-id-sum',
  });
  assert.equal(measures.length, 1);
  assert.equal(measures[0].aggregator, 'sum');
  assert.equal(measures[0].refDataSetFieldId, modelField.id);
});

test('source table normalization rejects a returned data-source, schema, or table mismatch', () => {
  assert.doesNotThrow(() => normalizeModelSourceTable(sourceTable(), SOURCE_REFERENCE));
  assert.throws(
    () => normalizeModelSourceTable({
      ...sourceTable(),
      dataSource: { id: 'DS.other' },
    }, SOURCE_REFERENCE),
    /returned source identity mismatch/,
  );
  assert.throws(
    () => normalizeModelSourceTable({
      ...sourceTable(),
      originId: 'TAB.input.other.null.team_people',
      schema: 'other',
    }, SOURCE_REFERENCE),
    /returned source identity mismatch|schema mismatch/,
  );
  assert.throws(
    () => normalizeModelSourceTable({
      ...sourceTable(),
      originId: 'TAB.input.input.null.other_people',
      name: 'other_people',
    }, SOURCE_REFERENCE),
    /returned source identity mismatch/,
  );
});

test('deep saved-model equivalence rejects relation and measure-node metadata drift', () => {
  const expected = modelFixture({ relational: true });
  assert.doesNotThrow(() => assertSavedModelEquivalent(expected, structuredClone(expected)));

  const relationDrift = structuredClone(expected);
  relationDrift.relationGraph.relations[0].filterDirection = 'BOTH';
  assert.throws(
    () => assertSavedModelEquivalent(expected, relationDrift),
    /semantic definition does not match/,
  );

  const nodeDrift = structuredClone(expected);
  nodeDrift.nodes.find((node) => node.id === expected.measures[0].id).alias = 'Wrong alias';
  assert.throws(
    () => assertModelReferenceGraph(nodeDrift),
    /measure node metadata mismatch/,
  );
});

test('accepts server-assigned measure node placement metadata', () => {
  const expected = modelFixture();
  const saved = structuredClone(expected);
  const measureNode = saved.nodes.find((node) => node.id === saved.measures[0].id);
  measureNode.order = 4;
  delete measureNode.refDataSetFieldId;
  assert.doesNotThrow(() => assertModelReferenceGraph(saved));
  assert.doesNotThrow(() => assertSavedModelEquivalent(expected, saved));
});

test('relational measure-name collisions synchronize measure node metadata', () => {
  const model = modelFixture();
  const changedMeasure = {
    ...model.measures[0],
    name: 'team_people_respondent_id_m',
    alias: 'TEAM Respondents',
    aliasFromDb: 'TEAM Respondents',
    order: 7,
  };
  const node = { ...model.nodes.find((candidate) => candidate.id === changedMeasure.id) };
  synchronizeModelMeasureNode(changedMeasure, node);
  assert.equal(node.name, changedMeasure.name);
  assert.equal(node.alias, changedMeasure.alias);
  assert.equal(node.aliasFromDb, changedMeasure.aliasFromDb);
  assert.equal(node.order, changedMeasure.order);
  assert.equal(node.refDataSetFieldId, changedMeasure.refDataSetFieldId);
});

test('full-model mutation guards reject stale baselines and unintended semantic deltas', () => {
  const baseline = modelFixture();
  assert.doesNotThrow(() => assertModelBaselineUnchanged(baseline, structuredClone(baseline)));
  const stale = structuredClone(baseline);
  stale.fields[0].alias = 'Concurrent edit';
  assert.throws(
    () => assertModelBaselineUnchanged(baseline, stale),
    /refusing stale full-model overwrite/,
  );

  const hierarchyOnly = structuredClone(baseline);
  hierarchyOnly.nodes.push({
    id: 'hierarchy-node',
    name: 'hierarchy',
    type: 'HIERARCHY',
    children: [],
  });
  assert.doesNotThrow(() => assertOnlyModelCollectionsChanged(
    baseline,
    hierarchyOnly,
    ['nodes'],
  ));
  assert.throws(
    () => assertOnlyModelCollectionsChanged(baseline, stale, ['nodes']),
    /unintended semantic collection: fields/,
  );
});

test('model clone remapping updates keyed and nested references and leaves no source residue', () => {
  const source = modelFixture({ relational: true });
  source.fieldTreeSetting = {
    [source.id]: { activeView: source.views[0].id },
  };
  const cloned = remapModelClone(source, {
    modelId: 'model-clone',
    viewIds: new Map(source.views.map((view, index) => [view.id, `clone-view-${index}`])),
    batchId: 'batch-clone',
  });
  assert.equal(cloned.id, 'model-clone');
  assert.equal(cloned._extendProps.batchId, 'batch-clone');
  assert.ok(Object.hasOwn(cloned.fieldTreeSetting, 'model-clone'));
  assert.doesNotThrow(() => assertNoModelCloneResidue(
    cloned,
    [source.id, ...source.views.map((view) => view.id), 'batch-source'],
  ));
});
