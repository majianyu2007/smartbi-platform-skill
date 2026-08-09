const BLANK_BUCKETS = new Set([
  '',
  '--',
  'null',
  'undefined',
  'unknown',
  '未知',
  '空值',
]);

export function summarizeDimensionKeys(keys, minimumUsableCategories = 2) {
  const normalized = [...new Set((keys || []).map((key) => String(key ?? '').trim()))];
  const blankCategoryCount = normalized.filter(
    (key) => BLANK_BUCKETS.has(key.toLowerCase()),
  ).length;
  const usableCategoryCount = normalized.length - blankCategoryCount;
  return {
    categoryCount: normalized.length,
    blankCategoryCount,
    usableCategoryCount,
    usableForChart: usableCategoryCount >= minimumUsableCategories,
  };
}
