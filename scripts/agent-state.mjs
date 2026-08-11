export const AGENT_OUTPUT_CONTENT_LIMIT = 4096;

const TERMINAL_AGENT_STATES = new Set(['FINISH', 'ERROR', 'FAILED', 'KILLED', 'STOP']);

function normalizeState(state) {
  return String(state || '').toUpperCase();
}

function expectedIds(expectedNodeIds) {
  const ids = Array.isArray(expectedNodeIds)
    ? expectedNodeIds
    : Object.values(expectedNodeIds || {});
  if (ids.length === 0 || ids.some((id) => !String(id || '').trim())) {
    throw new Error('Agent run validation requires the saved graph node ids');
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('Agent run validation received duplicate saved graph node ids');
  }
  return ids;
}

function safeTokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function clipContent(content, limit) {
  if (content.length <= limit) return content;
  let clipped = content.slice(0, limit);
  const finalCodeUnit = clipped.charCodeAt(clipped.length - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) clipped = clipped.slice(0, -1);
  return clipped;
}

function redactOutputContent(content) {
  let redacted = content;
  redacted = redacted.replace(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]',
  );
  redacted = redacted.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    'Bearer [REDACTED]',
  );
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED API KEY]');
  redacted = redacted.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED ACCESS KEY]');
  redacted = redacted.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\b(\s*[:=]\s*)[^\s"',;]+/gi,
    '$1$2[REDACTED]',
  );
  return { content: redacted, redacted: redacted !== content };
}

export function isAgentTerminalState(state) {
  return TERMINAL_AGENT_STATES.has(normalizeState(state));
}

export function agentOutputResourceId(nodeId, instanceId) {
  const node = String(nodeId || '').trim();
  const instance = String(instanceId || '').trim();
  if (!node || !instance) throw new Error('Agent output requires node and instance ids');
  return `${node}-${instance}`;
}

export function assertAgentNodeStatesSucceeded(state, expectedNodeIds) {
  if (!state || !isAgentTerminalState(state.state)) {
    throw new Error('Agent run has not reached a terminal state');
  }
  if (normalizeState(state.state) !== 'FINISH') {
    throw new Error(`Agent run failed with state ${normalizeState(state.state) || 'UNKNOWN'}`);
  }
  if (!Array.isArray(state.nodeStates) || state.nodeStates.length === 0) {
    throw new Error('Agent run returned no node states');
  }
  const requiredIds = expectedIds(expectedNodeIds);
  const observedIds = state.nodeStates.map((node) => String(node?.id || '').trim());
  if (
    observedIds.some((id) => !id)
    || new Set(observedIds).size !== observedIds.length
    || observedIds.length !== requiredIds.length
    || requiredIds.some((id) => !observedIds.includes(id))
  ) {
    throw new Error('Agent run node states do not match the saved graph');
  }
  const failedNodes = state.nodeStates.filter((node) => normalizeState(node.state) !== 'FINISH');
  if (failedNodes.length > 0) {
    throw new Error(
      `Agent run did not finish every node: ${failedNodes.map((node) => (
        `${String(node.id || 'UNKNOWN').slice(0, 128)}:${normalizeState(node.state) || 'UNKNOWN'}`
      )).join(',')}`,
    );
  }
  return true;
}

export function extractAgentFinishOutput(records) {
  if (!Array.isArray(records)) {
    throw new Error('Agent mapped LLM output has an unsupported response shape');
  }
  const candidates = [];
  for (const record of records) {
    const content = record?.value?.result_content;
    if (typeof content !== 'string' || !content.trim()) continue;
    candidates.push({
      content: content.trim(),
      inputTokens: safeTokenCount(record.value.input_tokens),
      outputTokens: safeTokenCount(record.value.output_tokens),
    });
  }
  if (candidates.length === 0) {
    throw new Error('Agent run finished without a non-empty Finish output');
  }
  const distinct = new Set(candidates.map((candidate) => candidate.content));
  if (distinct.size !== 1) {
    throw new Error('Agent run returned ambiguous mapped Finish outputs');
  }
  return candidates.at(-1);
}

export function assertAgentRunSucceeded(state, { expectedNodeIds, finishOutput } = {}) {
  assertAgentNodeStatesSucceeded(state, expectedNodeIds);
  const answer = String(finishOutput?.content || '').trim();
  if (!answer) throw new Error('Agent run finished without a non-empty Finish output');
  return answer;
}

export function createAgentOutputReceipt(
  finishOutput,
  limit = AGENT_OUTPUT_CONTENT_LIMIT,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > AGENT_OUTPUT_CONTENT_LIMIT) {
    throw new Error(`Agent output limit must be between 1 and ${AGENT_OUTPUT_CONTENT_LIMIT}`);
  }
  const content = String(finishOutput?.content || '').trim();
  if (!content) throw new Error('Agent output receipt requires non-empty content');
  const safeContent = redactOutputContent(content);
  const clipped = clipContent(safeContent.content, limit);
  return {
    content: clipped,
    truncated: clipped.length < safeContent.content.length,
    redacted: safeContent.redacted,
    originalLength: content.length,
    inputTokens: safeTokenCount(finishOutput.inputTokens),
    outputTokens: safeTokenCount(finishOutput.outputTokens),
  };
}

export function summarizeAgentNodeStates(state, nodeIds) {
  const requiredIds = expectedIds(nodeIds);
  assertAgentNodeStatesSucceeded(state, requiredIds);
  const byId = new Map(state.nodeStates.map((node) => [node.id, node]));
  const typeById = new Map(Object.entries(nodeIds || {}).map(([type, id]) => [id, type]));
  return requiredIds.map((id) => ({
    id: String(id).slice(0, 128),
    type: typeById.get(id) || 'node',
    state: normalizeState(byId.get(id)?.state),
  }));
}
