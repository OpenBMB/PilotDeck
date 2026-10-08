/** Ignore retired sampling controls from legacy extraBody configuration. */
export function sanitizeProviderBody(body: Record<string, unknown>): Record<string, unknown> {
  const { temperature: _retired, ...result } = body;
  const config = result.generationConfig;
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const { temperature: _retiredGoogle, ...generationConfig } = config as Record<string, unknown>;
    result.generationConfig = generationConfig;
  }
  return result;
}
