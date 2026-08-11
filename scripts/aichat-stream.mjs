export const DEFAULT_AICHAT_STREAM_LIMITS = Object.freeze({
  maxStreamBytes: 2 * 1024 * 1024,
  maxEventBytes: 256 * 1024,
  maxEvents: 1024,
  maxArtifacts: 64,
  maxParts: 256,
  maxTextBytes: 64 * 1024,
  maxTableRows: 200,
  maxTableColumns: 100,
  maxTableCells: 5000,
  maxCellBytes: 16 * 1024,
  maxMetadataBytes: 64 * 1024,
});

const FAILURE_STATES = new Set([
  'cancelled',
  'canceled',
  'failed',
  'error',
  'rejected',
  'aborted',
]);

const SECRET_KEY = /(authorization|cookie|credential|password|secret|token|api[_-]?key)/i;

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function boundedLimits(overrides = {}) {
  const limits = { ...DEFAULT_AICHAT_STREAM_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in limits)) throw new Error(`unknown AIChat stream limit: ${key}`);
    if (!Number.isSafeInteger(value) || value <= 0 || value > limits[key]) {
      throw new Error(`invalid AIChat stream limit ${key}: ${value}`);
    }
    limits[key] = value;
  }
  return limits;
}

function safeErrorText(value, fallback) {
  const text = typeof value === 'string'
    ? value
    : (value && typeof value.message === 'string' ? value.message : fallback);
  return String(text || fallback)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) || fallback;
}

function stripUrlSecrets(value) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function sanitizeMetadata(value, label, limits) {
  if (value === undefined || value === null) return null;
  const seen = new WeakSet();
  let serialized;
  try {
    serialized = JSON.stringify(value, function sanitize(key, current) {
      if (SECRET_KEY.test(key)) return '[redacted]';
      if (typeof current === 'string') return stripUrlSecrets(current);
      if (current && typeof current === 'object') {
        if (seen.has(current)) throw new Error(`${label} contains a cycle`);
        seen.add(current);
      }
      return current;
    });
  } catch (error) {
    throw new Error(`${label} is not safely serializable: ${safeErrorText(error, 'invalid metadata')}`);
  }
  if (serialized === undefined) return null;
  if (byteLength(serialized) > limits.maxMetadataBytes) {
    throw new Error(`${label} exceeds ${limits.maxMetadataBytes} bytes`);
  }
  return JSON.parse(serialized);
}

function assembleSseEvents(text, limits) {
  const input = String(text);
  if (byteLength(input) > limits.maxStreamBytes) {
    throw new Error(`AIChat stream exceeds ${limits.maxStreamBytes} bytes`);
  }

  const events = [];
  let dataLines = [];
  let eventType = null;
  let currentBytes = 0;
  const dispatch = () => {
    if (dataLines.length > 0) {
      events.push({ type: eventType || 'message', data: dataLines.join('\n') });
      if (events.length > limits.maxEvents) {
        throw new Error(`AIChat stream exceeds ${limits.maxEvents} SSE events`);
      }
    }
    dataLines = [];
    eventType = null;
    currentBytes = 0;
  };

  const lines = input.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  for (const line of lines) {
    if (line === '') {
      dispatch();
      continue;
    }
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      eventType = value;
      continue;
    }
    if (field !== 'data') continue;
    currentBytes += byteLength(value);
    if (currentBytes > limits.maxEventBytes) {
      throw new Error(`AIChat SSE event exceeds ${limits.maxEventBytes} bytes`);
    }
    dataLines.push(value);
  }
  dispatch();
  return events;
}

function correlatedTaskId(message) {
  return message?.id ?? message?.result?.taskId ?? null;
}

function assertExpectedTask(message, expectedTaskId, label) {
  const actual = correlatedTaskId(message);
  if (actual === null || actual === undefined || String(actual) !== expectedTaskId) {
    throw new Error(`${label} was correlated to an unexpected AIChat task`);
  }
}

function normalizeStatus(value) {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : null;
}

function safeLabel(value, maxBytes = 512) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  if (!normalized) return null;
  if (byteLength(normalized) > maxBytes) throw new Error(`AIChat artifact label exceeds ${maxBytes} bytes`);
  return normalized;
}

function safeFileDisplay(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let path = value.trim();
  try {
    const url = new URL(path);
    path = url.pathname;
  } catch {
    path = path.split(/[?#]/, 1)[0];
  }
  const segment = path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1);
  if (!segment) return null;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Keep the encoded basename; never retain its query or fragment.
  }
  return safeLabel(decoded, 512);
}

function validateTableRows(rows, counters, limits) {
  counters.rows += rows.length;
  if (counters.rows > limits.maxTableRows) {
    throw new Error(`AIChat table output exceeds ${limits.maxTableRows} rows`);
  }

  let substantive = false;
  const columns = new Set();
  for (const row of rows) {
    if (!row || (typeof row !== 'object')) {
      throw new Error('AIChat table row has an unsupported shape');
    }
    const entries = Array.isArray(row)
      ? row.map((value, index) => [String(index), value])
      : Object.entries(row);
    for (const [column, cell] of entries) {
      columns.add(column);
      counters.cells += 1;
      if (counters.cells > limits.maxTableCells) {
        throw new Error(`AIChat table output exceeds ${limits.maxTableCells} cells`);
      }
      const serialized = JSON.stringify(cell);
      if (serialized !== undefined && byteLength(serialized) > limits.maxCellBytes) {
        throw new Error(`AIChat table cell exceeds ${limits.maxCellBytes} bytes`);
      }
      if (
        cell !== null
        && cell !== undefined
        && (typeof cell !== 'string' || cell.trim() !== '')
      ) {
        substantive = true;
      }
    }
  }
  if (columns.size > limits.maxTableColumns) {
    throw new Error(`AIChat table output exceeds ${limits.maxTableColumns} columns`);
  }
  return { columnCount: columns.size, substantive };
}

function collectDeclaredModelIds(value, output, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectDeclaredModelIds(item, output, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replaceAll(/[_-]/g, '').toLocaleLowerCase();
    if (
      (normalized === 'modelid' || normalized === 'datasetid')
      && (typeof child === 'string' || typeof child === 'number')
    ) {
      output.add(String(child));
    }
    if (
      (normalized === 'model' || normalized === 'dataset')
      && child
      && typeof child === 'object'
      && (typeof child.id === 'string' || typeof child.id === 'number')
    ) {
      output.add(String(child.id));
    }
    collectDeclaredModelIds(child, output, depth + 1);
  }
}

function collectTopLevelMetadataModelIds(metadata, output) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
  for (const key of ['modelId', 'datasetId']) {
    const value = metadata[key];
    if (typeof value === 'string' || typeof value === 'number') output.add(String(value));
  }
  for (const key of ['model', 'dataset']) {
    const value = metadata[key];
    if (
      value
      && typeof value === 'object'
      && (typeof value.id === 'string' || typeof value.id === 'number')
    ) {
      output.add(String(value.id));
    }
  }
  collectDeclaredModelIds(metadata.provenance, output);
}

function artifactPartMetadata(artifact, metadata, part, limits) {
  const partMetadata = sanitizeMetadata(part.metadata || {}, 'AIChat artifact part metadata', limits);
  const schema = sanitizeMetadata(
    part.schema ?? artifact.metadata?.schema ?? null,
    'AIChat table schema',
    limits,
  );
  const provenance = sanitizeMetadata(
    part.provenance ?? artifact.metadata?.provenance ?? null,
    'AIChat artifact provenance',
    limits,
  );
  return { metadata, partMetadata, schema, provenance };
}

export function parseAichatStream(
  text,
  {
    expectedTaskId,
    expectedModelId,
    limits: limitOverrides = {},
  } = {},
) {
  if (typeof expectedTaskId !== 'string' || !expectedTaskId.trim()) {
    throw new Error('expectedTaskId is required to parse an AIChat stream');
  }
  if (typeof expectedModelId !== 'string' || !expectedModelId.trim()) {
    throw new Error('expectedModelId is required to parse an AIChat stream');
  }
  const taskId = expectedTaskId.trim();
  const modelId = expectedModelId.trim();
  const limits = boundedLimits(limitOverrides);
  const events = assembleSseEvents(text, limits);
  const artifacts = new Map();
  let messageCount = 0;
  let matchedEventCount = 0;
  let state = null;

  for (const [index, event] of events.entries()) {
    if (event.data.trim() === '[DONE]') continue;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      throw new Error(`AIChat SSE event ${index + 1} is not valid JSON`);
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error(`AIChat SSE event ${index + 1} has an unsupported JSON-RPC shape`);
    }
    messageCount += 1;
    const eventType = String(event.type || '').toLocaleLowerCase();
    if (eventType.includes('error') || eventType.includes('cancel')) {
      if (correlatedTaskId(message) != null) {
        assertExpectedTask(message, taskId, `AIChat SSE ${eventType}`);
      }
      throw new Error(
        `AIChat SSE ${eventType}: ${safeErrorText(message.error || message.result, 'generation failed')}`,
      );
    }

    if (message.error) {
      assertExpectedTask(message, taskId, 'AIChat JSON-RPC error');
      const code = message.error.code === undefined ? '' : ` (${String(message.error.code).slice(0, 40)})`;
      throw new Error(
        `AIChat JSON-RPC error${code}: ${safeErrorText(message.error, 'generation failed')}`,
      );
    }

    const result = message.result;
    if (!result || typeof result !== 'object') continue;
    const kind = typeof result.kind === 'string' ? result.kind.toLocaleLowerCase() : '';
    if (kind === 'artifact-update' || kind === 'status-update' || kind.includes('cancel') || kind === 'error') {
      assertExpectedTask(message, taskId, `AIChat ${kind || 'result'}`);
      matchedEventCount += 1;
    }

    if (kind.includes('cancel') || kind === 'error') {
      throw new Error(`AIChat generation ${kind || 'failed'}: ${safeErrorText(result, 'no safe reason supplied')}`);
    }

    if (kind === 'status-update') {
      const nextState = normalizeStatus(result.status?.state);
      if (nextState) state = nextState;
      if (nextState && FAILURE_STATES.has(nextState)) {
        throw new Error(
          `AIChat generation ${nextState}: ${safeErrorText(result.status, 'no safe reason supplied')}`,
        );
      }
      continue;
    }

    if (kind === 'artifact-update') {
      const artifact = result.artifact;
      const artifactId = typeof artifact?.artifactId === 'string' ? artifact.artifactId.trim() : '';
      if (!artifactId || !Array.isArray(artifact.parts)) {
        throw new Error('AIChat artifact update has an unsupported shape');
      }
      const previous = artifacts.get(artifactId);
      artifacts.set(artifactId, {
        artifact,
        updateCount: (previous?.updateCount || 0) + 1,
      });
      if (artifacts.size > limits.maxArtifacts) {
        throw new Error(`AIChat stream exceeds ${limits.maxArtifacts} artifacts`);
      }
    }
  }

  if (matchedEventCount === 0) {
    throw new Error('AIChat stream contained no events for the expected task');
  }
  if (state !== 'completed') {
    throw new Error(`AIChat generation did not complete (state: ${state || 'missing'})`);
  }

  const texts = [];
  const tables = [];
  const files = [];
  const unsupportedArtifacts = [];
  const provenanceIds = new Set();
  const tableCounters = { rows: 0, cells: 0 };
  let partCount = 0;
  let textBytes = 0;
  let substantiveArtifacts = 0;

  for (const [artifactId, entry] of artifacts) {
    const { artifact, updateCount } = entry;
    const mimeType = safeLabel(artifact.metadata?.mimeType, 256);
    const metadata = sanitizeMetadata(
      artifact.metadata || {},
      'AIChat artifact metadata',
      limits,
    );
    collectTopLevelMetadataModelIds(metadata, provenanceIds);
    for (const [partIndex, part] of artifact.parts.entries()) {
      partCount += 1;
      if (partCount > limits.maxParts) {
        throw new Error(`AIChat stream exceeds ${limits.maxParts} artifact parts`);
      }
      if (!part || typeof part !== 'object') {
        throw new Error('AIChat artifact part has an unsupported shape');
      }
      const details = artifactPartMetadata(artifact, metadata, part, limits);
      collectTopLevelMetadataModelIds(details.partMetadata, provenanceIds);
      collectDeclaredModelIds(details.provenance, provenanceIds);

      if (
        part.kind === 'text'
        && typeof part.text === 'string'
        && (!mimeType || mimeType.startsWith('text/'))
      ) {
        if (!part.text.trim()) continue;
        textBytes += byteLength(part.text);
        if (textBytes > limits.maxTextBytes) {
          throw new Error(`AIChat text output exceeds ${limits.maxTextBytes} bytes`);
        }
        texts.push({
          artifactId,
          partIndex,
          title: safeLabel(artifact.metadata?.title),
          mimeType,
          text: part.text,
          metadata: details.metadata,
          partMetadata: details.partMetadata,
          provenance: details.provenance,
          updateCount,
        });
        substantiveArtifacts += 1;
        continue;
      }

      if (part.kind === 'data' && mimeType === 'json/table') {
        if (!Array.isArray(part.data)) {
          throw new Error('AIChat json/table artifact has an unsupported data shape');
        }
        const checked = validateTableRows(part.data, tableCounters, limits);
        tables.push({
          artifactId,
          partIndex,
          title: safeLabel(artifact.metadata?.title),
          mimeType,
          schema: details.schema,
          provenance: details.provenance,
          metadata: details.metadata,
          partMetadata: details.partMetadata,
          rowCount: part.data.length,
          columnCount: checked.columnCount,
          rows: part.data,
          updateCount,
        });
        if (part.data.length > 0 && checked.substantive) substantiveArtifacts += 1;
        continue;
      }

      if (part.kind === 'file' && part.file && typeof part.file === 'object') {
        const size = Number.isSafeInteger(part.file.size) && part.file.size >= 0
          ? part.file.size
          : null;
        const name = safeFileDisplay(part.file.name);
        const display = safeFileDisplay(part.file.display);
        files.push({
          artifactId,
          partIndex,
          name,
          display,
          mimeType: safeLabel(part.file.mimeType, 256),
          size,
          metadata: details.metadata,
          partMetadata: details.partMetadata,
          provenance: details.provenance,
          contentValidated: false,
          updateCount,
        });
        if (size > 0 && Boolean(name || display)) substantiveArtifacts += 1;
        continue;
      }

      unsupportedArtifacts.push({
        artifactId,
        partIndex,
        kind: safeLabel(part.kind, 128),
        mimeType,
        title: safeLabel(artifact.metadata?.title),
        metadata: details.metadata,
        partMetadata: details.partMetadata,
        provenance: details.provenance,
        payload: sanitizeMetadata({
          data: part.data ?? null,
          text: part.text ?? null,
          file: part.file ?? null,
        }, 'unsupported AIChat artifact payload', limits),
        updateCount,
      });
    }
  }

  if (provenanceIds.size > 0 && (
    provenanceIds.size !== 1
    || !provenanceIds.has(modelId)
  )) {
    throw new Error('AIChat artifact provenance does not match the requested model');
  }
  if (substantiveArtifacts === 0) {
    throw new Error('AIChat completed without a substantive artifact');
  }

  return {
    state,
    transportCompleted: true,
    artifactPresent: true,
    generated: true,
    validated: false,
    validationStatus: 'not-validated',
    answer: texts.map((artifact) => artifact.text).join('\n\n'),
    texts,
    tables,
    files,
    unsupportedArtifacts,
    eventCount: events.length,
    messageCount,
    artifactCount: artifacts.size,
    taskCorrelation: {
      expectedTaskId: taskId,
      matchedEventCount,
    },
    provenance: {
      expectedModelId: modelId,
      status: provenanceIds.size > 0 ? 'matched' : 'not-exposed',
      declaredModelIds: [...provenanceIds],
    },
    limits,
  };
}
