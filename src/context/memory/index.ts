/**
 * Memory module — barrel exports.
 *
 * This module provides the memory integration layer between PilotDeck's
 * context runtime and the vendored edgeclaw-memory-core library.
 *
 * ## Module Boundary
 *
 * The memory system is split into two parts:
 *   1. **Adapter layer** (`src/context/memory/`) — PilotDeck-specific integration
 *   2. **Core library** (`src/context/memory/edgeclaw-memory-core/`) — vendored
 *
 * See `docs/memory-core-refactor.md` for the extraction roadmap.
 *
 * @module memory
 */

export {
  EdgeClawMemoryProvider,
  type EdgeClawMemoryProviderOptions,
  type EdgeClawMemoryServiceLike,
  type EdgeClawRetrieveContextResult,
  type EdgeClawCaptureTurnResult,
} from './EdgeClawMemoryProvider.js';

export {
  createEdgeClawMemoryProviderFromConfig,
} from './createEdgeClawMemoryProviderFromConfig.js';

export {
  type MemoryResolver,
  type MemoryRetrieveInput,
  type MemoryRetrieveResult,
  type MemoryCaptureTurnInput,
  type MemoryDiagnostic,
  type ContextMemoryMessage,
  canonicalMessagesToMemoryMessages,
} from './MemoryResolver.js';

export {
  MemoryAttachmentBuilder,
  type MemoryAttachmentBuilderInput,
  type MemoryAttachmentBuilderResult,
} from './MemoryAttachmentBuilder.js';
