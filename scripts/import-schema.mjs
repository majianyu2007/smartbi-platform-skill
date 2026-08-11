function normalizeFieldType(field) {
  const raw = field?.dataType ?? field?.type;
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw.name
    : raw;
  return typeof value === 'string'
    ? value.trim().toLocaleUpperCase() || null
    : null;
}

function normalizeField(field) {
  const raw = field && typeof field === 'object' ? field : { name: field };
  return {
    name: String(raw.name ?? '').normalize('NFKC').trim().toLocaleLowerCase(),
    type: normalizeFieldType(raw),
  };
}

export function normalizeImportSchema(fields) {
  return Array.isArray(fields) ? fields.map(normalizeField) : [];
}

function duplicateNames(schema) {
  const seen = new Set();
  const duplicates = new Set();
  for (const field of schema) {
    if (!field.name) continue;
    if (seen.has(field.name)) duplicates.add(field.name);
    seen.add(field.name);
  }
  return [...duplicates];
}

function missingTypeNames(schema) {
  return schema.flatMap((field, index) => (
    field.type ? [] : [field.name || `column-${index + 1}`]
  ));
}

function uniqueDifference(source, other) {
  const otherNames = new Set(other.map((field) => field.name));
  return [...new Set(source.map((field) => field.name))]
    .filter((name) => name && !otherNames.has(name));
}

export function replacementSchemaDiff(existingFields, incomingFields) {
  const existingSchema = normalizeImportSchema(existingFields);
  const incomingSchema = normalizeImportSchema(incomingFields);
  const existing = existingSchema.map((field) => field.name);
  const incoming = incomingSchema.map((field) => field.name);
  const added = uniqueDifference(incomingSchema, existingSchema);
  const removed = uniqueDifference(existingSchema, incomingSchema);
  const existingDuplicates = duplicateNames(existingSchema);
  const incomingDuplicates = duplicateNames(incomingSchema);
  const blankNames = {
    existing: existingSchema.flatMap((field, index) => (field.name ? [] : [index])),
    incoming: incomingSchema.flatMap((field, index) => (field.name ? [] : [index])),
  };
  const missingTypes = {
    existing: missingTypeNames(existingSchema),
    incoming: missingTypeNames(incomingSchema),
  };
  const comparableNameSet = added.length === 0
    && removed.length === 0
    && existingSchema.length === incomingSchema.length
    && existingDuplicates.length === 0
    && incomingDuplicates.length === 0
    && blankNames.existing.length === 0
    && blankNames.incoming.length === 0;
  const reordered = comparableNameSet
    && existing.some((name, index) => incoming[index] !== name);
  const incomingByName = new Map(incomingSchema.map((field) => [field.name, field]));
  const typeChanges = existingSchema.flatMap((field) => {
    const incomingField = incomingByName.get(field.name);
    if (!field.name || !field.type || !incomingField?.type || field.type === incomingField.type) {
      return [];
    }
    return [{ name: field.name, existing: field.type, incoming: incomingField.type }];
  });
  const compatible = existingSchema.length > 0
    && comparableNameSet
    && !reordered
    && missingTypes.existing.length === 0
    && missingTypes.incoming.length === 0
    && typeChanges.length === 0;
  return {
    compatible,
    existing,
    incoming,
    existingSchema,
    incomingSchema,
    added,
    removed,
    reordered,
    typeChanges,
    missingTypes,
    blankNames,
    duplicates: {
      existing: existingDuplicates,
      incoming: incomingDuplicates,
    },
  };
}

function describeSchemaDiff(diff) {
  return [
    diff.added.length > 0 ? `added=${diff.added.join(',')}` : null,
    diff.removed.length > 0 ? `removed=${diff.removed.join(',')}` : null,
    diff.reordered ? 'column-order-changed' : null,
    diff.typeChanges.length > 0
      ? `type-changed=${diff.typeChanges.map((change) => (
        `${change.name}:${change.existing}->${change.incoming}`
      )).join(',')}`
      : null,
    diff.missingTypes.existing.length > 0
      ? `existing-types-unavailable=${diff.missingTypes.existing.join(',')}`
      : null,
    diff.missingTypes.incoming.length > 0
      ? `incoming-types-unavailable=${diff.missingTypes.incoming.join(',')}`
      : null,
    diff.blankNames.existing.length > 0 ? 'existing-schema-has-blank-names' : null,
    diff.blankNames.incoming.length > 0 ? 'incoming-schema-has-blank-names' : null,
    diff.duplicates.existing.length > 0 ? 'existing-schema-has-duplicate-names' : null,
    diff.duplicates.incoming.length > 0 ? 'incoming-schema-has-duplicate-names' : null,
    diff.existing.length === 0 ? 'existing-schema-unavailable' : null,
    diff.existing.length !== diff.incoming.length ? 'field-count-changed' : null,
  ].filter(Boolean).join('; ');
}

export function assertCompleteImportSchema(fields, tableName) {
  const diff = replacementSchemaDiff(fields, fields);
  if (diff.compatible) return diff.existingSchema;
  throw new Error(
    `import table schema is incomplete for ${tableName}: ${describeSchemaDiff(diff)}`,
  );
}

export function assertReplacementSchemaCompatible(existingFields, incomingFields, tableName) {
  const diff = replacementSchemaDiff(existingFields, incomingFields);
  if (diff.compatible) return diff;
  throw new Error(
    `refusing schema-changing replacement for ${tableName}: ${describeSchemaDiff(diff)}. `
    + 'Delete the owned table with an exact confirmation, then import it as a new table.',
  );
}

export function assertImportedSchemaMatches(expectedFields, reopenedFields, tableName) {
  const diff = replacementSchemaDiff(expectedFields, reopenedFields);
  if (diff.compatible) return diff.incomingSchema;
  throw new Error(
    `imported table schema postcondition failed for ${tableName}: ${describeSchemaDiff(diff)}`,
  );
}
