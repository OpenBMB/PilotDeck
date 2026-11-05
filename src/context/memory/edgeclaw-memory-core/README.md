# Memory service

Private local-file dependency providing structured memory, retrieval and the memory dashboard used by PilotDeck.

Entry points: [src/index.ts](src/index.ts), [src/service.ts](src/service.ts), [ui-source](ui-source). Build with `pnpm --dir src/context/memory/edgeclaw-memory-core build` from the repository root; the root prebuild also performs this step.

The package exports lib/index.js and lib/index.d.ts. Its committed lib files currently seed the pnpm local-file installation snapshot; do not remove them without updating and validating the clean-install/build flow. See [context](../../README.md) and the [core build](../../../../README.md).
