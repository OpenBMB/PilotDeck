import type { AgentTranscriptDiagnostic, AgentTranscriptEntry } from "./TranscriptEntry.js";

export type TranscriptChainNode = {
  entry: AgentTranscriptEntry;
  children: TranscriptChainNode[];
};

export type TranscriptChainResult = {
  /** Entries along the longest path from root to leaf (the "active" conversation chain). */
  chain: AgentTranscriptEntry[];
  /** All leaf nodes (entries with no children). */
  leaves: AgentTranscriptEntry[];
  /** Root nodes (entries with no parent or whose parent is missing). */
  roots: AgentTranscriptEntry[];
  /** Orphaned entries whose parentEntryId points to a missing entry. */
  orphans: AgentTranscriptEntry[];
  diagnostics: AgentTranscriptDiagnostic[];
};

/**
 * Build a conversation chain from entryId / parentEntryId links. Mirrors
 * legacy `buildConversationChain()` (select the longest root→leaf path)
 * but produces a flat array instead of a linked list.
 *
 * When entries don't carry entryId (pre-chain transcripts) the function
 * falls back to sequence order — same as `replayTranscriptEntries()`.
 */
export function buildConversationChain(entries: AgentTranscriptEntry[]): TranscriptChainResult {
  const diagnostics: AgentTranscriptDiagnostic[] = [];

  const hasChainIds = entries.some((entry) => entry.entryId);
  if (!hasChainIds) {
    return {
      chain: [...entries],
      leaves: entries.length > 0 ? [entries[entries.length - 1]!] : [],
      roots: entries.length > 0 ? [entries[0]!] : [],
      orphans: [],
      diagnostics: [
        {
          code: "transcript_entry_invalid",
          severity: "warning",
          message: "No entryId found in transcript; falling back to sequence order.",
        },
      ],
    };
  }

  const byId = new Map<string, TranscriptChainNode>();
  const childIds = new Set<string>();

  for (const entry of entries) {
    if (entry.entryId) {
      byId.set(entry.entryId, { entry, children: [] });
    }
  }

  const orphans: AgentTranscriptEntry[] = [];
  for (const entry of entries) {
    if (!entry.entryId) continue;
    const parentId = entry.parentEntryId;
    if (!parentId) continue;
    const parentNode = byId.get(parentId);
    if (parentNode) {
      const childNode = byId.get(entry.entryId);
      if (childNode) {
        parentNode.children.push(childNode);
        childIds.add(entry.entryId);
      }
    } else {
      orphans.push(entry);
      diagnostics.push({
        code: "transcript_entry_invalid",
        severity: "warning",
        message: `Entry ${entry.entryId} references missing parent ${parentId}; treated as orphan.`,
      });
    }
  }

  const roots = entries.filter(
    (entry) => entry.entryId && !childIds.has(entry.entryId) && !entry.parentEntryId,
  );
  if (roots.length === 0) {
    // Circular or all-orphan: fall back to first entry with entryId.
    const firstWithId = entries.find((entry) => entry.entryId);
    if (firstWithId) {
      roots.push(firstWithId);
      diagnostics.push({
        code: "transcript_entry_invalid",
        severity: "warning",
        message: "No root entries found (possible cycle); using first entry as root.",
      });
    }
  }

  const leaves: AgentTranscriptEntry[] = [];
  for (const [, node] of byId) {
    if (node.children.length === 0) {
      leaves.push(node.entry);
    }
  }

  // Walk the longest path from any root.
  let longestPath: AgentTranscriptEntry[] = [];
  for (const root of roots) {
    const rootNode = byId.get(root.entryId!);
    if (!rootNode) continue;
    const path = findLongestPath(rootNode);
    if (path.length > longestPath.length) {
      longestPath = path;
    }
  }

  // Append orphans at the end (legacy `recoverOrphanedParallelToolResults` concept).
  const chainSet = new Set(longestPath.map((entry) => entry.entryId));
  for (const orphan of orphans) {
    if (orphan.entryId && !chainSet.has(orphan.entryId)) {
      longestPath.push(orphan);
    }
  }

  return { chain: longestPath, leaves, roots, orphans, diagnostics };
}

function findLongestPath(node: TranscriptChainNode): AgentTranscriptEntry[] {
  if (node.children.length === 0) {
    return [node.entry];
  }
  let best: AgentTranscriptEntry[] = [];
  for (const child of node.children) {
    const childPath = findLongestPath(child);
    if (childPath.length > best.length) {
      best = childPath;
    }
  }
  return [node.entry, ...best];
}
