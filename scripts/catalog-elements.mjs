export function normalizeCatalogElements(response, context = 'catalog children') {
  if (!response || typeof response !== 'object') {
    throw new Error(`cannot list ${context}: response unavailable`);
  }
  if (response.retCode !== 0) {
    throw new Error(`cannot list ${context}: retCode=${String(response.retCode)}`);
  }

  const result = response.result;
  if (result == null) return [];
  if (Array.isArray(result)) return result;
  if (typeof result !== 'object') {
    throw new Error(`unexpected ${context} result shape: ${typeof result}`);
  }
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.nodes)) return result.nodes;
  if (result.id) return [result];

  const values = Object.values(result);
  if (values.length === 0) return [];
  if (values.every((value) => value && typeof value === 'object' && value.id)) {
    return values;
  }

  throw new Error(`unexpected ${context} result shape`);
}
