import {
  chartTypeContract,
  dashboardDisplayModeForType,
} from './dashboard-multi.mjs';
import { dashboardPortletChartType } from './dashboard-verification.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function fieldSummary(field) {
  return {
    id: field?.id || null,
    name: field?.name || null,
    label: text(field?.label || field?.alias || field?.showName),
    type: field?.type || null,
    group: field?.group || null,
    dataType: field?.dataType || null,
    aggregate: field?.aggregate ?? null,
    originAggregate: field?.originAggregate ?? null,
  };
}

function tableMeasureFields(extended) {
  return Object.values(extended?.fieldGroup || {})
    .flatMap((fields) => (Array.isArray(fields) ? fields : []))
    .map(fieldSummary);
}

function chartSummary(portlet) {
  const portletType = text(portlet?.type);
  const extended = portlet?.extended || {};
  const fields = extended.fields || {};
  const globalMarks = extended.markFieldGroups?.GLOBAL_MARK || {};
  const publicMapMarks = extended.markFieldGroups?.PUBLIC_MARK_NONE_ECHARTS_MAP || {};
  const marks = Object.fromEntries(
    ['color', 'size', 'angle', 'label', 'tooltip', 'shape']
      .map((slot) => [slot, publicMapMarks[slot] || globalMarks[slot] || []]),
  );
  const slots = {
    cols: portletType === 'TABLE_CROSS' ? [] : (fields.cols || []).map(fieldSummary),
    rows: (fields.rows || []).map(fieldSummary),
    color: (marks.color || []).map(fieldSummary),
    size: (marks.size || []).map(fieldSummary),
    angle: (marks.angle || []).map(fieldSummary),
    label: (marks.label || []).map(fieldSummary),
    tooltip: (marks.tooltip || []).map(fieldSummary),
    shape: (marks.shape || []).map(fieldSummary),
    measureGroup: portletType === 'TABLE_CROSS' ? tableMeasureFields(extended) : [],
  };
  const dimension = portletType === 'TABLE_CROSS'
    ? (slots.rows[0] || null)
    : (slots.cols[0] || slots.rows[0] || slots.color[0] || slots.label[0] || null);
  const measure = slots.measureGroup[0]
    || slots.rows[0]
    || slots.angle[0]
    || slots.size[0]
    || slots.label[0]
    || null;
  return {
    id: portlet?.id || null,
    type: dashboardPortletChartType(portlet) || portletType,
    displayMode: portlet?.displayMode ?? null,
    title: text(extended.title?.text),
    dimension: dimension?.name || null,
    dimensionLabel: dimension?.label || '',
    measure: measure?.name || null,
    measureLabel: measure?.label || '',
    xAxisTitle: text(extended.chartDefine?.xAxis?.name),
    yAxisTitle: text(extended.chartDefine?.yAxis?.name),
    angleAxisTitle: text(extended.chartDefine?.angleAxis?.name),
    radiusAxisTitle: text(extended.chartDefine?.radiusAxis?.name),
    slots,
  };
}

function overlap(left, right) {
  return left.left < right.left + right.width
    && left.left + left.width > right.left
    && left.top < right.top + right.height
    && left.top + left.height > right.top;
}

export function auditDashboardPresentation(dashboard, expectedChartCount = null) {
  const charts = (dashboard?.define?.portlets || [])
    .filter((portlet) => {
      const type = text(portlet?.type);
      return type === 'TABLE_CROSS' || type.startsWith('ECHARTS_');
    })
    .map(chartSummary);
  const layout = dashboard?.define?.devices?.default?.layout;
  const floats = Object.values(layout?.define?.floats || {});
  const floatByPortlet = new Map();
  for (const item of floats) {
    const values = floatByPortlet.get(item?.portletId) || [];
    values.push(item);
    floatByPortlet.set(item?.portletId, values);
  }
  const issues = [];
  if (expectedChartCount != null && charts.length !== expectedChartCount) {
    issues.push(`dashboard has ${charts.length} visualizations; expected ${expectedChartCount}`);
  }
  charts.forEach((chart, index) => {
    const chartNumber = index + 1;
    if (!chart.title) issues.push(`chart ${chartNumber} has no title`);
    let contract = null;
    try {
      contract = chartTypeContract(chart.type);
      const expectedDisplayMode = dashboardDisplayModeForType(chart.type);
      if (chart.displayMode !== expectedDisplayMode) {
        issues.push(
          `chart ${chartNumber} displayMode is inconsistent with ${chart.type}`,
        );
      }
    } catch (error) {
      issues.push(`chart ${chartNumber} ${error.message}`);
    }
    for (const [slot, fields] of Object.entries(chart.slots)) {
      for (const field of fields) {
        if (!field.label) {
          issues.push(
            `chart ${chartNumber} slot ${slot} field ${field.name || '(unknown)'} has no label`,
          );
        }
        if (
          field.type === 'CALC_MEASURE'
          && (
            field.group !== 'CALC_MEASURE'
            || field.aggregate !== null
            || field.originAggregate !== null
          )
        ) {
          issues.push(
            `chart ${chartNumber} slot ${slot} calculated measure `
            + `${field.name || '(unknown)'} has invalid aggregation metadata`,
          );
        }
      }
    }
    for (const [slot, fields] of Object.entries(chart.slots)) {
      if (fields.length > 0 && !Object.hasOwn(contract?.slots || {}, slot)) {
        issues.push(`chart ${chartNumber} has fields in unsupported slot ${slot}`);
      }
    }
    for (const [slot, rule] of Object.entries(contract?.slots || {})) {
      const count = chart.slots[slot]?.length || 0;
      if (count < rule.min || count > rule.max) {
        issues.push(
          `chart ${chartNumber} slot ${slot} has ${count} field(s); `
          + `expected ${rule.min}-${Number.isFinite(rule.max) ? rule.max : 'many'}`,
        );
      }
    }
    if (contract?.axes === 'cartesian') {
      if (!chart.xAxisTitle) issues.push(`chart ${chartNumber} has no x-axis title`);
      if (!chart.yAxisTitle) issues.push(`chart ${chartNumber} has no y-axis title`);
    }
    if (contract?.axes === 'polar') {
      if (!chart.angleAxisTitle) issues.push(`chart ${chartNumber} has no angle-axis title`);
      if (!chart.radiusAxisTitle) issues.push(`chart ${chartNumber} has no radius-axis title`);
    }
    const positions = floatByPortlet.get(chart.id) || [];
    if (positions.length === 0) issues.push(`chart ${chartNumber} has no layout slot`);
    if (positions.length > 1) issues.push(`chart ${chartNumber} has multiple layout slots`);
    const position = positions[0];
    if (position) {
      const values = [position.left, position.top, position.width, position.height];
      if (!values.every(Number.isFinite) || position.width <= 0 || position.height <= 0) {
        issues.push(`chart ${chartNumber} has invalid layout geometry`);
      }
      const canvas = layout?.size || {};
      if (
        Number.isFinite(canvas.width)
        && Number.isFinite(canvas.height)
        && (
          position.left < 0
          || position.top < 0
          || position.left + position.width > canvas.width
          || position.top + position.height > canvas.height
        )
      ) {
        issues.push(`chart ${chartNumber} lies outside the dashboard canvas`);
      }
    }
  });
  for (let left = 0; left < charts.length; left += 1) {
    const leftPosition = (floatByPortlet.get(charts[left].id) || [])[0];
    if (!leftPosition) continue;
    for (let right = left + 1; right < charts.length; right += 1) {
      const rightPosition = (floatByPortlet.get(charts[right].id) || [])[0];
      if (rightPosition && overlap(leftPosition, rightPosition)) {
        issues.push(`charts ${left + 1} and ${right + 1} overlap`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    chartCount: charts.length,
    charts,
  };
}
