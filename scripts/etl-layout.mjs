export function layoutLinearEtlGraph(graph, { startX = 350, startY = 50, gapX = 140 } = {}) {
  const nodes = graph?.nodes || [];
  const links = graph?.links || [];
  if (nodes.length < 2 || links.length !== nodes.length - 1) return false;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const link of links) {
    if (!byId.has(link.from) || !byId.has(link.to)) return false;
    outgoing.get(link.from).push(link.to);
    incoming.get(link.to).push(link.from);
  }
  if ([...incoming.values()].some((ids) => ids.length > 1)) return false;
  if ([...outgoing.values()].some((ids) => ids.length > 1)) return false;
  const sources = nodes.filter((node) => incoming.get(node.id).length === 0);
  if (sources.length !== 1) return false;

  const ordered = [];
  const visited = new Set();
  let current = sources[0];
  while (current && !visited.has(current.id)) {
    ordered.push(current);
    visited.add(current.id);
    const nextId = outgoing.get(current.id)[0];
    current = nextId ? byId.get(nextId) : null;
  }
  if (ordered.length !== nodes.length) return false;

  let changed = false;
  ordered.forEach((node, index) => {
    const x = startX + index * gapX;
    if (Number(node.x) !== x || Number(node.y) !== startY) changed = true;
    node.x = x;
    node.y = startY;
  });
  return changed;
}

export function positionEtlNodeBeforeTarget(node, target, { gapX = 140 } = {}) {
  if (!node || !target) throw new Error('ETL insertion requires both a node and terminal target');
  const targetX = Number(target.x);
  const targetY = Number(target.y);
  node.x = Number.isFinite(targetX) ? targetX : 0;
  node.y = Number.isFinite(targetY) ? targetY : 0;
  target.x = node.x + gapX;
  target.y = node.y;
  return { node, target };
}
