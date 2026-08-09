import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEtlRunSucceeded,
  isEtlSuccessful,
  isEtlTerminalState,
} from '../scripts/etl-state.mjs';

test('recognizes Smartbi FAIL as a terminal ETL state', () => {
  assert.equal(isEtlTerminalState('FAIL'), true);
  assert.equal(isEtlSuccessful('FAIL'), false);
});

test('recognizes a user-stopped ETL as terminal but unsuccessful', () => {
  assert.equal(isEtlTerminalState('STOP'), true);
  assert.equal(isEtlSuccessful('STOP'), false);
});

test('recognizes FINISH as the only successful ETL state', () => {
  assert.equal(isEtlTerminalState('FINISH'), true);
  assert.equal(isEtlSuccessful('FINISH'), true);
  assert.equal(isEtlTerminalState('RUNNING'), false);
  assert.equal(isEtlTerminalState('INITED'), false);
});

test('ETL completion requires every expected node to report success', () => {
  assert.doesNotThrow(() => assertEtlRunSucceeded({
    state: 'FINISH',
    nodeStates: [
      { id: 'source', state: 'FINISH' },
      { id: 'transform', state: 'OK' },
      { id: 'target', state: 'SUCCESS' },
    ],
  }, ['source', 'transform', 'target']));
  assert.throws(
    () => assertEtlRunSucceeded({
      state: 'FINISH',
      nodeStates: [
        { id: 'source', state: 'FINISH' },
        { id: 'target', state: 'FAIL' },
      ],
    }, ['source', 'target']),
    /ETL nodes did not finish successfully/,
  );
  assert.throws(
    () => assertEtlRunSucceeded({
      state: 'FINISH',
      nodeStates: [{ id: 'source', state: 'FINISH' }],
    }, ['source', 'target']),
    /ETL run omitted node states: target/,
  );
});
