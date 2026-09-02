import type { CliProvider } from '../../provider-auth/types';
import type { ApiModelListItem } from '../../../shared/modelListApi';
import type { CatalogProvider, CatalogProviderProtocol } from '../../../shared/catalogProviders';
import type { OnboardingStepId } from './constants';
import type { WorkspaceType } from '../../project-creation-wizard/types';

export type { CliProvider };
export type { OnboardingStepId };

export type ProviderAuthStatus = {
  authenticated: boolean;
  email: string | null;
  loading: boolean;
  error: string | null;
};

export type ProviderStatusMap = Record<CliProvider, ProviderAuthStatus>;

export type TestStatus = 'idle' | 'testing' | 'success' | 'error' | 'manual';

export type ModelListStatus = 'idle' | 'loading' | 'error';

export type ImageSupportSource = 'catalog' | 'probe' | 'manual';

export type ModelImageSupport = {
  supportsImage: boolean | null;
  source: ImageSupportSource | null;
};

export type LlmSetupController = {
  selectedProvider: CatalogProvider | null;
  modelIds: string[];
  apiKey: string;
  customUrl: string;
  testStatus: TestStatus;
  testMessage: string;
  saving: boolean;
  apiModels: ApiModelListItem[] | null;
  modelListStatus: ModelListStatus;
  modelListMessage: string;
  customProviderId: string;
  customProtocol: CatalogProviderProtocol;
  isCustomMode: boolean;
  selectedModels: Array<{ id: string; displayName: string }>;
  selectedDefaultUrl: string;
  effectiveUrl: string;
  effectiveModelId: string;
  effectiveModelIds: string[];
  effectiveProtocol: CatalogProviderProtocol;
  effectiveProviderId: string;
  selectedProviderRequiresApiKey: boolean;
  canFetchModels: boolean;
  canTest: boolean;
  canContinue: boolean;
  unknownImageProbeCount: number;
  manualModelIds: string[];
  setModelIds: (value: string[] | ((current: string[]) => string[])) => void;
  selectModelId: (modelId: string) => void;
  deselectModelId: (modelId: string) => void;
  setApiKey: (value: string) => void;
  setCustomUrl: (value: string) => void;
  setCustomProviderId: (value: string) => void;
  setCustomProtocol: (value: CatalogProviderProtocol) => void;
  resetTest: () => void;
  handleProviderSelect: (provider: CatalogProvider) => void;
  handleFetchModels: () => Promise<void>;
  handleTest: () => Promise<void>;
  submitManualImageSupport: (values: Record<string, boolean>) => void;
  cancelManualImageSupport: () => void;
  handleSave: () => Promise<void>;
};

export type WorkspaceDraft = {
  workspaceType: WorkspaceType;
  workspacePath: string;
  githubUrl: string;
};
