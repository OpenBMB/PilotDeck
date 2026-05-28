import { CLAUDE_MODELS } from '../../shared/modelConstants.js';

function normalizeModelValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneOptions(options) {
  return options.map((option) => ({ ...option }));
}

export function getClaudeRuntimeModelConfig() {
  const builtInOptions = cloneOptions(CLAUDE_MODELS.OPTIONS);
  const configuredModel = normalizeModelValue(process.env.ANTHROPIC_MODEL);
  const hasConfiguredOption = configuredModel
    && builtInOptions.some((option) => option.value === configuredModel);

  if (configuredModel && !hasConfiguredOption) {
    builtInOptions.push({
      value: configuredModel,
      label: configuredModel,
    });
  }

  return {
    defaultModel: configuredModel || CLAUDE_MODELS.DEFAULT,
    availableModels: builtInOptions,
  };
}

export function getClaudeRuntimeModelValues() {
  return getClaudeRuntimeModelConfig().availableModels.map((option) => option.value);
}
