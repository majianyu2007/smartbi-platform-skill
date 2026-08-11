import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_OUTPUT_CONTENT_LIMIT,
  agentOutputResourceId,
  assertAgentNodeStatesSucceeded,
  assertAgentRunSucceeded,
  createAgentOutputReceipt,
  extractAgentFinishOutput,
  isAgentTerminalState,
  summarizeAgentNodeStates,
} from '../scripts/agent-state.mjs';

const nodeIds = { start: 'start', llm: 'llm', finish: 'finish' };

function finishedState() {
  return {
    state: 'finish',
    nodeStates: [
      { id: 'start', state: 'FINISH', diagnostic: 'must not escape' },
      { id: 'llm', state: 'finish', result: { private: true } },
      { id: 'finish', state: 'FINISH', output: 'must not escape' },
    ],
  };
}

test('Agent output endpoint key includes node and run instance ids', () => {
  assert.equal(agentOutputResourceId('llm-node', 'run-123'), 'llm-node-run-123');
  assert.throws(() => agentOutputResourceId('llm-node', ''), /requires node and instance ids/);
});

test('Agent completion requires the exact saved nodes and a non-empty mapped Finish output', () => {
  const state = finishedState();
  const finishOutput = extractAgentFinishOutput([{
    value: {
      result_content: '  verified answer  ',
      input_tokens: 10,
      output_tokens: 4,
      providerToken: 'must-not-escape',
    },
    rawProviderReceipt: 'must-not-escape',
  }]);
  assert.deepEqual(finishOutput, {
    content: 'verified answer',
    inputTokens: 10,
    outputTokens: 4,
  });
  assert.equal(assertAgentRunSucceeded(state, { expectedNodeIds: nodeIds, finishOutput }), 'verified answer');
  assert.equal(assertAgentNodeStatesSucceeded(state, nodeIds), true);
  assert.deepEqual(summarizeAgentNodeStates(state, nodeIds), [
    { id: 'start', type: 'start', state: 'FINISH' },
    { id: 'llm', type: 'llm', state: 'FINISH' },
    { id: 'finish', type: 'finish', state: 'FINISH' },
  ]);
});

test('Agent terminal validation fails closed on missing, extra, duplicate, or failed nodes', () => {
  const state = finishedState();
  assert.throws(
    () => assertAgentNodeStatesSucceeded({ ...state, state: 'FAILED' }, nodeIds),
    /failed with state FAILED/,
  );
  assert.throws(
    () => assertAgentNodeStatesSucceeded({
      ...state,
      nodeStates: state.nodeStates.slice(0, 2),
    }, nodeIds),
    /do not match the saved graph/,
  );
  assert.throws(
    () => assertAgentNodeStatesSucceeded({
      ...state,
      nodeStates: [...state.nodeStates, { id: 'branch', state: 'FINISH' }],
    }, nodeIds),
    /do not match the saved graph/,
  );
  assert.throws(
    () => assertAgentNodeStatesSucceeded({
      ...state,
      nodeStates: [
        { id: 'start', state: 'FINISH' },
        { id: 'llm', state: 'FINISH' },
        { id: 'llm', state: 'FINISH' },
      ],
    }, nodeIds),
    /do not match the saved graph/,
  );
  assert.throws(
    () => assertAgentNodeStatesSucceeded({
      ...state,
      nodeStates: state.nodeStates.map((node) => (
        node.id === 'llm' ? { ...node, state: 'ERROR' } : node
      )),
    }, nodeIds),
    /did not finish every node/,
  );
  assert.equal(isAgentTerminalState('FAILED'), true);
  assert.equal(isAgentTerminalState('RUNNING'), false);
});

test('Agent Finish output rejects empty or ambiguous records', () => {
  assert.throws(() => extractAgentFinishOutput([]), /non-empty Finish output/);
  assert.throws(
    () => extractAgentFinishOutput([
      { value: { result_content: 'first' } },
      { value: { result_content: 'second' } },
    ]),
    /ambiguous mapped Finish outputs/,
  );
  assert.throws(
    () => assertAgentRunSucceeded(finishedState(), {
      expectedNodeIds: nodeIds,
      finishOutput: { content: ' ' },
    }),
    /non-empty Finish output/,
  );
});

test('Agent output receipts redact raw records and cap returned content', () => {
  const receipt = createAgentOutputReceipt({
    content: 'abcdefghijk',
    inputTokens: 7,
    outputTokens: 3,
    raw: { apiKey: 'must-not-escape' },
  }, 8);
  assert.deepEqual(receipt, {
    content: 'abcdefgh',
    truncated: true,
    redacted: false,
    originalLength: 11,
    inputTokens: 7,
    outputTokens: 3,
  });
  assert.doesNotMatch(JSON.stringify(receipt), /must-not-escape|apiKey/);
  const redacted = createAgentOutputReceipt({
    content: 'result apiKey=supersecretvalue Authorization: Bearer abcdefghijklmnop',
  });
  assert.equal(redacted.redacted, true);
  assert.match(redacted.content, /\[REDACTED\]/);
  assert.doesNotMatch(redacted.content, /supersecretvalue|abcdefghijklmnop/);
  assert.throws(
    () => createAgentOutputReceipt({ content: 'x' }, AGENT_OUTPUT_CONTENT_LIMIT + 1),
    /output limit/,
  );
});
