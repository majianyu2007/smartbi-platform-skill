const MIN_CHARTS = 2;
const MAX_CHARTS = 8;

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
    throw new Error(`dashboard-create-multi requires ${MIN_CHARTS}-${MAX_CHARTS} chart definitions`);
  }
  return charts.map((chart, index) => {
    if (!chart || typeof chart !== 'object' || Array.isArray(chart)) {
      throw new Error(`dashboard chart ${index + 1} must be an object`);
    }
    const dimension = String(chart.dimension || '').trim();
    const measure = String(chart.measure || '').trim();
    const title = String(chart.title || `${measure} by ${dimension}`).trim();
    if (!dimension || !measure || !title) {
      throw new Error(`dashboard chart ${index + 1} requires dimension, measure, and title`);
    }
    const dimensionLabel = String(chart.dimensionLabel || dimension).trim();
    const measureLabel = String(chart.measureLabel || measure).trim();
    const xAxisTitle = String(chart.xAxisTitle || dimensionLabel).trim();
    const yAxisTitle = String(chart.yAxisTitle || measureLabel).trim();
    if (!dimensionLabel || !measureLabel || !xAxisTitle || !yAxisTitle) {
      throw new Error(`dashboard chart ${index + 1} requires non-empty field and axis labels`);
    }
    return {
      dimension,
      measure,
      title,
      dimensionLabel,
      measureLabel,
      xAxisTitle,
      yAxisTitle,
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
