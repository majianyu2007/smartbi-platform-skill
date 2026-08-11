import { createHash } from 'node:crypto';

export const AICHAT_RESULT_ENVELOPE_FORMAT = 'smartbi-aichat-result-envelope/v1';
export const AICHAT_DATA_SKILL_ID = 'SKILL_BUILTIN_DATA_MODEL_OR_REPORT_FETCH';
export const AICHAT_NO_TEMPLATE_REPORT_SKILL_ID = 'SKILL_BUILTIN_NO_TEMPLATE_REPORT';

const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_STDOUT_BYTES = 128 * 1024;
const AICHAT_STDOUT_SUMMARY_FORMAT = 'smartbi-aichat-stdout-summary/v1';
const MODES = new Set(['query', 'report']);

function requiredValue(args, index, option, command) {
  const value = args[index + 1];
  if (!value || String(value).startsWith('--')) {
    throw new Error(`${command} requires a value for ${option}`);
  }
  return value;
}

function normalizeQuestion(tokens, command) {
  const question = tokens.join(' ').trim();
  if (!question) throw new Error(`${command} requires a non-blank <prompt>`);
  if (Buffer.byteLength(question, 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error(`${command} prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  }
  return question;
}

function parsePromptFlags(tokens, command, allowed) {
  const prompt = [];
  const values = {};
  let afterSeparator = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (afterSeparator) {
      prompt.push(token);
      continue;
    }
    if (token === '--') {
      afterSeparator = true;
      continue;
    }
    if (!token.startsWith('--')) {
      prompt.push(token);
      continue;
    }
    const contract = allowed[token];
    if (!contract) throw new Error(`${command} does not support option ${token}`);
    if (contract.kind === 'boolean') {
      if (values[contract.key] !== undefined) throw new Error(`${command} received ${token} more than once`);
      values[contract.key] = true;
      continue;
    }
    if (values[contract.key] !== undefined) throw new Error(`${command} received ${token} more than once`);
    values[contract.key] = requiredValue(tokens, index, token, command);
    index += 1;
  }
  return { values, question: normalizeQuestion(prompt, command) };
}

export function parseAichatRunArgs(args, { command, mode }) {
  if (!Array.isArray(args) || !args[0]) {
    throw new Error(`${command} requires <modelId> [--llm-id <exactId>] [--] <prompt>`);
  }
  if (!MODES.has(mode)) throw new Error(`unsupported AIChat mode: ${mode}`);
  const parsed = parsePromptFlags(args.slice(1), command, {
    '--llm-id': { key: 'llmId', kind: 'value' },
  });
  return {
    modelId: args[0],
    mode,
    question: parsed.question,
    llmId: parsed.values.llmId || null,
  };
}

export function parseAichatExportArgs(args) {
  const command = 'aichat-export';
  if (!Array.isArray(args) || !args[0] || !args[1]) {
    throw new Error(
      'aichat-export requires <modelId> <absolutePrivateEnvelopePath> --mode <query|report> '
      + '[--llm-id <exactId>] [--overwrite --confirm-path <exactPath>] [--] <prompt>',
    );
  }
  const parsed = parsePromptFlags(args.slice(2), command, {
    '--mode': { key: 'mode', kind: 'value' },
    '--llm-id': { key: 'llmId', kind: 'value' },
    '--overwrite': { key: 'overwrite', kind: 'boolean' },
    '--confirm-path': { key: 'confirmPath', kind: 'value' },
  });
  const mode = parsed.values.mode;
  if (!MODES.has(mode)) throw new Error('aichat-export requires --mode query or --mode report');
  const overwrite = parsed.values.overwrite === true;
  const confirmPath = parsed.values.confirmPath || null;
  if (overwrite && !confirmPath) {
    throw new Error('aichat-export --overwrite requires --confirm-path <exactPath>');
  }
  if (!overwrite && confirmPath) {
    throw new Error('aichat-export --confirm-path is valid only with --overwrite');
  }
  return {
    modelId: args[0],
    outputPath: args[1],
    mode,
    question: parsed.question,
    llmId: parsed.values.llmId || null,
    overwrite,
    confirmPath,
  };
}

function normalizedSelection(item, kind) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim()) {
    throw new Error(`AIChat ${kind} selection is incomplete`);
  }
  return {
    id: item.id,
    name: item.alias || item.name || null,
    type: item.type || null,
  };
}

export function selectAichatLlm(configs, requestedId = null) {
  if (!Array.isArray(configs)) throw new Error('AIChat LLM configuration response is not a list');
  let candidates;
  if (requestedId) {
    candidates = configs.filter((item) => item?.id === requestedId);
    if (candidates.length === 0) throw new Error(`AIChat LLM configuration not found: ${requestedId}`);
    if (candidates.length > 1) throw new Error(`AIChat LLM configuration is ambiguous: ${requestedId}`);
  } else {
    candidates = configs.filter((item) => item?.isDefault === true);
    if (candidates.length === 0) {
      throw new Error('AIChat has no unique default LLM configuration; pass --llm-id <exactId>');
    }
    if (candidates.length > 1) {
      throw new Error('AIChat has multiple default LLM configurations; pass --llm-id <exactId>');
    }
  }
  return normalizedSelection(candidates[0], 'LLM');
}

export function requiredAichatSkillIds(mode) {
  if (mode === 'query') return [AICHAT_DATA_SKILL_ID];
  if (mode === 'report') return [AICHAT_DATA_SKILL_ID, AICHAT_NO_TEMPLATE_REPORT_SKILL_ID];
  throw new Error(`unsupported AIChat mode: ${mode}`);
}

export function selectAichatSkills(items, mode) {
  if (!Array.isArray(items)) throw new Error('AIChat skill response is not a list');
  return requiredAichatSkillIds(mode).map((skillId) => {
    const matches = items.filter((item) => item?.id === skillId);
    if (matches.length === 0) throw new Error(`required AIChat skill is unavailable: ${skillId}`);
    if (matches.length > 1) throw new Error(`required AIChat skill is ambiguous: ${skillId}`);
    return normalizedSelection(matches[0], 'skill');
  });
}

function assertExactSkillSelection(skills, mode) {
  const requiredIds = requiredAichatSkillIds(mode);
  if (
    !Array.isArray(skills)
    || skills.length !== requiredIds.length
    || skills.some((skill, index) => skill?.id !== requiredIds[index])
  ) {
    throw new Error(`AIChat ${mode} requires the exact built-in skill selection`);
  }
}

export function buildAichatRequest({
  model,
  question,
  mode,
  llm,
  skills,
  conversationId,
  taskId,
  messageId,
}) {
  if (!MODES.has(mode)) throw new Error(`unsupported AIChat mode: ${mode}`);
  if (!model?.id || !model?.name) throw new Error('AIChat requires an exact model id and name');
  if (!llm?.id) throw new Error('AIChat requires an explicit LLM selection');
  assertExactSkillSelection(skills, mode);
  const prompt = normalizeQuestion([question], `aichat-${mode}`);
  if (![conversationId, taskId, messageId].every((value) => typeof value === 'string' && value)) {
    throw new Error('AIChat request correlation identifiers are required');
  }
  return {
    jsonRpcStreamReq: {
      jsonrpc: '2.0',
      method: 'message/stream',
      params: {
        message: {
          messageId,
          kind: 'message',
          role: 'user',
          metadata: {
            agentId: 'customagent_AGENT_DATA_INSIGHT_ASSISTANT',
            convId: conversationId,
            datasets: [{ id: model.id, type: 'AUGMENTED_DATASET', name: model.name }],
            queryGridData: true,
            params: [
              { singleRound: false },
              { use_personal_knowledge: false },
              { reports: [] },
              { projectId: '' },
              { project_desc: '' },
              {},
              { webSearch: false },
              { crossDatasetQuery: false },
              { uploadFile: false },
              { need_inquiry: true },
              { is_recommend_dataset: false },
              { LLMConfigId: llm.id },
              { skills },
            ],
          },
          parts: [
            { kind: 'text', text: prompt },
            { kind: 'knowledge', knowledge: '[]' },
          ],
        },
      },
      id: taskId,
    },
  };
}

function requestPolicy(payload) {
  const message = payload.jsonRpcStreamReq.params.message;
  const flags = Object.assign({}, ...message.metadata.params);
  return {
    datasetIds: message.metadata.datasets.map((dataset) => dataset.id),
    queryGridData: message.metadata.queryGridData,
    crossDatasetQuery: flags.crossDatasetQuery,
    usePersonalKnowledge: flags.use_personal_knowledge,
    webSearch: flags.webSearch,
    uploadFile: flags.uploadFile,
    reportContextCount: Array.isArray(flags.reports) ? flags.reports.length : null,
    projectContext: Boolean(flags.projectId || flags.project_desc),
  };
}

export function createAichatEnvelope({
  parsed,
  payload,
  mode,
  model,
  graphReadiness,
  modelAuthorization,
  llm,
  skills,
  question,
  conversationId,
  taskId,
}) {
  if (
    parsed?.state !== 'completed'
    || parsed?.transportCompleted !== true
    || parsed?.artifactPresent !== true
    || parsed?.generated !== true
  ) {
    throw new Error('AIChat result is not a completed substantive generation');
  }
  if (
    graphReadiness?.status !== 'SUCCESS'
    || graphReadiness?.modelId !== model?.id
    || graphReadiness?.modelName !== model?.name
  ) {
    throw new Error('AIChat graph readiness receipt does not match the exact model');
  }
  if (
    modelAuthorization?.exactModelId !== true
    || modelAuthorization?.namespaceOwned !== true
    || modelAuthorization?.readPermission !== true
    || modelAuthorization?.personalWorkspace !== true
    || !['not-required', 'direct-candidate-child'].includes(modelAuthorization?.competitionPlacement)
  ) {
    throw new Error('AIChat model ownership/read authorization was not proven');
  }
  assertExactSkillSelection(skills, mode);
  const policy = requestPolicy(payload);
  if (
    policy.datasetIds.length !== 1
    || policy.datasetIds[0] !== model.id
    || policy.crossDatasetQuery !== false
  ) {
    throw new Error('AIChat request did not preserve the exact-model boundary');
  }
  return {
    format: AICHAT_RESULT_ENVELOPE_FORMAT,
    mode,
    generation: {
      state: parsed.state,
      transportCompleted: true,
      artifactPresent: true,
      generated: true,
    },
    validation: {
      validated: false,
      reconciliation: 'not-performed',
    },
    request: {
      conversationId,
      taskId,
      promptSha256: createHash('sha256').update(question, 'utf8').digest('hex'),
      policy,
    },
    model: { id: model.id, name: model.name, authorization: modelAuthorization },
    graphReadiness,
    selection: {
      llm,
      skills,
    },
    artifacts: {
      answer: parsed.answer,
      texts: parsed.texts,
      tables: parsed.tables,
      files: parsed.files,
      unsupported: parsed.unsupportedArtifacts,
      provenance: parsed.provenance,
    },
    stream: {
      eventCount: parsed.eventCount,
      messageCount: parsed.messageCount,
      artifactCount: parsed.artifactCount,
      taskCorrelation: parsed.taskCorrelation,
      enforcedLimits: parsed.limits,
    },
  };
}

export function summarizeAichatEnvelope(envelope) {
  if (envelope?.format !== AICHAT_RESULT_ENVELOPE_FORMAT || envelope?.generation?.generated !== true) {
    throw new Error('cannot summarize an incomplete AIChat envelope');
  }
  const answer = typeof envelope.artifacts.answer === 'string' ? envelope.artifacts.answer : '';
  const summary = {
    format: AICHAT_STDOUT_SUMMARY_FORMAT,
    envelopeFormat: envelope.format,
    mode: envelope.mode,
    generation: envelope.generation,
    validation: envelope.validation,
    request: envelope.request,
    model: envelope.model,
    graphReadiness: {
      status: envelope.graphReadiness.status,
      persistedFieldCount: envelope.graphReadiness.persistedFieldIds?.length || 0,
      revisionFreshness: envelope.graphReadiness.revisionFreshness,
    },
    selection: envelope.selection,
    answer: {
      present: Boolean(answer.trim()),
      bytes: Buffer.byteLength(answer, 'utf8'),
      sha256: answer ? createHash('sha256').update(answer, 'utf8').digest('hex') : null,
      withheldFromStdout: true,
    },
    artifactProvenance: {
      status: envelope.artifacts.provenance.status,
      exactModelWhenExposed: envelope.artifacts.provenance.status === 'matched',
    },
    tables: envelope.artifacts.tables.map((table) => ({
      artifactId: table.artifactId,
      title: table.title,
      mimeType: table.mimeType,
      rowCount: table.rowCount,
      columnCount: table.columnCount,
      schemaPreservedPrivately: table.schema !== null,
      provenancePreservedPrivately: table.provenance !== null,
      rowsWithheldFromStdout: true,
    })),
    files: envelope.artifacts.files.map((file) => ({
      artifactId: file.artifactId,
      name: file.name,
      display: file.display,
      mimeType: file.mimeType,
      size: file.size,
      contentValidated: false,
    })),
    privacy: {
      rawTableRowsWithheld: true,
      generatedTextWithheld: true,
      generatedTextValidated: false,
    },
    stream: envelope.stream,
  };
  if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > MAX_STDOUT_BYTES) {
    throw new Error(`AIChat aggregate-safe stdout exceeds ${MAX_STDOUT_BYTES} bytes`);
  }
  return summary;
}
