import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agentOutputResourceId,
  assertAgentRunSucceeded,
  isAgentTerminalState,
} from '../scripts/agent-state.mjs';

test('Agent output endpoint key includes node and run instance ids', () => {
  assert.equal(agentOutputResourceId('llm-node', 'run-123'), 'llm-node-run-123');
  assert.throws(() => agentOutputResourceId('llm-node', ''), /requires node and instance ids/);
});

test('Agent success requires FINISH for every node and a non-empty answer', () => {
  const state = {
    state: 'FINISH',
    nodeStates: [
      { id: 'start', state: 'FINISH' },
      { id: 'llm', state: 'FINISH' },
      { id: 'finish', state: 'FINISH' },
    ],
  };
  assert.equal(assertAgentRunSucceeded(state, [{ content: '  verified answer  ' }]), 'verified answer');
  assert.throws(() => assertAgentRunSucceeded(state, []), /without a non-empty LLM result/);
  assert.throws(
    () => assertAgentRunSucceeded({
      ...state,
      nodeStates: [{ id: 'llm', state: 'ERROR' }],
    }, [{ content: 'ignored' }]),
    /did not finish every node/,
  );
  assert.equal(isAgentTerminalState('FAILED'), true);
  assert.equal(isAgentTerminalState('RUNNING'), false);
});
