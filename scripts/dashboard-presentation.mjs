function text(value) {
  return String(value || '').trim();
}

function chartSummary(portlet) {
  const extended = portlet?.extended || {};
  const dimension = extended.fields?.cols?.[0] || null;
  const measure = extended.fields?.rows?.[0] || null;
  return {
    id: portlet?.id || null,
    title: text(extended.title?.text),
    dimension: dimension?.name || null,
    dimensionLabel: text(dimension?.label || dimension?.alias || dimension?.showName),
    measure: measure?.name || null,
    measureLabel: text(measure?.label || measure?.alias || measure?.showName),
    xAxisTitle: text(extended.chartDefine?.xAxis?.name),
    yAxisTitle: text(extended.chartDefine?.yAxis?.name),
  };
}

export function auditDashboardPresentation(dashboard, expectedChartCount = null) {
  const charts = (dashboard?.define?.portlets || [])
    .filter((portlet) => String(portlet?.type || '').startsWith('ECHARTS_'))
    .map(chartSummary);
  const floats = Object.values(
    dashboard?.define?.devices?.default?.layout?.define?.floats || {},
  );
  const laidOutPortletIds = new Set(floats.map((entry) => entry.portletId).filter(Boolean));
  const issues = [];

  if (expectedChartCount !== null && charts.length !== expectedChartCount) {
    issues.push(`chart count is ${charts.length}; expected ${expectedChartCount}`);
  }
  charts.forEach((chart, index) => {
    const chartNumber = index + 1;
    if (!chart.title) issues.push(`chart ${chartNumber} has no title`);
    if (!chart.dimensionLabel) issues.push(`chart ${chartNumber} has no dimension label`);
    if (!chart.measureLabel) issues.push(`chart ${chartNumber} has no measure label`);
    if (!chart.xAxisTitle) issues.push(`chart ${chartNumber} has no x-axis title`);
    if (!chart.yAxisTitle) issues.push(`chart ${chartNumber} has no y-axis title`);
    if (!laidOutPortletIds.has(chart.id)) issues.push(`chart ${chartNumber} has no layout slot`);
  });

  return {
    ok: issues.length === 0,
    issues,
    chartCount: charts.length,
    charts,
  };
}
