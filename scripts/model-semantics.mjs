const MODEL_AGGREGATOR_VALUES = [
  'SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'DISTINCT_COUNT', 'NONE',
  'FIRST_MEMBER', 'LAST_MEMBER', 'STDDEV_POP', 'STDDEV_SAMP',
  'VAR_POP', 'VAR_SAMP', 'ATTR',
];

export const MODEL_AGGREGATORS = Object.freeze([...MODEL_AGGREGATOR_VALUES]);

const MODEL_AGGREGATOR_SET = new Set(MODEL_AGGREGATOR_VALUES);
const INTEGER_TYPES = new Set(['BYTE', 'SHORT', 'SMALLINT', 'INTEGER', 'INT', 'LONG', 'BIGINT']);

function requiredText(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

export function stableModelJson(value) {
  return JSON.stringify(stableValue(value));
}

export function qualifyModelResource(modelId, type, id) {
  const normalizedModelId = requiredText(modelId, 'model id');
  const normalizedType = requiredText(type, 'model resource type').toUpperCase();
  const source = requiredText(id, `${normalizedType} resource id`);
  const expectedPrefix = `AUGMENTED_DATASET_${normalizedType}.${normalizedModelId}.`;
  if (source.startsWith('AUGMENTED_DATASET_')) {
    if (!source.startsWith(expectedPrefix)) {
      throw new Error(`${normalizedType} resource belongs to another model: ${source}`);
    }
    return source;
  }
  return `${expectedPrefix}${source}`;
}

export function parseModelTableId(tableId) {
  const normalized = requiredText(tableId, 'source table id');
  const parts = normalized.split('.');
  if (parts.length < 5 || parts[0] !== 'TAB') {
    throw new Error(`unsupported source table id: ${normalized}`);
  }
  const [, catalog, schema, nullMarker, ...tableParts] = parts;
  if (![catalog, schema, nullMarker].every((part) => String(part).trim()) || tableParts.length === 0) {
    throw new Error(`incomplete source table id: ${normalized}`);
  }
  const table = tableParts.join('.');
  if (!table) throw new Error(`source table id has no physical table name: ${normalized}`);
  return {
    tableId: normalized,
    catalog,
    schema: `SCHEMA.${catalog}.${schema}.${nullMarker}`,
    schemaName: schema,
    table,
  };
}

export function normalizeModelSourceReference(reference) {
  if (!plainObject(reference)) throw new Error('model source reference must be an object');
  const dataSource = requiredText(reference.dataSourceId, 'source dataSourceId');
  const tableId = requiredText(reference.tableId, 'source tableId');
  const requestedTableName = requiredText(reference.tableName, 'source tableName');
  const parsed = parseModelTableId(tableId);
  if (requestedTableName !== parsed.table) {
    throw new Error(
      `source tableName does not exactly match tableId: expected ${parsed.table}, received ${requestedTableName}`,
    );
  }
  return {
    dataSource,
    schema: parsed.schema,
    table: parsed.table,
    tableId: parsed.tableId,
  };
}

function normalizeReturnedSchema(value, expected) {
  if (value === undefined || value === null || value === '') return expected.schema;
  const normalized = requiredText(value, 'returned source schema');
  const parsed = parseModelTableId(expected.tableId);
  if (normalized !== expected.schema && normalized !== parsed.schemaName) {
    throw new Error(
      `returned source schema mismatch: expected ${expected.schema}, received ${normalized}`,
    );
  }
  return expected.schema;
}

function normalizeSourceFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('returned source table must contain fields');
  }
  const ids = new Set();
  const names = new Set();
  return fields.map((field, index) => {
    if (!plainObject(field)) throw new Error(`source field ${index + 1} must be an object`);
    const id = requiredText(field.id, `source field ${index + 1} id`);
    const name = requiredText(field.name, `source field ${index + 1} name`);
    const dataType = requiredText(field.dataType, `source field ${index + 1} dataType`).toUpperCase();
    if (ids.has(id)) throw new Error(`duplicate source field id: ${id}`);
    if (names.has(name)) throw new Error(`duplicate source field name: ${name}`);
    ids.add(id);
    names.add(name);
    return {
      ...field,
      id,
      name,
      dataType,
      alias: field.alias == null ? field.alias : String(field.alias).trim(),
      desc: field.desc == null ? field.desc : String(field.desc),
      dataFormat: field.dataFormat == null ? field.dataFormat : String(field.dataFormat),
    };
  });
}

export function normalizeModelSourceTable(table, expectedReference) {
  if (!plainObject(table)) throw new Error('returned source table metadata must be an object');
  const expected = normalizeModelSourceReference(expectedReference);
  const actualDataSource = requiredText(table.dataSource?.id, 'returned source dataSource id');
  const actualTableId = requiredText(table.originId, 'returned source table id');
  const actualTableName = requiredText(table.name, 'returned source table name');
  const parsedActual = parseModelTableId(actualTableId);
  const actual = {
    dataSource: actualDataSource,
    schema: normalizeReturnedSchema(table.schema, {
      ...expected,
      tableId: actualTableId,
    }),
    table: parsedActual.table,
    tableId: actualTableId,
  };
  if (
    actual.dataSource !== expected.dataSource
    || actual.schema !== expected.schema
    || actual.table !== expected.table
    || actual.tableId !== expected.tableId
    || actualTableName !== expected.table
  ) {
    throw new Error(
      'returned source identity mismatch: '
      + `expected (${expected.dataSource},${expected.schema},${expected.table}), `
      + `received (${actual.dataSource},${actual.schema},${actual.table})`,
    );
  }
  return {
    identity: expected,
    table: {
      ...table,
      dataSource: { ...table.dataSource, id: actualDataSource },
      originId: actualTableId,
      name: actualTableName,
      fields: normalizeSourceFields(table.fields),
    },
  };
}

function resolveSourceField(fields, requested, label) {
  const fieldName = requiredText(requested, label);
  const matches = fields.filter((field) => (
    [field.id, field.name, field.alias].filter(Boolean).includes(fieldName)
  ));
  if (matches.length !== 1) {
    throw new Error(`${label} must resolve exactly once: ${fieldName}`);
  }
  return matches[0];
}

export function normalizeMeasureSpecifications(sourceFields, specifications) {
  if (!Array.isArray(specifications)) {
    throw new Error('an explicit measures JSON array is required (use [] for no measures)');
  }
  const allowedKeys = new Set(['field', 'aggregator', 'alias', 'format', 'businessDefinition']);
  const usedFields = new Set();
  const usedAliases = new Set();
  return specifications.map((specification, index) => {
    if (!plainObject(specification)) {
      throw new Error(`measure ${index + 1} specification must be an object`);
    }
    for (const key of Object.keys(specification)) {
      if (!allowedKeys.has(key)) throw new Error(`measure ${index + 1} has unsupported property: ${key}`);
    }
    const field = resolveSourceField(
      sourceFields,
      specification.field,
      `measure ${index + 1} field`,
    );
    if (usedFields.has(field.id)) throw new Error(`duplicate measure field: ${field.id}`);
    usedFields.add(field.id);
    const aggregator = requiredText(
      specification.aggregator,
      `measure ${index + 1} aggregator`,
    ).toUpperCase();
    if (!MODEL_AGGREGATOR_SET.has(aggregator)) {
      throw new Error(`measure ${index + 1} has unsupported aggregator: ${aggregator}`);
    }
    const alias = specification.alias == null
      ? String(field.alias || field.name).trim()
      : requiredText(specification.alias, `measure ${index + 1} alias`);
    if (usedAliases.has(alias)) throw new Error(`duplicate measure alias: ${alias}`);
    usedAliases.add(alias);
    const format = specification.format == null
      ? String(field.dataFormat || '')
      : String(specification.format);
    const businessDefinition = specification.businessDefinition == null
      ? null
      : requiredText(
        specification.businessDefinition,
        `measure ${index + 1} businessDefinition`,
      );
    return { field, aggregator, alias, format, businessDefinition };
  });
}

export function buildExplicitMeasures({
  modelId,
  viewId,
  sourceFields,
  modelFields,
  specifications,
  idFactory,
}) {
  if (typeof idFactory !== 'function') throw new Error('measure id factory is required');
  const normalized = normalizeMeasureSpecifications(sourceFields, specifications);
  return normalized.map(({ field, aggregator, alias, format, businessDefinition }, order) => {
    const modelFieldMatches = modelFields.filter((candidate) => (
      candidate.viewId === viewId && candidate.referenceFieldId === field.id
    ));
    if (modelFieldMatches.length !== 1) {
      throw new Error(`measure source field has no unique model field: ${field.id}`);
    }
    const sourceType = String(field.dataType).toUpperCase();
    const valueType = INTEGER_TYPES.has(sourceType) ? 'BIGINT' : sourceType;
    const measureId = qualifyModelResource(modelId, 'MEASURE', idFactory());
    return {
      id: measureId,
      name: `${field.name}_m`,
      aliasFromDb: alias,
      descFromDb: businessDefinition,
      useFromDb: false,
      valueType,
      dataFormat: format,
      sqlColumnName: null,
      maskingRule: null,
      viewId,
      viewAlias: null,
      visible: 1,
      aggregator: aggregator.toLowerCase(),
      refDataSetFieldId: modelFieldMatches[0].id,
      transformRule: null,
      extended: null,
      resType: null,
      desc: businessDefinition,
      alias,
      creatorId: null,
      type: 'MEASURE',
      level: 0,
      order,
      parentId: 'measure',
      group: 'MEASURE',
      businessCaliber: businessDefinition,
      children: [],
    };
  });
}
export function synchronizeModelMeasureNode(measure, node) {
  if (!plainObject(measure) || !plainObject(node) || measure.id !== node.id) {
    throw new Error('measure and measure node must share one id');
  }
  for (const key of [
    'name',
    'alias',
    'aliasFromDb',
    'desc',
    'descFromDb',
    'businessCaliber',
    'order',
    'refDataSetFieldId',
    'aggregator',
    'valueType',
    'dataFormat',
    'viewId',
  ]) {
    node[key] = measure[key] ?? null;
  }
  return node;
}

export function modelViewSourceTuple(view) {
  const define = view?.define;
  if (!plainObject(define)) throw new Error(`model view has no source definition: ${view?.id || 'unknown'}`);
  const dataSource = requiredText(define.dataSource, `model view ${view?.id || ''} data source`);
  const tableId = requiredText(define.tableId, `model view ${view?.id || ''} table id`);
  const tableName = requiredText(define.tableName, `model view ${view?.id || ''} table name`);
  const parsed = parseModelTableId(tableId);
  if (tableName !== parsed.table) {
    throw new Error(`model view table identity mismatch: ${tableId} / ${tableName}`);
  }
  if (define.schema !== undefined && define.schema !== null && define.schema !== '') {
    normalizeReturnedSchema(define.schema, {
      dataSource,
      schema: parsed.schema,
      table: parsed.table,
      tableId,
    });
  }
  return { dataSource, schema: parsed.schema, table: parsed.table };
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    const normalized = requiredText(value, label);
    if (seen.has(normalized)) throw new Error(`duplicate ${label}: ${normalized}`);
    seen.add(normalized);
  }
  return seen;
}

function nodeById(model, id) {
  return (model.nodes || []).filter((node) => node?.id === id);
}

export function assertModelReferenceGraph(model) {
  if (!plainObject(model)) throw new Error('saved model must be an object');
  const modelId = requiredText(model.id, 'saved model id');
  requiredText(model.name, 'saved model name');
  for (const key of [
    'nodes',
    'measures',
    'levels',
    'calcMeasures',
    'calcMembers',
    'namedSets',
    'parameters',
  ]) {
    if (!Array.isArray(model[key])) throw new Error(`saved model ${key} must be an array`);
  }
  if (!plainObject(model.relationGraph)) throw new Error('saved model relationGraph must be an object');
  for (const key of ['relations', 'positions', 'layouts']) {
    if (!Array.isArray(model.relationGraph[key])) {
      throw new Error(`saved model relationGraph.${key} must be an array`);
    }
  }
  if (!Array.isArray(model.views) || model.views.length === 0) {
    throw new Error('saved model must contain at least one view');
  }
  const viewIds = assertUnique(model.views.map((view) => view?.id), 'model view id');
  const viewsById = new Map(model.views.map((view) => [view.id, view]));
  for (const view of model.views) {
    modelViewSourceTuple(view);
    if (!Array.isArray(view.fields) || view.fields.length === 0) {
      throw new Error(`saved model view ${view.id} must contain source fields`);
    }
    assertUnique((view.fields || []).map((field) => field?.id), `source field id in view ${view.id}`);
  }
  assertUnique((model.nodes || []).map((node) => node?.id), 'model node id');

  if (!Array.isArray(model.fields) || model.fields.length === 0) {
    throw new Error('saved model must contain fields');
  }
  assertUnique(model.fields.map((field) => field?.id), 'model field id');
  const fieldIds = new Set();
  const fieldsById = new Map();
  for (const field of model.fields) {
    const id = qualifyModelResource(modelId, 'FIELD', field.id);
    if (id !== field.id) throw new Error(`model field id is not qualified: ${field.id}`);
    if (!viewIds.has(field.viewId)) throw new Error(`model field references missing view: ${field.id}`);
    const sourceMatches = (viewsById.get(field.viewId)?.fields || [])
      .filter((sourceField) => sourceField.id === field.referenceFieldId);
    if (sourceMatches.length !== 1) {
      throw new Error(`model field source reference must resolve exactly once: ${field.id}`);
    }
    if (nodeById(model, field.id).length !== 1) {
      throw new Error(`model field node must resolve exactly once: ${field.id}`);
    }
    fieldIds.add(field.id);
    fieldsById.set(field.id, field);
  }

  assertUnique((model.measures || []).map((measure) => measure?.id), 'model measure id');
  for (const measure of model.measures || []) {
    const id = qualifyModelResource(modelId, 'MEASURE', measure.id);
    if (id !== measure.id) throw new Error(`model measure id is not qualified: ${measure.id}`);
    const aggregator = requiredText(measure.aggregator, `measure ${measure.id} aggregator`).toUpperCase();
    if (!MODEL_AGGREGATOR_SET.has(aggregator)) {
      throw new Error(`saved measure has unsupported aggregator: ${measure.id}/${aggregator}`);
    }
    if (!fieldIds.has(measure.refDataSetFieldId)) {
      throw new Error(`measure references missing qualified model field: ${measure.id}`);
    }
    const field = fieldsById.get(measure.refDataSetFieldId);
    if (field.viewId !== measure.viewId) {
      throw new Error(`measure and source field belong to different views: ${measure.id}`);
    }
    const nodes = nodeById(model, measure.id);
    if (nodes.length !== 1) throw new Error(`model measure node must resolve exactly once: ${measure.id}`);
    const node = nodes[0];
    if (node.type !== 'MEASURE') {
      throw new Error(`model measure node has an unexpected type: ${measure.id}/${node.type}`);
    }
    for (const key of ['name', 'alias', 'aliasFromDb']) {
      if ((node[key] ?? null) !== (measure[key] ?? null)) {
        throw new Error(`model measure node metadata mismatch for ${measure.id}: ${key}`);
      }
    }
  }

  for (const relation of model.relationGraph?.relations || []) {
    if (!viewIds.has(relation.srcViewId) || !viewIds.has(relation.destViewId)) {
      throw new Error('model relation references a missing view');
    }
    if (!Array.isArray(relation.fieldRelations) || relation.fieldRelations.length === 0) {
      throw new Error('model relation has no field relation');
    }
    for (const fieldRelation of relation.fieldRelations) {
      const source = fieldsById.get(fieldRelation.srcFieldId);
      const destination = fieldsById.get(fieldRelation.destFieldId);
      if (!source || source.viewId !== relation.srcViewId) {
        throw new Error(`relation source field is invalid: ${fieldRelation.srcFieldId}`);
      }
      if (!destination || destination.viewId !== relation.destViewId) {
        throw new Error(`relation destination field is invalid: ${fieldRelation.destFieldId}`);
      }
      if (fieldRelation.operator !== 'EQUALS') {
        throw new Error(`unsupported persisted relation operator: ${fieldRelation.operator}`);
      }
    }
  }

  assertUnique((model.levels || []).map((level) => level?.id), 'model level id');
  for (const level of model.levels || []) {
    const id = qualifyModelResource(modelId, 'LEVEL', level.id);
    if (id !== level.id) throw new Error(`model level id is not qualified: ${level.id}`);
    const reference = requiredText(level.refDataSetFieldId, `level ${level.id} source reference`);
    if (!fieldIds.has(reference)) throw new Error(`level references missing model field: ${level.id}`);
    const nodes = nodeById(model, level.id);
    if (nodes.length !== 1 || nodes[0].type !== level.levelType) {
      throw new Error(`model level node metadata mismatch: ${level.id}`);
    }
  }
  assertUnique(
    (model.calcMeasures || []).map((measure) => measure?.id),
    'model calculated measure id',
  );
  for (const measure of model.calcMeasures || []) {
    const id = qualifyModelResource(modelId, 'CALC_MEASURE', measure.id);
    if (id !== measure.id) {
      throw new Error(`model calculated measure id is not qualified: ${measure.id}`);
    }
    if (!String(measure.expression || '').trim()) {
      throw new Error(`model calculated measure has no expression: ${measure.id}`);
    }
    const nodes = nodeById(model, measure.id);
    if (nodes.length !== 1 || nodes[0].type !== 'CALC_MEASURE') {
      throw new Error(`model calculated measure node metadata mismatch: ${measure.id}`);
    }
  }
  return model;
}

function sourceFieldSemantics(field) {
  return {
    id: field.id,
    name: field.name,
    alias: field.alias ?? null,
    dataType: String(field.dataType || field.valueType || '').toUpperCase(),
    dataFormat: field.dataFormat ?? '',
  };
}

function nodeSemantics(node, serverOwnedMeasureNodeIds = new Set()) {
  const serverOwnedMeasureNode = serverOwnedMeasureNodeIds.has(node.id);
  return {
    id: node.id,
    name: node.name,
    alias: node.alias ?? null,
    aliasFromDb: node.aliasFromDb ?? null,
    desc: node.desc ?? null,
    descFromDb: node.descFromDb ?? null,
    type: node.type,
    group: node.group ?? null,
    parentId: node.parentId ?? null,
    order: serverOwnedMeasureNode ? null : (node.order ?? null),
    visible: node.visible ?? null,
    reportVisible: node.reportVisible ?? null,
    useFromDb: node.useFromDb ?? null,
    valueType: node.valueType ?? null,
    dataFormat: node.dataFormat ?? null,
    aggregator: node.aggregator == null ? null : String(node.aggregator).toUpperCase(),
    refDataSetFieldId: serverOwnedMeasureNode ? null : (node.refDataSetFieldId ?? null),
    referenceFieldId: node.referenceFieldId ?? null,
    businessCaliber: node.businessCaliber ?? null,
    viewId: node.viewId ?? null,
    levelType: node.levelType ?? null,
    extended: node.extended ?? null,
    children: (node.children || []).map((child) => nodeSemantics(child, serverOwnedMeasureNodeIds)),
  };
}

function fieldSemantics(field) {
  return {
    id: field.id,
    name: field.name,
    alias: field.alias ?? null,
    desc: field.desc ?? null,
    viewId: field.viewId,
    referenceFieldId: field.referenceFieldId,
    valueType: String(field.valueType || '').toUpperCase(),
    dataFormat: field.dataFormat ?? '',
    order: field.order ?? null,
    parentId: field.parentId ?? null,
  };
}

function measureSemantics(measure) {
  return {
    id: measure.id,
    name: measure.name,
    alias: measure.alias ?? null,
    aliasFromDb: measure.aliasFromDb ?? null,
    desc: measure.desc ?? null,
    businessCaliber: measure.businessCaliber ?? null,
    viewId: measure.viewId ?? null,
    valueType: String(measure.valueType || '').toUpperCase(),
    dataFormat: measure.dataFormat ?? '',
    aggregator: measure.aggregator == null ? null : String(measure.aggregator).toUpperCase(),
    refDataSetFieldId: measure.refDataSetFieldId ?? null,
    expression: measure.expression ?? null,
    extended: measure.extended ?? null,
    order: measure.order ?? null,
    parentId: measure.parentId ?? null,
  };
}
function levelSemantics(level) {
  return {
    id: level.id,
    name: level.name,
    alias: level.alias ?? null,
    aliasFromDb: level.aliasFromDb ?? null,
    desc: level.desc ?? null,
    parentId: level.parentId ?? null,
    order: level.order ?? null,
    group: level.group ?? null,
    visible: level.visible ?? null,
    reportVisible: level.reportVisible ?? null,
    viewId: level.viewId ?? null,
    valueType: String(level.valueType || '').toUpperCase(),
    dataFormat: level.dataFormat ?? null,
    levelType: level.levelType,
    refDataSetFieldId: level.refDataSetFieldId,
    transformRule: level.transformRule ?? null,
    extended: level.extended ?? null,
  };
}

function relationSemantics(relation) {
  return {
    srcViewId: relation.srcViewId,
    destViewId: relation.destViewId,
    fieldRelations: (relation.fieldRelations || []).map((fieldRelation) => ({
      srcFieldId: fieldRelation.srcFieldId,
      destFieldId: fieldRelation.destFieldId,
      operator: fieldRelation.operator,
    })),
    linkType: relation.linkType,
    cardinalityType: relation.cardinalityType,
    filterDirection: relation.filterDirection,
    assumeReferentialIntegrity: relation.assumeReferentialIntegrity,
  };
}

export function modelSemanticDefinition(model) {
  const serverOwnedMeasureNodeIds = new Set([
    ...(model.measures || []),
    ...(model.calcMeasures || []),
  ].map((measure) => measure.id));
  return {
    id: model.id,
    name: model.name,
    alias: model.alias ?? null,
    desc: model.desc ?? '',
    storeType: model.storeType,
    views: (model.views || []).map((view) => ({
      id: view.id,
      name: view.name,
      alias: view.alias ?? null,
      type: view.type,
      storeType: view.storeType,
      source: modelViewSourceTuple(view),
      fields: (view.fields || []).map(sourceFieldSemantics),
    })),
    fields: (model.fields || []).map(fieldSemantics),
    measures: (model.measures || []).map(measureSemantics),
    levels: (model.levels || []).map(levelSemantics),
    calcMeasures: (model.calcMeasures || []).map(measureSemantics),
    calcMembers: stableValue(model.calcMembers || []),
    namedSets: stableValue(model.namedSets || []),
    parameters: stableValue(model.parameters || []),
    nodes: (model.nodes || []).map((node) => nodeSemantics(node, serverOwnedMeasureNodeIds)),
    relationGraph: {
      relations: (model.relationGraph?.relations || []).map(relationSemantics),
      positions: stableValue(model.relationGraph?.positions || []),
      layouts: stableValue(model.relationGraph?.layouts || []),
      activeLayout: model.relationGraph?.activeLayout ?? null,
    },
  };
}

export function assertSavedModelEquivalent(expected, saved, label = 'saved model') {
  assertModelReferenceGraph(expected);
  assertModelReferenceGraph(saved);
  const expectedSemantic = stableModelJson(modelSemanticDefinition(expected));
  const savedSemantic = stableModelJson(modelSemanticDefinition(saved));
  if (expectedSemantic !== savedSemantic) {
    throw new Error(`${label} semantic definition does not match the requested model`);
  }
  return modelSemanticDefinition(saved);
}

export function assertModelBaselineUnchanged(baseline, current) {
  if (stableModelJson(baseline) !== stableModelJson(current)) {
    throw new Error('model changed after it was loaded; refusing stale full-model overwrite');
  }
}

export function assertOnlyModelCollectionsChanged(before, after, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const beforeSemantic = modelSemanticDefinition(before);
  const afterSemantic = modelSemanticDefinition(after);
  for (const key of Object.keys(beforeSemantic)) {
    if (allowed.has(key)) continue;
    if (stableModelJson(beforeSemantic[key]) !== stableModelJson(afterSemantic[key])) {
      throw new Error(`model mutation changed an unintended semantic collection: ${key}`);
    }
  }
}

function remapStringsAndKeys(value, replacements) {
  const remap = (source) => {
    let result = source;
    for (const [from, to] of replacements) result = result.split(from).join(to);
    return result;
  };
  if (typeof value === 'string') return remap(value);
  if (Array.isArray(value)) return value.map((item) => remapStringsAndKeys(item, replacements));
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    remap(key),
    remapStringsAndKeys(item, replacements),
  ]));
}
function collectPropertyValues(value, property, collected = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectPropertyValues(item, property, collected);
    return collected;
  }
  if (!plainObject(value)) return collected;
  for (const [key, item] of Object.entries(value)) {
    if (key === property && item != null) {
      collected.add(requiredText(item, `model clone ${property}`));
    }
    collectPropertyValues(item, property, collected);
  }
  return collected;
}


export function assertNoModelCloneResidue(model, forbiddenIds) {
  const serialized = stableModelJson(model);
  for (const forbidden of forbiddenIds) {
    const value = requiredText(forbidden, 'forbidden clone id');
    if (serialized.includes(value)) throw new Error(`model clone retains source id: ${value}`);
  }
}

export function remapModelClone(source, { modelId, viewIds, batchId }) {
  if (!plainObject(source)) throw new Error('source model is required');
  const sourceModelId = requiredText(source.id, 'source model id');
  const targetModelId = requiredText(modelId, 'target model id');
  const targetBatchId = requiredText(batchId, 'model clone batch id');
  if (!(viewIds instanceof Map)) throw new Error('model clone view id map is required');
  const sourceBatchIds = collectPropertyValues(source, 'batchId');
  if (sourceBatchIds.has(targetBatchId)) {
    throw new Error('model clone batch id must differ from every source batch id');
  }
  const replacementEntries = [
    [sourceModelId, targetModelId],
    ...viewIds,
    ...[...sourceBatchIds].map((sourceBatchId) => [sourceBatchId, targetBatchId]),
  ].sort(([left], [right]) => right.length - left.length);
  const replacements = new Map(replacementEntries);
  const cloned = remapStringsAndKeys(source, replacements);
  cloned.id = targetModelId;
  cloned.deletedViews = [];
  cloned.extractStatus = 'INIT';
  cloned.preAggregates = [];
  cloned.directPartitions = [];
  cloned.cacheSetting = null;
  cloned._extendProps = {
    ...(cloned._extendProps || {}),
    batchId: targetBatchId,
  };
  assertNoModelCloneResidue(cloned, replacements.keys());
  return cloned;
}
