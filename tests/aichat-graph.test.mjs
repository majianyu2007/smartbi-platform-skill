import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aichatGraphBuildCompletionEvidence,
  assertAichatGraphReady,
  assertExactPersistedGraphFieldIds,
  authorizeAichatGraphMutationTarget,
  extractAichatValidationCount,
  inspectAichatGraphNode,
  parseAichatGraphBuildArgs,
  planAichatGraphBuild,
  resolveUniqueGraphFields,
  verifyAichatTrainingCountProvenance,
} from '../scripts/aichat-graph.mjs';

const model = { id: 'model-1', name: 'TEAM_Model' };
const catalogModel = { id: 'model-1', name: 'TEAM_Model', alias: 'TEAM_Model' };
const successfulNode = {
  id: 'model-1',
  name: 'TEAM_Model',
  extended: JSON.stringify({
    status: 'SUCCESS',
    updateTime: '2026-08-11T12:00:00Z',
    trainOption: { fields: ['field.city'] },
  }),
};

test('graph build requires exact current model-name confirmation', () => {
  assert.throws(
    () => parseAichatGraphBuildArgs(['folder-1', 'model-1', 'city']),
    /--confirm-name <exactModelName>/,
  );
  assert.throws(
    () => authorizeAichatGraphMutationTarget({
      parentId: 'folder-1',
      requestedModelId: model.id,
      model,
      catalogChildren: [catalogModel],
      confirmName: 'TEAM_Mod',
    }),
    /confirmation mismatch/,
  );
  const authorized = authorizeAichatGraphMutationTarget({
    parentId: 'folder-1',
    requestedModelId: model.id,
    model,
    catalogChildren: [catalogModel],
    confirmName: model.name,
  });
  assert.deepEqual(authorized.checked, {
    exactModelId: true,
    exactCurrentName: true,
    directCatalogChild: true,
    competitionPlacement: null,
  });
});

test('competition graph builds require an explicit ETL provenance flow', () => {
  assert.throws(
    () => parseAichatGraphBuildArgs([
      'folder-1',
      model.id,
      'city',
      '--confirm-name',
      model.name,
    ], { requireEtlFlow: true }),
    /requires --etl-flow <ownedFlowId>/,
  );
});

test('prefix-only names do not authorize a graph target without direct owned placement', () => {
  assert.throws(
    () => authorizeAichatGraphMutationTarget({
      parentId: 'owned-folder',
      requestedModelId: model.id,
      model,
      catalogChildren: [],
      confirmName: model.name,
    }),
    /direct child/,
  );
  assert.throws(
    () => authorizeAichatGraphMutationTarget({
      parentId: 'wrong-candidate',
      requestedModelId: model.id,
      model,
      catalogChildren: [catalogModel],
      confirmName: model.name,
      competitionParentId: 'actual-candidate',
    }),
    /candidate folder/,
  );
  const placed = authorizeAichatGraphMutationTarget({
    parentId: 'actual-candidate',
    requestedModelId: model.id,
    model,
    catalogChildren: [catalogModel],
    confirmName: model.name,
    competitionParentId: 'actual-candidate',
  });
  assert.equal(placed.checked.competitionPlacement, true);
});

test('requested selectors must resolve uniquely and cannot select the same id twice', () => {
  const fields = [
    { id: 'field.city', name: 'city', alias: 'City' },
    { id: 'field.region', name: 'region', alias: 'City' },
  ];
  assert.throws(
    () => resolveUniqueGraphFields(fields, ['City']),
    /ambiguous/,
  );
  assert.throws(
    () => resolveUniqueGraphFields(fields, ['field.city', 'field.city']),
    /duplicate selected model graph field id/,
  );
});

test('persisted trained field ids must exactly match the requested set', () => {
  assert.deepEqual(
    assertExactPersistedGraphFieldIds(['field.city', 'field.age'], ['field.age', 'field.city']),
    ['field.age', 'field.city'],
  );
  assert.throws(
    () => assertExactPersistedGraphFieldIds(['field.city'], ['field.region']),
    /do not exactly match/,
  );
  assert.throws(
    () => assertExactPersistedGraphFieldIds(['field.city'], ['field.city', 'field.city']),
    /duplicate field id/,
  );
  assert.throws(
    () => assertExactPersistedGraphFieldIds(['field.city'], [' field.city ']),
    /must match exactly/,
  );
});

test('concurrent graph states never authorize another training request', () => {
  for (const status of ['BUILDING', 'PENDING']) {
    assert.throws(
      () => planAichatGraphBuild({
        status,
        requestedFieldIds: ['field.city'],
        persistedFieldIds: ['field.city'],
        persistedFieldIdsObserved: true,
        rebuild: true,
      }),
      new RegExp(`concurrent ${status} build; no training request was submitted`),
    );
  }
});

test('a concurrent top-level state overrides stale successful metadata', () => {
  const status = inspectAichatGraphNode({
    ...successfulNode,
    status: 'BUILDING',
  });
  assert.equal(status.status, 'BUILDING');
  assert.throws(
    () => planAichatGraphBuild({
      status: status.status,
      requestedFieldIds: ['field.city'],
      persistedFieldIds: status.persistedFieldIds,
      persistedFieldIdsObserved: status.persistedFieldIdsObserved,
      rebuild: true,
    }),
    /concurrent BUILDING build; no training request was submitted/,
  );
});

test('matching successful fields require explicit rebuild because revision freshness is unknown', () => {
  assert.throws(
    () => planAichatGraphBuild({
      status: 'SUCCESS',
      requestedFieldIds: ['field.city'],
      persistedFieldIds: ['field.city'],
      persistedFieldIdsObserved: true,
    }),
    /revision freshness is unknown.*--rebuild/,
  );
  assert.deepEqual(
    planAichatGraphBuild({
      status: 'SUCCESS',
      requestedFieldIds: ['field.city'],
      persistedFieldIds: ['field.city'],
      persistedFieldIdsObserved: true,
      rebuild: true,
    }),
    { action: 'rebuild', priorStatus: 'SUCCESS', revisionFreshness: 'unknown' },
  );
});

test('same-field rebuild needs new completion evidence before success', () => {
  const unchangedSuccess = {
    initialStatus: 'SUCCESS',
    requestedFieldIds: ['field.city'],
    initialPersistedFieldIds: ['field.city'],
    initialPersistedFieldIdsObserved: true,
    initialUpdateTime: 'before',
    finalStatus: 'SUCCESS',
    finalPersistedFieldIds: ['field.city'],
    finalPersistedFieldIdsObserved: true,
    finalUpdateTime: 'before',
  };
  assert.equal(aichatGraphBuildCompletionEvidence(unchangedSuccess), null);
  assert.equal(
    aichatGraphBuildCompletionEvidence({
      ...unchangedSuccess,
      observedConcurrentState: true,
    }),
    'observed-build-state-transition',
  );
  assert.equal(
    aichatGraphBuildCompletionEvidence({
      ...unchangedSuccess,
      initialPersistedFieldIds: ['field.region'],
    }),
    'persisted-field-change',
  );
});

test('training validation count must be present and unambiguous', () => {
  assert.equal(
    extractAichatValidationCount({ rowCount: 4020, detail: { count: '4020' } }),
    4020,
  );
  assert.throws(
    () => extractAichatValidationCount({ rowCount: 4020, detail: { count: 4019 } }),
    /conflicting record counts/,
  );
  assert.throws(
    () => extractAichatValidationCount({ valid: true }),
    /did not report a usable record count/,
  );
});

test('training-limit count requires matching current-run and independent target evidence', () => {
  assert.deepEqual(
    verifyAichatTrainingCountProvenance({
      validatorCount: 4020,
      etlRunCount: 4020,
      etlFlowId: 'flow-1',
      currentInstanceId: 'instance-9',
      targetTableId: 'DS.target',
      currentEtlRunVerified: true,
      etlCountComplete: true,
      etlCountSource: 'totalRowsCount',
      independentTargetVerified: true,
    }),
    {
      count: 4020,
      validatorSource: 'validate_field_data_count',
      etlCountSource: 'totalRowsCount',
      provenance: 'aichat-target-validation+current-successful-etl-run',
      etlFlowId: 'flow-1',
      currentInstanceId: 'instance-9',
      targetTableId: 'DS.target',
      checked: {
        currentSuccessfulEtlRun: true,
        completeEtlRowCount: true,
        independentTargetCount: true,
        exactCountMatch: true,
      },
    },
  );
  assert.throws(
    () => verifyAichatTrainingCountProvenance({
      validatorCount: 4019,
      etlRunCount: 4020,
      etlFlowId: 'flow-1',
      currentInstanceId: 'instance-9',
      targetTableId: 'DS.target',
      currentEtlRunVerified: true,
      etlCountComplete: true,
      etlCountSource: 'totalRowsCount',
      independentTargetVerified: true,
    }),
    /does not match the current successful ETL run/,
  );
  assert.throws(
    () => verifyAichatTrainingCountProvenance({
      validatorCount: 4020,
      etlRunCount: 4020,
      etlFlowId: 'flow-1',
      currentInstanceId: 'instance-9',
      targetTableId: 'DS.target',
      independentTargetVerified: true,
    }),
    /verified current successful ETL run/,
  );
  assert.throws(
    () => verifyAichatTrainingCountProvenance({
      validatorCount: 4020,
      etlRunCount: 4020,
      etlFlowId: 'flow-1',
      currentInstanceId: 'instance-9',
      targetTableId: 'DS.target',
      currentEtlRunVerified: true,
      independentTargetVerified: true,
    }),
    /complete current-run ETL row count/,
  );
  assert.throws(
    () => verifyAichatTrainingCountProvenance({
      validatorCount: 4020,
      etlRunCount: 4020,
      etlFlowId: 'flow-1',
      currentInstanceId: 'instance-9',
      targetTableId: 'DS.target',
      currentEtlRunVerified: true,
      etlCountComplete: true,
      independentTargetVerified: true,
    }),
    /totalRowsCount evidence/,
  );
  assert.throws(
    () => verifyAichatTrainingCountProvenance({
      validatorCount: 4020,
      etlRunCount: 4020,
      etlFlowId: 'flow-1',
      currentInstanceId: 'instance-9',
      targetTableId: 'DS.target',
      currentEtlRunVerified: true,
      etlCountComplete: true,
      etlCountSource: 'totalRowsCount',
    }),
    /independent target evidence/,
  );
});

test('query readiness requires exact model identity, SUCCESS, and persisted fields', () => {
  const ready = assertAichatGraphReady({
    modelId: model.id,
    modelName: model.name,
    nodes: [successfulNode],
  });
  assert.equal(ready.status, 'SUCCESS');
  assert.deepEqual(ready.persistedFieldIds, ['field.city']);
  assert.equal(ready.revisionFreshness, 'unknown');
  assert.equal(ready.revisionEvidence, null);
  assert.deepEqual(ready.checked, {
    exactModelId: true,
    exactModelName: true,
    graphListing: true,
    terminalSuccess: true,
    persistedFieldIds: true,
  });

  assert.throws(
    () => assertAichatGraphReady({
      modelId: 'model-2',
      modelName: model.name,
      nodes: [successfulNode],
    }),
    /not ready: NOTBUILD/,
  );
  assert.throws(
    () => assertAichatGraphReady({ modelId: model.id, modelName: 'TEAM_Other', nodes: [successfulNode] }),
    /name does not match/,
  );
  for (const status of ['NOTBUILD', 'FAILED']) {
    const nodes = status === 'NOTBUILD'
      ? []
      : [{ ...successfulNode, extended: JSON.stringify({ status, trainOption: { fields: ['field.city'] } }) }];
    assert.throws(
      () => assertAichatGraphReady({ modelId: model.id, modelName: model.name, nodes }),
      /not ready/,
    );
  }
  assert.throws(
    () => assertAichatGraphReady({
      modelId: model.id,
      modelName: model.name,
      nodes: [{ ...successfulNode, extended: JSON.stringify({ status: 'SUCCESS', trainOption: { fields: [] } }) }],
    }),
    /must not be empty/,
  );
});

test('uncaptured graph configuration contracts are explicitly unsupported', () => {
  for (const option of [
    '--recommended-questions',
    '--background',
    '--dynamic-columns',
    '--condition-format',
  ]) {
    assert.throws(
      () => parseAichatGraphBuildArgs([
        'folder-1',
        'model-1',
        'city',
        '--confirm-name',
        model.name,
        option,
        '{}',
      ]),
      new RegExp(`unsupported AIChat graph configuration ${option}`),
    );
  }
});
