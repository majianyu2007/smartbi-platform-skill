import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPPORTED_LOCAL_IMPORTS,
  importRowCountReceipt,
  planImportMutation,
  planLocalImportSource,
  resolveWorksheetSelection,
  validateImportPreview,
} from '../scripts/import-contract.mjs';

const regularFile = { isFile: true, size: 128 };

function source(filePath, worksheet = null) {
  return planLocalImportSource({ filePath, worksheet, ...regularFile });
}

function validPreview(overrides = {}) {
  return {
    fieldNameList: ['city_cn', 'estimate_value'],
    fieldAliasList: ['city_cn', 'estimate_value'],
    fieldTypeList: ['STRING', 'DOUBLE'],
    datas: [
      ['city_cn', 'estimate_value'],
      ['A', 1.5],
    ],
    rowCount: 2,
    ...overrides,
  };
}

test('supported local extension matrix is explicit and closed', () => {
  assert.deepEqual(Object.keys(SUPPORTED_LOCAL_IMPORTS).sort(), [
    '.csv',
    '.txt',
    '.xls',
    '.xlsx',
  ]);
  assert.equal(source('/tmp/data.CSV').format, 'CSV');
  assert.equal(source('/tmp/data.txt').format, 'TXT');
  assert.equal(source('/tmp/data.xls', 'Records').format, 'XLS');
  assert.equal(source('/tmp/data.xlsx', 'Records').format, 'XLSX');
  assert.throws(
    () => source('/tmp/data.tsv'),
    /unsupported import format.*CSV, TXT, XLS, and XLSX/,
  );
  assert.throws(
    () => source('https://datasets.example/data.csv'),
    /only a local file path.*provenance metadata only/,
  );
  assert.throws(
    () => source('s3://private-bucket/data.xlsx', 'Records'),
    /only a local file path/,
  );
  assert.throws(
    () => source('file:///tmp/data.csv'),
    /only a local file path/,
  );
});

test('source preflight rejects empty, non-regular, and ambiguous workbook inputs', () => {
  assert.throws(
    () => planLocalImportSource({ filePath: '/tmp/empty.csv', isFile: true, size: 0 }),
    /nonempty regular file/,
  );
  assert.throws(
    () => planLocalImportSource({ filePath: '/tmp/folder.csv', isFile: false, size: 10 }),
    /not a regular file/,
  );
  assert.throws(
    () => source('/tmp/book.xlsx'),
    /require --worksheet.*never chooses sheet 0 implicitly/,
  );
  assert.throws(
    () => source('/tmp/data.csv', 'Sheet1'),
    /valid only for XLS or XLSX/,
  );
});

test('worksheet resolution requires the requested exact sheet and rejects ambiguity', () => {
  const plan = source('/tmp/book.xlsx', 'Records');
  assert.deepEqual(
    resolveWorksheetSelection(plan, ['0|Summary|true', '2|Records|false']),
    {
      index: 2,
      name: 'Records',
      selected: false,
      sheetCount: 2,
      explicitlyRequested: true,
    },
  );
  assert.throws(
    () => resolveWorksheetSelection(plan, ['0|Summary|true']),
    /requested worksheet was not returned exactly once/,
  );
  assert.throws(
    () => resolveWorksheetSelection(
      source('/tmp/data.csv'),
      ['0|data|true', '1|unexpected|false'],
    ),
    /unexpectedly exposed 2 worksheets.*ambiguous import/,
  );
  assert.throws(
    () => resolveWorksheetSelection(plan, ['0|Records|true', '1|Records|false']),
    /duplicate worksheet names/,
  );
});

test('preview validation rejects blank and duplicate headers', () => {
  assert.throws(
    () => validateImportPreview(validPreview({
      fieldAliasList: ['city_cn', '  '],
      datas: [['city_cn', '  ']],
      rowCount: 1,
    })),
    /field aliases contains a blank header/,
  );
  assert.throws(
    () => validateImportPreview(validPreview({
      fieldNameList: ['City', ' city '],
      fieldAliasList: ['City', ' city '],
      datas: [['City', ' city ']],
      rowCount: 1,
    })),
    /field names contains duplicate headers/,
  );
});

test('preview validation enforces ordered row shape and complete types', () => {
  assert.throws(
    () => validateImportPreview(validPreview({
      datas: [['city_cn', 'estimate_value'], ['A']],
    })),
    /row 2 shape mismatch/,
  );
  assert.throws(
    () => validateImportPreview(validPreview({ fieldTypeList: ['STRING', ''] })),
    /field type is missing at column 2/,
  );
  assert.throws(
    () => validateImportPreview(validPreview({
      datas: [['estimate_value', 'city_cn']],
      rowCount: 1,
    })),
    /header row does not match the ordered field aliases/,
  );
  assert.throws(
    () => validateImportPreview(validPreview({ rowCount: '2' })),
    /rowCount must be an integer/,
  );
  assert.throws(
    () => validateImportPreview(validPreview({
      datas: [['city_cn', 'estimate_value']],
      rowCount: 2,
    })),
    /declared data rows but returned only the header/,
  );
});

test('success row-count receipt distinguishes preview from terminal evidence', () => {
  const preview = validateImportPreview(validPreview());
  assert.deepEqual(
    importRowCountReceipt(preview.previewCount, { retCode: 0, rowCount: 2 }),
    {
      preview: {
        value: 1,
        rawValue: 2,
        source: 'DataPackageServlet.GET_PREVIEW_DATA.rowCount',
        includesHeader: true,
        authoritative: false,
      },
      authoritative: {
        available: true,
        value: 2,
        source: 'DataPackageModule.getImportStatus.rowCount',
        headerTreatment: 'not established by the captured live contract',
      },
    },
  );
  assert.deepEqual(
    importRowCountReceipt(preview.previewCount, { retCode: 0 }).authoritative,
    {
      available: false,
      value: null,
      source: null,
      headerTreatment: null,
      reason: 'terminal import status did not expose a rowCount',
    },
  );
});

test('replacement plan proves staging before target mutation and cleans only staging', () => {
  const plan = planImportMutation({
    replace: true,
    existing: { id: 'TAB.input.input.null.team_target', type: 'BASETABLE' },
    target: {
      logicalName: 'TEAM_target',
      tableId: 'TAB.input.input.null.team_target',
    },
    staging: {
      logicalName: 'TEAM_stage_ab12',
      tableId: 'TAB.input.input.null.team_stage_ab12',
    },
  });
  assert.equal(plan.mode, 'replace');
  assert.equal(plan.sourceIntegrity, 'identical-sha256-before-target-mutation');
  assert.deepEqual(
    plan.phases.map((phase) => [phase.action, phase.resource]),
    [
      ['import', 'staging'],
      ['verify', 'staging'],
      ['replace', 'target'],
      ['verify', 'target'],
      ['cleanup', 'staging'],
    ],
  );
  assert.equal(plan.phases[2].requires, 'staging-postcondition');
  assert.equal(plan.phases[4].requires, 'target-postcondition');
  assert.equal(plan.phases.some((phase) => (
    phase.action === 'cleanup' && phase.resource === 'target'
  )), false);
  assert.deepEqual(plan.preserveOnFailure, ['staging']);
});

test('replacement planning fails before upload for absent or non-table targets', () => {
  const target = { logicalName: 'TEAM_target', tableId: 'TAB.input.input.null.team_target' };
  const staging = { logicalName: 'TEAM_stage', tableId: 'TAB.input.input.null.team_stage' };
  assert.throws(
    () => planImportMutation({ replace: true, target, staging }),
    /requires an existing target/,
  );
  assert.throws(
    () => planImportMutation({
      replace: true,
      existing: { id: target.tableId, type: 'DEFAULT_TREENODE' },
      target,
      staging,
    }),
    /must be a BASETABLE/,
  );
  assert.throws(
    () => planImportMutation({
      replace: true,
      existing: { id: 'TAB.input.input.null.other', type: 'BASETABLE' },
      target,
      staging,
    }),
    /does not match the existing table id/,
  );
});
