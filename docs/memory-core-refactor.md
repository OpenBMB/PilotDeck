# Memory Core Refactoring Plan

## Current State

The memory subsystem consists of **two layers**:

### Layer 1: Vendored Library (`src/context/memory/edgeclaw-memory-core/`)
A self-contained memory management library (~10 KLOC) vendored from the
[edgeclaw-memory-core](https://github.com/OpenBMB/edgeclaw-memory-core) project.
- **14 source files** (`.ts`): service, index, message-utils, core modules, storage, LLM extraction, retrieval
- **Package entry**: `edgeclaw-memory-core` (referenced via `file:...` in package.json)
- **Build output**: `src/context/memory/edgeclaw-memory-core/lib/` (compiled JS + type declarations)
- **No npm registry presence** — currently only used by PilotDeck

### Layer 2: Integration Adapter (`src/context/memory/`)
4 adapter files that bridge the vendored library with PilotDeck's context runtime:

| File | Responsibility |
|------|---------------|
| `EdgeClawMemoryProvider.ts` | Implements `MemoryResolver` interface using `EdgeClawMemoryService` |
| `MemoryAttachmentBuilder.ts` | Builds memory attachment blocks for model context |
| `MemoryResolver.ts` | Defines `MemoryResolver` interface and message conversion utilities |
| `createEdgeClawMemoryProviderFromConfig.ts` | Factory that creates provider from PilotDeck config |

### Dependencies
```json
"edgeclaw-memory-core": "file:src/context/memory/edgeclaw-memory-core"
```

Referenced from:
- `src/cli/createLocalGateway.ts` — imports `EdgeClawMemoryService` type
- `src/context/memory/createEdgeClawMemoryProviderFromConfig.ts` — imports `EdgeClawMemoryService`, `EdgeClawMemoryLlmOptions`

---

## Goal

Extract into a standalone npm package for:
1. **Independent versioning** — memory improvements don't require PilotDeck releases
2. **Reuse across projects** — any OpenBMB project can adopt the memory system
3. **Clearer module boundaries** — memory logic stays separate from agent/context runtime
4. **Focused testing** — memory can have its own test suite and CI

---

## Phases

### Phase 1 — Module Boundary (✅ This PR)

**Actions:**
1. Add barrel exports (`index.ts`) for the adapter layer at `src/context/memory/`
2. Add README at `src/context/memory/edgeclaw-memory-core/README.md`
3. Document the integration surface (interfaces, expected contracts)
4. Add inline comments identifying public API vs internal

**Deliverables:**
- `src/context/memory/index.ts` — barrel exports
- `src/context/memory/edgeclaw-memory-core/README.md` — vendor documentation
- Updated JSDoc on public interfaces

**Files Changed:**
- `src/context/memory/` — new barrel export
- `src/context/memory/edgeclaw-memory-core/README.md` — new vendor docs

---

### Phase 2 — Package Extraction

**Actions:**
1. Create `packages/edgeclaw-memory-core/` directory
2. Copy vendored source (`.ts` files, not `.js` build artifacts)
3. Set up independent `package.json`, `tsconfig.json`, test infrastructure
4. Update workspace config: add `packages/edgeclaw-memory-core` to workspaces
5. Install: `npm install` hoists the workspace package
6. Update imports in PilotDeck to use `@openbmb/memory-core`
7. Remove old vendored copy from `src/context/memory/edgeclaw-memory-core/`

**Deliverables:**
- `packages/edgeclaw-memory-core/` with full source
- Updated root `package.json` workspaces
- Cleaned src tree (remove vendored duplicate)

---

### Phase 3 — Publish

**Actions:**
1. Add CI workflow for the package
2. Publish `@openbmb/memory-core` to npm (or GitHub Packages)
3. Update PilotDeck dependency to `"@openbmb/memory-core": "^1.0.0"`
4. Remove workspace symlink

**Deliverables:**
- Published npm package
- Cleaned workspace configuration

---

## Migration Guide

### Consumer (PilotDeck)

Current import:
```typescript
import { EdgeClawMemoryService } from "edgeclaw-memory-core";
```

After Phase 2:
```typescript
import { EdgeClawMemoryService } from "@openbmb/memory-core";
```

### External projects

```bash
npm install @openbmb/memory-core
```

```typescript
import { EdgeClawMemoryService, ContextMemoryMessage } from "@openbmb/memory-core";
```

---

## Architecture

```
PilotDeck Context Runtime
        │
        ▼
┌─────────────────────────────┐
│  MemoryResolver (interface) │  ← src/context/memory/MemoryResolver.ts
│  EdgeClawMemoryProvider     │  ← src/context/memory/EdgeClawMemoryProvider.ts
│  MemoryAttachmentBuilder    │  ← src/context/memory/MemoryAttachmentBuilder.ts
└──────────┬──────────────────┘
           │ depends on
           ▼
┌─────────────────────────────┐
│  edgeclaw-memory-core       │  ← vendored library
│  (EdgeClawMemoryService)    │
│                             │
│  ┌───────┐ ┌─────────────┐ │
│  │ Core  │ │ Storage     │ │
│  │ Index │ │ (SQLite)    │ │
│  ├───────┤ ├─────────────┤ │
│  │File   │ │ Retrieval   │ │
│  │Memory │ │ LLM extr.   │ │
│  ├───────┤ ├─────────────┤ │
│  │Heart  │ │ DreamReview │ │
│  │beat   │ │             │ │
│  └───────┘ └─────────────┘ │
└─────────────────────────────┘
```

---

## Public API Surface

### Provided by Memory Core

```typescript
// Service
EdgeClawMemoryService        — main entry point
EdgeClawMemoryLlmOptions     — LLM configuration for memory operations

// Types
ContextMemoryMessage          — canonical memory message format
MemoryRetrieveInput          — input for memory retrieval
MemoryRetrieveResult         — result of memory retrieval
MemoryCaptureTurnInput       — input for turn capture

// Utilities
canonicalMessagesToMemoryMessages — converts PilotDeck messages to memory format
```

### Expected by Memory Core

```typescript
EdgeClawRetrieveContextResult — retrieval response shape
EdgeClawCaptureTurnResult     — capture response shape
EdgeClawCaseTraceRecord       — optional trace record shape
```

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Breaking changes in exported API | Phase 1 collars all integration points; Phase 2 uses semver |
| SQLite dependency portability | SQLite is well-supported across platforms. Pin better-sqlite3 version |
| LLM extraction quality drift | Unit tests for extraction will migrate with the package |
| Increased maintenance surface | Package CI + shared ownership within OpenBMB |
