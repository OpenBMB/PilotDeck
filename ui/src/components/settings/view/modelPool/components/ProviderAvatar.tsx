import { PROVIDER_LOGOS } from "../../../../onboarding/view/constants";
import { SETTINGS_CONFIG_ICON } from "../../navIcons";
import type { CatalogProvider } from "../../../../../shared/catalogProviders";

type ProviderAvatarProps = {
  providerId: string;
  catalogEntry?: CatalogProvider;
  size?: number;
  className?: string;
};

export default function ProviderAvatar({
  providerId,
  catalogEntry,
  size = 21,
  className = "provider-avatar",
}: ProviderAvatarProps) {
  const logoSrc =
    PROVIDER_LOGOS[providerId] ??
    (catalogEntry ? PROVIDER_LOGOS[catalogEntry.id] : undefined);

  if (logoSrc) {
    return (
      <span className={className}>
        <img src={logoSrc} alt="" width={size} height={size} />
      </span>
    );
  }

  return (
    <span
      className={`${className} custom`}
      aria-label={catalogEntry?.displayName ?? providerId}
      dangerouslySetInnerHTML={{ __html: SETTINGS_CONFIG_ICON }}
    />
  );
}
