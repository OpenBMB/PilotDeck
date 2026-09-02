# edgeclaw-memory-core

**Vendored dependency** — currently embedded in the PilotDeck source tree.

This directory contains a vendored copy of the `edgeclaw-memory-core` library,
an LLM-powered memory management system. It provides:

- **Indexed retrieval**: Semantic / vector search over conversation history
- **File-backed memory**: Persist knowledge across sessions
- **Heartbeat pipeline**: Periodic memory review and consolidation
- **Dream review**: Reflection on past interactions for insight extraction
- **LLM extraction**: Structured data extraction from free-form memory
- **SQLite storage**: Local persistence layer

## Current Status

- **Version**: `0.0.0` (private, pre-release)
- **Package name**: `edgeclaw-memory-core`
- **Entry**: `lib/index.js` (compiled from `src/index.ts`)
- **Build**: `npm run build` (runs `tsc` from within this directory)

## Usage

```typescript
import { EdgeClawMemoryService } from "edgeclaw-memory-core";

const service = new EdgeClawMemoryService({
  // options...
});
```

## Migration Plan

This library is planned for extraction to a standalone npm package
`@openbmb/memory-core`. See `docs/memory-core-refactor.md` for the
detailed roadmap.

## Build

```bash
cd src/context/memory/edgeclaw-memory-core
npm run build   # outputs to lib/
```

## Internal Architecture

```
src/
├── index.ts              — public barrel exports
├── message-utils.ts      — message format utilities
├── service.ts            — EdgeClawMemoryService
├── core/
│   ├── index.ts          — core barrel
│   ├── types.ts          — shared types
│   ├── file-memory.ts    — file-backed memory
│   ├── general-projects.ts — project-level memory
│   ├── trace-i18n.ts     — internationalized tracing
│   ├── pipeline/
│   │   └── heartbeat.ts  — periodic review pipeline
│   ├── retrieval/
│   │   └── reasoning-loop.ts — semantic retrieval
│   ├── review/
│   │   └── dream-review.ts — insight extraction
│   ├── skills/
│   │   └── llm-extraction.ts — structured data extraction
│   ├── storage/
│   │   └── sqlite.ts     — SQLite persistence
│   └── utils/
│       ├── id.ts         — ID generation
│       └── text.ts       — text processing utilities
```
