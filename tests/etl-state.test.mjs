import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEtlRunSucceeded,
  assertCurrentEtlRunEvidence,
  isEtlSuccessful,
  isEtlTerminalState,
  summarizeEtlPortResult,
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
  assert.doesNotThrow(() => assertEtlRunSucceeded({
    state: 'FINISH',
    nodeStates: [
      { id: 'source-instance-1', state: 'FINISH' },
      { id: 'transform-instance-1', state: 'FINISH' },
      { id: 'target-instance-1', state: 'FINISH' },
    ],
  }, ['source', 'transform', 'target'], 'instance-1'));
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

test('summarizes the live Smartbi object-shaped CSV preview', () => {
  assert.deepEqual(summarizeEtlPortResult({
    features: [],
    metadata: [
      { name: 'SITE', alias: 'SITE', dataType: 'VARCHAR' },
      { name: 'Q1', alias: 'Age', dataType: 'INTEGER' },
    ],
    csv: {
      stringHeaderNames: ['SITE', 'Q1'],
      rowsCount: 100,
      totalRowsCount: 4020,
      data: [],
    },
  }), {
    featureCount: 2,
    fields: ['SITE', 'Age'],
    schema: [
      {
        name: 'SITE',
        alias: 'SITE',
        type: 'VARCHAR',
        ordinal: 0,
        precision: null,
        scale: null,
        nullable: null,
      },
      {
        name: 'Q1',
        alias: 'Age',
        type: 'INTEGER',
        ordinal: 1,
        precision: null,
        scale: null,
        nullable: null,
      },
    ],
    schemaAvailable: true,
    rowCount: 4020,
    rowCountSource: 'totalRowsCount',
    rowCountComplete: true,
    available: true,
  });
});

test('current run evidence rejects a stale instance and verifies the exact target tuple', () => {
  const graph = {
    nodes: [
      {
        id: 'source',
        name: 'JDBC_DATASOURCE',
        inputs: [],
        outputs: [{ id: 'source-out', order: 0, types: ['DATASET'] }],
        configs: [{
          name: 'jdbc',
          value: JSON.stringify({
            datasourceId: 'DS.input',
            schemaId: 'SCHEMA.input.input.null',
            tableId: 'TAB.input.input.null.TEAM_source',
            tableData: { id: 'TAB.input.input.null.TEAM_source' },
          }),
        }],
        combineConfigs: [],
      },
      {
        id: 'target',
        name: 'JDBC_DATATARGER_OVERWRITE',
        inputs: [{ id: 'target-in', order: 0, types: ['DATASET'] }],
        outputs: [],
        configs: [{
          name: 'jdbcTarget',
          value: JSON.stringify({
            datasourceId: 'DS.input',
            schemaId: 'SCHEMA.input.input.null',
            tableId: 'TEAM_target',
          }),
        }],
        combineConfigs: [],
        smartbiCliTargetTableId: 'TAB.input.input.null.TEAM_target',
      },
    ],
    links: [{
      from: 'source',
      to: 'target',
      inputPortId: 'source-out',
      outputPortId: 'target-in',
    }],
  };
  const state = {
    state: 'FINISH',
    nodeStates: [
      { id: 'source-current', state: 'FINISH' },
      { id: 'target-current', state: 'FINISH' },
    ],
  };
  assert.deepEqual(
    assertCurrentEtlRunEvidence(
      { currentInstanceId: 'current' },
      graph,
      state,
      {
        tableId: 'TAB.input.input.null.TEAM_target',
        dataSourceId: 'DS.input',
        physicalTableName: 'TEAM_target',
      },
    ).target,
    {
      nodeId: 'target',
      tableId: 'TAB.input.input.null.TEAM_target',
      dataSourceId: 'DS.input',
      schemaId: 'SCHEMA.input.input.null',
      physicalTableName: 'TEAM_target',
    },
  );
  assert.throws(
    () => assertCurrentEtlRunEvidence(
      { currentInstanceId: 'stale' },
      graph,
      state,
    ),
    /omitted node states/,
  );
});
