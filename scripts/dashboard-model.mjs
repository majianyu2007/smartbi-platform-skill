function text(value) {
  return String(value ?? '').trim();
}

export function qualifyDashboardResourceId(modelId, type, id) {
  const source = text(id);
  return source.startsWith('AUGMENTED_DATASET_')
    ? source
    : `AUGMENTED_DATASET_${type}.${modelId}.${source}`;
}

function resourceCandidates(model, expectedKind) {
  const calculatedIds = new Set((model.calcMeasures || []).map((resource) => resource.id));
  const candidates = [
    ...(model.fields || []).map((resource) => ({
      resource,
      kind: 'dimension',
      resourceType: 'FIELD',
      calculated: false,
    })),
    ...(model.levels || []).map((resource) => ({
      resource,
      kind: 'dimension',
      resourceType: resource.levelType || 'LEVEL',
      idType: 'LEVEL',
      calculated: false,
    })),
    ...(model.measures || [])
      .filter((resource) => !calculatedIds.has(resource.id))
      .map((resource) => ({
        resource,
        kind: 'measure',
        resourceType: 'MEASURE',
        calculated: false,
      })),
    ...(model.calcMeasures || []).map((resource) => ({
      resource,
      kind: 'measure',
      resourceType: 'CALC_MEASURE',
      calculated: true,
    })),
  ].filter((candidate) => expectedKind === 'any' || candidate.kind === expectedKind);

  return candidates.map((candidate) => {
    const { resource } = candidate;
    const node = (model.nodes || []).find((item) => item.id === resource.id);
    const viewId = resource.viewId || node?.viewId || null;
    const view = (model.views || []).find((item) => item.id === viewId) || null;
    const idType = candidate.idType || candidate.resourceType;
    const qualifiedId = qualifyDashboardResourceId(model.id, idType, resource.id);
    const exactIds = new Set([text(resource.id), qualifiedId].filter(Boolean));
    const bareNames = new Set([text(resource.name), text(resource.alias)].filter(Boolean));
    const viewNames = new Set([
      text(viewId),
      text(view?.name),
      text(view?.alias),
      text(resource.viewAlias),
    ].filter(Boolean));
    const viewQualifiedNames = new Set();
    for (const viewName of viewNames) {
      for (const resourceName of bareNames) {
        viewQualifiedNames.add(`${viewName}.${resourceName}`);
        viewQualifiedNames.add(`${viewName}::${resourceName}`);
      }
    }
    return {
      ...candidate,
      node,
      view,
      qualifiedId,
      exactIds,
      bareNames,
      viewQualifiedNames,
    };
  });
}

function describeCandidate(candidate) {
  const view = candidate.view?.alias || candidate.view?.name || candidate.resource.viewAlias;
  const name = candidate.resource.alias || candidate.resource.name || candidate.resource.id;
  return `${view ? `${view}.` : ''}${name} [${candidate.qualifiedId}]`;
}

function uniqueMatch(matches, selector, expectedKind) {
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `dashboard ${expectedKind} selector is ambiguous: ${selector}; candidates: `
      + matches.map(describeCandidate).join(', '),
    );
  }
  return null;
}

export function resolveDashboardModelResource(model, selector, expectedKind = 'any') {
  if (!model?.id) throw new Error('dashboard model is missing an id');
  if (!['dimension', 'measure', 'any'].includes(expectedKind)) {
    throw new Error(`unsupported dashboard resource kind: ${expectedKind}`);
  }
  const normalized = text(selector);
  if (!normalized) throw new Error(`dashboard ${expectedKind} selector is required`);
  const candidates = resourceCandidates(model, expectedKind);

  const exact = uniqueMatch(
    candidates.filter((candidate) => candidate.exactIds.has(normalized)),
    normalized,
    expectedKind,
  );
  if (exact) return exact;

  const named = uniqueMatch(
    candidates.filter((candidate) => (
      candidate.viewQualifiedNames.has(normalized)
      || candidate.bareNames.has(normalized)
    )),
    normalized,
    expectedKind,
  );
  if (named) return named;

  throw new Error(`dashboard ${expectedKind} resource not found: ${normalized}`);
}

function labelFor(resource, displayLabel) {
  const label = text(displayLabel || resource.alias || resource.name);
  if (!label) throw new Error(`dashboard resource ${resource.id || '(unknown)'} has no display label`);
  return label;
}

export function serializeDashboardResource(
  model,
  selector,
  expectedKind = 'any',
  displayLabel = null,
  uniqueId = null,
) {
  if (typeof uniqueId !== 'function') {
    throw new Error('dashboard resource serializer requires a unique-id factory');
  }
  const resolved = resolveDashboardModelResource(model, selector, expectedKind);
  const { resource, node, resourceType, calculated, qualifiedId } = resolved;
  if (![resource.id, resource.name, resource.valueType].every((value) => text(value))) {
    throw new Error(`dashboard resource metadata is incomplete for selector: ${text(selector)}`);
  }
  const label = labelFor(resource, displayLabel);

  if (resourceType === 'FIELD') {
    const parentId = node?.parentId
      || resource.parentId
      || (resource.viewId
        ? `AUGMENTED_DATASET_FOLDER.${model.id}.${resource.viewId}`
        : null);
    if (!parentId) {
      throw new Error(`dashboard field parent metadata is incomplete: ${resource.id}`);
    }
    return {
      id: qualifiedId,
      alias: label,
      label,
      label0: label,
      showName: label,
      aggregatedCalcField: false,
      aggregate: 'NONE',
      originAggregate: null,
      orderBy: null,
      orderBySettings: null,
      align: null,
      dataFormat: resource.dataFormat || null,
      orderPriority: 0,
      subtotal: null,
      group: 'DIMENSION',
      dataType: resource.valueType,
      type: 'FIELD',
      fieldType: 'DIMENSION',
      uniqueId: uniqueId(),
      parentId,
      parentNodeName: null,
      order: node?.order ?? resource.order ?? 0,
      name: resource.name,
      originalDataType: resource.originalDataType || null,
      businessCaliber: resource.businessCaliber || null,
      fieldLabelStatus: { aggregate: '' },
    };
  }

  if (resolved.kind === 'dimension') {
    const parentId = node?.parentId || resource.parentId || null;
    if (!parentId) {
      throw new Error(`dashboard level parent metadata is incomplete: ${resource.id}`);
    }
    return {
      id: qualifiedId,
      alias: label,
      label,
      label0: label,
      showName: null,
      aggregate: 'NONE',
      originAggregate: null,
      orderBy: null,
      orderBySettings: null,
      align: null,
      dataFormat: resource.dataFormat || null,
      orderPriority: 0,
      subtotal: null,
      group: 'LEVEL',
      dataType: resource.valueType,
      type: resourceType,
      fieldType: 'DIMENSION',
      uniqueId: uniqueId(),
      parentId,
      parentNodeName: null,
      order: node?.order ?? resource.order ?? 0,
      name: resource.name,
      temp: null,
      fieldLabelStatus: { aggregate: '' },
    };
  }

  const aggregate = calculated ? null : text(resource.aggregator || 'sum').toUpperCase();
  return {
    id: qualifiedId,
    alias: label,
    label,
    label0: label,
    showName: label,
    aggregatedCalcField: false,
    aggregate,
    originAggregate: aggregate,
    orderBy: null,
    orderBySettings: null,
    align: null,
    dataFormat: resource.dataFormat || null,
    orderPriority: 0,
    subtotal: null,
    group: resourceType,
    dataType: resource.valueType,
    type: resourceType,
    fieldType: 'MEASURE',
    uniqueId: uniqueId(),
    parentId: node?.parentId || `AUGMENTED_DATASET_FOLDER.${model.id}.measure`,
    parentNodeName: null,
    order: node?.order ?? resource.order ?? 0,
    name: resource.name,
    originalDataType: resource.valueType,
    businessCaliber: resource.businessCaliber || null,
    ...(!calculated ? {
      refDataSetFieldId: resource.refDataSetFieldId
        ? qualifyDashboardResourceId(model.id, 'FIELD', resource.refDataSetFieldId)
        : null,
    } : {}),
    fieldLabelStatus: { aggregate: aggregate || '' },
  };
}
