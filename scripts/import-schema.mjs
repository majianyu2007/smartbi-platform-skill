function normalizeField(field) {
  const raw = field && typeof field === 'object' ? field : { name: field };
  return {
    name: String(raw.name ?? '').trim().toLocaleLowerCase(),
    type: String(raw.dataType ?? raw.type ?? '').trim().toLocaleUpperCase() || null,
  };
}

export function replacementSchemaDiff(existingFields, incomingFields) {
  const existingFieldsNormalized = (existingFields || []).map(normalizeField);
  const incomingFieldsNormalized = (incomingFields || []).map(normalizeField);
  const existing = existingFieldsNormalized.map((field) => field.name);
  const incoming = incomingFieldsNormalized.map((field) => field.name);
  const existingSet = new Set(existing);
  const incomingSet = new Set(incoming);
  const added = incoming.filter((name) => !existingSet.has(name));
  const removed = existing.filter((name) => !incomingSet.has(name));
  const reordered = added.length === 0
    && removed.length === 0
    && existing.some((name, index) => incoming[index] !== name);
  const typeChanges = existingFieldsNormalized.flatMap((field, index) => {
    const incomingField = incomingFieldsNormalized[index];
    if (
      !field.type
      || !incomingField?.type
      || field.name !== incomingField.name
      || field.type === incomingField.type
    ) {
      return [];
    }
    return [{ name: field.name, existing: field.type, incoming: incomingField.type }];
  });
  return {
    compatible: existing.length > 0
      && existing.length === incoming.length
      && !reordered
      && added.length === 0
      && removed.length === 0
      && typeChanges.length === 0,
    existing,
    incoming,
    added,
    removed,
    reordered,
    typeChanges,
  };
}

export function assertReplacementSchemaCompatible(existingFields, incomingFields, tableName) {
  const diff = replacementSchemaDiff(existingFields, incomingFields);
  if (diff.compatible) return diff;
  const details = [
    diff.added.length > 0 ? `added=${diff.added.join(',')}` : null,
    diff.removed.length > 0 ? `removed=${diff.removed.join(',')}` : null,
    diff.reordered ? 'column-order-changed' : null,
    diff.typeChanges.length > 0
      ? `type-changed=${diff.typeChanges.map((change) => (
        `${change.name}:${change.existing}->${change.incoming}`
      )).join(',')}`
      : null,
    diff.existing.length === 0 ? 'existing-schema-unavailable' : null,
  ].filter(Boolean).join('; ');
  throw new Error(
    `refusing schema-changing replacement for ${tableName}: ${details || 'field-count-changed'}. `
    + 'Delete the owned table with an exact confirmation, then import it as a new table.',
  );
}
