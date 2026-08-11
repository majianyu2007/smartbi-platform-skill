import { extname, basename } from 'node:path';

import { normalizeImportSchema } from './import-schema.mjs';

export const SUPPORTED_LOCAL_IMPORTS = Object.freeze({
  '.csv': Object.freeze({ format: 'CSV', kind: 'delimited', requiresWorksheet: false }),
  '.txt': Object.freeze({ format: 'TXT', kind: 'delimited', requiresWorksheet: false }),
  '.xls': Object.freeze({ format: 'XLS', kind: 'workbook', requiresWorksheet: true }),
  '.xlsx': Object.freeze({ format: 'XLSX', kind: 'workbook', requiresWorksheet: true }),
});

const REMOTE_SOURCE_PATTERN = /^[a-z][a-z\d+.-]*:/i;

function requireNonblankText(value, label) {
  const text = String(value ?? '');
  if (!text.trim()) throw new Error(`${label} must not be blank`);
  return text;
}

export function classifyLocalImportSource({
  filePath,
  worksheet = null,
}) {
  const source = requireNonblankText(filePath, 'upload file path');
  if (REMOTE_SOURCE_PATTERN.test(source) || source.startsWith('//')) {
    throw new Error(
      'upload accepts only a local file path; remote source URLs are unsupported '
      + 'and --source-url is provenance metadata only',
    );
  }
  const extension = extname(source).toLocaleLowerCase();
  const format = SUPPORTED_LOCAL_IMPORTS[extension];
  if (!format) {
    throw new Error(
      `unsupported import format ${extension || '(none)'}; supported local formats are CSV, TXT, XLS, and XLSX`,
    );
  }

  const requestedWorksheet = worksheet == null ? null : requireNonblankText(
    worksheet,
    '--worksheet',
  );
  if (format.requiresWorksheet && requestedWorksheet == null) {
    throw new Error(
      `${format.format} imports require --worksheet <exactWorksheetName>; `
      + 'the CLI never chooses sheet 0 implicitly',
    );
  }
  if (!format.requiresWorksheet && requestedWorksheet != null) {
    throw new Error(`--worksheet is valid only for XLS or XLSX imports, not ${format.format}`);
  }

  return Object.freeze({
    filePath: source,
    fileName: basename(source),
    extension,
    format: format.format,
    kind: format.kind,
    requiresWorksheet: format.requiresWorksheet,
    requestedWorksheet,
  });
}

export function planLocalImportSource({
  filePath,
  isFile,
  size,
  worksheet = null,
}) {
  const source = classifyLocalImportSource({ filePath, worksheet });
  if (isFile !== true) throw new Error('upload input is not a regular file');
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error('upload input must be a nonempty regular file');
  }
  return source;
}

export function parseUploadedWorksheets(sheetNames) {
  if (!Array.isArray(sheetNames) || sheetNames.length === 0) {
    throw new Error('upload response did not provide a nonempty worksheet list');
  }
  const sheets = sheetNames.map((entry, position) => {
    if (typeof entry !== 'string') {
      throw new Error(`upload worksheet entry ${position + 1} has an unsupported shape`);
    }
    const firstDelimiter = entry.indexOf('|');
    const lastDelimiter = entry.lastIndexOf('|');
    if (firstDelimiter <= 0 || lastDelimiter <= firstDelimiter) {
      throw new Error(`upload worksheet entry ${position + 1} is malformed`);
    }
    const indexText = entry.slice(0, firstDelimiter);
    const name = entry.slice(firstDelimiter + 1, lastDelimiter);
    const selectedText = entry.slice(lastDelimiter + 1).toLocaleLowerCase();
    const index = Number(indexText);
    if (!Number.isSafeInteger(index) || index < 0 || !name.trim()) {
      throw new Error(`upload worksheet entry ${position + 1} is malformed`);
    }
    if (!['true', 'false'].includes(selectedText)) {
      throw new Error(`upload worksheet entry ${position + 1} has an invalid selection marker`);
    }
    return Object.freeze({ index, name, selected: selectedText === 'true' });
  });
  if (new Set(sheets.map((sheet) => sheet.index)).size !== sheets.length) {
    throw new Error('upload response contains duplicate worksheet indexes');
  }
  if (new Set(sheets.map((sheet) => (
    sheet.name.normalize('NFKC').toLocaleLowerCase()
  ))).size !== sheets.length) {
    throw new Error('upload response contains duplicate worksheet names');
  }
  return sheets;
}

export function resolveWorksheetSelection(sourcePlan, sheetNames) {
  if (!sourcePlan || typeof sourcePlan !== 'object') {
    throw new Error('local import source plan is required');
  }
  const sheets = parseUploadedWorksheets(sheetNames);
  if (!sourcePlan.requiresWorksheet) {
    if (sheets.length !== 1) {
      throw new Error(
        `${sourcePlan.format} upload unexpectedly exposed ${sheets.length} worksheets; refusing an ambiguous import`,
      );
    }
    return Object.freeze({ ...sheets[0], sheetCount: 1, explicitlyRequested: false });
  }
  const matches = sheets.filter((sheet) => sheet.name === sourcePlan.requestedWorksheet);
  if (matches.length !== 1) {
    throw new Error(
      `requested worksheet was not returned exactly once by the upload; workbook has ${sheets.length} worksheets`,
    );
  }
  return Object.freeze({
    ...matches[0],
    sheetCount: sheets.length,
    explicitlyRequested: true,
  });
}

function normalizeHeaderCell(value, index) {
  const text = String(value ?? '').normalize('NFKC').trim();
  return index === 0 ? text.replace(/^\uFEFF/, '') : text;
}

function validateHeaderList(values, expectedLength, label) {
  if (!Array.isArray(values) || values.length !== expectedLength) {
    throw new Error(
      `preview ${label} shape mismatch: expected ${expectedLength}, got ${Array.isArray(values) ? values.length : 0}`,
    );
  }
  const original = values.map((value) => String(value ?? ''));
  const normalized = original.map(normalizeHeaderCell);
  const blankIndex = normalized.findIndex((value) => !value);
  if (blankIndex !== -1) {
    throw new Error(`preview ${label} contains a blank header at column ${blankIndex + 1}`);
  }
  const folded = normalized.map((value) => value.toLocaleLowerCase());
  if (new Set(folded).size !== folded.length) {
    throw new Error(`preview ${label} contains duplicate headers after normalization`);
  }
  return { original, normalized };
}

export function validateImportPreview(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('preview result has an unsupported shape');
  }
  if (!Array.isArray(result.fieldNameList) || result.fieldNameList.length === 0) {
    throw new Error('preview did not return any field names');
  }
  const fieldCount = result.fieldNameList.length;
  const fieldNameContract = validateHeaderList(
    result.fieldNameList,
    fieldCount,
    'field names',
  );
  const fieldAliasContract = validateHeaderList(
    result.fieldAliasList,
    fieldCount,
    'field aliases',
  );
  const fieldNames = fieldNameContract.original;
  const fieldAliases = fieldAliasContract.original;
  if (!Array.isArray(result.fieldTypeList) || result.fieldTypeList.length !== fieldCount) {
    throw new Error(
      `preview field types shape mismatch: expected ${fieldCount}, got ${Array.isArray(result.fieldTypeList) ? result.fieldTypeList.length : 0}`,
    );
  }
  const fieldTypes = result.fieldTypeList.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`preview field type is missing at column ${index + 1}`);
    }
    return value.trim().toLocaleUpperCase();
  });
  if (!Array.isArray(result.datas) || result.datas.length === 0) {
    throw new Error('preview did not return a header row');
  }
  for (const [index, row] of result.datas.entries()) {
    if (!Array.isArray(row) || row.length !== fieldCount) {
      throw new Error(
        `preview row ${index + 1} shape mismatch: expected ${fieldCount} columns`,
      );
    }
  }
  const headerContract = validateHeaderList(result.datas[0], fieldCount, 'header row');
  const foldedAliases = fieldAliasContract.normalized.map(
    (value) => value.toLocaleLowerCase(),
  );
  const foldedHeader = headerContract.normalized.map(
    (value) => value.toLocaleLowerCase(),
  );
  if (foldedHeader.some((value, index) => value !== foldedAliases[index])) {
    throw new Error('preview header row does not match the ordered field aliases');
  }
  const rawRowCount = result.rowCount;
  if (!Number.isSafeInteger(rawRowCount) || rawRowCount < 1) {
    throw new Error('preview rowCount must be an integer including the header row');
  }
  if (result.datas.length > rawRowCount) {
    throw new Error('preview returned more rows than its declared rowCount');
  }
  if (rawRowCount > 1 && result.datas.length < 2) {
    throw new Error('preview declared data rows but returned only the header');
  }
  const schema = normalizeImportSchema(fieldNames.map((name, index) => ({
    name,
    dataType: fieldTypes[index],
  })));
  return Object.freeze({
    fieldNames: Object.freeze(fieldNames),
    fieldAliases: Object.freeze(fieldAliases),
    fieldTypes: Object.freeze(fieldTypes),
    schema: Object.freeze(schema),
    previewCount: Object.freeze({
      value: rawRowCount - 1,
      rawValue: rawRowCount,
      source: 'DataPackageServlet.GET_PREVIEW_DATA.rowCount',
      includesHeader: true,
      authoritative: false,
    }),
    returnedPreviewRows: result.datas.length,
  });
}

export function importRowCountReceipt(previewCount, terminalStatus) {
  if (!previewCount || previewCount.source !== 'DataPackageServlet.GET_PREVIEW_DATA.rowCount') {
    throw new Error('validated preview count is required');
  }
  if (!terminalStatus || terminalStatus.retCode !== 0) {
    throw new Error('terminal successful import status is required');
  }
  const terminalValue = terminalStatus.rowCount;
  let authoritative;
  if (terminalValue == null) {
    authoritative = Object.freeze({
      available: false,
      value: null,
      source: null,
      headerTreatment: null,
      reason: 'terminal import status did not expose a rowCount',
    });
  } else {
    if (!Number.isSafeInteger(terminalValue) || terminalValue < 0) {
      throw new Error('terminal import status rowCount is invalid');
    }
    authoritative = Object.freeze({
      available: true,
      value: terminalValue,
      source: 'DataPackageModule.getImportStatus.rowCount',
      headerTreatment: 'not established by the captured live contract',
    });
  }
  return Object.freeze({ preview: previewCount, authoritative });
}

function requireImportTarget(target, label) {
  if (!target || typeof target !== 'object' || !target.logicalName || !target.tableId) {
    throw new Error(`${label} import target is incomplete`);
  }
  return Object.freeze({ ...target });
}

export function planImportMutation({ replace = false, existing = null, target, staging = null }) {
  const guardedTarget = requireImportTarget(target, 'final');
  if (!replace) {
    if (existing) throw new Error('new import target already exists; replacement was not requested');
    return Object.freeze({
      mode: 'create',
      target: guardedTarget,
      staging: null,
      phases: Object.freeze([
        Object.freeze({ action: 'import', resource: 'target', destructive: false }),
        Object.freeze({ action: 'verify', resource: 'target', proves: 'target-postcondition' }),
      ]),
      preserveOnFailure: Object.freeze([]),
    });
  }
  if (!existing?.id) throw new Error('replacement requires an existing target');
  if (existing.type !== 'BASETABLE') {
    throw new Error('replacement target must be a BASETABLE in the personal acquisition folder');
  }
  if (String(existing.id).toLocaleLowerCase() !== guardedTarget.tableId.toLocaleLowerCase()) {
    throw new Error('replacement target does not match the existing table id');
  }
  const guardedStaging = requireImportTarget(staging, 'staging');
  if (
    guardedStaging.tableId.toLocaleLowerCase() === guardedTarget.tableId.toLocaleLowerCase()
    || guardedStaging.logicalName.toLocaleLowerCase() === guardedTarget.logicalName.toLocaleLowerCase()
  ) {
    throw new Error('replacement staging target must be distinct from the existing table');
  }
  return Object.freeze({
    mode: 'replace',
    existingId: existing.id,
    target: guardedTarget,
    staging: guardedStaging,
    sourceIntegrity: 'identical-sha256-before-target-mutation',
    phases: Object.freeze([
      Object.freeze({ action: 'import', resource: 'staging', destructive: false }),
      Object.freeze({ action: 'verify', resource: 'staging', proves: 'staging-postcondition' }),
      Object.freeze({
        action: 'replace',
        resource: 'target',
        destructive: true,
        requires: 'staging-postcondition',
      }),
      Object.freeze({ action: 'verify', resource: 'target', proves: 'target-postcondition' }),
      Object.freeze({
        action: 'cleanup',
        resource: 'staging',
        createdByInvocationOnly: true,
        requires: 'target-postcondition',
      }),
    ]),
    preserveOnFailure: Object.freeze(['staging']),
  });
}
