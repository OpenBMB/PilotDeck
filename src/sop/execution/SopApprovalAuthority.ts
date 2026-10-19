export interface SopApprovalAuthority {
  authenticate(input: { bearer: string; projectKey: string; signal?: AbortSignal }): Promise<{ subjectId: string }>;
}

/** Optional Web adapter; loading the pure execution host never opens a user database. */
export function createOwnerSopApprovalAuthority(options: {
  databasePath: string; jwtSecret?: string;
}): SopApprovalAuthority {
  let authority: Promise<{ authenticate(input: { bearer: string; signal?: AbortSignal }): Promise<{ userId: string }> }> | undefined;
  return {
    async authenticate(input) {
      authority ??= import(new URL('../../../ui/server/pilotdeck-approval-authority.mjs', import.meta.url).href)
        .then(async module => {
          const { readNativeInstallationOwner } = await import('../../composition/nativeApprovalSessionResolver.js');
          return module.createPilotDeckApprovalAuthority({ ...options,
            readOwner: () => readNativeInstallationOwner(options.databasePath) });
        });
      const subject = await (await authority).authenticate(input);
      return { subjectId: subject.userId };
    },
  };
}
