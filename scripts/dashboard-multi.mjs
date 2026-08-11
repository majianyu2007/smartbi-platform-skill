const MIN_CHARTS = 1;
const MAX_CHARTS = 32;

export const DASHBOARD_CHART_TYPES = Object.freeze([
  'ECHARTS_BAR',
  'ECHARTS_CANDLESTICK__WATERFALL',
  'ECHARTS_LINE',
  'ECHARTS_LINE__AREA',
  'ECHARTS_PIE',
  'ECHARTS_SUNBURST',
  'ECHARTS_SCATTER',
  'ECHARTS_SCATTER__LARGE',
  'ECHARTS_COMBINATION__SINGLE',
  'ECHARTS_COMBINATION__DUAL',
  'ECHARTS_MAP',
  'ECHARTS_MAP_SCATTER',
  'ECHARTS_MAP_SCATTER__LARGE',
  'ECHARTS_MAP_HEATMAP',
  'ECHARTS_WORDCLOUD',
  'ECHARTS_GRAPH',
  'ECHARTS_RADAR',
  'ECHARTS_GAUGE',
  'ECHARTS_GAUGE__INDICATOR',
  'ECHARTS_GAUGE__INSIDE',
  'ECHARTS_GAUGE__RING',
  'ECHARTS_GAUGE__LEVEL',
  'ECHARTS_GAUGE__OUTSIDE',
  'ECHARTS_HEATMAP',
  'ECHARTS_TREEMAP',
  'ECHARTS_SANKEY',
  'ECHARTS_FUNNEL',
  'ECHARTS_BAR__HORIZONTAL',
  'ECHARTS_BAR__POLAR',
  'ECHARTS_LINE__POLAR',
  'ECHARTS_PIE__DONUT',
  'TABLE_CROSS',
]);

const NULL_DISPLAY_MODE_TYPES = new Set([
  'ECHARTS_CANDLESTICK__WATERFALL',
  'ECHARTS_COMBINATION__SINGLE',
  'ECHARTS_COMBINATION__DUAL',
  'ECHARTS_MAP_SCATTER__LARGE',
  'ECHARTS_HEATMAP',
  'ECHARTS_WORDCLOUD',
  'ECHARTS_SUNBURST',
  'ECHARTS_SANKEY',
  'ECHARTS_TREEMAP',
  'TABLE_CROSS',
]);

const MARK_SLOTS = Object.freeze(['color', 'size', 'angle', 'label', 'tooltip', 'shape']);
const ALL_SLOTS = new Set(['cols', 'rows', ...MARK_SLOTS, 'measureGroup']);
const CHART_KEYS = new Set([
  'type', 'dimensions', 'dimension', 'measures', 'measure', 'slots', 'labels',
  'dimensionLabel', 'measureLabel', 'title', 'xAxisTitle', 'yAxisTitle',
  'angleAxisTitle', 'radiusAxisTitle', 'displayMode', ...ALL_SLOTS,
]);

function rule(kind, min = 0, max = Number.POSITIVE_INFINITY) {
  return Object.freeze({ kind, min, max });
}

function contract(slots, axes = null) {
  return Object.freeze({ slots: Object.freeze(slots), axes });
}

const CONTRACTS = Object.freeze({
  ECHARTS_BAR: contract({ cols: rule('dimension', 1), rows: rule('measure', 1) }, 'cartesian'),
  ECHARTS_CANDLESTICK__WATERFALL: contract(
    { cols: rule('dimension', 1), rows: rule('measure', 1, 1) },
    'cartesian',
  ),
  ECHARTS_LINE: contract({ cols: rule('dimension', 1), rows: rule('measure', 1) }, 'cartesian'),
  ECHARTS_LINE__AREA: contract(
    { cols: rule('dimension', 1), rows: rule('measure', 1) },
    'cartesian',
  ),
  ECHARTS_PIE: contract({
    color: rule('dimension', 1, 1),
    angle: rule('measure', 1, 1),
  }),
  ECHARTS_SUNBURST: contract({
    cols: rule('dimension', 1),
    angle: rule('measure', 1, 1),
  }),
  ECHARTS_SCATTER: contract({
    cols: rule('measure', 1, 1),
    rows: rule('measure', 1, 1),
    color: rule('dimension', 0, 1),
    size: rule('measure', 0, 1),
  }, 'cartesian'),
  ECHARTS_SCATTER__LARGE: contract({
    cols: rule('measure', 1, 1),
    rows: rule('measure', 1, 1),
    color: rule('dimension', 0, 1),
  }, 'cartesian'),
  ECHARTS_COMBINATION__SINGLE: contract(
    { cols: rule('dimension', 1), rows: rule('measure', 1) },
    'cartesian',
  ),
  ECHARTS_COMBINATION__DUAL: contract(
    { cols: rule('dimension', 1), rows: rule('measure', 2) },
    'cartesian',
  ),
  ECHARTS_MAP: contract({
    cols: rule('dimension', 1, 1),
    color: rule('measure', 1, 1),
  }),
  ECHARTS_MAP_SCATTER: contract({
    cols: rule('dimension', 1, 1),
    rows: rule('dimension', 1, 1),
    color: rule('any', 1, 1),
    size: rule('measure', 0, 1),
    shape: rule('dimension', 0, 1),
  }),
  ECHARTS_MAP_SCATTER__LARGE: contract({
    cols: rule('dimension', 1, 1),
    rows: rule('dimension', 1, 1),
    color: rule('any', 1, 1),
  }),
  ECHARTS_MAP_HEATMAP: contract({
    cols: rule('dimension', 1, 1),
    rows: rule('dimension', 1, 1),
    color: rule('measure', 1, 1),
  }),
  ECHARTS_WORDCLOUD: contract({
    label: rule('dimension', 1, 1),
    size: rule('measure', 0, 1),
    color: rule('dimension', 0, 1),
  }),
  ECHARTS_GRAPH: contract({
    cols: rule('dimension', 2, 2),
    color: rule('dimension', 0, 2),
    size: rule('measure', 0, 2),
  }),
  ECHARTS_RADAR: contract({
    cols: rule('dimension', 1, 1),
    rows: rule('measure', 1),
  }),
  ECHARTS_GAUGE: contract({ label: rule('measure', 1, 1) }),
  ECHARTS_GAUGE__INDICATOR: contract({ label: rule('measure', 1, 1) }),
  ECHARTS_GAUGE__INSIDE: contract({ label: rule('measure', 1, 1) }),
  ECHARTS_GAUGE__RING: contract({ label: rule('measure', 1, 1) }),
  ECHARTS_GAUGE__LEVEL: contract({ label: rule('measure', 1, 1) }),
  ECHARTS_GAUGE__OUTSIDE: contract({ label: rule('measure', 1, 1) }),
  ECHARTS_HEATMAP: contract({
    cols: rule('dimension', 1, 1),
    rows: rule('dimension', 1, 1),
    color: rule('measure', 1, 1),
  }),
  ECHARTS_TREEMAP: contract({
    label: rule('dimension', 1, 1),
    size: rule('measure', 0, 1),
    color: rule('any', 0, 1),
  }),
  ECHARTS_SANKEY: contract({
    cols: rule('dimension', 2, 2),
    size: rule('measure', 1, 1),
  }),
  ECHARTS_FUNNEL: contract({
    color: rule('dimension', 1, 1),
    size: rule('measure', 1, 1),
  }),
  ECHARTS_BAR__HORIZONTAL: contract(
    { cols: rule('measure', 1), rows: rule('dimension', 1) },
    'cartesian',
  ),
  ECHARTS_BAR__POLAR: contract(
    { cols: rule('dimension', 1), rows: rule('measure', 1) },
    'polar',
  ),
  ECHARTS_LINE__POLAR: contract(
    { cols: rule('dimension', 1), rows: rule('measure', 1) },
    'polar',
  ),
  ECHARTS_PIE__DONUT: contract({
    color: rule('dimension', 1, 1),
    angle: rule('measure', 1, 1),
  }),
  TABLE_CROSS: contract({
    rows: rule('dimension', 1),
    measureGroup: rule('measure', 1),
  }),
});

export function chartTypeContract(type) {
  const normalized = String(type || '').trim();
  const result = CONTRACTS[normalized];
  if (!result) {
    throw new Error(
      `unsupported dashboard chart type: ${normalized || '(empty)'}; `
      + `expected one of ${DASHBOARD_CHART_TYPES.join(', ')}`,
    );
  }
  return result;
}

export function dashboardDisplayModeForType(type) {
  const normalized = String(type || '').trim();
  chartTypeContract(normalized);
  return NULL_DISPLAY_MODE_TYPES.has(normalized) ? null : normalized;
}

function fieldNames(value, label) {
  const values = value == null ? [] : (Array.isArray(value) ? value : [value]);
  if (values.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must contain only non-empty strings`);
  }
  const normalized = values.map((item) => item.trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate fields`);
  }
  return normalized;
}

function defaultSlots(type, dimensions, measures) {
  const [dimension, dimension2, dimension3] = dimensions;
  const [measure, measure2, measure3] = measures;
  if (['ECHARTS_PIE', 'ECHARTS_PIE__DONUT'].includes(type)) {
    return { color: [dimension], angle: [measure] };
  }
  if (type === 'ECHARTS_SUNBURST') return { cols: dimensions, angle: [measure] };
  if (['ECHARTS_SCATTER', 'ECHARTS_SCATTER__LARGE'].includes(type)) {
    return {
      cols: [measure],
      rows: [measure2],
      color: [dimension],
      size: type === 'ECHARTS_SCATTER' ? [measure3] : [],
    };
  }
  if (type === 'ECHARTS_MAP') return { cols: [dimension], color: [measure] };
  if (type === 'ECHARTS_MAP_SCATTER') {
    return {
      cols: [dimension],
      rows: [dimension2],
      color: [dimension3 || measure],
      size: [measure],
      shape: [dimension3],
    };
  }
  if (type === 'ECHARTS_MAP_SCATTER__LARGE') {
    return {
      cols: [dimension],
      rows: [dimension2],
      color: [dimension3 || measure],
    };
  }
  if (type === 'ECHARTS_MAP_HEATMAP') {
    return { cols: [dimension], rows: [dimension2], color: [measure] };
  }
  if (type === 'ECHARTS_WORDCLOUD') {
    return { label: [dimension], size: [measure], color: [dimension2 || dimension] };
  }
  if (type === 'ECHARTS_GRAPH') {
    return {
      cols: [dimension, dimension2],
      color: [dimension3],
      size: [measure, measure2],
    };
  }
  if (type.startsWith('ECHARTS_GAUGE')) return { label: [measure] };
  if (type === 'ECHARTS_HEATMAP') {
    return { cols: [dimension], rows: [dimension2], color: [measure] };
  }
  if (type === 'ECHARTS_TREEMAP') {
    return { label: [dimension], size: [measure], color: [dimension2 || dimension] };
  }
  if (type === 'ECHARTS_SANKEY') {
    return { cols: [dimension, dimension2], size: [measure] };
  }
  if (type === 'ECHARTS_FUNNEL') return { color: [dimension], size: [measure] };
  if (type === 'TABLE_CROSS') return { rows: dimensions, measureGroup: measures };
  if (type === 'ECHARTS_BAR__HORIZONTAL') {
    return { cols: measures, rows: dimensions };
  }
  return { cols: dimensions, rows: measures };
}

function normalizedSlots(chart, type, dimensions, measures) {
  const rules = chartTypeContract(type).slots;
  const slots = Object.fromEntries(
    Object.entries(defaultSlots(type, dimensions, measures))
      .map(([name, values]) => [
        name,
        fieldNames(
          values.filter((value) => value !== undefined && value !== null && String(value).trim()),
          `${type}.${name}`,
        ),
      ]),
  );
  const explicit = Object.hasOwn(chart, 'slots') ? chart.slots : {};
  if (!explicit || typeof explicit !== 'object' || Array.isArray(explicit)) {
    throw new Error(`${type} slots must be an object`);
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (value == null) {
      throw new Error(`${type}.${name} must contain only non-empty strings`);
    }
    if (!ALL_SLOTS.has(name) || !Object.hasOwn(rules, name)) {
      throw new Error(`${type} has unsupported field slot: ${name}`);
    }
    slots[name] = fieldNames(value, `${type}.${name}`);
  }
  for (const name of ALL_SLOTS) {
    if (Object.hasOwn(chart, name) && chart[name] !== undefined) {
      if (!Object.hasOwn(rules, name)) {
        throw new Error(`${type} has unsupported field slot: ${name}`);
      }
      if (chart[name] == null) {
        throw new Error(`${type}.${name} must contain only non-empty strings`);
      }
      if (Object.hasOwn(explicit, name)) {
        throw new Error(`${type} field slot ${name} cannot be set both directly and in slots`);
      }
      slots[name] = fieldNames(chart[name], `${type}.${name}`);
    }
    slots[name] ||= [];
  }
  return slots;
}

function validateSlots(type, slots) {
  const { slots: rules } = chartTypeContract(type);
  for (const [name, fields] of Object.entries(slots)) {
    if (fields.length > 0 && !Object.hasOwn(rules, name)) {
      throw new Error(`${type} has unsupported field slot: ${name}`);
    }
  }
  for (const [name, { min, max }] of Object.entries(rules)) {
    const count = slots[name]?.length || 0;
    if (count < min || count > max) {
      const expected = min === max
        ? `exactly ${min}`
        : `${min}-${Number.isFinite(max) ? max : 'many'}`;
      throw new Error(`${type} slot ${name} requires ${expected} field(s); received ${count}`);
    }
  }
}

function normalizeLabels(value, index, boundFields) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`dashboard chart ${index + 1} labels must be an object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, label]) => {
      const normalizedName = String(name || '').trim();
      if (typeof label !== 'string' || !normalizedName || !label.trim()) {
        throw new Error(`dashboard chart ${index + 1} labels require non-empty string keys and values`);
      }
      const normalizedLabel = label.trim();
      if (!boundFields.has(normalizedName)) {
        throw new Error(
          `dashboard chart ${index + 1} label key is not a bound field: ${normalizedName}`,
        );
      }
      return [normalizedName, normalizedLabel];
    }),
  );
}

function explicitText(chart, key, fallback, index) {
  if (!Object.hasOwn(chart, key) || chart[key] === undefined) {
    return String(fallback || '').trim();
  }
  if (typeof chart[key] !== 'string') {
    throw new Error(`dashboard chart ${index + 1} ${key} must be a string`);
  }
  const value = chart[key].trim();
  if (!value) throw new Error(`dashboard chart ${index + 1} ${key} cannot be empty`);
  return value;
}

export function normalizeDashboardCharts(input) {
  let charts = input;
  if (typeof input === 'string') {
    try {
      charts = JSON.parse(input);
    } catch (error) {
      throw new Error(`dashboard chart JSON is invalid: ${error.message}`);
    }
  }
  if (!Array.isArray(charts) || charts.length < MIN_CHARTS || charts.length > MAX_CHARTS) {
    throw new Error(`dashboard chart definition requires ${MIN_CHARTS}-${MAX_CHARTS} charts`);
  }
  return charts.map((chart, index) => {
    if (!chart || typeof chart !== 'object' || Array.isArray(chart)) {
      throw new Error(`dashboard chart ${index + 1} must be an object`);
    }
    const unknownKeys = Object.keys(chart).filter((key) => !CHART_KEYS.has(key));
    if (unknownKeys.length) {
      throw new Error(
        `dashboard chart ${index + 1} has unsupported key(s): ${unknownKeys.join(', ')}`,
      );
    }
    if (Object.hasOwn(chart, 'dimensions') && Object.hasOwn(chart, 'dimension')) {
      throw new Error(`dashboard chart ${index + 1} cannot set dimensions and dimension together`);
    }
    if (Object.hasOwn(chart, 'measures') && Object.hasOwn(chart, 'measure')) {
      throw new Error(`dashboard chart ${index + 1} cannot set measures and measure together`);
    }
    for (const key of ['dimensions', 'dimension', 'measures', 'measure']) {
      if (Object.hasOwn(chart, key) && chart[key] == null) {
        throw new Error(`dashboard chart ${index + 1} ${key} must contain only non-empty strings`);
      }
    }
    if (Object.hasOwn(chart, 'labels') && chart.labels == null) {
      throw new Error(`dashboard chart ${index + 1} labels must be an object`);
    }
    if (
      Object.hasOwn(chart, 'type')
      && (typeof chart.type !== 'string' || !chart.type.trim())
    ) {
      throw new Error(`dashboard chart ${index + 1} type must be a non-empty string`);
    }
    const type = chart.type?.trim() || 'ECHARTS_BAR';
    const chartContract = chartTypeContract(type);
    const dimensions = fieldNames(
      chart.dimensions ?? chart.dimension,
      `dashboard chart ${index + 1} dimensions`,
    );
    const measures = fieldNames(
      chart.measures ?? chart.measure,
      `dashboard chart ${index + 1} measures`,
    );
    const slots = normalizedSlots(chart, type, dimensions, measures);
    validateSlots(type, slots);
    const boundFields = new Set(Object.values(slots).flat());
    for (const name of [...dimensions, ...measures]) {
      if (!boundFields.has(name)) {
        throw new Error(
          `dashboard chart ${index + 1} declares an unbound field: ${name}`,
        );
      }
    }
    const labels = normalizeLabels(chart.labels, index, boundFields);
    const authoredLabel = (name) => (
      name && Object.hasOwn(labels, name) ? labels[name] : ''
    );
    const firstByKind = (kind) => Object.entries(chartContract.slots)
      .find(([slot, rule]) => rule.kind === kind && slots[slot]?.length)?.[0];
    const dimensionSlot = firstByKind('dimension');
    const measureSlot = firstByKind('measure');
    const dimension = dimensions[0] || slots[dimensionSlot]?.[0] || '';
    const measure = measures[0] || slots[measureSlot]?.[0] || '';
    const dimensionLabel = explicitText(
      chart,
      'dimensionLabel',
      authoredLabel(dimension) || dimension,
      index,
    );
    const measureLabel = explicitText(
      chart,
      'measureLabel',
      authoredLabel(measure) || measure,
      index,
    );
    const fieldLabel = (name) => authoredLabel(name)
      || (name === dimension ? dimensionLabel : '')
      || (name === measure ? measureLabel : '')
      || name;
    const primaryDimensionLabel = fieldLabel(dimension);
    const primaryMeasureLabel = fieldLabel(measure);
    const defaultTitle = [primaryMeasureLabel, primaryDimensionLabel]
      .filter(Boolean)
      .join(' by ') || type;
    const title = explicitText(chart, 'title', defaultTitle, index);
    const xAxisTitle = explicitText(
      chart,
      'xAxisTitle',
      fieldLabel(slots.cols[0]),
      index,
    );
    const yAxisTitle = explicitText(
      chart,
      'yAxisTitle',
      fieldLabel(slots.rows[0]),
      index,
    );
    if (chartContract.axes === 'cartesian' && (!xAxisTitle || !yAxisTitle)) {
      throw new Error(`dashboard chart ${index + 1} requires non-empty axis labels`);
    }
    const angleAxisTitle = explicitText(
      chart,
      'angleAxisTitle',
      fieldLabel(slots.cols[0] || dimension),
      index,
    );
    const radiusAxisTitle = explicitText(
      chart,
      'radiusAxisTitle',
      fieldLabel(slots.rows[0] || measure),
      index,
    );
    if (chartContract.axes === 'polar' && (!angleAxisTitle || !radiusAxisTitle)) {
      throw new Error(`dashboard chart ${index + 1} requires non-empty polar-axis labels`);
    }
    const expectedDisplayMode = dashboardDisplayModeForType(type);
    if (
      Object.hasOwn(chart, 'displayMode')
      && chart.displayMode !== null
      && typeof chart.displayMode !== 'string'
    ) {
      throw new Error(`dashboard chart ${index + 1} displayMode must be a string or null`);
    }
    const displayMode = Object.hasOwn(chart, 'displayMode')
      ? (chart.displayMode == null ? null : chart.displayMode.trim())
      : expectedDisplayMode;
    if (displayMode !== expectedDisplayMode) {
      throw new Error(
        `dashboard chart ${index + 1} displayMode must be `
        + `${expectedDisplayMode === null ? 'null' : expectedDisplayMode} for ${type}`,
      );
    }
    return {
      type,
      displayMode,
      dimensions,
      measures,
      slots,
      title,
      labels,
      dimension,
      measure,
      dimensionLabel,
      measureLabel,
      xAxisTitle,
      yAxisTitle,
      angleAxisTitle,
      radiusAxisTitle,
    };
  });
}

export function dashboardGrid(charts) {
  const normalized = normalizeDashboardCharts(charts);
  const width = 600;
  const height = 320;
  const gapX = 24;
  const gapY = 24;
  const floats = {};
  normalized.forEach((chart, index) => {
    const slot = index + 1;
    floats[slot] = {
      slot: String(slot),
      left: (index % 2) * (width + gapX),
      top: Math.floor(index / 2) * (height + gapY),
      width,
      height,
    };
  });
  const rows = Math.ceil(normalized.length / 2);
  return {
    charts: normalized,
    floats,
    canvas: { width: 1280, height: Math.max(720, rows * (height + gapY)) },
  };
}
