const CONCURRENT_GRAPH_STATES = new Set(['BUILDING', 'PENDING']);
const MUTABLE_GRAPH_STATES = new Set(['NOTBUILD', 'FAILED', 'SUCCESS']);
const AICHAT_VALIDATION_COUNT_KEYS = new Set([
  'dataCount',
  'count',
  'total',
  'fieldDataCount',
  'rowCount',
]);

export const AICHAT_GRAPH_BUILD_USAGE =
  'aichat-graph-build requires <parentId> <modelId> <fieldNameOrId,...> '
  + '--confirm-name <exactModelName> [--etl-flow <flowId>] [--rebuild]';

export const UNSUPPORTED_AICHAT_GRAPH_CONFIGURATION = Object.freeze({
  '--recommended-question': 'recommended-question persistence contract is not captured',
  '--recommended-questions': 'recommended-question persistence contract is not captured',
  '--recommend-questions': 'recommended-question persistence contract is not captured',
  '--background': 'model-background persistence contract is not captured',
  '--model-background': 'model-background persistence contract is not captured',
  '--dynamic-column': 'dynamic-column persistence contract is not captured',
  '--dynamic-columns': 'dynamic-column persistence contract is not captured',
  '--condition-format': 'condition-format persistence contract is not captured',
  '--conditions': 'condition persistence contract is not captured',
  '--condition': 'condition persistence contract is not captured',
});

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function requiredFieldId(value, label) {
  const raw = String(value ?? '');
  const fieldId = raw.trim();
  if (!fieldId) throw new Error(`${label} is required`);
  if (raw !== fieldId) throw new Error(`${label} must match exactly without surrounding whitespace`);
  return fieldId;
}

function unsupportedConfigurationFlag(argument) {
  return Object.keys(UNSUPPORTED_AICHAT_GRAPH_CONFIGURATION).find((flag) => (
    argument === flag || argument.startsWith(`${flag}=`)
  ));
}

function normalizeFieldIds(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  const normalized = values.map((value, index) => requiredFieldId(value, `${label}[${index}]`));
  const seen = new Set();
  for (const id of normalized) {
    if (seen.has(id)) throw new Error(`${label} contains duplicate field id: ${id}`);
    seen.add(id);
  }
  return normalized;
}

function sameFieldIdSet(left, right) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function parseExtended(node) {
  if (node?.extended == null || node.extended === '') return {};
  if (typeof node.extended === 'object' && !Array.isArray(node.extended)) {
    return node.extended;
  }
  if (typeof node.extended !== 'string') {
    throw new Error('model graph status metadata has an unsupported shape');
  }
  try {
    const parsed = JSON.parse(node.extended);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new Error('model graph status metadata is malformed');
  }
}

export function parseAichatGraphBuildArgs(argsList, { requireEtlFlow = false } = {}) {
  if (!Array.isArray(argsList)) throw new Error(AICHAT_GRAPH_BUILD_USAGE);
  const positional = [];
  let confirmName = null;
  let etlFlowId = null;
  let rebuild = false;

  for (let index = 0; index < argsList.length; index += 1) {
    const argument = String(argsList[index] ?? '');
    const unsupported = unsupportedConfigurationFlag(argument);
    if (unsupported) {
      throw new Error(
        `unsupported AIChat graph configuration ${unsupported}: `
        + UNSUPPORTED_AICHAT_GRAPH_CONFIGURATION[unsupported],
      );
    }
    if (argument === '--rebuild') {
      if (rebuild) throw new Error('aichat-graph-build received --rebuild more than once');
      rebuild = true;
      continue;
    }
    if (argument === '--confirm-name' || argument === '--etl-flow') {
      const value = argsList[index + 1];
      if (!value || String(value).startsWith('--')) {
        throw new Error(`${argument} requires an exact value`);
      }
      if (argument === '--confirm-name') {
        if (confirmName != null) throw new Error('aichat-graph-build received --confirm-name more than once');
        confirmName = String(value);
      } else {
        if (etlFlowId != null) throw new Error('aichat-graph-build received --etl-flow more than once');
        etlFlowId = String(value);
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) {
      throw new Error(`unknown aichat-graph-build option: ${argument}`);
    }
    positional.push(argument);
  }

  if (positional.length !== 3 || !confirmName) throw new Error(AICHAT_GRAPH_BUILD_USAGE);
  if (requireEtlFlow && !etlFlowId) {
    throw new Error('competition aichat-graph-build requires --etl-flow <ownedFlowId>');
  }
  const selectors = positional[2].split(',').map((value) => value.trim()).filter(Boolean);
  if (selectors.length === 0) throw new Error('aichat-graph-build requires at least one field');
  return {
    parentId: requiredText(positional[0], 'model parent id'),
    modelId: requiredText(positional[1], 'model id'),
    selectors,
    confirmName,
    etlFlowId,
    rebuild,
  };
}

export function authorizeAichatGraphMutationTarget({
  parentId,
  requestedModelId,
  model,
  catalogChildren,
  confirmName,
  competitionParentId = null,
}) {
  const expectedParentId = requiredText(parentId, 'model parent id');
  const expectedModelId = requiredText(requestedModelId, 'model id');
  if (!model || typeof model !== 'object') throw new Error('current model is unavailable');
  if (model.id !== expectedModelId) {
    throw new Error('current model id does not match the requested graph target');
  }
  const currentName = requiredText(model.name, 'current model name');
  if (confirmName !== currentName) {
    throw new Error(`model confirmation mismatch: expected exact current name ${currentName}`);
  }
  if (!Array.isArray(catalogChildren)) throw new Error('model catalog parent could not be listed');
  const directMatches = catalogChildren.filter((child) => child?.id === expectedModelId);
  if (directMatches.length !== 1) {
    throw new Error(`model must be exactly one direct child of catalog parent ${expectedParentId}`);
  }
  const catalogResource = directMatches[0];
  if (catalogResource.name !== currentName && catalogResource.alias !== currentName) {
    throw new Error('catalog model name does not match the current model name');
  }
  if (competitionParentId != null && competitionParentId !== expectedParentId) {
    throw new Error('competition model is not a direct child of the supplied candidate folder');
  }
  return {
    catalogResource,
    modelId: expectedModelId,
    modelName: currentName,
    parentId: expectedParentId,
    checked: {
      exactModelId: true,
      exactCurrentName: true,
      directCatalogChild: true,
      competitionPlacement: competitionParentId == null ? null : true,
    },
  };
}

export function resolveUniqueGraphFields(fields, selectors) {
  if (!Array.isArray(fields)) throw new Error('model graph field tree is invalid');
  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw new Error('aichat-graph-build requires at least one field');
  }
  const selected = [];
  const selectedById = new Map();
  for (const rawSelector of selectors) {
    const selector = requiredText(rawSelector, 'model graph field selector');
    const exactIdMatches = fields.filter((field) => field?.id === selector);
    const normalized = selector.toLowerCase();
    const matches = exactIdMatches.length > 0
      ? exactIdMatches
      : fields.filter((field) => (
          String(field?.name ?? '').toLowerCase() === normalized
          || String(field?.alias ?? '').toLowerCase() === normalized
        ));
    if (matches.length === 0) throw new Error(`model graph field not found: ${selector}`);
    if (matches.length !== 1) {
      throw new Error(`model graph field is ambiguous: ${selector}; use the exact field id`);
    }
    const field = matches[0];
    const fieldId = requiredFieldId(field.id, `model graph field id for ${selector}`);
    if (selectedById.has(fieldId)) {
      throw new Error(
        `duplicate selected model graph field id ${fieldId}: `
        + `${selectedById.get(fieldId)} and ${selector}`,
      );
    }
    selectedById.set(fieldId, selector);
    selected.push(field);
  }
  return selected;
}

export function inspectAichatGraphNode(node) {
  if (!node) {
    return {
      status: 'NOTBUILD',
      persistedFieldIds: [],
      persistedFieldIdsObserved: false,
      updateTime: null,
      duration: null,
      revisionFreshness: 'unknown',
      revisionEvidence: null,
    };
  }
  const extended = parseExtended(node);
  const statusEvidence = [extended.status, node.status, node.lastBuildStatus]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean);
  const status = statusEvidence.find((value) => CONCURRENT_GRAPH_STATES.has(value))
    || statusEvidence.find((value) => value === 'FAILED')
    || statusEvidence[0]
    || 'NOTBUILD';
  const fields = extended.trainOption?.fields;
  const persistedFieldIdsObserved = Array.isArray(fields);
  const persistedFieldIds = persistedFieldIdsObserved
    ? fields.map((fieldId) => requiredFieldId(fieldId, 'persisted model graph field id'))
    : [];
  return {
    status,
    persistedFieldIds,
    persistedFieldIdsObserved,
    updateTime: extended.updateTime || node.lastModifiedDate || null,
    duration: extended.duration ?? null,
    revisionFreshness: 'unknown',
    revisionEvidence: null,
  };
}

export function inspectAichatGraphStatus({ modelId, modelName, nodes }) {
  const exactModelId = requiredText(modelId, 'model id');
  const exactModelName = requiredText(modelName, 'model name');
  if (!Array.isArray(nodes)) throw new Error('model graph listing is invalid');
  const matches = nodes.filter((node) => node?.id === exactModelId);
  if (matches.length > 1) throw new Error(`model graph listing contains duplicate id: ${exactModelId}`);
  if (matches.length === 0) {
    return {
      modelId: exactModelId,
      modelName: exactModelName,
      ...inspectAichatGraphNode(null),
      checked: { exactModelId: true, exactModelName: true, graphListing: true },
    };
  }
  const node = matches[0];
  if (node.name !== exactModelName) {
    throw new Error('model graph listing name does not match the current model name');
  }
  return {
    modelId: exactModelId,
    modelName: exactModelName,
    ...inspectAichatGraphNode(node),
    checked: { exactModelId: true, exactModelName: true, graphListing: true },
  };
}

export function assertAichatGraphReady({ modelId, modelName, nodes }) {
  const status = inspectAichatGraphStatus({ modelId, modelName, nodes });
  if (status.status !== 'SUCCESS') {
    throw new Error(`model graph is not ready: ${status.status}`);
  }
  if (!status.persistedFieldIdsObserved) {
    throw new Error('successful model graph did not expose persisted trained field ids');
  }
  const persistedFieldIds = normalizeFieldIds(
    status.persistedFieldIds,
    'persisted model graph fields',
  );
  return {
    ...status,
    persistedFieldIds,
    checked: {
      ...status.checked,
      terminalSuccess: true,
      persistedFieldIds: true,
    },
  };
}

export function graphFieldIdsMatchExactly(requestedFieldIds, persistedFieldIds) {
  const requested = normalizeFieldIds(requestedFieldIds, 'requested model graph fields');
  const persisted = normalizeFieldIds(persistedFieldIds, 'persisted model graph fields');
  return sameFieldIdSet(requested, persisted);
}

export function aichatGraphBuildCompletionEvidence({
  initialStatus,
  requestedFieldIds,
  initialPersistedFieldIds = [],
  initialPersistedFieldIdsObserved = false,
  initialUpdateTime = null,
  finalStatus,
  finalPersistedFieldIds = [],
  finalPersistedFieldIdsObserved = false,
  finalUpdateTime = null,
  observedConcurrentState = false,
}) {
  if (String(finalStatus || '').toUpperCase() !== 'SUCCESS') return null;
  if (!finalPersistedFieldIdsObserved || finalPersistedFieldIds.length === 0) return null;
  if (!graphFieldIdsMatchExactly(requestedFieldIds, finalPersistedFieldIds)) return null;
  if (String(initialStatus || '').toUpperCase() !== 'SUCCESS') {
    return 'new-terminal-success';
  }
  const initialFieldsMatch = initialPersistedFieldIdsObserved
    && initialPersistedFieldIds.length > 0
    && graphFieldIdsMatchExactly(requestedFieldIds, initialPersistedFieldIds);
  if (!initialFieldsMatch) return 'persisted-field-change';
  if (observedConcurrentState === true) return 'observed-build-state-transition';
  if (initialUpdateTime && finalUpdateTime && initialUpdateTime !== finalUpdateTime) {
    return 'graph-update-time-change';
  }
  return null;
}

export function assertExactPersistedGraphFieldIds(requestedFieldIds, persistedFieldIds) {
  const requested = normalizeFieldIds(requestedFieldIds, 'requested model graph fields');
  const persisted = normalizeFieldIds(persistedFieldIds, 'persisted model graph fields');
  if (!sameFieldIdSet(requested, persisted)) {
    throw new Error('persisted model graph field ids do not exactly match the requested field ids');
  }
  return persisted;
}

export function planAichatGraphBuild({
  status,
  requestedFieldIds,
  persistedFieldIds = [],
  persistedFieldIdsObserved = false,
  rebuild = false,
}) {
  const graphStatus = String(status || 'NOTBUILD').toUpperCase();
  const requested = normalizeFieldIds(requestedFieldIds, 'requested model graph fields');
  if (CONCURRENT_GRAPH_STATES.has(graphStatus)) {
    throw new Error(
      `model graph already has a concurrent ${graphStatus} build; no training request was submitted`,
    );
  }
  if (!MUTABLE_GRAPH_STATES.has(graphStatus)) {
    throw new Error(`model graph has unsupported build state ${graphStatus}; no training request was submitted`);
  }
  if (graphStatus !== 'SUCCESS') {
    return { action: 'train', priorStatus: graphStatus, revisionFreshness: 'unknown' };
  }
  if (!persistedFieldIdsObserved) {
    if (rebuild) {
      return { action: 'rebuild', priorStatus: graphStatus, revisionFreshness: 'unknown' };
    }
    throw new Error(
      'successful model graph has no persisted field evidence; rerun with --rebuild after confirming the exact model name',
    );
  }
  const persisted = normalizeFieldIds(persistedFieldIds, 'persisted model graph fields');
  const sameFields = sameFieldIdSet(requested, persisted);
  if (sameFields && !rebuild) {
    throw new Error(
      'model graph fields match, but model revision freshness is unknown; pass --rebuild to confirm retraining',
    );
  }
  return {
    action: sameFields ? 'rebuild' : 'train',
    priorStatus: graphStatus,
    revisionFreshness: 'unknown',
  };
}

function normalizeCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label} did not report a usable non-negative integer count`);
  }
  return count;
}

export function extractAichatValidationCount(validation) {
  const queue = [{ value: validation, depth: 0 }];
  const counts = new Set();
  while (queue.length > 0) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || depth > 3) continue;
    for (const [key, candidate] of Object.entries(value)) {
      if (
        AICHAT_VALIDATION_COUNT_KEYS.has(key)
        && (typeof candidate === 'number' || typeof candidate === 'string')
      ) {
        counts.add(normalizeCount(candidate, 'AIChat target validation'));
      }
      if (candidate && typeof candidate === 'object') {
        queue.push({ value: candidate, depth: depth + 1 });
      }
    }
  }
  if (counts.size === 0) {
    throw new Error('AIChat target validation did not report a usable record count');
  }
  if (counts.size !== 1) {
    throw new Error('AIChat target validation reported conflicting record counts');
  }
  return counts.values().next().value;
}

export function verifyAichatTrainingCountProvenance({
  validatorCount,
  etlRunCount,
  etlFlowId,
  currentInstanceId,
  targetTableId,
  currentEtlRunVerified = false,
  etlCountComplete = false,
  etlCountSource = null,
  independentTargetVerified = false,
}) {
  if (currentEtlRunVerified !== true) {
    throw new Error('AIChat training count requires a verified current successful ETL run');
  }
  if (etlCountComplete !== true) {
    throw new Error('AIChat training count requires a complete current-run ETL row count');
  }
  if (etlCountSource !== 'totalRowsCount') {
    throw new Error('AIChat training count requires ETL totalRowsCount evidence');
  }
  if (independentTargetVerified !== true) {
    throw new Error('AIChat training count requires independent target evidence');
  }
  const flowId = requiredText(etlFlowId, 'ETL flow id');
  const instanceId = requiredText(currentInstanceId, 'current ETL instance id');
  const tableId = requiredText(targetTableId, 'materialized target table id');
  const targetCount = normalizeCount(validatorCount, 'AIChat target validation');
  const runCount = normalizeCount(etlRunCount, 'current ETL run');
  if (targetCount !== runCount) {
    throw new Error(
      `AIChat target count does not match the current successful ETL run: target=${targetCount}, etl=${runCount}`,
    );
  }
  return {
    count: targetCount,
    validatorSource: 'validate_field_data_count',
    etlCountSource,
    provenance: 'aichat-target-validation+current-successful-etl-run',
    etlFlowId: flowId,
    currentInstanceId: instanceId,
    targetTableId: tableId,
    checked: {
      currentSuccessfulEtlRun: true,
      completeEtlRowCount: true,
      independentTargetCount: true,
      exactCountMatch: true,
    },
  };
}
