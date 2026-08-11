import { chartTypeContract } from './dashboard-multi.mjs';

const SET_ARRAY_KEYS = new Set(['impactWidgets', 'ignoreFilters', 'warnImpacts']);
const VISUAL_PORTLET_KEYS = new Set([
  'id', 'name', 'type', 'displayMode', 'style', 'macros', 'extended', 'invalidField',
]);
const VISUAL_EXTENDED_KEYS = new Set([
  'asFilter', 'skillChartType', 'title', 'datasetIds', 'fields', 'markFieldGroups',
  'fieldGroup', 'data', 'showSeriesNumber', 'table', 'header', 'rowheader',
  'scatterLargeCount', 'areaMapId', 'linkedSelectionValue', 'pagination', 'layoutType',
  'sortSetting', 'providerName', 'markFieldGroupsCfg', 'chartDefine', 'refresh', 'viewState',
]);
const DEFINE_KEYS = new Set([
  'devices', 'portlets', 'containers', 'datasetRelations', 'privateDatasets',
  'pageOptions', 'globalExtended', 'pageThemeDefine', 'themeStyleOptions', 'refresh',
  'macros', 'activeDevice',
]);
const CHART_DEFINE_SCHEMA = Object.freeze({
  tooltip: { trigger: true },
  seriesConfig: {
    global: {
      label: { show: true, position: true, fontSize: true },
      stack: true,
    },
  },
  grid: { left: true, right: true, top: true, bottom: true, containLabel: true },
  xAxis: {
    name: true,
    nameLocation: true,
    nameGap: true,
    axisLabel: { interval: true, rotate: true },
  },
  yAxis: {
    name: true,
    nameLocation: true,
    nameGap: true,
    axisLabel: {},
  },
  angleAxis: { name: true },
  radiusAxis: { name: true },
  legend: {},
  visualMap: { show: true },
  geo: { roam: true },
  valueAxis: {},
  layout: true,
});

function text(value) {
  return String(value ?? '').trim();
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalSetArray(value) {
  if (!Array.isArray(value)) return value;
  return [...value].sort((left, right) => stableValue(left).localeCompare(stableValue(right)));
}

function mismatch(actual, expected, path, key = null) {
  const normalizedActual = key && SET_ARRAY_KEYS.has(key) ? canonicalSetArray(actual) : actual;
  const normalizedExpected = key && SET_ARRAY_KEYS.has(key) ? canonicalSetArray(expected) : expected;
  if (Array.isArray(normalizedExpected)) {
    if (!Array.isArray(normalizedActual)) return `${path} is not an array`;
    if (normalizedActual.length !== normalizedExpected.length) {
      return `${path} has ${normalizedActual.length} item(s); expected ${normalizedExpected.length}`;
    }
    for (let index = 0; index < normalizedExpected.length; index += 1) {
      const issue = mismatch(normalizedActual[index], normalizedExpected[index], `${path}[${index}]`);
      if (issue) return issue;
    }
    return null;
  }
  if (normalizedExpected && typeof normalizedExpected === 'object') {
    if (!normalizedActual || typeof normalizedActual !== 'object' || Array.isArray(normalizedActual)) {
      return `${path} is not an object`;
    }
    const actualKeys = Object.keys(normalizedActual).sort();
    const expectedKeys = Object.keys(normalizedExpected).sort();
    if (stableValue(actualKeys) !== stableValue(expectedKeys)) {
      return `${path} keys differ; saved=${stableValue(actualKeys)} expected=${stableValue(expectedKeys)}`;
    }
    for (const expectedKey of Object.keys(normalizedExpected)) {
      if (!Object.hasOwn(normalizedActual, expectedKey)) return `${path}.${expectedKey} is missing`;
      const issue = mismatch(
        normalizedActual[expectedKey],
        normalizedExpected[expectedKey],
        `${path}.${expectedKey}`,
        expectedKey,
      );
      if (issue) return issue;
    }
    return null;
  }
  return Object.is(normalizedActual, normalizedExpected)
    ? null
    : `${path} differs; saved=${stableValue(normalizedActual)} expected=${stableValue(normalizedExpected)}`;
}

export function assertAuthoredDashboardValue(actual, expected, label = 'dashboard value') {
  const issue = mismatch(actual, expected, label);
  if (issue) throw new Error(`${label} persistence mismatch: ${issue}`);
}

export function dashboardPortletChartType(portlet) {
  const portletType = text(portlet?.type);
  if (portletType === 'TABLE_CROSS') return portletType;
  if (!portletType.startsWith('ECHARTS_')) return null;
  if (portletType !== 'ECHARTS_MAP') return portletType;
  const displayMode = text(portlet?.displayMode);
  if (displayMode.startsWith('ECHARTS_MAP')) return displayMode;
  const authoredType = text(portlet?.extended?.skillChartType);
  return authoredType.startsWith('ECHARTS_MAP') ? authoredType : portletType;
}

export function isDashboardVisualizationPortlet(portlet) {
  const type = dashboardPortletChartType(portlet);
  if (!type) return false;
  try {
    chartTypeContract(type);
    return true;
  } catch {
    return false;
  }
}

function exactIds(items, label) {
  const ids = items.map((item) => text(item?.id));
  if (ids.some((id) => !id)) throw new Error(`${label} contains an item without an id`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ids`);
  return ids;
}

function assertSameIdSet(actualIds, expectedIds, label) {
  const actual = [...new Set(actualIds)].sort();
  const expected = [...new Set(expectedIds)].sort();
  if (stableValue(actual) !== stableValue(expected)) {
    throw new Error(`${label} target set mismatch: saved=${stableValue(actual)} expected=${stableValue(expected)}`);
  }
}

export function assertSavedDashboardMatchesDefinition(saved, expected) {
  const savedPortlets = saved?.define?.portlets || [];
  const expectedPortlets = expected?.define?.portlets || [];
  const savedIds = exactIds(savedPortlets, 'saved dashboard portlets');
  const expectedIds = exactIds(expectedPortlets, 'proposed dashboard portlets');
  assertSameIdSet(savedIds, expectedIds, 'dashboard portlet');

  const issue = mismatch(saved?.define, expected?.define, 'dashboard.define');
  if (issue) throw new Error(`dashboard definition persistence mismatch: ${issue}`);
  if (expected?.editDefine !== undefined) {
    const editIssue = mismatch(saved?.editDefine, expected.editDefine, 'dashboard.editDefine');
    if (editIssue) throw new Error(`dashboard edit definition persistence mismatch: ${editIssue}`);
  }
  for (const key of ['name', 'alias']) {
    if (expected?.[key] !== undefined && saved?.[key] !== expected[key]) {
      throw new Error(`dashboard ${key} persistence mismatch`);
    }
  }
  if (expected?.desc !== undefined && saved?.desc !== expected.desc) {
    throw new Error('dashboard description persistence mismatch');
  }

  const savedFloats = saved?.define?.devices?.default?.layout?.define?.floats || {};
  const expectedFloats = expected?.define?.devices?.default?.layout?.define?.floats || {};
  assertSameIdSet(Object.keys(savedFloats), Object.keys(expectedFloats), 'dashboard layout slot');
  assertSameIdSet(
    Object.values(savedFloats).map((item) => text(item?.portletId)),
    Object.values(expectedFloats).map((item) => text(item?.portletId)),
    'dashboard layout portlet',
  );
  return {
    portletCount: savedPortlets.length,
    visualizationCount: savedPortlets.filter(isDashboardVisualizationPortlet).length,
    layoutSlotCount: Object.keys(savedFloats).length,
  };
}

function keysOutside(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function isEmptyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).length === 0
    : false;
}

function hasItems(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function assertKnownShape(value, schema, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(schema, key));
  if (unknown.length) {
    throw new Error(`${label} contains unsupported key(s): ${unknown.join(', ')}`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child) && schema[key] !== true) {
      assertKnownShape(child, schema[key] || {}, `${label}.${key}`);
    }
  }
}

export function assertDashboardRepairable(dashboard) {
  const define = dashboard?.define;
  if (!define || typeof define !== 'object') throw new Error('dashboard repair source has no definition');
  const unknownDefineKeys = keysOutside(define, DEFINE_KEYS);
  if (unknownDefineKeys.length) {
    throw new Error(`dashboard repair refuses unsupported page metadata: ${unknownDefineKeys.join(', ')}`);
  }
  const portlets = define.portlets || [];
  if (portlets.length === 0) throw new Error('dashboard repair source has no visualizations');
  exactIds(portlets, 'dashboard repair source portlets');
  const unsupportedPortlets = portlets.filter((portlet) => !isDashboardVisualizationPortlet(portlet));
  if (unsupportedPortlets.length) {
    throw new Error(
      `dashboard repair refuses non-chart or unsupported portlets: ${unsupportedPortlets.map((item) => `${item.type || '(unknown)'}:${item.id || '(no id)'}`).join(', ')}`,
    );
  }
  if (hasItems(define.containers) || hasItems(define.privateDatasets) || define.datasetRelations) {
    throw new Error('dashboard repair refuses containers, private datasets, or dataset relations');
  }
  for (const key of ['pageOptions', 'globalExtended']) {
    if (define[key] != null && !isEmptyObject(define[key])) {
      throw new Error(`dashboard repair refuses unsupported ${key} metadata`);
    }
  }
  if (define.themeStyleOptions != null || hasItems(define.macros)) {
    throw new Error('dashboard repair refuses custom theme or macro metadata');
  }
  const theme = define.pageThemeDefine || {};
  const unknownThemeKeys = keysOutside(
    theme,
    new Set(['version', 'page', 'portlet', 'chart', 'table', 'filter', 'indicator']),
  );
  if (unknownThemeKeys.length) {
    throw new Error(
      `dashboard repair refuses unsupported page-theme metadata: ${unknownThemeKeys.join(', ')}`,
    );
  }
  for (const value of Object.values(theme)) {
    if (value != null && !isEmptyObject(value) && value !== '1') {
      throw new Error('dashboard repair refuses custom page-theme metadata');
    }
  }
  const devices = define.devices || {};
  if (Object.keys(devices).length !== 1 || !devices.default) {
    throw new Error('dashboard repair refuses non-default device metadata');
  }
  const device = devices.default;
  const unknownDeviceKeys = keysOutside(device, new Set(['gridLine', 'style', 'layout']));
  if (unknownDeviceKeys.length || device.gridLine != null) {
    throw new Error('dashboard repair refuses unsupported device metadata');
  }
  if (device.style) {
    const unknownStyleKeys = keysOutside(device.style, new Set(['background', 'theme', 'padding']));
    if (
      unknownStyleKeys.length
      || (device.style.background != null && !isEmptyObject(device.style.background))
      || (device.style.padding != null && !isEmptyObject(device.style.padding))
      || (device.style.theme != null && device.style.theme !== 'fashion_light_blue')
    ) {
      throw new Error('dashboard repair refuses custom device style metadata');
    }
  }
  const layout = device.layout || {};
  const unknownLayoutKeys = keysOutside(
    layout,
    new Set([
      'type', 'define', 'mobileDeviceLayoutType', 'size', 'mobileDevice',
      'screenType', 'useMobileFilters',
    ]),
  );
  if (unknownLayoutKeys.length || (layout.type != null && layout.type !== 'FREE')) {
    throw new Error('dashboard repair refuses unsupported layout metadata');
  }
  for (const key of [
    'mobileDeviceLayoutType', 'mobileDevice', 'screenType', 'useMobileFilters',
  ]) {
    if (layout[key] != null) {
      throw new Error(`dashboard repair refuses unsupported layout metadata ${key}`);
    }
  }
  const layoutDefine = layout.define || {};
  const unknownLayoutDefineKeys = keysOutside(layoutDefine, new Set(['floats', 'table']));
  if (unknownLayoutDefineKeys.length) {
    throw new Error('dashboard repair refuses unsupported layout-definition metadata');
  }
  const floatKeys = new Set([
    'portletId', 'type', 'left', 'top', 'width', 'height', 'z-index', 'id',
  ]);
  for (const [slot, float] of Object.entries(layoutDefine.floats || {})) {
    const unknownFloatKeys = keysOutside(float, floatKeys);
    if (unknownFloatKeys.length) {
      throw new Error(
        `dashboard repair refuses unsupported layout metadata in slot ${slot}: `
        + unknownFloatKeys.join(', '),
      );
    }
  }
  const layoutPortletIds = Object.values(layoutDefine.floats || [])
    .map((float) => text(float?.portletId));
  if (
    layoutPortletIds.some((id) => !id)
    || new Set(layoutPortletIds).size !== layoutPortletIds.length
  ) {
    throw new Error('dashboard repair refuses ambiguous layout portlet targets');
  }
  assertSameIdSet(
    layoutPortletIds,
    portlets.map((portlet) => portlet.id),
    'dashboard repair layout',
  );
  if (
    layoutDefine.table
    && (
      layoutDefine.table.direction !== 'vertical'
      || hasItems(layoutDefine.table.slots)
      || keysOutside(layoutDefine.table, new Set(['direction', 'slots'])).length
    )
  ) {
    throw new Error('dashboard repair refuses custom table-layout metadata');
  }
  if (layout.size) {
    const unknownSizeKeys = keysOutside(layout.size, new Set(['width', 'height', 'scaleType']));
    if (unknownSizeKeys.length || (layout.size.scaleType && layout.size.scaleType !== 'FIT_WIDTH')) {
      throw new Error('dashboard repair refuses unsupported canvas metadata');
    }
  }
  if (
    define.refresh
    && stableValue(define.refresh)
      !== stableValue({ systemOpenRefresh: true, systemFilterChangeRefresh: true })
  ) {
    throw new Error('dashboard repair refuses custom refresh metadata');
  }
  if (define.activeDevice != null && define.activeDevice !== 'default') {
    throw new Error('dashboard repair refuses a non-default active device');
  }
  const editDefine = dashboard.editDefine || {};
  const unknownEditKeys = keysOutside(editDefine, new Set(['rulerLineConfigs']));
  if (unknownEditKeys.length) {
    throw new Error(`dashboard repair refuses unsupported editor metadata: ${unknownEditKeys.join(', ')}`);
  }
  const rulerConfigs = editDefine.rulerLineConfigs || [];
  if (
    (Object.hasOwn(editDefine, 'rulerLineConfigs') && !Array.isArray(editDefine.rulerLineConfigs))
    || rulerConfigs.length > 1
    || rulerConfigs.some((config) => (
      stableValue(config)
      !== stableValue({ layoutId: 'default', state: 'show', lines: [] })
    ))
  ) {
    throw new Error('dashboard repair refuses custom ruler-line metadata');
  }

  for (const portlet of portlets) {
    const unknownPortletKeys = keysOutside(portlet, VISUAL_PORTLET_KEYS);
    if (unknownPortletKeys.length) {
      throw new Error(
        `dashboard repair refuses unsupported portlet metadata on ${portlet.id}: ${unknownPortletKeys.join(', ')}`,
      );
    }
    if (portlet.style != null || hasItems(portlet.macros)) {
      throw new Error(`dashboard repair refuses custom style or macros on portlet ${portlet.id}`);
    }
    const extended = portlet.extended || {};
    const unknownExtendedKeys = keysOutside(extended, VISUAL_EXTENDED_KEYS);
    if (unknownExtendedKeys.length) {
      throw new Error(
        `dashboard repair refuses unsupported chart metadata on ${portlet.id}: ${unknownExtendedKeys.join(', ')}`,
      );
    }
    if (Object.hasOwn(extended, 'asFilter') && extended.asFilter !== false) {
      throw new Error(`dashboard repair refuses chart linkage on portlet ${portlet.id}`);
    }
    for (const [key, expected] of [
      ['layoutType', 'FREE'],
      ['providerName', 'AUGMENTED'],
      ['linkedSelectionValue', 'KeepSelectedValue'],
    ]) {
      if (Object.hasOwn(extended, key) && extended[key] !== expected) {
        throw new Error(`dashboard repair refuses custom ${key} on portlet ${portlet.id}`);
      }
    }
    if (
      Object.hasOwn(extended, 'refresh')
      && stableValue(extended.refresh) !== stableValue({ enable: false })
    ) {
      throw new Error(`dashboard repair refuses custom refresh metadata on portlet ${portlet.id}`);
    }
    const unknownFieldKeys = keysOutside(
      extended.fields,
      new Set(['cols', 'rows', 'filters', 'marks']),
    );
    if (unknownFieldKeys.length || hasItems(extended.fields?.marks)) {
      throw new Error(`dashboard repair refuses unsupported field metadata on portlet ${portlet.id}`);
    }
    for (const key of ['ignoreFilters', 'impactWidgets', 'jumpRules', 'warnImpacts', 'impactReportsType']) {
      if (Object.hasOwn(extended, key)) {
        throw new Error(`dashboard repair refuses interactivity metadata ${key} on portlet ${portlet.id}`);
      }
    }
    if (hasItems(extended.fields?.filters)) {
      throw new Error(`dashboard repair refuses chart-local filters on portlet ${portlet.id}`);
    }
    if (extended.viewState != null && !isEmptyObject(extended.viewState)) {
      throw new Error(`dashboard repair refuses saved view-state metadata on portlet ${portlet.id}`);
    }
    if (extended.pagination != null && !isEmptyObject(extended.pagination)) {
      throw new Error(`dashboard repair refuses pagination metadata on portlet ${portlet.id}`);
    }
    const rowSorts = extended.sortSetting?.row?.sorts || [];
    const colSorts = extended.sortSetting?.col?.sorts || [];
    if (rowSorts.length || colSorts.length) {
      throw new Error(`dashboard repair refuses sorting metadata on portlet ${portlet.id}`);
    }
    if (extended.chartDefine) {
      assertKnownShape(
        extended.chartDefine,
        CHART_DEFINE_SCHEMA,
        `dashboard repair chart definition ${portlet.id}`,
      );
    }
  }
  return { portletCount: portlets.length };
}
