const SUPPORTED_AGENT_CONTRACT = 'start-llm-finish-v1';
const AGENT_METADATA_LIMIT = 256;

const SECRET_KEY_NAMES = new Set([
  'apikey',
  'authorization',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'token',
  'accesstoken',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function hasValue(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.some(hasValue);
  if (isPlainObject(value)) return Object.values(value).some(hasValue);
  return true;
}

function containsCredentialLikeText(value) {
  const text = String(value || '');
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(text)
    || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(text)
    || /\bAKIA[0-9A-Z]{16}\b/.test(text);
}

function maybeStructuredString(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || !['{', '['].includes(trimmed[0])) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function assertNoSecretBearingValue(value, seen = new Set()) {
  if (typeof value === 'string') {
    if (containsCredentialLikeText(value)) {
      throw new Error('Agent graph contains secret-bearing configuration');
    }
    const structured = maybeStructuredString(value);
    if (structured !== null) assertNoSecretBearingValue(structured, seen);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('Agent graph contains a cyclic configuration payload');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const keyKind = normalizedKey(key);
    if (SECRET_KEY_NAMES.has(keyKind) && hasValue(child)) {
      throw new Error('Agent graph contains secret-bearing configuration');
    }
    if ((keyKind.includes('provider') || keyKind.includes('mcp')) && hasValue(child)) {
      throw new Error('Agent graph contains an unsupported provider or MCP payload');
    }
    assertNoSecretBearingValue(child, seen);
  }
  seen.delete(value);
}

function parseStructured(value, label, { allowMissing = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (allowMissing) return null;
    throw new Error(`${label} is unavailable`);
  }
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sameJson(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameJson(item, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => (
        key === rightKeys[index] && sameJson(left[key], right[key])
      ));
  }
  return false;
}

function assertExactJson(actual, expected, label) {
  if (!sameJson(actual, expected)) {
    throw new Error(`unsupported Agent ${label} configuration`);
  }
}

function nodeConfigMap(node) {
  if (!Array.isArray(node.configs)) {
    throw new Error(`Agent ${node.type} node has no configuration catalog`);
  }
  const result = new Map();
  for (const config of node.configs) {
    const name = String(config?.name || '').trim();
    if (!name) throw new Error(`Agent ${node.type} node contains an unnamed configuration`);
    if (result.has(name)) {
      throw new Error(`Agent ${node.type} node contains duplicate configuration ${name}`);
    }
    const configKind = normalizedKey(name);
    if (
      configKind !== 'mcpsetting'
      && configKind !== 'llmconfigselect'
      && (configKind.includes('mcp') || configKind.includes('provider'))
      && hasValue(config?.value)
    ) {
      throw new Error('Agent graph contains an unsupported provider or MCP payload');
    }
    if (SECRET_KEY_NAMES.has(configKind) && hasValue(config?.value)) {
      throw new Error('Agent graph contains secret-bearing configuration');
    }
    result.set(name, config?.value);
  }
  return result;
}

function requireJsonConfig(configs, name, label) {
  if (!configs.has(name)) throw new Error(`Agent ${label} configuration is unavailable`);
  return parseStructured(configs.get(name), `Agent ${label} configuration`);
}

function requireTextConfig(configs, name, label) {
  if (!configs.has(name) || typeof configs.get(name) !== 'string') {
    throw new Error(`Agent ${label} configuration is unavailable`);
  }
  const value = configs.get(name);
  if (!value.trim()) throw new Error(`Agent ${label} configuration is empty`);
  return value;
}

function requireSinglePort(node, side) {
  const ports = node[side];
  if (!Array.isArray(ports) || ports.length !== 1) {
    throw new Error(`Agent ${node.type} node requires exactly one ${side} port`);
  }
  const [port] = ports;
  if (!port || !String(port.id || '').trim() || !String(port.label || '').trim()) {
    throw new Error(`Agent ${node.type} ${side} port is incomplete`);
  }
  return port;
}

function requireNoPorts(node, side) {
  const ports = node[side];
  if (ports !== undefined && (!Array.isArray(ports) || ports.length !== 0)) {
    throw new Error(`Agent ${node.type} node has unsupported ${side} ports`);
  }
}

function assertLink(link, source, sourcePort, target, targetPort) {
  if (
    link?.from !== source.id
    || link?.to !== target.id
    || link?.inputPortId !== sourcePort.id
    || link?.outputPortId !== targetPort.id
    || link?.inputPortName !== sourcePort.label
    || link?.outputPortName !== targetPort.label
  ) {
    throw new Error(`Agent link ${source.type} to ${target.type} does not match its exact ports`);
  }
}

function clipMetadata(value) {
  const text = String(value || '');
  if (text.length <= AGENT_METADATA_LIMIT) return text;
  let clipped = text.slice(0, AGENT_METADATA_LIMIT);
  const finalCodeUnit = clipped.charCodeAt(clipped.length - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) clipped = clipped.slice(0, -1);
  return clipped;
}

export function agentRootIdForSelf(selfRootId) {
  const match = /^SELF_([^/\\\s]+)$/.exec(String(selfRootId || ''));
  if (!match) throw new Error('authenticated personal workspace id is unsupported');
  return `SELF_AGENT_GRAPHS_${match[1]}`;
}

export function findDirectOwnedAgentChild(agentId, directChildren) {
  const id = String(agentId || '').trim();
  if (!id) throw new Error('agent id is required');
  if (!Array.isArray(directChildren)) {
    throw new Error('authenticated Agent root listing is unavailable');
  }
  const matches = directChildren.filter((resource) => resource?.id === id);
  if (matches.length === 0) {
    throw new Error(`Agent is not a direct child of the authenticated Agent root: ${id}`);
  }
  if (matches.length !== 1) {
    throw new Error(`Agent ownership is ambiguous in the authenticated Agent root: ${id}`);
  }
  const [resource] = matches;
  if (!String(resource.name || '').trim() || !String(resource.alias || '').trim()) {
    throw new Error(`Agent ownership metadata is incomplete: ${id}`);
  }
  return resource;
}

export function assertOwnedAgentGraphIdentity(agent, catalogResource, agentRootId) {
  if (!agent?.id || !catalogResource?.id || agent.id !== catalogResource.id) {
    throw new Error('Agent graph identity does not match its owned catalog resource');
  }
  if (
    !String(agent.name || '').trim()
    || !String(agent.alias || '').trim()
    || agent.name !== catalogResource.name
    || agent.alias !== catalogResource.alias
  ) {
    throw new Error('Agent graph name does not match its owned catalog resource');
  }
  for (const resource of [agent, catalogResource]) {
    if (
      Object.hasOwn(resource, 'parentId')
      && resource.parentId !== null
      && resource.parentId !== undefined
      && resource.parentId !== agentRootId
    ) {
      throw new Error('Agent graph reports a foreign parent location');
    }
  }
  return catalogResource;
}

export function assertExactAgentNameConfirmation(agent, confirmation) {
  const exact = String(confirmation || '');
  if (!exact || (exact !== agent?.name && exact !== agent?.alias)) {
    throw new Error('Agent exact-name confirmation does not match the current saved name');
  }
}

export function assertSupportedAgentGraph(rawGraph, expectedPrompts = null) {
  const graph = parseStructured(rawGraph, 'Agent graph definition');
  if (!isPlainObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
    throw new Error('Agent graph definition is incomplete');
  }
  assertNoSecretBearingValue(graph);
  if (graph.nodes.length !== 3) {
    throw new Error('unsupported Agent graph: expected exactly StartNode, LLM, and FinishNode');
  }
  const expectedTypes = ['StartNode', 'LLM', 'FinishNode'];
  const nodesByType = new Map();
  const nodeIds = new Set();
  for (const node of graph.nodes) {
    if (!expectedTypes.includes(node?.type) || node.name !== node.type) {
      throw new Error(`unsupported Agent node type: ${String(node?.type || node?.name || 'UNKNOWN')}`);
    }
    if (nodesByType.has(node.type)) throw new Error(`duplicate Agent node type: ${node.type}`);
    if (!String(node.id || '').trim() || nodeIds.has(node.id)) {
      throw new Error('Agent node ids must be non-empty and unique');
    }
    nodeIds.add(node.id);
    nodesByType.set(node.type, node);
  }
  if (nodesByType.size !== expectedTypes.length) {
    throw new Error('unsupported Agent graph node set');
  }

  const start = nodesByType.get('StartNode');
  const llm = nodesByType.get('LLM');
  const finish = nodesByType.get('FinishNode');
  requireNoPorts(start, 'inputs');
  const startOutput = requireSinglePort(start, 'outputs');
  const llmInput = requireSinglePort(llm, 'inputs');
  const llmOutput = requireSinglePort(llm, 'outputs');
  const finishInput = requireSinglePort(finish, 'inputs');
  requireNoPorts(finish, 'outputs');
  const portIds = [startOutput.id, llmInput.id, llmOutput.id, finishInput.id];
  if (new Set(portIds).size !== portIds.length) throw new Error('Agent port ids must be unique');

  if (graph.links.length !== 2) {
    throw new Error('unsupported Agent graph: expected exactly two links');
  }
  const startLink = graph.links.find((link) => link?.from === start.id && link?.to === llm.id);
  const finishLink = graph.links.find((link) => link?.from === llm.id && link?.to === finish.id);
  if (!startLink || !finishLink || startLink === finishLink) {
    throw new Error('unsupported Agent graph branch or link direction');
  }
  assertLink(startLink, start, startOutput, llm, llmInput);
  assertLink(finishLink, llm, llmOutput, finish, finishInput);

  if (!String(startOutput.varOptions?.label || '').trim()) {
    throw new Error('unsupported Agent Start output variable');
  }
  assertExactJson(startOutput.varOptions, {
    label: startOutput.varOptions?.label,
    value: startOutput.id,
    children: [{ label: '用户分析问题', type: 'String', value: 'question' }],
  }, 'Start output variable');
  if (
    llmOutput.varOptions?.value !== llmOutput.id
    || !String(llmOutput.varOptions?.label || '').trim()
  ) {
    throw new Error('unsupported Agent LLM output variable');
  }

  const startConfigs = nodeConfigMap(start);
  const llmConfigs = nodeConfigMap(llm);
  const finishConfigs = nodeConfigMap(finish);
  assertExactJson(requireJsonConfig(startConfigs, 'param', 'Start parameters'), [{
    selectLeftOption: 'question',
    selectRightOption: 'String',
    descOption: '用户分析问题',
  }], 'Start parameters');
  assertExactJson(requireJsonConfig(llmConfigs, 'llmConfigSelect', 'LLM model'), {
    id: 'default',
    value: 'default',
    type: 'default',
  }, 'LLM model');
  assertExactJson(requireJsonConfig(llmConfigs, 'varSetting', 'LLM variable binding'), [{
    selectLeftOption: 'question',
    selectRightOption: ['sessionVar', 'query'],
  }], 'LLM variable binding');
  assertExactJson(requireJsonConfig(llmConfigs, 'mcpSetting', 'LLM MCP'), [{ selectValue: null }], 'LLM MCP');
  assertExactJson(requireJsonConfig(llmConfigs, 'outputType', 'LLM output type'), ['summary'], 'LLM output type');
  const systemPrompt = requireTextConfig(llmConfigs, 'systemPrompt', 'LLM system prompt');
  const userPrompt = requireTextConfig(llmConfigs, 'userPrompt', 'LLM user prompt');
  if (!userPrompt.includes('{{question}}')) {
    throw new Error('Agent LLM user prompt does not reference the bound question');
  }
  if (expectedPrompts) {
    if (systemPrompt !== expectedPrompts.systemPrompt || userPrompt !== expectedPrompts.userPrompt) {
      throw new Error('saved Agent prompts do not match the requested graph');
    }
  }
  assertExactJson(requireJsonConfig(finishConfigs, 'outputMode', 'Finish output mode'), ['any'], 'Finish output mode');
  assertExactJson(requireJsonConfig(finishConfigs, 'finishSetting', 'Finish mapping'), [{
    selectLeftOption: 'update_attachment_markdown',
    selectRightOption: [llmOutput.id, 'result_content'],
  }], 'Finish mapping');

  return {
    contract: SUPPORTED_AGENT_CONTRACT,
    nodeIds: { start: start.id, llm: llm.id, finish: finish.id },
    portIds: {
      startOutput: startOutput.id,
      llmInput: llmInput.id,
      llmOutput: llmOutput.id,
      finishInput: finishInput.id,
    },
    prompts: { systemPrompt, userPrompt },
    finish: { sourceNodeId: llm.id, sourcePortId: llmOutput.id, field: 'result_content' },
  };
}

export function validateSupportedAgentResource(rawAgent, expectedPrompts = null) {
  if (!rawAgent?.id || !String(rawAgent.name || '').trim() || !String(rawAgent.alias || '').trim()) {
    throw new Error('Agent resource identity is incomplete');
  }
  const agent = {
    ...rawAgent,
    define: parseStructured(rawAgent.define, 'Agent graph definition'),
    params: parseStructured(rawAgent.params, 'Agent parameters'),
    setting: parseStructured(rawAgent.setting, 'Agent settings', { allowMissing: true }),
  };
  assertNoSecretBearingValue({ define: agent.define, params: agent.params, setting: agent.setting });
  assertExactJson(agent.params, { sysParam: [], customParam: [] }, 'parameter');
  if (hasValue(agent.setting)) throw new Error('unsupported Agent settings payload');
  return { agent, contract: assertSupportedAgentGraph(agent.define, expectedPrompts) };
}

export function assertSameAgentGraphContract(actual, expected) {
  if (!sameJson(actual, expected)) {
    throw new Error('saved Agent graph does not match the submitted supported contract');
  }
}

export function assertAgentDeploymentRelations(rawRelations, agentId, { required = false } = {}) {
  if (!Array.isArray(rawRelations)) {
    throw new Error('Agent deployment relation response has an unsupported shape');
  }
  if (rawRelations.length > 1) {
    throw new Error(`multiple deployment relations exist for Agent ${agentId}`);
  }
  if (rawRelations.length === 0) {
    if (required) throw new Error(`Agent deployment relation was not persisted: ${agentId}`);
    return null;
  }
  const [relation] = rawRelations;
  if (!isPlainObject(relation) || !String(relation.id || '').trim() || relation.agentId !== agentId) {
    throw new Error('Agent deployment relation ownership is missing or ambiguous');
  }
  return relation;
}

export function summarizeAgentDeploymentRelation(relation) {
  if (!relation) return null;
  return {
    id: clipMetadata(relation.id),
    agentId: clipMetadata(relation.agentId),
  };
}

export function summarizeAgentResource(agent, contract) {
  return {
    id: clipMetadata(agent.id),
    name: clipMetadata(agent.name),
    alias: clipMetadata(agent.alias),
    graph: {
      contract: contract.contract,
      nodeCount: 3,
      linkCount: 2,
      nodes: [
        { id: clipMetadata(contract.nodeIds.start), type: 'StartNode' },
        { id: clipMetadata(contract.nodeIds.llm), type: 'LLM' },
        { id: clipMetadata(contract.nodeIds.finish), type: 'FinishNode' },
      ],
      links: [
        { from: clipMetadata(contract.nodeIds.start), to: clipMetadata(contract.nodeIds.llm) },
        { from: clipMetadata(contract.nodeIds.llm), to: clipMetadata(contract.nodeIds.finish) },
      ],
      llm: {
        configuration: 'default',
        mcp: false,
        prompts: '[REDACTED]',
        configValues: '[REDACTED]',
      },
      finish: {
        format: 'markdown',
        sourceNodeId: clipMetadata(contract.finish.sourceNodeId),
        sourceField: contract.finish.field,
      },
    },
  };
}
