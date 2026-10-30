/**
 * 配置归一化：所有字段都给默认值，坏值静默回退，保证插件永远能加载。
 */

/** 正整数，否则回退。 */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** 字符串数组，去空白与重复。 */
function stringList(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()))]
}

export function resolveConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: config.enabled !== false,
    seed: config.seed !== false,
    summaries: config.summaries !== false,
    capture: config.capture !== false,
    inject: config.inject !== false,
    maxLessons: positive(config.maxLessons, 12),
    maxInjectBytes: positive(config.maxInjectBytes, 6000),
    minOccurrences: positive(config.minOccurrences, 1),
    injectIntoSubagents: config.injectIntoSubagents === true,
    repeatWarn: config.repeatWarn !== false,
    projectScoped: config.projectScoped !== false,
    maxFindingsPerSession: positive(config.maxFindingsPerSession, 200),
    maxLessonsStored: positive(config.maxLessonsStored, 300),
    storeDir: typeof config.storeDir === 'string' ? config.storeDir.trim() : '',
    captureTools: stringList(config.captureTools),
    debug: config.debug === true,
  }
}