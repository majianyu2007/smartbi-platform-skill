import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AICHAT_DATA_SKILL_ID,
  AICHAT_NO_TEMPLATE_REPORT_SKILL_ID,
  buildAichatRequest,
  createAichatEnvelope,
  parseAichatExportArgs,
  parseAichatRunArgs,
  selectAichatLlm,
  selectAichatSkills,
  summarizeAichatEnvelope,
} from '../scripts/aichat-query.mjs';

const MODEL = { id: 'model-1', name: 'TEAM_Model' };
const LLM = { id: 'llm-approved', name: 'Approved', type: 'LLM' };
const SKILL_ITEMS = [
  { id: AICHAT_DATA_SKILL_ID, alias: 'Data', type: 'BUILTIN' },
  { id: AICHAT_NO_TEMPLATE_REPORT_SKILL_ID, alias: 'Report', type: 'BUILTIN' },
  { id: 'SKILL_BUILTIN_TEMPLATE_REPORT', alias: 'Template', type: 'BUILTIN' },
];

function payloadFor(mode = 'query') {
  return buildAichatRequest({
    model: MODEL,
    question: '按城市汇总总量',
    mode,
    llm: LLM,
    skills: selectAichatSkills(SKILL_ITEMS, mode),
    conversationId: 'conversation-1',
    taskId: 'task-1',
    messageId: 'message-1',
  });
}

function parsedResult() {
  return {
    state: 'completed',
    transportCompleted: true,
    artifactPresent: true,
    generated: true,
    answer: '生成结果',
    texts: [],
    tables: [{
      artifactId: 'table-1',
      title: 'Aggregate',
      mimeType: 'json/table',
      rowCount: 1,
      columnCount: 2,
      schema: [{ name: 'city' }, { name: 'total' }],
      provenance: { datasetId: 'model-1' },
      rows: [{ city: '北京', total: 185 }],
    }],
    files: [],
    unsupportedArtifacts: [],
    provenance: { expectedModelId: 'model-1', status: 'matched', declaredModelIds: ['model-1'] },
    eventCount: 2,
    messageCount: 2,
    artifactCount: 1,
    taskCorrelation: { expectedTaskId: 'task-1', matchedEventCount: 2 },
    limits: { maxTableRows: 200 },
  };
}

const GRAPH_READY = {
  modelId: 'model-1',
  modelName: 'TEAM_Model',
  status: 'SUCCESS',
  persistedFieldIds: ['field-1'],
  updateTime: '2026-08-11T00:00:00Z',
  duration: 10,
  revisionFreshness: 'unknown',
  checked: {
    exactModelId: true,
    exactModelName: true,
    graphListing: true,
    terminalSuccess: true,
    persistedFieldIds: true,
  },
};

const MODEL_AUTHORIZATION = {
  exactModelId: true,
  namespaceOwned: true,
  readPermission: true,
  personalWorkspace: true,
  competitionPlacement: 'not-required',
};

test('payload binds exactly one model and disables cross-dataset and external context', () => {
  const payload = payloadFor('query');
  const message = payload.jsonRpcStreamReq.params.message;
  const flags = Object.assign({}, ...message.metadata.params);
  assert.deepEqual(message.metadata.datasets, [{
    id: 'model-1',
    type: 'AUGMENTED_DATASET',
    name: 'TEAM_Model',
  }]);
  assert.equal(flags.crossDatasetQuery, false);
  assert.equal(flags.use_personal_knowledge, false);
  assert.equal(flags.webSearch, false);
  assert.equal(flags.uploadFile, false);
  assert.deepEqual(flags.reports, []);
  assert.equal(flags.projectId, '');
  assert.equal(flags.project_desc, '');
  assert.equal(flags.LLMConfigId, 'llm-approved');
  assert.deepEqual(flags.skills.map((skill) => skill.id), [AICHAT_DATA_SKILL_ID]);
});

test('LLM selection requires an exact id or one unique default', () => {
  assert.deepEqual(
    selectAichatLlm([{ id: 'only-default', alias: 'Default', isDefault: true }]),
    { id: 'only-default', name: 'Default', type: null },
  );
  assert.equal(
    selectAichatLlm([{ id: 'explicit' }, { id: 'other', isDefault: true }], 'explicit').id,
    'explicit',
  );
  assert.throws(
    () => selectAichatLlm([{ id: 'first' }, { id: 'second' }]),
    /pass --llm-id/,
  );
  assert.throws(
    () => selectAichatLlm([
      { id: 'first', isDefault: true },
      { id: 'second', isDefault: true },
    ]),
    /multiple default/,
  );
  assert.throws(
    () => selectAichatLlm([{ id: 'duplicate' }, { id: 'duplicate' }], 'duplicate'),
    /ambiguous/,
  );
});

test('skill selection is exact, unique, and mode-specific', () => {
  assert.deepEqual(
    selectAichatSkills(SKILL_ITEMS, 'report').map((skill) => skill.id),
    [AICHAT_DATA_SKILL_ID, AICHAT_NO_TEMPLATE_REPORT_SKILL_ID],
  );
  assert.throws(
    () => selectAichatSkills([SKILL_ITEMS[0]], 'report'),
    /required AIChat skill is unavailable/,
  );
  assert.throws(
    () => selectAichatSkills([SKILL_ITEMS[0], SKILL_ITEMS[0]], 'query'),
    /ambiguous/,
  );
});

test('CLI parsing requires explicit export envelope mode and exact overwrite path', () => {
  assert.deepEqual(
    parseAichatRunArgs(['model-1', '--llm-id', 'llm-1', '--', '按城市', '汇总'], {
      command: 'aichat-query',
      mode: 'query',
    }),
    {
      modelId: 'model-1',
      mode: 'query',
      question: '按城市 汇总',
      llmId: 'llm-1',
    },
  );
  assert.throws(
    () => parseAichatExportArgs(['model-1', '/private/result.json', 'prompt']),
    /requires --mode query or --mode report/,
  );
  assert.throws(
    () => parseAichatExportArgs([
      'model-1',
      '/private/result.json',
      '--mode',
      'report',
      '--overwrite',
      'prompt',
    ]),
    /requires --confirm-path/,
  );
  assert.deepEqual(
    parseAichatExportArgs([
      'model-1',
      '/private/result.json',
      '--mode',
      'report',
      '--overwrite',
      '--confirm-path',
      '/private/result.json',
      '--',
      '生成',
      '报告',
    ]),
    {
      modelId: 'model-1',
      outputPath: '/private/result.json',
      mode: 'report',
      question: '生成 报告',
      llmId: null,
      overwrite: true,
      confirmPath: '/private/result.json',
    },
  );
});

test('envelope distinguishes generated output from validation and stdout withholds rows', () => {
  const envelope = createAichatEnvelope({
    parsed: parsedResult(),
    payload: payloadFor('query'),
    mode: 'query',
    model: MODEL,
    graphReadiness: GRAPH_READY,
    modelAuthorization: MODEL_AUTHORIZATION,
    llm: LLM,
    skills: selectAichatSkills(SKILL_ITEMS, 'query'),
    question: '按城市汇总总量',
    conversationId: 'conversation-1',
    taskId: 'task-1',
  });
  assert.equal(envelope.generation.generated, true);
  assert.equal(envelope.validation.validated, false);
  assert.equal(envelope.validation.reconciliation, 'not-performed');
  const stdout = summarizeAichatEnvelope(envelope);
  assert.equal(stdout.format, 'smartbi-aichat-stdout-summary/v1');
  assert.equal(stdout.envelopeFormat, envelope.format);
  assert.equal(stdout.tables[0].rowsWithheldFromStdout, true);
  assert.equal('rows' in stdout.tables[0], false);
  assert.equal(stdout.privacy.rawTableRowsWithheld, true);
  assert.equal(stdout.answer.withheldFromStdout, true);
  assert.equal(stdout.privacy.generatedTextWithheld, true);
});

test('envelope refuses failed graph readiness or unproven model authorization', () => {
  assert.throws(
    () => createAichatEnvelope({
      parsed: parsedResult(),
      payload: payloadFor('query'),
      mode: 'query',
      model: MODEL,
      graphReadiness: { ...GRAPH_READY, status: 'FAILED' },
      modelAuthorization: MODEL_AUTHORIZATION,
      llm: LLM,
      skills: selectAichatSkills(SKILL_ITEMS, 'query'),
      question: '按城市汇总总量',
      conversationId: 'conversation-1',
      taskId: 'task-1',
    }),
    /readiness receipt does not match/,
  );
  assert.throws(
    () => createAichatEnvelope({
      parsed: parsedResult(),
      payload: payloadFor('query'),
      mode: 'query',
      model: MODEL,
      graphReadiness: GRAPH_READY,
      modelAuthorization: { ...MODEL_AUTHORIZATION, personalWorkspace: false },
      llm: LLM,
      skills: selectAichatSkills(SKILL_ITEMS, 'query'),
      question: '按城市汇总总量',
      conversationId: 'conversation-1',
      taskId: 'task-1',
    }),
    /ownership\/read authorization was not proven/,
  );
});
