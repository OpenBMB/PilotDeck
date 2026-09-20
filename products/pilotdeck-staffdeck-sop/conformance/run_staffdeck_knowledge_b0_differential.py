#!/usr/bin/env python3
"""Run fixed StaffDeck B0 and candidate citation behavior in isolated interpreters."""

from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path


BASELINE_ROOT = Path(
    os.environ.get("STAFFDECK_B0_ROOT", "/tmp/pilotdeck-staffdeck-m0.j4voeS/staffdeck-b0")
)
CANDIDATE_ROOT = Path(
    os.environ.get("STAFFDECK_CANDIDATE_ROOT", "/Users/a1/Desktop/claw/openbmb/StaffDeck-portable-sop")
)


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--single":
        print(json.dumps(run_fixture(Path(sys.argv[2])), ensure_ascii=True, sort_keys=True))
        return

    baseline = run_isolated(BASELINE_ROOT)
    candidate = run_isolated(CANDIDATE_ROOT)
    if candidate != baseline:
        raise AssertionError(
            "StaffDeck Knowledge citation differential mismatch\n"
            f"expected={json.dumps(baseline, ensure_ascii=True, sort_keys=True)}\n"
            f"actual={json.dumps(candidate, ensure_ascii=True, sort_keys=True)}"
        )

    altered = copy.deepcopy(candidate)
    altered["citations"][0], altered["citations"][1] = (
        altered["citations"][1],
        altered["citations"][0],
    )
    if altered == candidate:
        raise AssertionError("Comparator sensitivity fixture did not detect changed knowledge hit order")

    print(
        json.dumps(
            {
                "status": "PASS",
                "baseline": str(BASELINE_ROOT),
                "candidate": str(CANDIDATE_ROOT),
                "cases": [
                    "citation-label-order",
                    "knowledge-result-priority-and-rank-order",
                    "truncated-email-restoration",
                ],
                "compared": 3,
            },
            indent=2,
        )
    )


def run_isolated(root: Path) -> dict[str, object]:
    completed = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--single", str(root)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def run_fixture(root: Path) -> dict[str, object]:
    sys.path.insert(0, str(root / "backend"))
    from app.knowledge.citations import (  # pylint: disable=import-outside-toplevel
        compact_knowledge_citation_labels,
        knowledge_citations_from_results,
        restore_truncated_atomic_references,
    )

    compacted_content, compacted_citations = compact_knowledge_citation_labels(
        "Review [3], then [1], and remove [99].\nReference sources: [3] [1]",
        [
            {"id": "kref_a", "label": "[1]", "chunk_id": "chunk-a", "document_id": "doc-a", "excerpt": "A"},
            {"id": "kref_b", "label": "[2]", "chunk_id": "chunk-b", "document_id": "doc-b", "excerpt": "B"},
            {"id": "kref_c", "label": "[3]", "chunk_id": "chunk-c", "document_id": "doc-c", "excerpt": "C"},
        ],
    )
    citations = knowledge_citations_from_results(
        [
            {
                "evidence_pack": [
                    {"chunk_id": "older", "document_id": "old-doc", "source_path": "older.md", "content": "older evidence"}
                ]
            },
            {
                "evidence_pack": [
                    {"chunk_id": "rank-1", "document_id": "doc-1", "source_path": "first.md", "content": "first evidence", "title": "First"},
                    {"chunk_id": "rank-2", "document_id": "doc-2", "source_path": "second.md", "content": "second evidence", "title": "Second"},
                ],
                "selected_concepts": [{"id": "not-used", "content": "concept fallback"}],
            },
        ],
        limit=4,
    )
    restored = restore_truncated_atomic_references(
        "Contact support@example... for help.",
        [{"excerpt": "For assistance use support@example.com."}],
    )
    return {
        "compactedContent": compacted_content,
        "compactedCitations": compacted_citations,
        "citations": citations,
        "restored": restored,
    }


if __name__ == "__main__":
    main()
