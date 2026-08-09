export function normalizeCatalogElements(response, context = 'catalog children') {
  if (!response || response.retCode !== 0) {
    throw new Error(`cannot list ${context}: ${JSON.stringify(response)}`);
  }

  const result = response.result;
  if (result == null) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.nodes)) return result.nodes;
  if (result.id) return [result];

  const values = Object.values(result);
  if (values.length === 0) return [];
  if (values.every((value) => value && typeof value === 'object' && value.id)) {
    return values;
  }

  throw new Error(`unexpected ${context} result: ${JSON.stringify(result)}`);
}
