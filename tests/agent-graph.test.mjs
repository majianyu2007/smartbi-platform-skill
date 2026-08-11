import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agentRootIdForSelf,
  assertAgentDeploymentRelations,
  assertExactAgentNameConfirmation,
  assertOwnedAgentGraphIdentity,
  assertSameAgentGraphContract,
  assertSupportedAgentGraph,
  findDirectOwnedAgentChild,
  summarizeAgentDeploymentRelation,
  summarizeAgentResource,
  validateSupportedAgentResource,
} from '../scripts/agent-graph.mjs';

function config(name, value) {
  return { name, value: typeof value === 'string' ? value : JSON.stringify(value) };
}

function validGraph({ systemPrompt = 'Internal analysis instructions.', userPrompt = 'Question: {{question}}' } = {}) {
  return {
    nodes: [
      {
        id: 'start',
        name: 'StartNode',
        type: 'StartNode',
        inputs: [],
        outputs: [{
          id: 'start-output',
          label: 'Start output',
          varOptions: {
            label: 'Start-output-1',
            value: 'start-output',
            children: [{ label: '用户分析问题', type: 'String', value: 'question' }],
          },
        }],
        configs: [config('param', [{
          selectLeftOption: 'question',
          selectRightOption: 'String',
          descOption: '用户分析问题',
        }])],
      },
      {
        id: 'llm',
        name: 'LLM',
        type: 'LLM',
        inputs: [{ id: 'llm-input', label: 'LLM input' }],
        outputs: [{
          id: 'llm-output',
          label: 'LLM output',
          varOptions: { label: 'LLM-output-1', value: 'llm-output' },
        }],
        configs: [
          config('llmConfigSelect', { id: 'default', value: 'default', type: 'default' }),
          config('varSetting', [{
            selectLeftOption: 'question',
            selectRightOption: ['sessionVar', 'query'],
          }]),
          config('mcpSetting', [{ selectValue: null }]),
          config('systemPrompt', systemPrompt),
          config('userPrompt', userPrompt),
          config('outputType', ['summary']),
        ],
      },
      {
        id: 'finish',
        name: 'FinishNode',
        type: 'FinishNode',
        inputs: [{ id: 'finish-input', label: 'Finish input' }],
        outputs: [],
        configs: [
          config('outputMode', ['any']),
          config('finishSetting', [{
            selectLeftOption: 'update_attachment_markdown',
            selectRightOption: ['llm-output', 'result_content'],
          }]),
        ],
      },
    ],
    links: [
      {
        from: 'start',
        to: 'llm',
        inputPortId: 'start-output',
        outputPortId: 'llm-input',
        inputPortName: 'Start output',
        outputPortName: 'LLM input',
      },
      {
        from: 'llm',
        to: 'finish',
        inputPortId: 'llm-output',
        outputPortId: 'finish-input',
        inputPortName: 'LLM output',
        outputPortName: 'Finish input',
      },
    ],
    top: 0,
    left: 0,
  };
}

function validAgent(overrides = {}) {
  return {
    id: 'agent-1',
    name: 'TEAM_agent',
    alias: 'TEAM_agent',
    define: JSON.stringify(validGraph()),
    params: JSON.stringify({ sysParam: [], customParam: [] }),
    setting: JSON.stringify({}),
    ...overrides,
  };
}

test('supported Agent graph is exactly Start to LLM to Finish with exact ports and configs', () => {
  const graph = validGraph();
  const contract = assertSupportedAgentGraph(graph, {
    systemPrompt: 'Internal analysis instructions.',
    userPrompt: 'Question: {{question}}',
  });
  assert.deepEqual(contract.nodeIds, { start: 'start', llm: 'llm', finish: 'finish' });
  assert.deepEqual(contract.finish, {
    sourceNodeId: 'llm',
    sourcePortId: 'llm-output',
    field: 'result_content',
  });
  assert.doesNotThrow(() => assertSameAgentGraphContract(contract, structuredClone(contract)));
});

test('Agent graph rejects duplicate ids, branches, wrong ports, and unavailable LLM config', () => {
  const duplicateIds = validGraph();
  duplicateIds.nodes[1].id = 'start';
  assert.throws(() => assertSupportedAgentGraph(duplicateIds), /node ids must be non-empty and unique/);

  const branch = validGraph();
  branch.links.push({ ...branch.links[1] });
  assert.throws(() => assertSupportedAgentGraph(branch), /exactly two links/);

  const wrongPort = validGraph();
  wrongPort.links[0].outputPortId = 'foreign-input';
  assert.throws(() => assertSupportedAgentGraph(wrongPort), /does not match its exact ports/);

  const missingModel = validGraph();
  missingModel.nodes[1].configs = missingModel.nodes[1].configs
    .filter((item) => item.name !== 'llmConfigSelect');
  assert.throws(() => assertSupportedAgentGraph(missingModel), /LLM model configuration is unavailable/);
});

test('Agent graph rejects custom providers, MCP payloads, secrets, and unsupported envelopes', () => {
  const customProvider = validGraph();
  customProvider.nodes[1].configs.push(config('providerConfig', { apiKey: 'hidden-value' }));
  assert.throws(() => assertSupportedAgentGraph(customProvider), /secret-bearing configuration/);

  const hiddenProvider = validGraph();
  hiddenProvider.nodes[1].providerPayload = { endpoint: 'https://provider.example.test' };
  assert.throws(
    () => assertSupportedAgentGraph(hiddenProvider),
    /unsupported provider or MCP payload/,
  );

  const mcpPayload = validGraph();
  mcpPayload.nodes[1].configs.find((item) => item.name === 'mcpSetting').value = JSON.stringify([{
    selectValue: { server: 'https://mcp.example.test' },
  }]);
  assert.throws(() => assertSupportedAgentGraph(mcpPayload), /LLM MCP configuration/);

  const customModel = validGraph();
  customModel.nodes[1].configs.find((item) => item.name === 'llmConfigSelect').value = JSON.stringify({
    id: 'third-party',
    value: 'third-party',
    type: 'provider',
  });
  assert.throws(() => assertSupportedAgentGraph(customModel), /LLM model configuration/);

  const secretParams = validAgent({
    params: JSON.stringify({ sysParam: [], customParam: [], apiKey: 'hidden-value' }),
  });
  assert.throws(() => validateSupportedAgentResource(secretParams), /secret-bearing configuration/);
});

test('Agent ownership requires one exact direct child and matching live graph identity', () => {
  assert.equal(agentRootIdForSelf('SELF_authenticated-user'), 'SELF_AGENT_GRAPHS_authenticated-user');
  assert.throws(() => agentRootIdForSelf('foreign-root'), /workspace id is unsupported/);

  const child = {
    id: 'agent-1',
    name: 'TEAM_agent',
    alias: 'TEAM_agent',
    type: 'AGENT_GRAPH',
    parentId: 'SELF_AGENT_GRAPHS_authenticated-user',
  };
  assert.equal(findDirectOwnedAgentChild('agent-1', [child]), child);
  assert.throws(
    () => findDirectOwnedAgentChild('agent-1', []),
    /not a direct child of the authenticated Agent root/,
  );
  assert.throws(
    () => findDirectOwnedAgentChild('agent-1', [child, { ...child }]),
    /ownership is ambiguous/,
  );
  assert.equal(
    assertOwnedAgentGraphIdentity(validAgent({ parentId: child.parentId }), child, child.parentId),
    child,
  );
  assert.throws(
    () => assertOwnedAgentGraphIdentity(
      validAgent({ alias: 'TEAM_foreign', parentId: child.parentId }),
      child,
      child.parentId,
    ),
    /name does not match/,
  );
  assert.throws(
    () => assertOwnedAgentGraphIdentity(
      validAgent({ parentId: 'SELF_AGENT_GRAPHS_foreign-user' }),
      child,
      child.parentId,
    ),
    /foreign parent location/,
  );
});

test('Agent run and deploy confirmation is exact and case-sensitive', () => {
  const agent = validAgent();
  assert.doesNotThrow(() => assertExactAgentNameConfirmation(agent, 'TEAM_agent'));
  assert.throws(
    () => assertExactAgentNameConfirmation(agent, 'team_agent'),
    /exact-name confirmation does not match/,
  );
  assert.throws(
    () => assertExactAgentNameConfirmation(agent, ''),
    /exact-name confirmation does not match/,
  );
});

test('Agent deployment relation is exact, unique, and fails closed on ambiguous ownership', () => {
  assert.equal(assertAgentDeploymentRelations([], 'agent-1'), null);
  const relation = { id: 'relation-1', agentId: 'agent-1', rawSettings: 'not-returned' };
  assert.equal(assertAgentDeploymentRelations([relation], 'agent-1'), relation);
  assert.deepEqual(summarizeAgentDeploymentRelation(relation), {
    id: 'relation-1',
    agentId: 'agent-1',
  });
  assert.doesNotMatch(JSON.stringify(summarizeAgentDeploymentRelation(relation)), /not-returned|rawSettings/);
  assert.throws(
    () => assertAgentDeploymentRelations([relation, { ...relation, id: 'relation-2' }], 'agent-1'),
    /multiple deployment relations/,
  );
  assert.throws(
    () => assertAgentDeploymentRelations([{ id: 'relation-1' }], 'agent-1'),
    /ownership is missing or ambiguous/,
  );
  assert.throws(
    () => assertAgentDeploymentRelations([{ id: 'relation-1', agentId: 'foreign' }], 'agent-1'),
    /ownership is missing or ambiguous/,
  );
  assert.throws(
    () => assertAgentDeploymentRelations([], 'agent-1', { required: true }),
    /was not persisted/,
  );
});

test('Agent graph receipts redact prompts, configs, settings, and cap metadata', () => {
  const longName = `TEAM_${'n'.repeat(400)}`;
  const { agent, contract } = validateSupportedAgentResource(validAgent({
    name: longName,
    alias: longName,
    desc: 'private description',
  }));
  const receipt = summarizeAgentResource(agent, contract);
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.name.length, 256);
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(
    serialized,
    /Internal analysis instructions|Question:|private description|sysParam|customParam|define|setting/,
  );
});
