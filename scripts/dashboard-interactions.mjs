import {
  assertAuthoredDashboardValue,
  isDashboardVisualizationPortlet,
} from './dashboard-verification.mjs';

const FILTER_SELECT_TYPES = new Set(['SINGLE', 'MULTIPLE']);
const JUMP_OPEN_TYPES = new Set(['DIALOG', 'FLOAT', 'NEW_TAB', 'NEW_WIN', 'COVER_SELF']);
const CHART_FIELD_SLOTS = new Set([
  'cols', 'rows', 'color', 'size', 'angle', 'label', 'tooltip', 'shape',
]);
const NUMERIC_DATA_TYPES = new Set([
  'BYTE', 'SHORT', 'SMALLINT', 'INTEGER', 'INT', 'LONG', 'BIGINT', 'FLOAT',
  'DOUBLE', 'DECIMAL', 'BIGDECIMAL', 'NUMBER',
]);
const DATETIME_DATA_TYPES = new Set(['DATETIME', 'TIMESTAMP']);
const BOOLEAN_DATA_TYPES = new Set(['BOOL', 'BOOLEAN']);
const STRING_DATA_TYPES = new Set(['STRING', 'VARCHAR', 'CHAR', 'TEXT']);

function text(value) {
  return String(value ?? '').trim();
}

function objectSpec(input, command) {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new Error(`${command} specJson must be valid JSON`);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${command} specJson must be an object`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} has unsupported key(s): ${unknown.join(', ')}`);
}

function optionalText(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function validateDashboardPortletIndexes(indexes, chartCount, label) {
  if (!Array.isArray(indexes) || indexes.length === 0) {
    throw new Error(`${label} requires at least one chart index`);
  }
  const unique = [...new Set(indexes)];
  if (unique.length !== indexes.length) {
    throw new Error(`${label} contains duplicate chart indexes`);
  }
  for (const index of unique) {
    if (!Number.isInteger(index) || index < 0 || index >= chartCount) {
      throw new Error(`${label} chart index is invalid: ${index}`);
    }
  }
  return unique;
}

export function parseInteractiveDashboardSpec(input) {
  const spec = objectSpec(input, 'dashboard-create-interactive');
  rejectUnknownKeys(spec, new Set(['charts', 'filter', 'linkage']), 'interactive dashboard spec');
  if (!Array.isArray(spec.charts) || spec.charts.length < 2) {
    throw new Error('interactive dashboard requires at least two charts');
  }
  if (!spec.filter || typeof spec.filter !== 'object' || Array.isArray(spec.filter)) {
    throw new Error('interactive dashboard requires a filter object');
  }
  rejectUnknownKeys(
    spec.filter,
    new Set(['field', 'label', 'title', 'targets', 'selectType', 'columnNum']),
    'interactive dashboard filter',
  );
  if (typeof spec.filter.field !== 'string' || !spec.filter.field.trim()) {
    throw new Error('interactive dashboard requires filter.field as a non-empty string');
  }
  const field = spec.filter.field.trim();
  if (spec.filter.selectType !== undefined && typeof spec.filter.selectType !== 'string') {
    throw new Error('interactive dashboard filter selectType must be a string');
  }
  const selectType = (spec.filter.selectType || 'MULTIPLE').trim().toUpperCase();
  if (!FILTER_SELECT_TYPES.has(selectType)) {
    throw new Error(`interactive dashboard filter selectType is unsupported: ${selectType}`);
  }
  const columnNum = spec.filter.columnNum === undefined ? 3 : spec.filter.columnNum;
  if (!Number.isInteger(columnNum) || columnNum < 1 || columnNum > 12) {
    throw new Error('interactive dashboard filter columnNum must be an integer from 1 to 12');
  }
  if (spec.filter.targets !== undefined && !Array.isArray(spec.filter.targets)) {
    throw new Error('interactive dashboard filter targets must be an array of chart indexes');
  }
  if (!Array.isArray(spec.linkage) || spec.linkage.length === 0) {
    throw new Error('interactive dashboard requires at least one chart linkage');
  }
  const seenSources = new Set();
  const linkage = spec.linkage.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`dashboard linkage ${index + 1} must be an object`);
    }
    rejectUnknownKeys(item, new Set(['source', 'targets']), `dashboard linkage ${index + 1}`);
    if (!Number.isInteger(item.source) || item.source < 0) {
      throw new Error(`dashboard linkage ${index + 1} source must be a non-negative integer`);
    }
    if (seenSources.has(item.source)) {
      throw new Error(`dashboard linkage source ${item.source} is duplicated`);
    }
    seenSources.add(item.source);
    if (
      !Array.isArray(item.targets)
      || item.targets.length === 0
      || item.targets.some((target) => !Number.isInteger(target) || target < 0)
    ) {
      throw new Error(`dashboard linkage ${index + 1} requires non-negative integer targets`);
    }
    return { source: item.source, targets: [...item.targets] };
  });
  return {
    charts: spec.charts,
    filter: {
      field,
      label: optionalText(spec.filter.label, 'interactive dashboard filter label'),
      title: optionalText(spec.filter.title, 'interactive dashboard filter title'),
      targets: spec.filter.targets ? [...spec.filter.targets] : null,
      selectType,
      columnNum,
    },
    linkage,
  };
}

function parsePortletSelector(spec, idKey, indexKey, label) {
  const hasId = Object.hasOwn(spec, idKey);
  const hasIndex = Object.hasOwn(spec, indexKey);
  if (hasId === hasIndex) {
    throw new Error(`${label} requires exactly one of ${idKey} or ${indexKey}`);
  }
  if (hasId) {
    if (typeof spec[idKey] !== 'string' || !spec[idKey].trim()) {
      throw new Error(`${label} ${idKey} must be a non-empty string`);
    }
    return { portletId: spec[idKey].trim(), index: null };
  }
  const index = spec[indexKey];
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`${label} ${indexKey} must be a non-negative integer`);
  }
  return { portletId: null, index };
}

export function parseDashboardJumpSpec(input) {
  const spec = objectSpec(input, 'dashboard-jump-add');
  rejectUnknownKeys(
    spec,
    new Set([
      'field', 'targetField', 'sourceChart', 'targetFilter', 'sourcePortletId',
      'targetFilterPortletId', 'sourceSlot', 'openType', 'name',
    ]),
    'dashboard jump spec',
  );
  if (typeof spec.field !== 'string' || !spec.field.trim()) {
    throw new Error('dashboard-jump-add requires spec.field as a non-empty string');
  }
  const field = spec.field.trim();
  if (
    spec.targetField !== undefined
    && (typeof spec.targetField !== 'string' || !spec.targetField.trim())
  ) {
    throw new Error('dashboard-jump-add targetField must be a non-empty string');
  }
  const targetField = spec.targetField?.trim() || field;
  const source = parsePortletSelector(
    spec,
    'sourcePortletId',
    'sourceChart',
    'dashboard-jump-add source',
  );
  const target = parsePortletSelector(
    spec,
    'targetFilterPortletId',
    'targetFilter',
    'dashboard-jump-add target',
  );
  if (spec.sourceSlot !== undefined && typeof spec.sourceSlot !== 'string') {
    throw new Error('dashboard-jump-add sourceSlot must be a string');
  }
  const sourceSlot = spec.sourceSlot === undefined ? null : spec.sourceSlot.trim();
  if (sourceSlot !== null && !CHART_FIELD_SLOTS.has(sourceSlot)) {
    throw new Error(`dashboard-jump-add unsupported sourceSlot: ${sourceSlot || '(empty)'}`);
  }
  if (spec.openType !== undefined && typeof spec.openType !== 'string') {
    throw new Error('dashboard-jump-add openType must be a string');
  }
  const openType = (spec.openType || 'DIALOG').trim().toUpperCase();
  if (!JUMP_OPEN_TYPES.has(openType)) {
    throw new Error(`dashboard-jump-add unsupported openType: ${openType}`);
  }
  const name = optionalText(spec.name, 'dashboard-jump-add name') || `${field} 条件跳转`;
  return {
    field,
    targetField,
    sourceChart: source.index,
    sourcePortletId: source.portletId,
    targetFilter: target.index,
    targetFilterPortletId: target.portletId,
    sourceSlot,
    openType,
    name,
  };
}

function assertUniquePortletIds(portlets, label) {
  const ids = portlets.map((portlet) => text(portlet?.id));
  if (ids.some((id) => !id)) throw new Error(`${label} contains a portlet without an id`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate portlet ids`);
}

export function resolveDashboardPortletReference(
  portlets,
  { portletId = null, index = null, kind, label },
) {
  const source = Array.isArray(portlets) ? portlets : [];
  assertUniquePortletIds(source, label);
  const predicate = kind === 'visualization'
    ? isDashboardVisualizationPortlet
    : (portlet) => text(portlet?.type).startsWith('FILTER_');
  if (!['visualization', 'filter'].includes(kind)) {
    throw new Error(`unsupported dashboard portlet reference kind: ${kind}`);
  }
  if (portletId) {
    const matches = source.filter((portlet) => text(portlet.id) === portletId);
    if (matches.length !== 1 || !predicate(matches[0])) {
      throw new Error(`${label} portlet id does not resolve to one ${kind}: ${portletId}`);
    }
    return matches[0];
  }
  if (!Number.isInteger(index) || index < 0) throw new Error(`${label} index is required`);
  if (kind === 'visualization') {
    const unsupported = source.filter(
      (portlet) => !text(portlet?.type).startsWith('FILTER_') && !isDashboardVisualizationPortlet(portlet),
    );
    if (unsupported.length) {
      throw new Error(`${label} index resolution is ambiguous; use sourcePortletId`);
    }
  }
  const eligible = source.filter(predicate);
  if (!eligible[index]) throw new Error(`${label} index is out of range: ${index}`);
  return eligible[index];
}

function collectPortletFields(portlet) {
  const fields = [];
  for (const [slot, values] of Object.entries(portlet?.extended?.fields || {})) {
    if (!Array.isArray(values)) continue;
    values.forEach((field, index) => fields.push({ field, slot, index }));
  }
  const groups = portlet?.extended?.markFieldGroups || {};
  for (const group of Object.values(groups)) {
    if (!group || typeof group !== 'object') continue;
    for (const [slot, values] of Object.entries(group)) {
      if (!Array.isArray(values)) continue;
      values.forEach((field, index) => fields.push({ field, slot, index }));
    }
  }
  return [...new Map(fields.map((candidate) => [
    `${text(candidate.field?.id)}\u0000${candidate.slot}\u0000${candidate.index}`,
    candidate,
  ])).values()];
}

function uniqueFieldMatch(matches, portlet, requestedName, requestedSlot) {
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `dashboard portlet ${portlet?.id || '(unknown)'} field selector is ambiguous: ${requestedName}`
      + (requestedSlot ? ` in ${requestedSlot}` : ''),
    );
  }
  return null;
}

export function locateDashboardPortletField(portlet, requestedName, requestedSlot = null) {
  const selector = text(requestedName);
  if (!selector) throw new Error('dashboard portlet field selector is required');
  const candidates = collectPortletFields(portlet).filter(
    (candidate) => !requestedSlot || candidate.slot === requestedSlot,
  );
  const exact = uniqueFieldMatch(
    candidates.filter(({ field }) => text(field?.id) === selector),
    portlet,
    selector,
    requestedSlot,
  );
  if (exact) return exact;
  const named = uniqueFieldMatch(
    candidates.filter(({ field }) => [field?.name, field?.alias, field?.label, field?.label0]
      .some((value) => text(value) === selector)),
    portlet,
    selector,
    requestedSlot,
  );
  if (named) return named;
  throw new Error(
    `dashboard portlet ${portlet?.id || '(unknown)'} has no field named ${selector}`
    + (requestedSlot ? ` in ${requestedSlot}` : ''),
  );
}

function dataTypeFamily(value) {
  const type = text(value).toUpperCase();
  if (!type) return null;
  if (NUMERIC_DATA_TYPES.has(type)) return 'NUMBER';
  if (type === 'DATE') return 'DATE';
  if (DATETIME_DATA_TYPES.has(type)) return 'DATETIME';
  if (type === 'TIME') return 'TIME';
  if (BOOLEAN_DATA_TYPES.has(type)) return 'BOOLEAN';
  if (STRING_DATA_TYPES.has(type)) return 'STRING';
  return type;
}

export function assertCompatibleDashboardDataTypes(sourceType, targetType) {
  const sourceFamily = dataTypeFamily(sourceType);
  const targetFamily = dataTypeFamily(targetType);
  if (!sourceFamily || !targetFamily || sourceFamily !== targetFamily) {
    throw new Error(
      `dashboard jump field data types are incompatible: ${text(sourceType) || '(missing)'} -> ${text(targetType) || '(missing)'}`,
    );
  }
  return sourceFamily;
}

function exactSet(actual, expected, label) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    throw new Error(`${label} target set is incomplete`);
  }
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length) {
    throw new Error(`${label} target set contains duplicates`);
  }
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} target set mismatch`);
  }
}

export function assertFilterImpactsVisualization(dashboard, filterPortlet) {
  const portlets = dashboard?.define?.portlets || [];
  assertUniquePortletIds(portlets, 'target dashboard');
  const impactIds = filterPortlet?.extended?.impactWidgets;
  if (!Array.isArray(impactIds) || impactIds.length === 0) {
    throw new Error(`target filter ${filterPortlet?.id || '(unknown)'} has no impacted target`);
  }
  if (new Set(impactIds).size !== impactIds.length) {
    throw new Error(`target filter ${filterPortlet.id} has duplicate impacted targets`);
  }
  const impacted = impactIds.map((id) => {
    const matches = portlets.filter((portlet) => portlet.id === id);
    if (matches.length !== 1) {
      throw new Error(`target filter impact does not resolve to one portlet: ${id}`);
    }
    return matches[0];
  });
  if (!impacted.some(isDashboardVisualizationPortlet)) {
    throw new Error(`target filter ${filterPortlet.id} does not impact a chart or table`);
  }
  return impactIds;
}

export function assertInteractiveDashboardPersisted(saved, interaction) {
  const portlets = saved?.define?.portlets || [];
  assertUniquePortletIds(portlets, 'saved interactive dashboard');
  const portletIds = portlets.map((portlet) => portlet.id);
  const expectedFilter = interaction.filter.portlet;
  const savedFilter = portlets.find((portlet) => portlet.id === expectedFilter.id);
  if (!savedFilter || savedFilter.type !== 'FILTER_LIST') {
    throw new Error('dashboard filter interaction persistence mismatch: filter is missing');
  }
  const expectedFilterExtended = { ...expectedFilter.extended };
  const savedFilterExtended = { ...savedFilter.extended };
  delete expectedFilterExtended.impactWidgets;
  delete savedFilterExtended.impactWidgets;
  assertAuthoredDashboardValue(
    { ...savedFilter, extended: savedFilterExtended },
    { ...expectedFilter, extended: expectedFilterExtended },
    'dashboard filter metadata',
  );
  const savedTargets = savedFilter.extended?.impactWidgets || [];
  exactSet(savedTargets, interaction.filter.targetPortletIds, 'dashboard filter');
  for (const targetId of interaction.filter.targetPortletIds) {
    if (!portletIds.includes(targetId)) {
      throw new Error(`dashboard filter target does not exist after reopen: ${targetId}`);
    }
  }

  for (const linkage of interaction.linkages) {
    const source = portlets.find((portlet) => portlet.id === linkage.sourcePortletId);
    if (!source) throw new Error(`dashboard linkage source does not exist after reopen: ${linkage.sourcePortletId}`);
    for (const targetId of linkage.targetPortletIds) {
      if (!portletIds.includes(targetId)) {
        throw new Error(`dashboard linkage target does not exist after reopen: ${targetId}`);
      }
    }
    if (source.extended?.asFilter !== true || source.extended?.impactReportsType !== 'custom') {
      throw new Error(`dashboard chart linkage persistence mismatch: ${linkage.source}`);
    }
    const ignored = source.extended?.ignoreFilters || [];
    exactSet(ignored, linkage.ignorePortletIds, `dashboard linkage ${linkage.source} ignored`);
    const impacted = portletIds.filter((portletId) => !new Set(ignored).has(portletId));
    exactSet(impacted, linkage.targetPortletIds, `dashboard linkage ${linkage.source} impacted`);
  }
  return {
    filter: {
      portletId: savedFilter.id,
      fieldId: savedFilter.extended?.fields?.filters?.[0]?.id || null,
      selectType: savedFilter.extended?.filterSelectType || null,
      columnNum: savedFilter.extended?.columnNum ?? null,
      defaultType: savedFilter.extended?.defaultValueSetting?.defaultType || null,
      targetPortletIds: [...savedTargets],
    },
    linkageCount: interaction.linkages.length,
  };
}

export function assertJumpRulePersisted(savedRule, expectedRule) {
  if (!savedRule) throw new Error('dashboard conditional jump persistence mismatch: rule is missing');
  assertAuthoredDashboardValue(savedRule, expectedRule, 'dashboard conditional jump rule');
}
