const TERMINAL_STATES = new Set(['FINISH', 'ERROR', 'FAIL', 'FAILED', 'KILLED', 'STOP']);

export function isEtlTerminalState(state) {
  return TERMINAL_STATES.has(String(state || '').toUpperCase());
}

export function isEtlSuccessful(state) {
  return String(state || '').toUpperCase() === 'FINISH';
}

const SUCCESSFUL_NODE_STATES = new Set(['FINISH', 'OK', 'SUCCESS']);

export function assertEtlRunSucceeded(flowState, expectedNodeIds = []) {
  if (!isEtlSuccessful(flowState?.state)) {
    throw new Error(`ETL run failed with state ${flowState?.state || 'UNKNOWN'}`);
  }
  if (!Array.isArray(flowState.nodeStates) || flowState.nodeStates.length === 0) {
    throw new Error('ETL run returned no node states');
  }
  const byId = new Map(flowState.nodeStates.map((node) => [node?.id, node]));
  const missing = expectedNodeIds.filter((id) => !byId.has(id));
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
