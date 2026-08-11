const KNOWN_FOLDER_TYPE_SET = new Set([
  'DEFAULT_TREENODE',
  'SELF_TREENODE',
  'AUGMENTED_DATASET_FOLDER',
]);
const COPYABLE_FOLDER_TYPE_SET = new Set(['DEFAULT_TREENODE', 'SELF_TREENODE']);
const ORDINARY_PARENT_TYPE_SET = new Set(['DEFAULT_TREENODE', 'SELF_TREENODE']);
const GENERATED_FOLDER_TYPE_SET = new Set(['AUGMENTED_DATASET_FOLDER']);

export const CATALOG_FOLDER_TYPES = Object.freeze([...KNOWN_FOLDER_TYPE_SET]);
export const COPYABLE_CATALOG_FOLDER_TYPES = Object.freeze([...COPYABLE_FOLDER_TYPE_SET]);

export function normalizeNamingConfig(mode, value, { maxLength = null } = {}) {
  const normalizedMode = String(mode || '');
  if (!['prefix', 'suffix'].includes(normalizedMode)) {
    throw new Error(`invalid naming mode: ${normalizedMode || '(empty)'} (use prefix or suffix)`);
  }
  const marker = String(value || '');
  if (!marker) throw new Error('namespace value must not be empty');
  if (!/^[A-Za-z0-9_.-]+$/.test(marker)) {
    throw new Error('namespace value may contain only letters, numbers, underscore, dot, and hyphen');
  }
  if (maxLength != null) {
    if (!Number.isInteger(maxLength) || maxLength < 2) {
      throw new Error('namespace maximum length must be an integer greater than one');
    }
    if (marker.length >= maxLength) {
      throw new Error(`namespace value must be shorter than ${maxLength} characters`);
    }
  }
  return Object.freeze({ mode: normalizedMode, value: marker });
}

export function applyNamespaceMarker(base, naming, { maxLength = null } = {}) {
  const { mode, value } = normalizeNamingConfig(naming?.mode, naming?.value, { maxLength });
  const source = String(base || '');
  const alreadyNamespaced = mode === 'suffix'
    ? source.endsWith(value)
    : source.startsWith(value);
  const descriptive = alreadyNamespaced
    ? (mode === 'suffix' ? source.slice(0, -value.length) : source.slice(value.length))
    : source;
  const trimmed = maxLength == null
    ? descriptive
    : descriptive.slice(0, maxLength - value.length);
  return mode === 'suffix' ? `${trimmed}${value}` : `${value}${trimmed}`;
}

export function isKnownCatalogFolder(resource) {
  return Boolean(resource && KNOWN_FOLDER_TYPE_SET.has(resource.type));
}

export function isCopyableCatalogFolder(resource) {
  return Boolean(resource && COPYABLE_FOLDER_TYPE_SET.has(resource.type));
}

export function shouldTraverseCatalogNode(resource) {
  return Boolean(resource?.hasChild || isKnownCatalogFolder(resource));
}

function normalizePathChain(path, rootId, parent) {
  if (!parent?.id) throw new Error('owned catalog parent requires an id');
  if (!rootId) throw new Error('owned catalog domain root requires an id');
  if (parent.id === rootId) return [parent];
  if (!Array.isArray(path)) throw new Error('catalog parent path is not an array');

  const nodes = path.filter((node) => node && typeof node === 'object' && node.id);
  const rootIndex = nodes.findIndex((node) => node.id === rootId);
  const parentIndex = nodes.findIndex((node) => node.id === parent.id);
  if (rootIndex < 0 || parentIndex < 0) {
    throw new Error(`catalog parent path does not prove direct domain ancestry: ${parent.id}`);
  }

  const slice = rootIndex <= parentIndex
    ? nodes.slice(rootIndex, parentIndex + 1)
    : nodes.slice(parentIndex, rootIndex + 1).reverse();
  const seen = new Set();
  for (const node of slice) {
    if (seen.has(node.id)) throw new Error(`catalog parent path repeats an id: ${node.id}`);
    seen.add(node.id);
  }
  slice[slice.length - 1] = parent;
  return slice;
}

export function assertContiguousOwnedFolderChain({
  parent,
  path,
  rootId,
  domain,
  isOwned,
  generatedFolderTypes = GENERATED_FOLDER_TYPE_SET,
}) {
  if (typeof isOwned !== 'function') throw new Error('catalog ownership predicate is required');
  const chain = normalizePathChain(path, rootId, parent);
  let ownedUserFolderSeen = false;

  for (let index = 1; index < chain.length; index += 1) {
    const node = chain[index];
    if (isOwned(node)) {
      ownedUserFolderSeen = true;
      continue;
    }
    if (generatedFolderTypes.has(node.type) && ownedUserFolderSeen) continue;
    throw new Error(`catalog parent chain crosses a non-owned folder: ${node.id}`);
  }

  if (
    parent.id !== rootId
    && !KNOWN_FOLDER_TYPE_SET.has(parent.type)
  ) {
    throw new Error(`refusing a non-folder catalog parent: ${parent.id}`);
  }

  return Object.freeze({
    parent,
    path: Object.freeze(chain.map((node) => Object.freeze({ ...node }))),
    rootId,
    domain,
    isDomainRoot: parent.id === rootId,
  });
}

export function assertCatalogPlacementCompatible({ resource, source, target, operation }) {
  if (!resource?.id || !source?.parent?.id || !target?.parent?.id) {
    throw new Error(`${operation || 'catalog mutation'} requires resolved source and target resources`);
  }
  if (!source.domain || source.domain !== target.domain) {
    throw new Error(`${operation || 'catalog mutation'} cannot cross catalog domains`);
  }
  if (!source.isDomainRoot && !ORDINARY_PARENT_TYPE_SET.has(source.parent.type)) {
    throw new Error(`${operation || 'catalog mutation'} cannot extract resources from ${source.parent.type}`);
  }
  if (!target.isDomainRoot && !ORDINARY_PARENT_TYPE_SET.has(target.parent.type)) {
    throw new Error(`${operation || 'catalog mutation'} cannot place resources under ${target.parent.type}`);
  }
  if (resource.type === 'BASETABLE' || resource.type === 'AUGMENTED_DATASET_FOLDER') {
    throw new Error(`${operation || 'catalog mutation'} does not support resource type ${resource.type}`);
  }
  return true;
}

export function assertCopyTargetOutsideSource({
  sourceId,
  targetParentId,
  targetPath,
  operation = 'copy',
}) {
  if (!sourceId || !targetParentId) {
    throw new Error(`${operation} cycle check requires source and target ids`);
  }
  if (sourceId === targetParentId) {
    throw new Error(`refusing to ${operation} a resource into itself or its descendant: ${sourceId}`);
  }
  if (!Array.isArray(targetPath)) {
    throw new Error(`cannot prove ${operation} target ancestry: ${targetParentId}`);
  }
  if (targetPath.some((node) => node?.id === sourceId)) {
    throw new Error(`refusing to ${operation} a resource into itself or its descendant: ${sourceId}`);
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function createImmutableCatalogCopyManifest({
  sourceId,
  targetParentId,
  targetPath,
  entries,
  isOwned,
}) {
  assertCopyTargetOutsideSource({ sourceId, targetParentId, targetPath });
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('catalog copy manifest is empty');
  }
  if (typeof isOwned !== 'function') throw new Error('catalog copy ownership predicate is required');

  const byId = new Map();
  for (const entry of entries) {
    if (!entry?.id) throw new Error('catalog copy manifest entry requires an id');
    if (byId.has(entry.id)) throw new Error(`catalog copy manifest repeats resource: ${entry.id}`);
    if (!isOwned(entry)) throw new Error(`refusing to copy non-namespaced descendant: ${entry.id}`);
    if (entry.type === 'BASETABLE') {
      throw new Error(`catalog copy does not support personal acquisition type BASETABLE: ${entry.id}`);
    }
    if (shouldTraverseCatalogNode(entry) && !isCopyableCatalogFolder(entry)) {
      throw new Error(`catalog copy contains an unsupported container type: ${entry.type || 'unknown'}`);
    }
    byId.set(entry.id, entry);
  }

  const root = byId.get(sourceId);
  if (!root) throw new Error(`catalog copy manifest is missing its source root: ${sourceId}`);
  for (const entry of entries) {
    if (entry.id === sourceId) {
      if (entry.parentSourceId != null) {
        throw new Error('catalog copy source root must not have a manifest parent');
      }
      continue;
    }
    const parent = byId.get(entry.parentSourceId);
    if (!parent || !isCopyableCatalogFolder(parent)) {
      throw new Error(`catalog copy manifest has an invalid parent for ${entry.id}`);
    }
  }

  const reachable = new Set([sourceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (!reachable.has(entry.id) && reachable.has(entry.parentSourceId)) {
        reachable.add(entry.id);
        changed = true;
      }
    }
  }
  if (reachable.size !== entries.length) {
    throw new Error('catalog copy manifest contains a cycle or disconnected resource');
  }

  const clone = structuredClone({ sourceId, targetParentId, entries });
  return deepFreeze(clone);
}

export function assertDirectResourceSnapshot(expected, current, parentId) {
  if (!expected?.id || !current || current.id !== expected.id) {
    throw new Error(`resource is no longer a direct child of the supplied parent: ${expected?.id || 'unknown'}`);
  }
  for (const field of ['name', 'alias', 'type']) {
    if ((current[field] ?? null) !== (expected[field] ?? null)) {
      throw new Error(`resource changed after authorization (${field}): ${expected.id}`);
    }
  }
  if (parentId && current.parentId != null && current.parentId !== parentId) {
    throw new Error(`resource changed parent after authorization: ${expected.id}`);
  }
  return current;
}

export function findCatalogCollision(children, { name, alias = name, ignoredId = null } = {}) {
  if (!Array.isArray(children)) throw new Error('catalog collision check requires a child list');
  const candidates = new Set([name, alias].filter((value) => value != null));
  return children.find((node) => (
    node?.id !== ignoredId
    && ([node?.name, node?.alias].some((value) => candidates.has(value)))
  ));
}
