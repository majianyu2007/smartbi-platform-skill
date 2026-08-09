function normalizedFieldNames(fields) {
  return fields.map((field) => String(field?.name ?? field ?? '').trim().toLocaleLowerCase());
}

export function replacementSchemaDiff(existingFields, incomingFieldNames) {
  const existing = normalizedFieldNames(existingFields || []);
  const incoming = normalizedFieldNames(incomingFieldNames || []);
  const existingSet = new Set(existing);
  const incomingSet = new Set(incoming);
  const added = incoming.filter((name) => !existingSet.has(name));
  const removed = existing.filter((name) => !incomingSet.has(name));
  const reordered = added.length === 0
    && removed.length === 0
    && existing.some((name, index) => incoming[index] !== name);
  return {
    compatible: existing.length > 0
      && existing.length === incoming.length
      && !reordered
      && added.length === 0
      && removed.length === 0,
    existing,
    incoming,
    added,
    removed,
    reordered,
  };
}

export function assertReplacementSchemaCompatible(existingFields, incomingFieldNames, tableName) {
  const diff = replacementSchemaDiff(existingFields, incomingFieldNames);
  if (diff.compatible) return diff;
  const details = [
    diff.added.length > 0 ? `added=${diff.added.join(',')}` : null,
    diff.removed.length > 0 ? `removed=${diff.removed.join(',')}` : null,
    diff.reordered ? 'column-order-changed' : null,
    diff.existing.length === 0 ? 'existing-schema-unavailable' : null,
  ].filter(Boolean).join('; ');
  throw new Error(
    `refusing schema-changing replacement for ${tableName}: ${details || 'field-count-changed'}. `
    + 'Delete the owned table with an exact confirmation, then import it as a new table.',
  );
}
