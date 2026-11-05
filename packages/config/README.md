# Shared runtime support

CommonJS helpers shared by Node services and Electron. This package provides runtime paths, diagnostic codes, redaction and managed logs; it does not own YAML storage or migrations.

Entry points: [index.cjs](index.cjs), [errors.cjs](errors.cjs), [runtimeLogs.cjs](runtimeLogs.cjs). Declarations are shipped with the package.

Run `pnpm --filter @pilotdeck/config test` from the repository root. Changes to these helpers require checking both Web and desktop consumers; see [testing](../../docs/testing.md).
