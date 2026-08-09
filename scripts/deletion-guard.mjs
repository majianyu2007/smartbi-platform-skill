const OWNED_CATALOG = 'owned-catalog';
const PERSONAL_ACQUISITION = 'personal-acquisition';

export const DELETION_PARENT_KINDS = Object.freeze({
  OWNED_CATALOG,
  PERSONAL_ACQUISITION,
});

export function parseResourceDeleteArgs(args = []) {
  const [parentId, resourceId, ...options] = args;
  if (!parentId || !resourceId) {
    throw new Error('resource-delete requires <parentId> <resourceId> [--confirm-name <exactName>]');
  }

  let confirmName = null;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option !== '--confirm-name') {
      throw new Error(`unknown resource-delete option: ${option}`);
    }
    if (confirmName !== null) {
      throw new Error('resource-delete accepts --confirm-name only once');
    }
    const value = options[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--confirm-name requires an exact resource name');
    }
    confirmName = value;
    index += 1;
  }

  return { parentId, resourceId, confirmName };
}

export function authorizeResourceDeletion({
  resource,
  isNamespaced,
  parentKind,
  confirmName = null,
}) {
  if (!resource?.id) throw new Error('resource deletion requires a resolved direct child');
  if (![OWNED_CATALOG, PERSONAL_ACQUISITION].includes(parentKind)) {
    throw new Error(`unsupported deletion parent kind: ${parentKind}`);
  }

  if (isNamespaced) return { legacy: false, confirmedName: null };

  const displayNames = new Set(
    [resource.name, resource.alias].filter((value) => typeof value === 'string' && value.length > 0),
  );
  if (parentKind !== PERSONAL_ACQUISITION || resource.type !== 'BASETABLE') {
    throw new Error(`refusing to delete non-namespaced resource: ${resource.alias || resource.name}`);
  }
  if (!confirmName) {
    throw new Error('non-namespaced personal table deletion requires --confirm-name <exactName>');
  }
  if (!displayNames.has(confirmName)) {
    throw new Error(`confirmation name does not match the selected resource: ${confirmName}`);
  }

  return { legacy: true, confirmedName: confirmName };
}
