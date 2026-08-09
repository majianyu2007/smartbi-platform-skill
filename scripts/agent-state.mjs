const TERMINAL_AGENT_STATES = new Set(['FINISH', 'ERROR', 'FAILED', 'KILLED', 'STOP']);

export function isAgentTerminalState(state) {
  return TERMINAL_AGENT_STATES.has(String(state || '').toUpperCase());
}

export function agentOutputResourceId(nodeId, instanceId) {
  const node = String(nodeId || '').trim();
  const instance = String(instanceId || '').trim();
  if (!node || !instance) throw new Error('Agent output requires node and instance ids');
  return `${node}-${instance}`;
}

export function assertAgentRunSucceeded(state, outputs) {
  if (!state || !isAgentTerminalState(state.state)) {
    throw new Error('Agent run has not reached a terminal state');
  }
  if (state.state !== 'FINISH') {
    throw new Error(`Agent run failed with state ${state.state}`);
  }
  if (!Array.isArray(state.nodeStates) || state.nodeStates.length === 0) {
    throw new Error('Agent run returned no node states');
  }
  const failedNodes = state.nodeStates.filter((node) => node.state !== 'FINISH');
  if (failedNodes.length > 0) {
    throw new Error(
      `Agent run did not finish every node: ${failedNodes.map((node) => (
        `${node.alias || node.name || node.id}:${node.state || 'UNKNOWN'}`
      )).join(',')}`,
    );
  }
  const answer = String(outputs?.at(-1)?.content || '').trim();
  if (!answer) throw new Error('Agent run finished without a non-empty LLM result');
  return answer;
}
