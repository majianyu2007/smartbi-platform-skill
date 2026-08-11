import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAichatStream } from '../scripts/aichat-stream.mjs';

const OPTIONS = {
  expectedTaskId: 'task-1',
  expectedModelId: 'model-1',
};

function event(message, { multiline = false } = {}) {
  const json = JSON.stringify(message, null, multiline ? 2 : 0);
  return `${json.split('\n').map((line) => `data: ${line}`).join('\n')}\n\n`;
}

function completed() {
  return event({
    id: 'task-1',
    result: {
      kind: 'status-update',
      taskId: 'task-1',
      status: { state: 'completed' },
    },
  });
}

test('assembles multiline SSE and preserves text, table schema, and provenance', () => {
  const stream = [
    event({
      id: 'task-1',
      result: {
        kind: 'artifact-update',
        artifact: {
          artifactId: 'report',
          metadata: {
            mimeType: 'text/markdown',
            title: 'Report',
            provenance: { datasetId: 'model-1' },
          },
          parts: [{ kind: 'text', text: '# Generated report' }],
        },
      },
    }, { multiline: true }),
    event({
      id: 'task-1',
      result: {
        kind: 'artifact-update',
        artifact: {
          artifactId: 'table-1',
          metadata: {
            mimeType: 'json/table',
            title: 'Aggregate',
            schema: [{ name: 'city', type: 'STRING' }, { name: 'total', type: 'INTEGER' }],
            provenance: { datasetId: 'model-1', aggregation: 'sum' },
          },
          parts: [{ kind: 'data', data: [{ city: '北京', total: 185 }] }],
        },
      },
    }),
    completed(),
  ].join('');
  const parsed = parseAichatStream(stream, OPTIONS);
  assert.equal(parsed.generated, true);
  assert.equal(parsed.validated, false);
  assert.equal(parsed.answer, '# Generated report');
  assert.equal(parsed.tables[0].rowCount, 1);
  assert.deepEqual(parsed.tables[0].schema, [
    { name: 'city', type: 'STRING' },
    { name: 'total', type: 'INTEGER' },
  ]);
  assert.deepEqual(parsed.tables[0].provenance, {
    datasetId: 'model-1',
    aggregation: 'sum',
  });
  assert.equal(parsed.provenance.status, 'matched');
});

test('uses the JSON-RPC id when the server reports a child task id', () => {
  const stream = [
    event({
      id: 'task-1',
      result: {
        kind: 'artifact-update',
        taskId: 'server-child-task',
        artifact: {
          artifactId: 'answer',
          metadata: { mimeType: 'text/plain' },
          parts: [{ kind: 'text', text: 'completed answer' }],
        },
      },
    }),
    event({
      id: 'task-1',
      result: {
        kind: 'status-update',
        taskId: 'server-child-task',
        status: { state: 'completed' },
      },
    }),
  ].join('');
  const parsed = parseAichatStream(stream, OPTIONS);
  assert.equal(parsed.state, 'completed');
  assert.equal(parsed.answer, 'completed answer');
});

test('rejects an artifact or status correlated to another task', () => {
  const stream = [
    event({
      id: 'task-other',
      result: {
        kind: 'artifact-update',
        artifact: {
          artifactId: 'wrong',
          metadata: { mimeType: 'text/plain' },
          parts: [{ kind: 'text', text: 'wrong task' }],
        },
      },
    }),
    completed(),
  ].join('');
  assert.throws(
    () => parseAichatStream(stream, OPTIONS),
    /unexpected AIChat task/,
  );
});

test('propagates bounded JSON-RPC errors and cancellation states', () => {
  assert.throws(
    () => parseAichatStream(event({
      jsonrpc: '2.0',
      id: 'task-1',
      error: { code: -32000, message: 'backend rejected generation' },
    }), OPTIONS),
    /JSON-RPC error \(-32000\): backend rejected generation/,
  );
  assert.throws(
    () => parseAichatStream(event({
      id: 'task-1',
      result: {
        kind: 'status-update',
        taskId: 'task-1',
        status: { state: 'cancelled', message: 'cancelled by server' },
      },
    }), OPTIONS),
    /generation cancelled/,
  );
});

test('completed blank text, empty table, and empty file artifacts are rejected', () => {
  const artifacts = [
    {
      artifactId: 'blank',
      metadata: { mimeType: 'text/plain' },
      parts: [{ kind: 'text', text: '   \n' }],
    },
    {
      artifactId: 'empty-table',
      metadata: { mimeType: 'json/table' },
      parts: [{ kind: 'data', data: [] }],
    },
    {
      artifactId: 'empty-file',
      metadata: { mimeType: 'application/octet-stream' },
      parts: [{ kind: 'file', file: {} }],
    },
  ];
  for (const artifact of artifacts) {
    const stream = [
      event({ id: 'task-1', result: { kind: 'artifact-update', artifact } }),
      completed(),
    ].join('');
    assert.throws(
      () => parseAichatStream(stream, OPTIONS),
      /without a substantive artifact/,
    );
  }
});

test('rejects non-completed generation and mismatched artifact provenance', () => {
  const running = [
    event({
      id: 'task-1',
      result: {
        kind: 'artifact-update',
        artifact: {
          artifactId: 'answer',
          metadata: { mimeType: 'text/plain' },
          parts: [{ kind: 'text', text: 'partial' }],
        },
      },
    }),
    event({
      id: 'task-1',
      result: {
        kind: 'status-update',
        taskId: 'task-1',
        status: { state: 'running' },
      },
    }),
  ].join('');
  assert.throws(() => parseAichatStream(running, OPTIONS), /did not complete/);

  const crossModel = [
    event({
      id: 'task-1',
      result: {
        kind: 'artifact-update',
        artifact: {
          artifactId: 'answer',
          metadata: {
            mimeType: 'text/plain',
            provenance: { datasetId: 'model-other' },
          },
          parts: [{ kind: 'text', text: 'cross-model answer' }],
        },
      },
    }),
    completed(),
  ].join('');
  assert.throws(
    () => parseAichatStream(crossModel, OPTIONS),
    /provenance does not match/,
  );
});

test('enforces stream and row caps instead of truncating or dumping overflow', () => {
  const tableStream = [
    event({
      id: 'task-1',
      result: {
        kind: 'artifact-update',
        artifact: {
          artifactId: 'table',
          metadata: { mimeType: 'json/table' },
          parts: [{ kind: 'data', data: [{ value: 1 }, { value: 2 }] }],
        },
      },
    }),
    completed(),
  ].join('');
  assert.throws(
    () => parseAichatStream(tableStream, {
      ...OPTIONS,
      limits: { maxTableRows: 1 },
    }),
    /exceeds 1 rows/,
  );
  assert.throws(
    () => parseAichatStream(tableStream, {
      ...OPTIONS,
      limits: { maxStreamBytes: 32 },
    }),
    /stream exceeds 32 bytes/,
  );
});

test('latest full artifact snapshot wins without lossy row deduplication', () => {
  const first = {
    artifactId: 'table-1',
    metadata: { mimeType: 'json/table', title: 'result' },
    parts: [{ kind: 'data', data: [{ city: '北京', value: 100 }] }],
  };
  const latest = {
    ...first,
    parts: [{ kind: 'data', data: [{ city: '北京', value: 185 }] }],
  };
  const parsed = parseAichatStream([
    event({ id: 'task-1', result: { kind: 'artifact-update', artifact: first } }),
    event({ id: 'task-1', result: { kind: 'artifact-update', artifact: latest } }),
    completed(),
  ].join(''), OPTIONS);
  assert.deepEqual(parsed.tables[0].rows, [{ city: '北京', value: 185 }]);
  assert.equal(parsed.tables[0].updateCount, 2);
});
