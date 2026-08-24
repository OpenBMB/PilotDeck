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

export type TestStatus = 'idle' | 'testing' | 'success' | 'error';

export type ModelListStatus = 'idle' | 'loading' | 'error';

export type LlmSetupController = {
  selectedProvider: CatalogProvider | null;
  selectedModelId: string;
  customModelId: string;
  apiKey: string;
  customUrl: string;
  showAdvanced: boolean;
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
  effectiveProtocol: CatalogProviderProtocol;
  effectiveProviderId: string;
  selectedProviderRequiresApiKey: boolean;
  canFetchModels: boolean;
  canTest: boolean;
  setSelectedModelId: (value: string) => void;
  setCustomModelId: (value: string) => void;
  setApiKey: (value: string) => void;
  setCustomUrl: (value: string) => void;
  setShowAdvanced: (value: boolean | ((current: boolean) => boolean)) => void;
  setCustomProviderId: (value: string) => void;
  setCustomProtocol: (value: CatalogProviderProtocol) => void;
  resetTest: () => void;
  handleProviderSelect: (provider: CatalogProvider) => void;
  handleFetchModels: () => Promise<void>;
  handleTest: () => Promise<void>;
  handleSave: () => Promise<void>;
};

export type WorkspaceDraft = {
  workspaceType: WorkspaceType;
  workspacePath: string;
  githubUrl: string;
};
