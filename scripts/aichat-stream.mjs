export function parseAichatStream(text) {
  const messages = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      messages.push(JSON.parse(line.slice(5)));
    } catch {
      // Ignore malformed incremental frames; later frames carry the complete artifact.
    }
  }
  const artifacts = new Map();
  let state = null;
  for (const message of messages) {
    const result = message.result;
    if (result?.kind === 'artifact-update' && result.artifact?.artifactId) {
      artifacts.set(result.artifact.artifactId, result.artifact);
    }
    if (result?.kind === 'status-update' && result.taskId === message.id) {
      state = result.status?.state || state;
    }
  }
  const answers = [];
  const tables = [];
  const files = [];
  for (const artifact of artifacts.values()) {
    const mimeType = artifact.metadata?.mimeType;
    for (const part of artifact.parts || []) {
      if (
        part.kind === 'text'
        && part.text
        && (!mimeType || String(mimeType).startsWith('text/'))
      ) {
        answers.push(part.text);
      }
      if (part.kind === 'data' && Array.isArray(part.data) && mimeType === 'json/table') {
        tables.push({ title: artifact.metadata?.title || null, rows: part.data });
      }
      if (part.kind === 'file' && part.file) {
        files.push({
          name: part.file.name || null,
          display: part.file.display?.split('/').pop() || null,
          mimeType: part.file.mimeType || null,
          size: part.file.size ?? null,
        });
      }
    }
  }
  const uniqueTables = [...new Map(tables.map((table) => [JSON.stringify(table), table])).values()];
  const uniqueFiles = [...new Map(files.map((file) => [JSON.stringify(file), file])).values()];
  const answer = answers.at(-1) || null;
  return {
    ok: state === 'completed' && Boolean(answer || uniqueTables.length || uniqueFiles.length),
    state,
    answer,
    tables: uniqueTables,
    files: uniqueFiles,
    eventCount: messages.length,
  };
}
