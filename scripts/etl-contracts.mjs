const SENSITIVE_CONTRACT_KEY = /(?:password|passwd|secret|credential|cookie|authorization|access[_-]?token|refresh[_-]?token)/i;
const SENSITIVE_CONTRACT_TEXT = /(?:password|passwd|secret|credential|cookie|authorization|access[_-]?token|refresh[_-]?token)\s*[:=]|:\/\/[^/\s:@]+:[^@\s/]+@/i;

const CAPABILITIES = {
  JDBC_DATASOURCE: {
    effect: 'table-source',
    inputs: 0,
    outputs: 1,
    operations: ['create', 'execute'],
    material: false,
  },
  DATAPREPARE_ROW_NUMBER: {
    effect: 'unary-transform',
    inputs: 1,
    outputs: 1,
    operations: ['create', 'insert', 'execute'],
    material: false,
  },
  DATAPREPARE_FILTERING_MAPPING_V3: {
    effect: 'unary-transform',
    inputs: 1,
    outputs: 1,
    operations: ['insert', 'execute'],
    material: true,
  },
  DATAPREPARE_SAMPLE: {
    effect: 'unary-transform',
    inputs: 1,
    outputs: 1,
    operations: ['insert', 'execute'],
    material: true,
  },
  UNION_ALL: {
    effect: 'union-transform',
    minInputs: 2,
    outputs: 1,
    operations: ['create', 'execute'],
    material: true,
  },
  JDBC_DATATARGER_OVERWRITE: {
    effect: 'overwrite-target',
    inputs: 1,
    outputs: 0,
    operations: ['create', 'execute'],
    material: true,
  },
  SMARTBI_DATASET_OUTPUT: {
    effect: 'dataset-output',
    inputs: 1,
    outputs: 0,
    operations: ['configure'],
    material: true,
  },
};

export const ETL_NODE_CAPABILITIES = Object.freeze(Object.fromEntries(
  Object.entries(CAPABILITIES).map(([name, capability]) => [name, Object.freeze({
    ...capability,
    operations: Object.freeze([...capability.operations]),
  })]),
));

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text;
}

function normalizedNodeName(node) {
  return requiredText(node?.name || node?.type, 'ETL node technical name');
}

function normalizeTypes(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must declare at least one compatible type`);
  }
  const types = value.map((item, index) => requiredText(item, `${label} type ${index}`).toUpperCase());
  if (new Set(types).size !== types.length) throw new Error(`${label} declares duplicate compatible types`);
  return types;
}

function normalizePorts(ports, label, { requireIds = false } = {}) {
  if (ports == null) return [];
  if (!Array.isArray(ports)) throw new Error(`${label} must be an array`);
  const normalized = ports.map((port, index) => {
    record(port, `${label}[${index}]`);
    let order = Number(port.order);
    if (!Number.isInteger(order) || order < 0) {
      if (ports.length !== 1) throw new Error(`${label}[${index}] has no declared non-negative order`);
      order = 0;
    }
    const id = port.id == null ? null : requiredText(port.id, `${label}[${index}] id`);
    if (requireIds && !id) throw new Error(`${label}[${index}] has no persisted id`);
    return {
      ...port,
      ...(id ? { id } : {}),
      order,
      types: normalizeTypes(port.types, `${label}[${index}]`),
    };
  });
  const orders = normalized.map((port) => port.order);
  if (new Set(orders).size !== orders.length) throw new Error(`${label} declares duplicate port orders`);
  const ids = normalized.map((port) => port.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} declares duplicate port ids`);
  return normalized.sort((left, right) => left.order - right.order);
}

function normalizeConfigs(configs, label) {
  if (configs == null) return [];
  if (!Array.isArray(configs)) throw new Error(`${label} must be an array`);
  const names = new Set();
  return configs.map((config, index) => {
    record(config, `${label}[${index}]`);
    const name = requiredText(config.name, `${label}[${index}] name`);
    if (names.has(name)) throw new Error(`${label} declares duplicate config ${name}`);
    names.add(name);
    return { ...config, name };
  });
}

export function getEtlNodeCapability(nodeOrName) {
  const name = typeof nodeOrName === 'string' ? nodeOrName : normalizedNodeName(nodeOrName);
  return ETL_NODE_CAPABILITIES[name] || null;
}

export function normalizeEtlNodeTemplate(template, { requirePortIds = false } = {}) {
  record(template, 'ETL node template');
  const name = normalizedNodeName(template);
  const combineConfigs = template.combineConfigs ?? [];
  if (!Array.isArray(combineConfigs)) throw new Error(`ETL node ${name} combineConfigs must be an array`);
  return {
    ...template,
    name,
    type: template.type || name,
    inputs: normalizePorts(template.inputs, `ETL node ${name} inputs`, { requireIds: requirePortIds }),
    outputs: normalizePorts(template.outputs, `ETL node ${name} outputs`, { requireIds: requirePortIds }),
    configs: normalizeConfigs(template.configs, `ETL node ${name} configs`),
    combineConfigs: structuredClone(combineConfigs),
  };
}

export function normalizeEtlNodeCatalog(catalog) {
  record(catalog, 'ETL node catalog');
  if (!Array.isArray(catalog.defaultOptions) || catalog.defaultOptions.length === 0) {
    throw new Error('ETL node catalog has no non-empty defaultOptions array');
  }
  const names = new Set();
  const defaultOptions = catalog.defaultOptions.map((template) => {
    const normalized = normalizeEtlNodeTemplate(template);
    const key = normalized.name.toUpperCase();
    if (names.has(key)) {
      throw new Error(`ETL node catalog declares duplicate template ${normalized.name}`);
    }
    names.add(key);
    return normalized;
  });
  return { ...catalog, defaultOptions };
}

function safeContractClone(value, key = '') {
  if (SENSITIVE_CONTRACT_KEY.test(key)) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return JSON.stringify(safeContractClone(parsed));
      } catch {
        // Non-JSON strings remain part of the declared config contract.
      }
    }
    return SENSITIVE_CONTRACT_TEXT.test(value) ? '[redacted]' : value;
  }
  if (value == null || ['number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => safeContractClone(item)).filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return String(value);
  return Object.fromEntries(Object.entries(value).flatMap(([childKey, childValue]) => {
    const safe = safeContractClone(childValue, childKey);

    return safe === undefined ? [] : [[childKey, safe]];
  }));
}
export function sanitizeEtlContractValue(value) {
  return safeContractClone(value);
}

function describeConfigContract(config) {
  const safe = safeContractClone(config);
  if (SENSITIVE_CONTRACT_KEY.test(config.name)) {
    delete safe.value;
    delete safe.defaultValue;
  }
  return safe;
}

export function describeEtlNodeTemplate(template) {
  const normalized = normalizeEtlNodeTemplate(template);
  const capability = getEtlNodeCapability(normalized);
  return {
    name: normalized.name,
    type: normalized.type,
    alias: normalized.alias ?? null,
    desc: normalized.desc ?? null,
    capability: capability ? safeContractClone(capability) : { effect: 'unsupported' },
    inputCount: normalized.inputs.length,
    outputCount: normalized.outputs.length,
    inputs: normalized.inputs.map((port) => safeContractClone(port)),
    outputs: normalized.outputs.map((port) => safeContractClone(port)),
    configs: normalized.configs.map(describeConfigContract),
    combineConfigs: safeContractClone(normalized.combineConfigs),
  };
}

export function assertVerifiedEtlTemplate(template, operation) {
  const normalized = normalizeEtlNodeTemplate(template);
  const capability = getEtlNodeCapability(normalized);
  if (!capability || !capability.operations.includes(operation)) {
    throw new Error(`ETL node effect is not verified for ${operation}: ${normalized.name}`);
  }
  const inputCount = normalized.inputs.length;
  if (Number.isInteger(capability.inputs) && inputCount !== capability.inputs) {
    throw new Error(`ETL node ${normalized.name} input contract drifted: expected ${capability.inputs}, found ${inputCount}`);
  }
  if (Number.isInteger(capability.minInputs) && inputCount < capability.minInputs) {
    throw new Error(`ETL node ${normalized.name} has fewer than ${capability.minInputs} declared inputs`);
  }
  if (Number.isInteger(capability.maxInputs) && inputCount > capability.maxInputs) {
    throw new Error(`ETL node ${normalized.name} has more than ${capability.maxInputs} declared inputs`);
  }
  if (Number.isInteger(capability.outputs) && normalized.outputs.length !== capability.outputs) {
    throw new Error(
      `ETL node ${normalized.name} output contract drifted: expected ${capability.outputs}, found ${normalized.outputs.length}`,
    );
  }
  return normalized;
}

function compatibleTypes(left, right) {
  const rightTypes = new Set(right.types);
  return left.types.some((type) => rightTypes.has(type));
}

export function selectCompatibleEtlPorts(leftNode, rightNode, { rightPortIndex = null } = {}) {
  const left = normalizeEtlNodeTemplate(leftNode, { requirePortIds: true });
  const right = normalizeEtlNodeTemplate(rightNode, { requirePortIds: true });
  const rightPorts = rightPortIndex == null
    ? right.inputs
    : [right.inputs[rightPortIndex]].filter(Boolean);
  for (const input of rightPorts) {
    const output = left.outputs.find((candidate) => compatibleTypes(candidate, input));
    if (output) return { output, input };
  }
  throw new Error(`no compatible declared ETL ports for ${left.name} -> ${right.name}`);
}

export function createEtlLink(leftNode, rightNode, options = {}) {
  const { output, input } = selectCompatibleEtlPorts(leftNode, rightNode, options);
  return {
    ...(options.metadata || {}),
    from: leftNode.id,
    to: rightNode.id,
    inputPortId: output.id,
    outputPortId: input.id,
  };
}

function optionValues(options, label) {
  if (options == null) return null;
  if (!Array.isArray(options)) throw new Error(`${label} options use an unsupported contract`);
  const values = [];
  for (const [index, option] of options.entries()) {
    if (['string', 'number', 'boolean'].includes(typeof option)) {
      values.push(option);
      continue;
    }
    record(option, `${label} option ${index}`);
    const keys = ['value', 'id', 'key', 'name'].filter((key) => option[key] != null);
    if (keys.length === 0) throw new Error(`${label} option ${index} has no verified value field`);
    values.push(option[keys[0]]);
  }
  return values;
}

function comparableValue(value) {
  if (value != null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parsedJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function blankConfigValue(value) {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function validateConfigValue(config, value, label) {
  if (blankConfigValue(value)) {
    if (config.required === true || String(config.required).toLowerCase() === 'true') {
      throw new Error(`${label} is required`);
    }
    return value;
  }
  const allowed = optionValues(config.options, label);
  if (allowed && !allowed.some((candidate) => comparableValue(candidate) === comparableValue(value))) {
    throw new Error(`${label} is not one of the declared options`);
  }
  const type = String(config.type || '').trim().toLowerCase();
  const parsed = parsedJson(value);
  if (/^(?:string|text|textarea|sql|expression|column|field)$/.test(type)) {
    if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  } else if (/^(?:number|numeric|decimal|float|double)$/.test(type)) {
    if (!Number.isFinite(Number(value))) throw new Error(`${label} must be numeric`);
  } else if (/^(?:integer|int|long)$/.test(type)) {
    if (!Number.isInteger(Number(value))) throw new Error(`${label} must be an integer`);
  } else if (/^(?:boolean|bool|switch)$/.test(type)) {
    if (!(typeof value === 'boolean' || /^(?:true|false)$/i.test(String(value)))) {
      throw new Error(`${label} must be boolean`);
    }
  } else if (/^(?:json|object)$/.test(type)) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
  } else if (/^(?:array|list)$/.test(type)) {
    if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  } else if (/^(?:select|enum)$/.test(type)) {
    if (!allowed) throw new Error(`${label} has no declared options`);
  } else if (!type) {
    if (!allowed) {
      const defaultValue = config.value;
      if (defaultValue == null || typeof parsed !== typeof parsedJson(defaultValue)) {
        throw new Error(`${label} has an unsupported untyped contract`);
      }
    }
  } else {
    throw new Error(`${label} uses unsupported config type ${config.type}`);
  }
  return value != null && typeof value === 'object' ? JSON.stringify(value) : value;
}

export function configureEtlNode(node, template, values, previousConfiguredKeys = []) {
  record(values, 'ETL node config values');
  const current = normalizeEtlNodeTemplate(template);
  const existing = normalizeEtlNodeTemplate(node);
  if (!Array.isArray(previousConfiguredKeys)) {
    throw new Error(`ETL node ${current.name} configured-key provenance must be an array`);
  }
  if (
    existing.smartbiCliConfiguredKeys != null
    && !Array.isArray(existing.smartbiCliConfiguredKeys)
  ) {
    throw new Error(`ETL node ${current.name} saved configured-key provenance is invalid`);
  }
  const savedPortContract = {
    inputs: existing.inputs.map((port) => ({ order: port.order, types: port.types })),
    outputs: existing.outputs.map((port) => ({ order: port.order, types: port.types })),
  };
  const livePortContract = {
    inputs: current.inputs.map((port) => ({ order: port.order, types: port.types })),
    outputs: current.outputs.map((port) => ({ order: port.order, types: port.types })),
  };
  if (JSON.stringify(savedPortContract) !== JSON.stringify(livePortContract)) {
    throw new Error(`ETL node ${current.name} live port contract changed`);
  }
  if (existing.name !== current.name) {
    throw new Error(`ETL saved node ${existing.name} does not match live template ${current.name}`);
  }
  if (current.combineConfigs.length > 0) {
    throw new Error(`ETL node ${current.name} uses an unsupported combined-config contract`);
  }
  const liveByName = new Map(current.configs.map((config) => [config.name, config]));
  const existingByName = new Map(existing.configs.map((config) => [config.name, config]));
  for (const name of Object.keys(values)) {
    if (!liveByName.has(name)) throw new Error(`ETL node ${current.name} has no config named ${name}`);
  }
  for (const name of existingByName.keys()) {
    if (!liveByName.has(name)) throw new Error(`ETL node ${current.name} saved config is no longer supported: ${name}`);
  }
  const configs = current.configs.map((liveConfig) => {
    const savedConfig = existingByName.get(liveConfig.name);
    const value = Object.hasOwn(values, liveConfig.name)
      ? values[liveConfig.name]
      : (savedConfig ? savedConfig.value : liveConfig.value);
    return {
      ...(savedConfig || {}),
      ...liveConfig,
      value: validateConfigValue(liveConfig, value, `ETL node ${current.name} config ${liveConfig.name}`),
    };
  });
  const configuredKeys = [...new Set([
    ...previousConfiguredKeys,
    ...(existing.smartbiCliConfiguredKeys || []),
    ...Object.keys(values),
  ].map((name) => requiredText(name, `ETL node ${current.name} configured key`)))]
    .filter((name) => liveByName.has(name))
    .sort();
  const nextNode = { ...existing, configs, smartbiCliConfiguredKeys: configuredKeys };
  const changed = JSON.stringify({ configs: existing.configs, keys: existing.smartbiCliConfiguredKeys || [] })
    !== JSON.stringify({ configs, keys: configuredKeys });
  return { node: nextNode, configuredKeys, changed };
}

export function normalizeEtlGraph(graph) {
  record(graph, 'ETL graph');
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new Error('ETL graph must contain a non-empty nodes array');
  }
  if (!Array.isArray(graph.links)) throw new Error('ETL graph links must be an array');
  const nodeIds = new Set();
  const portOwners = new Map();
  const nodes = graph.nodes.map((rawNode, index) => {
    const node = normalizeEtlNodeTemplate(rawNode, { requirePortIds: true });
    const id = requiredText(node.id, `ETL graph node ${index} id`);
    if (nodeIds.has(id)) throw new Error(`ETL graph declares duplicate node id ${id}`);
    nodeIds.add(id);
    for (const port of node.inputs) {
      if (portOwners.has(port.id)) throw new Error(`ETL graph declares duplicate port id ${port.id}`);
      portOwners.set(port.id, { nodeId: id, direction: 'input', port });
    }
    for (const port of node.outputs) {
      if (portOwners.has(port.id)) throw new Error(`ETL graph declares duplicate port id ${port.id}`);
      portOwners.set(port.id, { nodeId: id, direction: 'output', port });
    }
    return { ...node, id };
  });
  const links = graph.links.map((rawLink, index) => {
    record(rawLink, `ETL graph link ${index}`);
    const from = requiredText(rawLink.from, `ETL graph link ${index} from`);
    const to = requiredText(rawLink.to, `ETL graph link ${index} to`);
    const inputPortId = requiredText(rawLink.inputPortId, `ETL graph link ${index} source port`);
    const outputPortId = requiredText(rawLink.outputPortId, `ETL graph link ${index} target port`);
    if (!nodeIds.has(from) || !nodeIds.has(to)) throw new Error(`ETL graph link ${index} references a missing node`);
    if (from === to) throw new Error(`ETL graph link ${index} is a self-cycle`);
    const sourcePort = portOwners.get(inputPortId);
    const targetPort = portOwners.get(outputPortId);
    if (!sourcePort || sourcePort.nodeId !== from || sourcePort.direction !== 'output') {
      throw new Error(`ETL graph link ${index} has a dangling or misowned source port`);
    }
    if (!targetPort || targetPort.nodeId !== to || targetPort.direction !== 'input') {
      throw new Error(`ETL graph link ${index} has a dangling or misowned target port`);
    }
    if (!compatibleTypes(sourcePort.port, targetPort.port)) {
      throw new Error(`ETL graph link ${index} connects incompatible port types`);
    }
    return { ...rawLink, from, to, inputPortId, outputPortId };
  });
  const identities = links.map((link) => `${link.from}\u0000${link.to}\u0000${link.inputPortId}\u0000${link.outputPortId}`);
  if (new Set(identities).size !== identities.length) throw new Error('ETL graph contains duplicate links');

  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const link of links) {
    outgoing.get(link.from).push(link.to);
    indegree.set(link.to, indegree.get(link.to) + 1);
  }
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited += 1;
    for (const nextId of outgoing.get(id)) {
      indegree.set(nextId, indegree.get(nextId) - 1);
      if (indegree.get(nextId) === 0) queue.push(nextId);
    }
  }
  if (visited !== nodes.length) throw new Error('ETL graph contains a cycle');
  return { ...graph, nodes, links };
}

export function assertExecutableEtlGraph(graph, { allowDatasetOutput = false } = {}) {
  const normalized = normalizeEtlGraph(graph);
  const expectedTerminalEffect = allowDatasetOutput ? 'dataset-output' : 'overwrite-target';
  const capabilities = new Map();
  for (const node of normalized.nodes) {
    const capability = getEtlNodeCapability(node);
    const operation = capability?.effect === 'dataset-output' && allowDatasetOutput
      ? 'configure'
      : 'execute';
    if (!capability || !capability.operations.includes(operation)) {
      throw new Error(`ETL node effect is not verified for ${operation}: ${node.name}`);
    }
    assertVerifiedEtlTemplate(node, operation);
    capabilities.set(node.id, capability);
  }
  const incoming = new Map(normalized.nodes.map((node) => [node.id, []]));
  const outgoing = new Map(normalized.nodes.map((node) => [node.id, []]));
  for (const link of normalized.links) {
    outgoing.get(link.from).push(link);
    incoming.get(link.to).push(link);
  }
  const sources = normalized.nodes.filter((node) => capabilities.get(node.id).effect === 'table-source');
  const terminals = normalized.nodes.filter((node) => outgoing.get(node.id).length === 0);
  if (sources.length === 0) throw new Error('ETL execution graph has no verified table source');
  if (terminals.length !== 1 || capabilities.get(terminals[0]?.id)?.effect !== expectedTerminalEffect) {
    throw new Error(`ETL graph requires exactly one verified ${expectedTerminalEffect}`);
  }
  for (const node of normalized.nodes) {
    const effect = capabilities.get(node.id).effect;
    if (effect === 'table-source') {
      if (incoming.get(node.id).length !== 0 || outgoing.get(node.id).length === 0) {
        throw new Error(`ETL source ${node.id} has an invalid graph placement`);
      }
    } else if (effect === expectedTerminalEffect) {
      if (incoming.get(node.id).length !== 1) throw new Error(`ETL target ${node.id} must have one inbound link`);
    } else {
      if (incoming.get(node.id).length === 0 || outgoing.get(node.id).length === 0) {
        throw new Error(`ETL transform ${node.id} is disconnected`);
      }
    }
  }
  const reachable = new Set(sources.map((node) => node.id));
  const queue = [...reachable];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const link of outgoing.get(id)) {
      if (!reachable.has(link.to)) {
        reachable.add(link.to);
        queue.push(link.to);
      }
    }
  }
  if (reachable.size !== normalized.nodes.length) throw new Error('ETL execution graph contains unreachable nodes');
  return normalized;
}

export function spliceUnaryBeforeTerminal(graph, rawNode) {
  const normalized = normalizeEtlGraph(graph);
  const node = assertVerifiedEtlTemplate(rawNode, 'insert');
  if (node.inputs.length !== 1 || node.outputs.length !== 1) {
    throw new Error(`ETL splice requires a unary node: ${node.name}`);
  }
  if (normalized.nodes.some((candidate) => candidate.id === node.id)) {
    throw new Error(`ETL graph already contains node id ${node.id}`);
  }
  const terminalNodes = normalized.nodes.filter((candidate) => candidate.outputs.length === 0);
  const inbound = terminalNodes.length === 1
    ? normalized.links.filter((link) => link.to === terminalNodes[0].id)
    : [];
  if (terminalNodes.length !== 1 || inbound.length !== 1) {
    throw new Error(
      `ETL must have one zero-output terminal with one inbound link; found ${terminalNodes.length} terminals and ${inbound.length} links`,
    );
  }
  const target = terminalNodes[0];
  const previous = inbound[0];
  const upstream = normalized.nodes.find((candidate) => candidate.id === previous.from);
  if (!upstream) throw new Error('ETL terminal inbound link has no source node');
  const upstreamPort = upstream.outputs.find((port) => port.id === previous.inputPortId);
  const targetPort = target.inputs.find((port) => port.id === previous.outputPortId);
  const input = node.inputs[0];
  const output = node.outputs[0];
  if (!compatibleTypes(upstreamPort, input) || !compatibleTypes(output, targetPort)) {
    throw new Error(`ETL node ${node.name} is incompatible with the terminal splice ports`);
  }
  const rewired = {
    ...previous,
    to: node.id,
    outputPortId: input.id,
  };
  const inserted = {
    from: node.id,
    to: target.id,
    inputPortId: output.id,
    outputPortId: targetPort.id,
  };
  const next = {
    ...normalized,
    nodes: normalized.nodes.map((candidate) => (
      candidate.id === target.id ? { ...candidate, state: 'INITED' } : candidate
    )).concat(node),
    links: normalized.links.filter((link) => link !== previous).concat(rewired, inserted),
  };
  return { graph: normalizeEtlGraph(next), node, targetId: target.id, preservedLink: rewired };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function assertContains(actual, expected, path) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new Error(`persisted ETL graph changed ${path} length`);
    }
    expected.forEach((item, index) => assertContains(actual[index], item, `${path}[${index}]`));
    return;
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      throw new Error(`persisted ETL graph changed ${path}`);
    }
    for (const [key, value] of Object.entries(expected)) assertContains(actual[key], value, `${path}.${key}`);
    return;
  }
  if (!Object.is(actual, expected)) throw new Error(`persisted ETL graph changed ${path}`);
}

export function assertEtlGraphPersisted(expectedGraph, actualGraph) {
  const expected = stableValue(normalizeEtlGraph(expectedGraph));
  const actual = stableValue(normalizeEtlGraph(actualGraph));
  assertContains(actual, expected, 'graph');
  return actualGraph;
}

const ETL_PROCESS_RUNTIME_FIELDS = new Set([
  'define',
  'state',
  'currentInstanceId',
  'runningInfo',
  'nodeStates',
  'lastModifiedDate',
  'lastModifiedTime',
  'modifiedDate',
  'modifiedTime',
  'updateTime',
  'version',
]);

export function assertEtlProcessDagMetadataPreserved(expected, actual) {
  record(expected, 'expected ETL processDag');
  record(actual, 'reopened ETL processDag');
  for (const [key, value] of Object.entries(expected)) {
    if (ETL_PROCESS_RUNTIME_FIELDS.has(key) || value === undefined) continue;
    if (
      !Object.hasOwn(actual, key)
      || JSON.stringify(stableValue(actual[key])) !== JSON.stringify(stableValue(value))
    ) {
      throw new Error(`persisted ETL processDag changed metadata field ${key}`);
    }
  }
  return actual;
}

export function prepareEtlProcessDag(processDag, graph, { definitionChanged = true } = {}) {
  record(processDag, 'ETL processDag');
  const normalized = normalizeEtlGraph(graph);
  const definition = definitionChanged
    ? {
        ...normalized,
        nodes: normalized.nodes.map((node) => ({ ...node, state: 'INITED' })),
      }
    : normalized;
  const next = {
    ...processDag,
    define: definitionChanged || !processDag.define
      ? JSON.stringify(definition)
      : processDag.define,
  };
  if (definitionChanged) {
    next.state = 'INITED';
    next.currentInstanceId = null;
    next.runningInfo = {
      ...(processDag.runningInfo && typeof processDag.runningInfo === 'object' ? processDag.runningInfo : {}),
      dagState: 'INITED',
      costTime: 0,
    };
    if (Object.hasOwn(next, 'nodeStates')) next.nodeStates = null;
    if (Object.hasOwn(next, 'flowRunInfo')) next.flowRunInfo = null;
  }
  return next;
}

function canonicalType(value) {
  const type = String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!type) throw new Error('ETL schema field has no canonical type');
  return type;
}

export function normalizeEtlSchema(fields, label = 'ETL schema') {
  if (!Array.isArray(fields) || fields.length === 0) throw new Error(`${label} has no fields`);
  const seen = new Set();
  return fields.map((rawField, ordinal) => {
    const field = rawField && typeof rawField === 'object' ? rawField : { name: rawField };
    const name = requiredText(field.name ?? field.fieldName, `${label} field ${ordinal} name`);
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) throw new Error(`${label} declares duplicate field ${name}`);
    seen.add(key);
    return {
      name,
      alias: field.alias == null ? null : String(field.alias),
      type: canonicalType(field.dataType ?? field.type ?? field.fieldType ?? field.sqlType),
      ordinal,
      precision: Number.isInteger(Number(field.precision)) ? Number(field.precision) : null,
      scale: Number.isInteger(Number(field.scale)) ? Number(field.scale) : null,
      nullable: typeof field.nullable === 'boolean' ? field.nullable : null,
    };
  });
}

export function assertEtlSchemasIdentical(expectedFields, actualFields, {
  expectedLabel = 'expected ETL schema',
  actualLabel = 'actual ETL schema',
} = {}) {
  const expected = normalizeEtlSchema(expectedFields, expectedLabel);
  const actual = normalizeEtlSchema(actualFields, actualLabel);
  if (expected.length !== actual.length) {
    throw new Error(`${actualLabel} field count mismatch: expected ${expected.length}, found ${actual.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left.name !== right.name || left.type !== right.type) {
      throw new Error(
        `${actualLabel} mismatch at ordinal ${index}: expected ${left.name}:${left.type}, found ${right.name}:${right.type}`,
      );
    }
  }
  return actual;
}

export function assertDistinctEtlTableIds(sourceTableIds, targetTableId = null) {
  if (!Array.isArray(sourceTableIds) || sourceTableIds.length === 0) {
    throw new Error('ETL requires at least one source table id');
  }
  const normalized = sourceTableIds.map((id) => requiredText(id, 'ETL source table id').toLocaleLowerCase());
  if (new Set(normalized).size !== normalized.length) throw new Error('ETL source table ids must be unique');
  if (targetTableId && normalized.includes(requiredText(targetTableId, 'ETL target table id').toLocaleLowerCase())) {
    throw new Error('ETL source and target table ids must differ');
  }
  return sourceTableIds;
}

export function parseImportedTableReference(tableId) {
  const text = requiredText(tableId, 'imported table id');
  const parts = text.split('.');
  if (parts.length < 5 || parts[0] !== 'TAB') {
    throw new Error(`expected an imported table id such as TAB.input.input.null.table_name: ${text}`);
  }
  const [, catalog, schema, nullMarker, ...tableNameParts] = parts;
  return {
    tableId: text,
    dataSourceId: `DS.${catalog}`,
    schemaId: `SCHEMA.${catalog}.${schema}.${nullMarker}`,
    physicalTableName: tableNameParts.join('.'),
  };
}

function parsedConfig(node, configName) {
  const config = (node.configs || []).find((item) => item.name === configName);
  if (!config || blankConfigValue(config.value)) {
    throw new Error(`ETL node ${node.id || node.name} has no ${configName} configuration`);
  }
  const value = parsedJson(config.value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`ETL node ${node.id || node.name} ${configName} configuration is not a JSON object`);
  }
  return value;
}

export function extractEtlTableBindings(graph) {
  const normalized = normalizeEtlGraph(graph);
  const sources = normalized.nodes.filter((node) => node.name === 'JDBC_DATASOURCE').map((node) => {
    const value = parsedConfig(node, 'jdbc');
    const declaredIds = [value.tableId, value.tableData?.id].filter(Boolean).map(String);
    if (declaredIds.length === 0 || new Set(declaredIds.map((id) => id.toLocaleLowerCase())).size !== 1) {
      throw new Error(`ETL source ${node.id} has missing or conflicting table ids`);
    }
    const parsed = parseImportedTableReference(declaredIds[0]);
    if (
      value.datasourceId !== parsed.dataSourceId
      || canonicalSchemaId(value.schemaId) !== canonicalSchemaId(parsed.schemaId)
    ) {
      throw new Error(`ETL source ${node.id} binding does not match its imported table id`);
    }
    return {
      nodeId: node.id,
      tableId: parsed.tableId,
      dataSourceId: parsed.dataSourceId,
      schemaId: parsed.schemaId,
      physicalTableName: parsed.physicalTableName,
    };
  });
  const targetNodes = normalized.nodes.filter((node) => node.name === 'JDBC_DATATARGER_OVERWRITE');
  const targets = targetNodes.map((node) => {
    const value = parsedConfig(node, 'jdbcTarget');
    const tableId = requiredText(node.smartbiCliTargetTableId, `ETL target ${node.id} persisted table id`);
    const parsed = parseImportedTableReference(tableId);
    if (
      value.datasourceId !== parsed.dataSourceId
      || canonicalSchemaId(value.schemaId) !== canonicalSchemaId(parsed.schemaId)
      || String(value.tableId || '') !== parsed.physicalTableName
    ) {
      throw new Error(`ETL target ${node.id} binding does not match its imported table id`);
    }
    return {
      nodeId: node.id,
      tableId: parsed.tableId,
      dataSourceId: parsed.dataSourceId,
      schemaId: parsed.schemaId,
      physicalTableName: parsed.physicalTableName,
    };
  });
  return { graph: normalized, sources, targets };
}

function canonicalSchemaId(value) {
  return String(value || '').replace(/^SCHEMA\./, '').toLocaleLowerCase();
}

export function assertEtlTableBindingsAllowed({
  sources,
  target,
  personalFolder,
  personalChildren,
  competition = false,
}) {
  if (!target) throw new Error('ETL has no verified target binding');
  if (competition && sources.length !== 1) {
    throw new Error(`competition ETL requires exactly one persisted source; found ${sources.length}`);
  }
  assertDistinctEtlTableIds(sources.map((source) => source.tableId), target.tableId);
  const allowedIds = new Set((personalChildren || []).map((child) => String(child?.id || '').toLocaleLowerCase()));
  const expectedDataSource = requiredText(personalFolder?.dsId, 'personal acquisition data source id');
  const expectedSchema = canonicalSchemaId(personalFolder?.bindingSchemaId || personalFolder?.schemaId);
  for (const binding of [...sources, target]) {
    if (binding.dataSourceId !== expectedDataSource || canonicalSchemaId(binding.schemaId) !== expectedSchema) {
      throw new Error(`ETL table binding is outside the authenticated personal acquisition schema: ${binding.tableId}`);
    }
    if (!allowedIds.has(String(binding.tableId).toLocaleLowerCase())) {
      throw new Error(`ETL table is not a direct child of the authenticated personal acquisition folder: ${binding.tableId}`);
    }
  }
  return { sources, target };
}

export function assertExactEtlTarget(actual, expected) {
  record(actual, 'actual ETL target');
  record(expected, 'expected ETL target');
  const expectedTableId = requiredText(expected.tableId, 'expected ETL target table id');
  const expectedDataSourceId = requiredText(expected.dataSourceId, 'expected ETL target data source id');
  const expectedPhysicalName = requiredText(
    expected.physicalTableName || expected.tableName,
    'expected ETL target physical table name',
  );
  const expectedSchemaId = expected.schemaId == null ? null : canonicalSchemaId(expected.schemaId);
  if (
    actual.tableId !== expectedTableId
    || actual.dataSourceId !== expectedDataSourceId
    || actual.physicalTableName !== expectedPhysicalName
    || (expectedSchemaId && canonicalSchemaId(actual.schemaId) !== expectedSchemaId)
  ) {
    throw new Error('current ETL materialized target does not match the expected target tuple');
  }
  return actual;
}
