import type {
  CatalogModel,
  CatalogProvider,
} from "../../../../../shared/catalogProviders";

export type ActiveModelCapabilities = {
  ref: string;
  providerId: string;
  modelId: string;
  catalogModel?: CatalogModel;
  catalogProvider?: CatalogProvider;
  multimodalInput: string[] | null;
  maxOutputTokensOverride: number | undefined;
};
