import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAichatStream } from '../scripts/aichat-stream.mjs';

function event(message) {
  return `data:${JSON.stringify(message)}\n`;
}

test('completed markdown report is returned as a non-empty answer', () => {
  const stream = [
    event({
      id: 'task-1',
      result: {
        kind: 'artifact-update',
        artifact: {
          artifactId: 'report',
          metadata: { mimeType: 'text/markdown' },
          parts: [{ kind: 'text', text: '# Validated report' }],
        },
      },
    }),
    event({
      id: 'task-1',
      result: { kind: 'status-update', taskId: 'task-1', status: { state: 'completed' } },
    }),
  ].join('');
  const parsed = parseAichatStream(stream);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.answer, '# Validated report');
});

test('completed status without an answer, table, or file is not successful', () => {
  const parsed = parseAichatStream(event({
    id: 'task-1',
    result: { kind: 'status-update', taskId: 'task-1', status: { state: 'completed' } },
  }));
  assert.equal(parsed.state, 'completed');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.answer, null);
});

test('latest artifact update wins and table artifacts are deduplicated', () => {
  const table = {
    artifactId: 'table-1',
    metadata: { mimeType: 'json/table', title: 'result' },
    parts: [{ kind: 'data', data: [{ city: '北京', value: 185 }] }],
  };
  const stream = [
    event({ id: 'task-1', result: { kind: 'artifact-update', artifact: table } }),
    event({ id: 'task-1', result: { kind: 'artifact-update', artifact: table } }),
    event({
      id: 'task-1',
      result: { kind: 'status-update', taskId: 'task-1', status: { state: 'completed' } },
    }),
  ].join('');
  const parsed = parseAichatStream(stream);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.tables, [{ title: 'result', rows: [{ city: '北京', value: 185 }] }]);
});
