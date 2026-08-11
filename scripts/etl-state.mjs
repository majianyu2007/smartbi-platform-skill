import {
  assertExactEtlTarget,
  extractEtlTableBindings,
  normalizeEtlSchema,
} from './etl-contracts.mjs';

const TERMINAL_STATES = new Set(['FINISH', 'ERROR', 'FAIL', 'FAILED', 'KILLED', 'STOP']);

export function isEtlTerminalState(state) {
  return TERMINAL_STATES.has(String(state || '').toUpperCase());
}

export function isEtlSuccessful(state) {
  return String(state || '').toUpperCase() === 'FINISH';
}

const SUCCESSFUL_NODE_STATES = new Set(['FINISH', 'OK', 'SUCCESS']);

export function summarizeEtlPortResult(result) {
  const features = Array.isArray(result?.features) && result.features.length > 0
    ? result.features
    : (Array.isArray(result?.metadata) ? result.metadata : []);
  const csv = result?.csv;
  const fields = features
    .map((feature) => feature?.alias || feature?.name)
    .filter(Boolean);
  if (fields.length === 0 && Array.isArray(csv?.stringHeaderNames)) {
    fields.push(...csv.stringHeaderNames.filter(Boolean));
  }
  let schema = [];
  if (features.length > 0) {
    try {
      schema = normalizeEtlSchema(features, 'ETL terminal preview schema');
    } catch {
      schema = [];
    }
  }
  let rowCount = null;
  let rowCountSource = null;
  let rowCountComplete = false;
  if (Number.isInteger(csv?.totalRowsCount)) {
    rowCount = csv.totalRowsCount;
    rowCountSource = 'totalRowsCount';
    rowCountComplete = true;
  } else if (Number.isInteger(csv?.rowsCount)) {
    rowCount = csv.rowsCount;
    rowCountSource = 'rowsCount';
  } else if (Array.isArray(csv)) {
    rowCount = csv.length;
    rowCountSource = 'preview-array-length';
  }
  return {
    featureCount: fields.length,
    fields,
    schema,
    schemaAvailable: schema.length === fields.length && schema.length > 0,
    rowCount,
    rowCountSource,
    rowCountComplete,
    available: fields.length > 0 && Number.isInteger(rowCount),
  };
}

export function assertEtlRunSucceeded(flowState, expectedNodeIds = [], instanceId = null) {
  if (!isEtlSuccessful(flowState?.state)) {
    throw new Error(`ETL run failed with state ${flowState?.state || 'UNKNOWN'}`);
  }
  if (!Array.isArray(flowState.nodeStates) || flowState.nodeStates.length === 0) {
    throw new Error('ETL run returned no node states');
  }
  const reportedIds = flowState.nodeStates.map((node) => String(node?.id || ''));
  const missing = expectedNodeIds.filter((id) => !reportedIds.some((reportedId) => (
    reportedId === id || reportedId === `${id}-${instanceId}`
  )));
  if (missing.length > 0) {
    throw new Error(`ETL run omitted node states: ${missing.join(',')}`);
  }
  const failed = flowState.nodeStates.filter((node) => (
    !SUCCESSFUL_NODE_STATES.has(String(node?.state || '').toUpperCase())
  ));
  if (failed.length > 0) {
    throw new Error(
      `ETL nodes did not finish successfully: ${failed.map((node) => (
        `${node?.alias || node?.name || node?.id}:${node?.state || 'UNKNOWN'}`
      )).join(',')}`,
    );
  }
  return flowState.nodeStates;
}

export function assertCurrentEtlRunEvidence(processDag, graph, flowState, expectedTarget = null) {
  const instanceId = String(processDag?.currentInstanceId || '').trim();
  if (!instanceId) throw new Error('ETL flow has no current run instance');
  const expectedNodeIds = (graph?.nodes || []).map((node) => node?.id).filter(Boolean);
  const nodeStates = assertEtlRunSucceeded(flowState, expectedNodeIds, instanceId);
  const { targets } = extractEtlTableBindings(graph);
  if (targets.length !== 1) {
    throw new Error(`ETL current run requires exactly one materialized target; found ${targets.length}`);
  }
  if (expectedTarget) assertExactEtlTarget(targets[0], expectedTarget);
  return { instanceId, nodeStates, target: targets[0] };
}
