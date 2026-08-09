function clone(value) {
  return structuredClone(value);
}

function crossTable(report) {
  return report?.define?.portlets?.find((portlet) => portlet.type === 'CROSS_TABLE') || null;
}

function emptyFilterPanel(portlet) {
  if (portlet?.type !== 'FILTER_PANEL') return false;
  const children = portlet.extended?.children;
  return !Array.isArray(children) || children.length === 0;
}

function technicalLabel(field) {
  const label = String(field?.label || field?.alias || '').trim();
  const name = String(field?.name || '').trim();
  if (!label) return true;
  return label === name || label.includes('_');
}

export function auditAnalysisPresentation(report) {
  const issues = [];
  const table = crossTable(report);
  if (!table) {
    issues.push('missing cross table');
    return { ok: false, issues };
  }

  const rows = table.extended?.fields?.rows || [];
  const measures = table.extended?.fields?.measures || [];
  if (rows.length === 0) issues.push('missing row field');
  if (measures.length === 0) issues.push('missing measure field');
  if (rows.some(technicalLabel)) issues.push('row label is technical');
  if (measures.some(technicalLabel)) issues.push('measure label is technical');
  if ((report.define?.portlets || []).some(emptyFilterPanel)) issues.push('empty filter panel');

  return { ok: issues.length === 0, issues };
}

export function improveAnalysisPresentation(report, {
  rowLabel,
  measureLabel,
  description = '',
} = {}) {
  if (!report || typeof report !== 'object') throw new Error('analysis report is required');
  if (!String(rowLabel || '').trim()) throw new Error('analysis row label is required');
  if (!String(measureLabel || '').trim()) throw new Error('analysis measure label is required');

  const repaired = clone(report);
  const table = crossTable(repaired);
  if (!table) throw new Error('analysis report has no CROSS_TABLE portlet');
  const rows = table.extended?.fields?.rows || [];
  const measures = table.extended?.fields?.measures || [];
  if (rows.length !== 1 || measures.length !== 1) {
    throw new Error('analysis presentation repair requires exactly one row field and one measure');
  }

  const normalizedRowLabel = String(rowLabel).trim();
  const normalizedMeasureLabel = String(measureLabel).trim();
  for (const field of rows) {
    field.alias = normalizedRowLabel;
    field.label = normalizedRowLabel;
    field.desc = normalizedRowLabel;
    field.showName = normalizedRowLabel;
  }
  for (const field of measures) {
    field.alias = normalizedMeasureLabel;
    field.label = normalizedMeasureLabel;
    field.desc = normalizedMeasureLabel;
    field.showName = normalizedMeasureLabel;
  }

  repaired.define.portlets = repaired.define.portlets.filter((portlet) => !emptyFilterPanel(portlet));
  const normalizedDescription = String(description || '').trim();
  if (normalizedDescription) {
    repaired.desc = normalizedDescription;
    table.name = normalizedDescription;
  }

  return repaired;
}
