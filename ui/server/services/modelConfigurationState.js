import fs from 'fs';
import { loadPilotConfig } from '../../../src/pilot/config/loadPilotConfig.js';
import {
  configRevision,
  readPilotDeckConfigFile,
  resolveConfiguredProviderApiKey,
  resolveConfiguredProviderUrl,
  resolveModel,
  validatePilotDeckConfig,
} from './pilotdeckConfig.js';

const BOOTSTRAP_PLACEHOLDER_PROVIDER = '_placeholder';
const BOOTSTRAP_PLACEHOLDER_KEY = 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function baseState(record) {
  return {
    configPath: record.configPath ?? null,
    revision: configRevision(record.raw),
  };
}

function needsConfiguration(record, reason) {
  return {
    ...baseState(record),
    state: 'needs_configuration',
    reason,
  };
}

function invalidConfiguration(record, errors) {
  return {
    ...baseState(record),
    state: 'invalid',
    errors: [...new Set(errors.filter(Boolean))],
  };
}

function gatewayValidationErrors(record, env) {
  if (!record.configPath || !fs.existsSync(record.configPath)) return [];

  try {
    loadPilotConfig({ configPath: record.configPath, env });
    return [];
  } catch (error) {
    if (Array.isArray(error?.diagnostics) && error.diagnostics.length > 0) {
      return error.diagnostics
        .filter((diagnostic) => diagnostic?.severity === 'fatal')
        .map((diagnostic) => {
          const prefix = diagnostic.path ? `${diagnostic.path}: ` : '';
          const hint = diagnostic.hint ? ` (${diagnostic.hint})` : '';
          return `${prefix}${diagnostic.message}${hint}`;
        });
    }
    return [error instanceof Error ? error.message : String(error)];
  }
}

/**
 * Return the single model-configuration state used by onboarding and runtime
 * supervisors. A "ready" result means the selected model resolves, its
 * credential requirements are met, and the Gateway parser accepts the file.
 */
export function evaluateModelConfigurationState(record, options = {}) {
  if (!record.exists) {
    return needsConfiguration(record, 'missing_config');
  }

  if (record.parseError) {
    return invalidConfiguration(record, [`Invalid YAML: ${record.parseError}`]);
  }

  const config = record.config;
  const env = options.env ?? process.env;
  const configuredModelRef = normalizeString(config?.agent?.model);
  const modelRef = normalizeString(env.PILOT_AGENT_MODEL) || configuredModelRef;
  const effectiveConfig = modelRef === configuredModelRef
    ? config
    : {
        ...config,
        agent: {
          ...config?.agent,
          model: modelRef,
        },
      };
  if (modelRef.startsWith(`${BOOTSTRAP_PLACEHOLDER_PROVIDER}/`)) {
    return needsConfiguration(record, 'legacy_placeholder');
  }

  if (!modelRef) {
    return needsConfiguration(record, 'missing_model');
  }

  const selected = resolveModel(effectiveConfig, modelRef, { allowMissing: true });
  if (!selected) {
    return invalidConfiguration(record, [
      `agent.model="${modelRef}" doesn't resolve to a configured provider/model`,
    ]);
  }

  if (
    selected.providerId === BOOTSTRAP_PLACEHOLDER_PROVIDER
    || normalizeString(selected.provider?.apiKey) === BOOTSTRAP_PLACEHOLDER_KEY
  ) {
    return needsConfiguration(record, 'legacy_placeholder');
  }

  if (!resolveConfiguredProviderUrl(selected.providerId, selected.provider)) {
    return invalidConfiguration(record, [
      `model.providers.${selected.providerId}.url is required`,
    ]);
  }

  if (
    selected.providerId !== 'ollama'
    && !resolveConfiguredProviderApiKey(selected.providerId, selected.provider, options.env)
  ) {
    return needsConfiguration(record, 'missing_credential');
  }

  const validation = validatePilotDeckConfig(effectiveConfig);
  if (!validation.valid) {
    return invalidConfiguration(record, validation.errors);
  }

  const gatewayErrors = options.validateGateway === false
    ? []
    : gatewayValidationErrors(record, env);
  if (gatewayErrors.length > 0) {
    return invalidConfiguration(record, gatewayErrors);
  }

  return {
    ...baseState(record),
    state: 'ready',
    modelRef,
  };
}

export function getModelConfigurationState(options = {}) {
  return evaluateModelConfigurationState(readPilotDeckConfigFile(), options);
}
