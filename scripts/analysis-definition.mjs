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

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function resolveAnalysisResource(
  resources,
  requested,
  { kind = 'analysis resource', namespacedRequested = null } = {},
) {
  if (!Array.isArray(resources)) throw new Error(`${kind} collection is missing`);
  const exact = requiredText(requested, `${kind} selector`);
  const accepted = new Set([exact]);
  if (namespacedRequested != null) accepted.add(requiredText(namespacedRequested, `${kind} namespaced selector`));
  const matches = resources.filter((resource) => (
    [resource?.id, resource?.name, resource?.alias]
      .filter((value) => value !== undefined && value !== null && value !== '')
      .some((value) => accepted.has(String(value)))
  ));
  if (matches.length !== 1) {
    throw new Error(`${kind} must resolve exactly once: ${exact} (matches=${matches.length})`);
  }
  return matches[0];
}

export function analysisCrossTables(report) {
  return (report?.define?.portlets || []).filter((portlet) => portlet?.type === 'CROSS_TABLE');
}

function selectedCrossTable(report, portletId = null) {
  const tables = analysisCrossTables(report);
  if (tables.length === 0) throw new Error('analysis has no runnable CROSS_TABLE portlet');
  if (portletId == null) {
    if (tables.length !== 1) {
      throw new Error(`analysis CROSS_TABLE selection is ambiguous: found ${tables.length}`);
    }
    return tables[0];
  }
  const matches = tables.filter((portlet) => portlet.id === portletId);
  if (matches.length !== 1) throw new Error(`analysis portlet must resolve exactly once: ${portletId}`);
  return matches[0];
}
function nonEmptyDefinition(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value) || typeof value === 'string') return value.length > 0;
  if (plainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function hasSavedConditions(report, portlet) {
  const relations = [
    report?.define?.conditionRelation,
    portlet?.extended?.conditionRelation,
  ].filter(Boolean);
  return relations.some((relation) => (
    nonEmptyDefinition(relation?.childNodes)
    || nonEmptyDefinition(relation?.conditions)
  ));
}

function assertSupportedQueryDefinition(report, portlet) {
  const fields = portlet?.extended?.fields;
  if (!portlet?.extended?.dataSource || !fields) {
    throw new Error('analysis CROSS_TABLE is missing its data source or fields');
  }
  if (nonEmptyDefinition(fields.filters) || hasSavedConditions(report, portlet)) {
    throw new Error('filtered analysis execution is unsupported without a captured filter contract');
  }
  if ((report?.define?.portlets || []).some((item) => item?.type === 'FILTER_PANEL')) {
    throw new Error('filter-panel analysis execution is unsupported without a captured filter contract');
  }
}

export function buildAnalysisQuery(report, { portletId = null, idFactory } = {}) {
  if (typeof idFactory !== 'function') throw new Error('analysis query id factory is required');
  const portlet = selectedCrossTable(report, portletId);
  assertSupportedQueryDefinition(report, portlet);
  const extended = portlet.extended;
  return {
    queryBatchId: idFactory(),
    queryType: 'PORTLET_CROSS_TABLE',
    clientId: idFactory(),
    dataSource: extended.dataSource,
    pagination: { num: 0, size: 100 },
    calculateTotalRowCount: false,
    conditionRelation: { relation: 'AND', childNodes: [] },
    queryFields: extended.fields,
    privateDataset: report.define.privateDataset || { folders: [], fields: [] },
    colSubtotalPosition: 'right',
    groupOrderByState: extended.viewState?.groupOrderByState || null,
    useAdvancedSort: true,
    querySortSetting: {
      rowSorts: extended.sortSetting?.row?.sorts || [],
      colSorts: extended.sortSetting?.col?.sorts || [],
    },
    tableHeader: report.define.reportSetting?.tableHeader || null,
    tableFooter: report.define.reportSetting?.tableFooter || null,
  };
}

function containsDataScalar(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(containsDataScalar);
  if (plainObject(value)) return Object.values(value).some(containsDataScalar);
  return false;
}

export function assertAnalysisQueryResult(result, { label = 'analysis query' } = {}) {
  if (!plainObject(result)) throw new Error(`${label} returned a malformed response`);
  if (result.success === false || result.succeeded === false) {
    throw new Error(`${label} returned an unsuccessful response`);
  }
  if (Object.hasOwn(result, 'retCode') && Number(result.retCode) !== 0) {
    throw new Error(`${label} returned retCode ${result.retCode}`);
  }
  if (!plainObject(result.rowMap)) throw new Error(`${label} response has no rowMap object`);
  const rowKeys = Object.keys(result.rowMap);
  if (rowKeys.length === 0) throw new Error(`${label} returned no rows`);
  if (!Array.isArray(result.columns) || result.columns.filter(Boolean).length === 0) {
    throw new Error(`${label} returned no columns`);
  }
  const cellEvidence = result.gridData?.data
    ?? result.gridData?.datas
    ?? result.gridData?.rows
    ?? result.data
    ?? Object.values(result.rowMap);
  if (!containsDataScalar(cellEvidence)) throw new Error(`${label} returned no data cells`);
  return {
    total: result.total ?? null,
    rowCount: result.gridData?.rowsCount ?? rowKeys.length,
    rowKeys,
    columns: result.columns.filter(Boolean).map((column) => (
      plainObject(column) ? column.label ?? column.value ?? column.name ?? column.id ?? null : column
    )),
  };
}

export function analysisBindingSnapshot(report, { portletId = null } = {}) {
  const portlet = selectedCrossTable(report, portletId);
  const fields = portlet.extended?.fields;
  if (!fields) throw new Error('analysis CROSS_TABLE has no field definition');
  return {
    portletId: portlet.id,
    modelId: requiredText(portlet.extended?.dataSource?.id, 'analysis model id'),
    rows: (fields.rows || []).map((field) => ({
      id: requiredText(field?.id, 'analysis row id'),
      type: requiredText(field?.type, 'analysis row type'),
    })),
    measures: (fields.measures || []).map((field) => ({
      id: requiredText(field?.id, 'analysis measure id'),
      type: requiredText(field?.type, 'analysis measure type'),
      aggregate: field.aggregate ?? null,
      originAggregate: field.originAggregate ?? null,
    })),
  };
}

export function assertAnalysisBindings(report, expected, { portletId = null } = {}) {
  const saved = analysisBindingSnapshot(report, { portletId: portletId ?? expected.portletId });
  if (stableJson(saved) !== stableJson(expected)) {
    throw new Error('reopened analysis bindings do not match the requested row/measure definition');
  }
  return saved;
}

export function assertSimpleAnalysisRepairable(report) {
  const portlets = report?.define?.portlets;
  if (!Array.isArray(portlets) || portlets.length !== 1 || portlets[0]?.type !== 'CROSS_TABLE') {
    throw new Error('analysis repair supports exactly one CROSS_TABLE and no other portlets');
  }
  const table = portlets[0];
  const fields = table.extended?.fields;
  if (!fields || fields.rows?.length !== 1 || fields.measures?.length !== 1) {
    throw new Error('analysis repair requires exactly one row and one measure');
  }
  if (nonEmptyDefinition(fields.filters) || hasSavedConditions(report, table)) {
    throw new Error('analysis repair refuses filtered definitions');
  }
  const privateDataset = report.define?.privateDataset;
  if (
    nonEmptyDefinition(privateDataset?.folders)
    || nonEmptyDefinition(privateDataset?.fields)
  ) {
    throw new Error('analysis repair refuses private calculated definitions');
  }
  const rowSorts = table.extended?.sortSetting?.row?.sorts || [];
  const colSorts = table.extended?.sortSetting?.col?.sorts || [];
  if (rowSorts.length > 0 || colSorts.length > 0 || table.extended?.viewState?.groupOrderByState) {
    throw new Error('analysis repair refuses sorted or grouped definitions whose references cannot be remapped safely');
  }
  return table;
}

function applyBindingLabel(field, label) {
  const normalized = requiredText(label, 'analysis binding label');
  return {
    ...field,
    alias: normalized,
    label: normalized,
    desc: normalized,
    showName: normalized,
  };
}

export function patchSimpleAnalysisDefinition(report, {
  row,
  measure,
  rowLabel,
  measureLabel,
  description = '',
}) {
  const originalTable = assertSimpleAnalysisRepairable(report);
  const repaired = structuredClone(report);
  const table = repaired.define.portlets.find((portlet) => portlet.id === originalTable.id);
  table.extended.fields.rows = [applyBindingLabel(row, rowLabel)];
  table.extended.fields.measures = [applyBindingLabel(measure, measureLabel)];
  const normalizedDescription = String(description || '').trim();
  if (normalizedDescription) {
    repaired.desc = normalizedDescription;
    table.name = normalizedDescription;
  }
  return repaired;
}

export function analysisSemanticDefinition(report) {
  if (!plainObject(report)) throw new Error('analysis report is required');
  return {
    id: requiredText(report.id, 'analysis report id'),
    name: report.name,
    alias: report.alias ?? null,
    desc: report.desc ?? '',
    define: stableValue(report.define),
  };
}

export function assertSavedAnalysisEquivalent(expected, saved, label = 'saved analysis') {
  if (stableJson(analysisSemanticDefinition(expected)) !== stableJson(analysisSemanticDefinition(saved))) {
    throw new Error(`${label} definition does not match the requested analysis`);
  }
  return analysisSemanticDefinition(saved);
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

export function remapAnalysisPortlets(report, idFactory) {
  if (typeof idFactory !== 'function') throw new Error('analysis portlet id factory is required');
  const portlets = report?.define?.portlets;
  if (!Array.isArray(portlets) || portlets.length === 0) throw new Error('analysis has no portlets to clone');
  const replacements = new Map();
  for (const portlet of portlets) {
    const id = requiredText(portlet?.id, 'analysis portlet id');
    if (replacements.has(id)) throw new Error(`duplicate analysis portlet id: ${id}`);
    replacements.set(id, requiredText(idFactory(), 'new analysis portlet id'));
  }
  const remapped = remapStringsAndKeys(report, replacements);
  const serialized = stableJson(remapped);
  for (const oldId of replacements.keys()) {
    if (serialized.includes(oldId)) throw new Error(`analysis clone retains source portlet id: ${oldId}`);
  }
  return { report: remapped, replacements };
}

export function analysisModelIds(report) {
  const ids = analysisCrossTables(report).map((portlet) => (
    requiredText(portlet.extended?.dataSource?.id, `analysis portlet ${portlet.id} model id`)
  ));
  if (ids.length === 0) throw new Error('analysis has no model-backed CROSS_TABLE');
  return [...new Set(ids)];
}
