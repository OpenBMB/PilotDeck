"""Regression tests for subagent-aware parity trace normalization."""
from __future__ import annotations

import json
import unittest

from trace import (
    canonicalize,
    compare_baseline_trace_details,
    compare_trace_details,
    compare_traces,
    validate_production_sidecar_proof,
    validate_trace_expectations,
)
from run import (
    baseline_comparison_mode,
    baseline_not_applicable_reason,
    declared_extension_matches,
    scenario_for_adapter,
)


FIRST_SUBAGENT = "11111111-1111-4111-8111-111111111111"
SECOND_SUBAGENT = "22222222-2222-4222-8222-222222222222"
OTHER_SUBAGENT = "33333333-3333-4333-8333-333333333333"
FIRST_MESSAGE = "44444444-4444-4444-8444-444444444444"
SECOND_MESSAGE = "55555555-5555-4555-8555-555555555555"
FIRST_TURN = "66666666-6666-4666-8666-666666666666"
SECOND_TURN = "77777777-7777-4777-8777-777777777777"


def subagent_trace(subagent_id: str, message_id: str, turn_id: str, followup_id: str | None = None) -> dict[str, object]:
    target = followup_id or subagent_id
    return {
        "modelView": {
            "messages": [{
                "raw": {
                    "data": {"subagentId": subagent_id, "turnId": turn_id},
                    "content": [{
                        "text": f"accepted message {message_id} for subagent {subagent_id}",
                    }],
                },
            }, {
                "input": {"subagent_id": target},
            }],
            "tool_calls": [{
                "function": {
                    "name": "send_message",
                    "arguments": json.dumps({"subagent_id": target, "message": "continue"}),
                },
            }],
        },
    }


class SubagentTraceNormalizationTests(unittest.TestCase):
    def test_baseline_availability_is_scenario_specific(self) -> None:
        self.assertEqual(
            baseline_not_applicable_reason({"scenarioId": "sidecar_seed_read_state", "suite": "sidecar-production"}),
            "main Gateway client does not expose seed_read_state",
        )
        self.assertIsNone(baseline_not_applicable_reason({"scenarioId": "sidecar_live_model_stream", "suite": "sidecar-production"}))
        self.assertEqual(baseline_comparison_mode({"scenarioId": "sidecar_budget_limit"}), "unavailable")
        self.assertEqual(baseline_comparison_mode({"scenarioId": "pure_text"}), "shared")

    def test_unavailable_main_extension_does_not_forge_a_baseline_oracle(self) -> None:
        scenario = {
            "scenarioId": "sidecar_durable_compaction",
            "expected": {"terminalOutcome": "completed"},
            "expectedByPair": {"pilotdeck-native->pilotdeck-sidecar": {"terminalOutcome": "completed"}},
            "expectedByAdapter": {"pilotdeck-sidecar": {"terminalOutcome": "completed"}},
        }
        baseline = scenario_for_adapter(scenario, "pilotdeck-baseline-native")
        self.assertEqual(baseline, scenario)
        self.assertEqual(scenario_for_adapter(scenario, "pilotdeck-native"), scenario)

    def test_request_output_target_and_terminal_result_type_are_semantic(self) -> None:
        left = [{
            "kind": "model.request", "scenarioId": "output", "q": "output", "sequence": 0,
            "modelView": {"provider": "openai", "model": "test", "maxOutputTokens": 64},
        }, {
            "kind": "terminal", "scenarioId": "output", "q": "output", "sequence": 1,
            "outcome": "failed", "resultType": "aborted",
        }]
        right = [{
            "kind": "model.request", "scenarioId": "output", "q": "output", "sequence": 0,
            "modelView": {"provider": "openai", "model": "test", "maxOutputTokens": 128},
        }, {
            "kind": "terminal", "scenarioId": "output", "q": "output", "sequence": 1,
            "outcome": "failed", "resultType": "failed",
        }]
        differences = compare_traces(left, right)
        request_difference = next(item for item in differences if item.path.endswith("modelView"))
        self.assertEqual(request_difference.left["maxOutputTokens"], 64)
        self.assertEqual(request_difference.right["maxOutputTokens"], 128)
        self.assertTrue(any("resultType" in item.path for item in differences))

    def test_canonical_request_controls_are_semantic(self) -> None:
        left = [{
            "kind": "model.request", "scenarioId": "controls", "q": "controls", "sequence": 0,
            "modelView": {
                "provider": "openai", "model": "test", "cachePlan": {"mode": "off"},
                "thinking": {"enabled": False}, "toolChoice": "auto", "speed": "normal",
            },
        }]
        right = [{
            "kind": "model.request", "scenarioId": "controls", "q": "controls", "sequence": 0,
            "modelView": {
                "provider": "openai", "model": "test", "cachePlan": {"mode": "auto"},
                "thinking": {"enabled": True}, "toolChoice": "required", "speed": "fast",
            },
        }]
        self.assertTrue(compare_traces(left, right))

    def test_baseline_contract_ignores_only_declared_composition_surfaces(self) -> None:
        baseline = [{
            "kind": "model.request", "scenarioId": "shared", "q": "shared", "sequence": 0,
            "modelView": {
                "provider": "p", "model": "m", "maxOutputTokens": 10,
                "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}]}],
                "tools": [{"name": "lookup", "inputSchema": {"type": "object"}}],
            },
        }]
        current = [{
            "kind": "durable.status", "scenarioId": "shared", "q": "shared", "sequence": 0,
            "event": "context_budget", "statusKind": "status", "text": "context_budget",
        }, {
            "kind": "model.request", "scenarioId": "shared", "q": "shared", "sequence": 1,
            "modelView": {
                "provider": "p", "model": "m", "maxOutputTokens": 10,
                "messages": [
                    {"role": "user", "content": [{"type": "text", "text": "hello"}]},
                ],
                "tools": [
                    {"name": "lookup", "inputSchema": {"type": "object"}},
                    {"name": "new_extension", "inputSchema": {"type": "object"}},
                ],
            },
        }]
        scenario = {"baselineComparison": {"extensionTools": ["new_extension"]}}
        self.assertEqual(compare_baseline_trace_details(baseline, current, scenario).semantic, [])
        current[1]["modelView"]["messages"][0]["content"][0]["text"] = "changed"
        self.assertTrue(compare_baseline_trace_details(baseline, current, scenario).semantic)

    def test_baseline_contract_associates_budget_before_or_after_the_same_request(self) -> None:
        request = {
            "kind": "model.request",
            "attempt": 1,
            "modelView": {"provider": "p", "model": "m", "messages": []},
        }
        budget = {
            "kind": "context.budget",
            "used": 10,
            "displayUsed": 10,
            "total": 100,
            "effectiveTotal": 90,
            "reservedOutputTokens": 10,
            "ratio": 1 / 9,
            "state": "ok",
        }
        baseline = [request, budget, {"kind": "model.response", "attempt": 1}]
        current = [budget, {"kind": "durable.status", "event": "context_budget"}, request, {"kind": "model.response", "attempt": 1}]
        self.assertEqual(compare_baseline_trace_details(baseline, current, {}).semantic, [])

    def test_baseline_contract_rejects_changed_missing_or_duplicate_request_budget(self) -> None:
        request = {
            "kind": "model.request",
            "attempt": 1,
            "modelView": {"provider": "p", "model": "m", "messages": []},
        }
        budget = {
            "kind": "context.budget",
            "used": 10,
            "displayUsed": 10,
            "total": 100,
            "effectiveTotal": 90,
            "reservedOutputTokens": 10,
            "ratio": 1 / 9,
            "state": "ok",
        }
        baseline = [request, budget]
        changed = [{**budget, "used": 11, "displayUsed": 11, "ratio": 11 / 90}, request]
        missing = [request]
        duplicate = [budget, budget, request]
        changed_paths = {difference.path for difference in compare_baseline_trace_details(baseline, changed, {}).semantic}
        missing_paths = {difference.path for difference in compare_baseline_trace_details(baseline, missing, {}).semantic}
        duplicate_paths = {difference.path for difference in compare_baseline_trace_details(baseline, duplicate, {}).semantic}
        self.assertIn("trace[0]~[0].contextBudget.used", changed_paths)
        self.assertIn("trace[0]~[0].contextBudget.displayUsed", changed_paths)
        self.assertIn("trace[0]~[0].contextBudget", missing_paths)
        self.assertIn("trace[1]", duplicate_paths)

    def test_baseline_contract_rejects_corrupt_budget_during_declared_request_drift(self) -> None:
        baseline = [{
            "kind": "model.request",
            "modelView": {"messages": [], "tools": []},
        }, {
            "kind": "context.budget", "used": 10, "displayUsed": 10,
            "total": 100, "effectiveTotal": 90, "reservedOutputTokens": 10,
            "ratio": 1 / 9, "state": "ok",
        }]
        current = [{
            "kind": "context.budget", "used": -1, "displayUsed": -1,
            "total": 100, "effectiveTotal": 90, "reservedOutputTokens": 10,
            "ratio": 1 / 9, "state": "ok",
        }, {
            "kind": "model.request",
            "modelView": {"messages": [], "tools": [{"name": "sdk_extension"}]},
        }]
        scenario = {"baselineComparison": {"extensionTools": ["sdk_extension"]}}
        paths = {difference.path for difference in compare_baseline_trace_details(baseline, current, scenario).semantic}
        self.assertIn("trace.contextBudget.current[0].used", paths)
        del current[0]["used"]
        paths = {difference.path for difference in compare_baseline_trace_details(baseline, current, scenario).semantic}
        self.assertIn("trace.contextBudget.current[0].used", paths)

    def test_baseline_contract_rejects_synchronized_budget_bias_for_unchanged_request(self) -> None:
        baseline = [{
            "kind": "model.request",
            "modelView": {"messages": [], "tools": []},
        }, {
            "kind": "context.budget", "used": 10, "displayUsed": 10,
            "total": 100, "effectiveTotal": 90, "reservedOutputTokens": 10,
            "ratio": 1 / 9, "state": "ok",
            "breakdown": {"system": 4, "tools": 3, "messages": 3, "mcp": 0, "memory": 0, "total": 10},
        }]
        current = [{
            "kind": "context.budget", "used": 50, "displayUsed": 50,
            "total": 100, "effectiveTotal": 90, "reservedOutputTokens": 10,
            "ratio": 5 / 9, "state": "ok",
            "breakdown": {"system": 20, "tools": 10, "messages": 10, "mcp": 5, "memory": 5, "total": 50},
        }, {
            "kind": "model.request",
            "modelView": {"messages": [], "tools": []},
        }]
        paths = {difference.path for difference in compare_baseline_trace_details(baseline, current, {}).semantic}
        self.assertIn("trace[0]~[0].contextBudget.used", paths)
        self.assertIn("trace[0]~[0].contextBudget.breakdown.total", paths)

    def test_baseline_contract_allows_declared_request_drift_with_valid_breakdown(self) -> None:
        baseline = [{
            "kind": "model.request",
            "modelView": {"messages": [], "tools": []},
        }, {
            "kind": "context.budget", "used": 10, "displayUsed": 10,
            "total": 100, "effectiveTotal": 90, "reservedOutputTokens": 10,
            "ratio": 1 / 9, "state": "ok",
        }]
        current = [{
            "kind": "context.budget", "used": 50, "displayUsed": 50,
            "total": 100, "effectiveTotal": 90, "reservedOutputTokens": 10,
            "ratio": 5 / 9, "state": "ok",
            "breakdown": {"system": 20, "tools": 10, "messages": 10, "mcp": 5, "memory": 5, "total": 50},
        }, {
            "kind": "model.request",
            "modelView": {"messages": [], "tools": [{"name": "sdk_extension"}]},
        }]
        scenario = {"baselineComparison": {"extensionTools": ["sdk_extension"]}}
        self.assertEqual(compare_baseline_trace_details(baseline, current, scenario).semantic, [])

    def test_baseline_contract_rejects_inconsistent_budget_breakdown(self) -> None:
        baseline = [{
            "kind": "model.request",
            "modelView": {"messages": [], "tools": []},
        }, {
            "kind": "context.budget", "used": 10, "displayUsed": 10, "total": 100,
            "effectiveTotal": 90, "reservedOutputTokens": 10,
            "ratio": 1 / 9, "state": "ok",
        }]
        current = [{
            "kind": "context.budget", "used": 50, "displayUsed": 50, "total": 100,
            "effectiveTotal": 90, "reservedOutputTokens": 10,
            "ratio": 5 / 9, "state": "ok",
            "breakdown": {"system": 10, "tools": 10, "messages": 10, "mcp": 0, "memory": 0, "total": 50},
        }, {
            "kind": "model.request",
            "modelView": {"messages": [], "tools": [{"name": "sdk_extension"}]},
        }]
        scenario = {"baselineComparison": {"extensionTools": ["sdk_extension"]}}
        paths = {difference.path for difference in compare_baseline_trace_details(baseline, current, scenario).semantic}
        self.assertEqual(paths, {"trace.contextBudget.current[0].breakdown.total_consistency"})

    def test_baseline_contract_rejects_unrecognized_runtime_context_residual(self) -> None:
        baseline = [{"kind": "model.request", "modelView": {"messages": []}}]
        current = [{"kind": "model.request", "modelView": {"messages": [{
            "role": "user",
            "metadata": {"purpose": "runtime_context"},
            "content": [{"type": "text", "text": "Injected instruction"}],
        }]}}]
        self.assertTrue(compare_baseline_trace_details(baseline, current, {}).semantic)

    def test_baseline_contract_rejects_reordered_runtime_context_blocks(self) -> None:
        def request(blocks: list[str]) -> list[dict[str, object]]:
            return [{"kind": "model.request", "modelView": {
                "systemPrompt": "",
                "messages": [{
                    "role": "user",
                    "metadata": {"purpose": "runtime_context"},
                    "content": [{"type": "text", "text": value} for value in blocks],
                }],
            }}]
        user = "<user-context>cwd</user-context>"
        skills = "<available-skills>skills</available-skills>"
        self.assertTrue(compare_baseline_trace_details(request([user, skills]), request([skills, user]), {}).semantic)

    def test_baseline_contract_preserves_runtime_context_multiplicity(self) -> None:
        baseline = [{"kind": "model.request", "modelView": {
            "systemPrompt": "<user-context>cwd</user-context>", "messages": [],
        }}]
        current = [{"kind": "model.request", "modelView": {
            "systemPrompt": "<user-context>cwd</user-context><user-context>cwd</user-context>", "messages": [],
        }}]
        self.assertTrue(compare_baseline_trace_details(baseline, current, {}).semantic)

    def test_baseline_contract_rejects_reordered_runtime_context_tags(self) -> None:
        baseline = [{"kind": "model.request", "modelView": {
            "systemPrompt": "<user-context>cwd</user-context><available-skills>skills</available-skills>",
            "messages": [],
        }}]
        current = [{"kind": "model.request", "modelView": {
            "systemPrompt": "<available-skills>skills</available-skills><user-context>cwd</user-context>",
            "messages": [],
        }}]
        self.assertTrue(compare_baseline_trace_details(baseline, current, {}).semantic)

    def test_baseline_contract_preserves_all_request_controls_and_extra_tools(self) -> None:
        baseline = [{
            "kind": "model.request",
            "modelView": {
                "provider": "p", "model": "m", "systemPrompt": "keep",
                "cachePlan": {"mode": "auto"}, "cacheBreakpoints": [1],
                "thinking": {"enabled": True}, "toolChoice": "required", "speed": "fast",
                "tools": [{"name": "lookup"}],
            },
        }]
        for field, changed in [
            ("systemPrompt", "changed"),
            ("cachePlan", {"mode": "off"}),
            ("cacheBreakpoints", [2]),
            ("thinking", {"enabled": False}),
            ("toolChoice", "auto"),
            ("speed", "normal"),
            ("tools", [{"name": "other"}]),
        ]:
            current = json.loads(json.dumps(baseline))
            current[0]["modelView"][field] = changed
            self.assertTrue(
                compare_baseline_trace_details(baseline, current, {}).semantic,
                field,
            )

    def test_baseline_contract_compares_runtime_prompt_sections_across_projection_forms(self) -> None:
        baseline = [{
            "kind": "model.request",
            "modelView": {
                "systemPrompt": "static policy\n<user-context>\nmain cwd\n</user-context>\n<available-skills>\nmain skills\n</available-skills>",
                "messages": [],
            },
        }]
        current = [{
            "kind": "model.request",
            "modelView": {
                "systemPrompt": "static policy\n<available-skills>\nmain skills\n</available-skills>",
                "messages": [{
                    "role": "user",
                    "metadata": {"purpose": "runtime_context"},
                    "content": [{"type": "text", "text": "<runtime-context><user-context>main cwd</user-context></runtime-context>"}],
                }],
            },
        }]
        self.assertEqual(compare_baseline_trace_details(baseline, current, {}).semantic, [])
        current[0]["modelView"]["messages"] = []
        self.assertTrue(compare_baseline_trace_details(baseline, current, {}).semantic)

    def test_baseline_tool_description_contract_is_exact_without_hiding_schema(self) -> None:
        baseline = [{
            "kind": "model.request",
            "modelView": {"tools": [{
                "name": "execute_code", "description": "main description",
                "inputSchema": {"type": "object", "required": ["code"]},
            }]},
        }]
        current = [{
            "kind": "model.request",
            "modelView": {"tools": [{
                "name": "execute_code", "description": "sdk sandbox description",
                "inputSchema": {"type": "object", "required": ["code"]},
            }]},
        }]
        scenario = {"baselineComparison": {"toolDescriptionContracts": {
            "execute_code": {"baseline": "main description", "current": "sdk sandbox description"},
        }}}
        self.assertEqual(compare_baseline_trace_details(baseline, current, scenario).semantic, [])
        current[0]["modelView"]["tools"][0]["description"] = "unreviewed description"
        self.assertTrue(compare_baseline_trace_details(baseline, current, scenario).semantic)
        current[0]["modelView"]["tools"][0]["description"] = "sdk sandbox description"
        current[0]["modelView"]["tools"][0]["inputSchema"] = {"type": "object", "required": ["script"]}
        self.assertTrue(compare_baseline_trace_details(baseline, current, scenario).semantic)

    def test_extension_contract_does_not_waive_unrelated_regression(self) -> None:
        scenario = {
            "baselineComparison": {
                "mode": "extension",
                "allowedDifferences": [{
                    "pathSuffix": "terminal.outcome",
                    "baseline": "failed",
                    "current": "completed",
                }],
            },
        }
        allowed = [
            type("Difference", (), {"path": "trace[1].terminal.outcome", "left": "failed", "right": "completed"})(),
        ]
        self.assertTrue(declared_extension_matches(scenario, allowed))
        regression = allowed + [
            type("Difference", (), {"path": "trace[0].modelView", "left": {"provider": "p"}, "right": {"provider": "bad"}})(),
        ]
        self.assertFalse(declared_extension_matches(scenario, regression))

    def test_extension_contract_can_pin_adapter_specific_durable_differences(self) -> None:
        scenario = {"baselineComparison": {
            "mode": "extension",
            "allowedDifferencesByAdapter": {
                "pilotdeck-current-native": [{
                    "pathSuffix": "resultType", "baseline": None, "current": "aborted",
                }],
                "pilotdeck-current-sidecar": [],
            },
        }}
        difference = type("Difference", (), {
            "path": "trace[1].resultType", "left": None, "right": "aborted",
        })()
        self.assertTrue(declared_extension_matches(
            scenario,
            [difference],
            adapter="pilotdeck-current-native",
        ))
        self.assertFalse(declared_extension_matches(
            scenario,
            [difference],
            adapter="pilotdeck-current-sidecar",
        ))

    def test_partial_order_extension_contract_cannot_match_the_wrong_side(self) -> None:
        scenario = {"baselineComparison": {"mode": "extension", "allowedDifferences": [{
            "path": "trace.partialOrder.left.durable_steer_missing.s1[0]",
            "baseline": "durable_before_applied",
            "current": "missing",
        }]}}
        left_missing = type("Difference", (), {
            "path": "trace.partialOrder.left.durable_steer_missing.s1[0]",
            "left": "durable_before_applied", "right": "missing",
        })()
        right_missing = type("Difference", (), {
            "path": "trace.partialOrder.right.durable_steer_missing.s1[0]",
            "left": "durable_before_applied", "right": "missing",
        })()
        self.assertTrue(declared_extension_matches(scenario, [left_missing]))
        self.assertFalse(declared_extension_matches(scenario, [right_missing]))

    def test_terminal_usage_and_durable_partial_orders_are_semantic(self) -> None:
        left = [
            {"kind": "durable.status", "event": "working"},
            {"kind": "agent.status", "event": "working"},
            {"kind": "durable.steer", "itemId": "s1"},
            {"kind": "steer.applied", "itemId": "s1"},
            {"kind": "compact.boundary"},
            {"kind": "model.request", "modelView": {"messages": []}},
            {"kind": "terminal", "usage": {"inputTokens": 10, "outputTokens": 20, "nativeCost": 0.01}},
        ]
        usage_changed = json.loads(json.dumps(left))
        usage_changed[-1]["usage"]["nativeCost"] = 1
        self.assertTrue(compare_traces(left, usage_changed))
        wrong_order = [left[1], left[0], left[3], left[2], left[5], left[4], left[6]]
        self.assertTrue(compare_traces(left, wrong_order))

    def test_compaction_cycle_requires_boundary_completion_then_its_request(self) -> None:
        good = [
            {"kind": "compact.boundary", "compactionId": "compact-1"},
            {"kind": "durable.compaction_completed", "compactionId": "compact-1", "status": "compacted"},
            {"kind": "model.request", "afterCompactionId": "compact-1", "modelView": {"messages": []}},
        ]
        request_before_completion = [good[0], good[2], good[1]]
        request_before_boundary = [good[2], good[0], good[1]]
        self.assertEqual(compare_traces(good, good), [])
        self.assertTrue(compare_traces(good, request_before_completion))
        self.assertTrue(compare_traces(good, request_before_boundary))

    def test_compaction_cycles_cannot_borrow_another_cycles_request(self) -> None:
        crossed = [
            {"kind": "compact.boundary", "compactionId": "compact-a"},
            {"kind": "durable.compaction_completed", "compactionId": "compact-a", "status": "compacted"},
            {"kind": "compact.boundary", "compactionId": "compact-b"},
            {"kind": "durable.compaction_completed", "compactionId": "compact-b", "status": "compacted"},
            {"kind": "model.request", "afterCompactionId": "compact-b", "modelView": {"messages": []}},
        ]
        self.assertTrue(any(
            "compaction_followup_request_missing.compact-a" in difference.path
            for difference in compare_trace_details(crossed, crossed).semantic
        ))

    def test_deadline_oracle_requires_explicit_operation_terminal(self) -> None:
        scenario = {"expectedByAdapter": {
            "pilotdeck-current-sidecar": {"operationOutcome": "result_unknown"},
        }}
        self.assertTrue(validate_trace_expectations(
            [{"kind": "terminal", "outcome": "failed"}],
            scenario,
            "pilotdeck",
            "pilotdeck-current-sidecar",
        ))
        self.assertEqual(validate_trace_expectations(
            [{"kind": "operation.terminal", "outcome": "result_unknown"}],
            scenario,
            "pilotdeck",
            "pilotdeck-current-sidecar",
        ), [])

    def test_context_budget_gateway_event_is_semantic(self) -> None:
        left = [{"kind": "context.budget", "used": 10, "total": 100, "ratio": 0.1, "state": "ok"}]
        right = [{"kind": "context.budget", "used": 20, "total": 100, "ratio": 0.2, "state": "ok"}]
        self.assertTrue(compare_traces(left, right))

    def test_each_visible_durable_event_requires_its_own_prior_write(self) -> None:
        good = [
            {"kind": "durable.status", "event": "turn_timeout"},
            {"kind": "agent.status", "event": "turn_timeout"},
            {"kind": "durable.status", "event": "turn_timeout"},
            {"kind": "agent.status", "event": "turn_timeout"},
        ]
        missing_second_write = [
            {"kind": "durable.status", "event": "turn_timeout"},
            {"kind": "agent.status", "event": "turn_timeout"},
            {"kind": "agent.status", "event": "turn_timeout"},
        ]
        late_second_write = [
            {"kind": "durable.status", "event": "turn_timeout"},
            {"kind": "agent.status", "event": "turn_timeout"},
            {"kind": "agent.status", "event": "turn_timeout"},
            {"kind": "durable.status", "event": "turn_timeout"},
        ]
        self.assertEqual(compare_traces(good, good), [])
        self.assertTrue(compare_traces(good, missing_second_write))
        self.assertTrue(compare_traces(good, late_second_write))

    def test_skipped_compaction_is_not_a_durable_replacement(self) -> None:
        left = [{
            "kind": "durable.compaction_completed", "scenarioId": "compact", "q": "compact", "sequence": 0,
            "operationId": "one", "status": "skipped",
        }]
        right = [{
            "kind": "durable.compaction_completed", "scenarioId": "compact", "q": "compact", "sequence": 0,
            "operationId": "two", "status": "compacted",
        }]
        self.assertTrue(compare_traces(left, right))

    def test_inserted_durable_status_does_not_cascade_across_later_events(self) -> None:
        baseline = [
            {"kind": "model.request", "scenarioId": "anchor", "q": "x", "sequence": 0, "attempt": 1},
            {"kind": "terminal", "scenarioId": "anchor", "q": "x", "sequence": 1, "outcome": "completed"},
        ]
        current = [
            {"kind": "durable.status", "scenarioId": "anchor", "q": "x", "sequence": 0, "event": "context_budget"},
            {"kind": "model.request", "scenarioId": "anchor", "q": "x", "sequence": 1, "attempt": 1},
            {"kind": "terminal", "scenarioId": "anchor", "q": "x", "sequence": 2, "outcome": "completed"},
        ]
        differences = compare_traces(baseline, current)
        self.assertEqual(len(differences), 1)
        self.assertEqual(differences[0].right["kind"], "durable.status")
    def test_compaction_identity_is_normalized_without_hiding_status_semantics(self) -> None:
        left = [{
            "kind": "agent.status",
            "scenarioId": "compact",
            "q": "compact",
            "sequence": 0,
            "event": "compact_started",
            "detail": {"compactionId": FIRST_SUBAGENT, "trigger": "auto"},
        }]
        right = [{
            "kind": "agent.status",
            "scenarioId": "compact",
            "q": "compact",
            "sequence": 0,
            "event": "compact_started",
            "detail": {"compactionId": SECOND_SUBAGENT, "trigger": "auto"},
        }]
        self.assertEqual(compare_traces(left, right), [])
        right[0]["detail"]["trigger"] = "reactive"
        self.assertTrue(compare_traces(left, right))

    def test_production_sidecar_proof_fails_closed_without_real_transport_evidence(self) -> None:
        fake_runner = [{
            "kind": "harness.proof",
            "scenarioId": "proof",
            "q": "proof",
            "sequence": 0,
            "state": "transport_selected",
            "transport": "stdio",
        }]
        self.assertEqual(
            validate_production_sidecar_proof(fake_runner, {"budget"}),
            [
                "production sidecar handshake proof is missing",
                "production sidecar module proof is missing: budget",
            ],
        )

    def test_production_sidecar_proof_accepts_handshake_and_required_modules(self) -> None:
        records = [
            {"kind": "harness.proof", "state": "transport_selected", "transport": "stdio"},
            {"kind": "harness.proof", "state": "handshake_completed"},
            {"kind": "harness.proof", "state": "module_call_received", "module": "budget"},
            {"kind": "harness.proof", "state": "module_call_received", "module": "turn"},
        ]
        self.assertEqual(validate_production_sidecar_proof(records, {"budget", "turn"}), [])

    def test_production_sidecar_proof_rejects_the_wrong_operation(self) -> None:
        records = [
            {"kind": "harness.proof", "state": "transport_selected", "transport": "stdio"},
            {"kind": "harness.proof", "state": "handshake_completed"},
            {"kind": "harness.proof", "state": "module_call_received", "module": "capability", "operation": "plan_todo"},
        ]
        self.assertEqual(
            validate_production_sidecar_proof(records, {"capability"}, {"capability:execute_batch"}),
            ["production sidecar operation proof is missing: capability:execute_batch"],
        )

    def test_sidecar_production_oracles_cover_durable_and_model_evidence(self) -> None:
        scenario = {
            "expected": {
                "modelAttempts": 2,
                "modelInputContains": "durable compact summary",
                "steerAppliedCount": 1,
                "durableSteerCount": 1,
                "compactionBoundaryCount": 1,
                "compactionCompletedCount": 1,
                "compactionPersistedBeforeModel": True,
            },
        }
        records = [
            {"kind": "compact.boundary", "messages": [{"content": [{"text": "durable compact summary"}]}]},
            {"kind": "model.request", "modelView": {"messages": [{"content": [{"text": "durable compact summary"}]}]}},
            {"kind": "steer.applied", "itemId": "steer-1"},
            {"kind": "model.request", "modelView": {"messages": []}},
            {
                "kind": "durable.state",
                "durableSteerCount": 1,
                "compactionBoundaryCount": 1,
                "compactionCompletedCount": 1,
            },
        ]
        self.assertEqual(validate_trace_expectations(records, scenario, "pilotdeck", "sidecar"), [])

    def test_plan_mode_oracle_requires_host_owned_mode_across_turns(self) -> None:
        scenario = {
            "expected": {
                "terminalOutcome": "completed",
                "policyModes": ["default", "plan", "plan", "default"],
                "toolErrorCode": "plan_mode_violation",
                "sideEffectCount": 1,
            },
        }
        records = [
            {"kind": "policy.turn", "permissionMode": "default", "runMode": "agent"},
            {"kind": "policy.turn", "permissionMode": "plan", "runMode": "plan"},
            {
                "kind": "tool.finish",
                "name": "parity_write_probe",
                "success": False,
                "error": {"code": "plan_mode_violation"},
            },
            {"kind": "policy.turn", "permissionMode": "plan", "runMode": "plan"},
            {"kind": "policy.turn", "permissionMode": "default", "runMode": "agent"},
            {"kind": "side_effect.state", "sideEffectCount": 1},
            {"kind": "terminal", "outcome": "completed"},
        ]
        self.assertEqual(validate_trace_expectations(records, scenario, "pilotdeck", "sidecar"), [])

        stale_plan_mode = [dict(record) for record in records]
        stale_plan_mode[4]["permissionMode"] = "plan"
        self.assertTrue(validate_trace_expectations(stale_plan_mode, scenario, "pilotdeck", "sidecar"))

    def test_subagent_duration_is_volatile_in_objects_and_embedded_report_json(self) -> None:
        def record(duration_ms: int) -> dict[str, object]:
            report = {
                "subagentType": "general-purpose",
                "description": "Inspect one bounded task",
                "text": "same report",
                "usage": {"inputTokens": 7},
                "turns": 1,
                "durationMs": duration_ms,
            }
            return {
                "kind": "tool.result",
                "scenarioId": "one-shot",
                "q": "delegate",
                "sequence": 0,
                "result": {
                    "data": {
                        "durationMs": duration_ms,
                        "preview": "[general-purpose] inspect\n\n" + json.dumps(report),
                    },
                },
                "modelView": {
                    "content": [{"text": json.dumps(report)}],
                    "metadata": {"durationMs": duration_ms},
                },
            }

        self.assertEqual(compare_traces([record(2_034)], [record(2_046)]), [])

    def test_parent_child_interleaving_is_not_a_semantic_total_order(self) -> None:
        parent_request = {
            "kind": "model.request", "scenarioId": "continuable", "q": "delegate",
            "sequence": 0, "agentScope": "parent", "attempt": 1,
            "modelView": {"messages": [{"role": "user", "content": [{"type": "text", "text": "parent"}]}]},
        }
        child_request = {
            "kind": "model.request", "scenarioId": "continuable", "q": "delegate",
            "sequence": 1, "agentScope": "child", "attempt": 1,
            "modelView": {"messages": [{"role": "user", "content": [{"type": "text", "text": "child"}]}]},
        }
        parent_response = {
            "kind": "model.response", "scenarioId": "continuable", "q": "delegate",
            "sequence": 2, "agentScope": "parent", "attempt": 1,
            "modelView": {"content": "parent done"},
        }
        child_response = {
            "kind": "model.response", "scenarioId": "continuable", "q": "delegate",
            "sequence": 3, "agentScope": "child", "attempt": 1,
            "modelView": {"content": "child done"},
        }
        self.assertEqual(
            compare_traces(
                [parent_request, child_request, parent_response, child_response],
                [parent_request, parent_response, child_request, child_response],
            ),
            [],
        )

        changed_child = dict(child_response)
        changed_child["modelView"] = {"content": "different child result"}
        self.assertTrue(compare_traces(
            [parent_request, child_request, parent_response, child_response],
            [parent_request, parent_response, child_request, changed_child],
        ))

    def test_continuable_subagent_settlement_normalizes_identity_but_not_status(self) -> None:
        left = {"text": f"Continuable subagent {FIRST_SUBAGENT} settled: completed."}
        right = {"text": f"Continuable subagent {SECOND_SUBAGENT} settled: completed."}
        self.assertEqual(canonicalize(left), canonicalize(right))

        failed = {"text": f"Continuable subagent {SECOND_SUBAGENT} settled: failed."}
        self.assertNotEqual(canonicalize(left), canonicalize(failed))

    def test_subagent_duration_normalization_preserves_report_semantics(self) -> None:
        def record(text: str, duration_ms: int) -> dict[str, object]:
            report = {
                "text": text,
                "usage": {"inputTokens": 7},
                "turns": 1,
                "durationMs": duration_ms,
            }
            return {
                "kind": "tool.result",
                "scenarioId": "one-shot",
                "q": "delegate",
                "sequence": 0,
                "result": {"data": {"preview": "report\n" + json.dumps(report)}},
            }

        differences = compare_traces(
            [record("native report", 2_034)],
            [record("sidecar report", 2_046)],
        )
        self.assertTrue(differences)

    def test_one_shot_subagent_references_are_normalized_in_reports_and_model_input(self) -> None:
        def record(subagent_id: str, session_scope: str) -> dict[str, object]:
            report = {
                "subagentSessionId": f"/tmp/{session_scope}/home::sub::{subagent_id}",
                "transcriptRelativePath": f"{session_scope}/subagents/{subagent_id}.jsonl",
                "text": "same report",
            }
            return {
                "kind": "tool.result",
                "scenarioId": "one-shot",
                "q": "delegate",
                "sequence": 0,
                "result": {"data": {"preview": "report\n" + json.dumps(report)}},
                "modelView": {
                    "content": [{"raw": {"data": report, "metadata": report}}],
                },
            }

        self.assertEqual(
            compare_traces(
                [record(FIRST_SUBAGENT, "native")],
                [record(SECOND_SUBAGENT, "sidecar")],
            ),
            [],
        )

    def test_non_generated_one_shot_reference_remains_semantic(self) -> None:
        left = {"subagentSessionId": "stable-session", "transcriptRelativePath": "subagents/stable.jsonl"}
        right = {"subagentSessionId": "other-session", "transcriptRelativePath": "subagents/other.jsonl"}

        self.assertNotEqual(canonicalize(left), canonicalize(right))

    def test_concurrency_safe_tool_lifecycle_compares_by_tool_and_phase(self) -> None:
        def event(kind: str, name: str, tool_call_id: str, sequence: int) -> dict[str, object]:
            result = {"toolName": name, "toolCallId": tool_call_id, "type": "success"} if kind == "tool.result" else None
            return {
                "kind": kind,
                "scenarioId": "parallel-tools",
                "q": "compare",
                "sequence": sequence,
                "name": name if kind != "tool.result" else None,
                "toolCallId": tool_call_id,
                "result": result,
                "concurrencySafe": True,
                "sideEffectCount": 0,
            }

        serial = [
            event("tool.call", "lookup", "call-1", 0), event("tool.start", "lookup", "call-1", 1),
            event("tool.finish", "lookup", "call-1", 2), event("tool.result", "lookup", "call-1", 3),
            event("tool.call", "summarize", "call-2", 4), event("tool.start", "summarize", "call-2", 5),
            event("tool.finish", "summarize", "call-2", 6), event("tool.result", "summarize", "call-2", 7),
        ]
        interleaved = [
            event("tool.call", "lookup", "call-1", 0), event("tool.start", "lookup", "call-1", 1),
            event("tool.call", "summarize", "call-2", 2), event("tool.start", "summarize", "call-2", 3),
            event("tool.finish", "lookup", "call-1", 4), event("tool.result", "lookup", "call-1", 5),
            event("tool.finish", "summarize", "call-2", 6), event("tool.result", "summarize", "call-2", 7),
        ]

        self.assertEqual(compare_traces(serial, interleaved), [])

    def test_concurrency_canonicalization_requires_unique_identities_and_no_side_effect(self) -> None:
        def event(kind: str, sequence: int, *, tool_call_id: str = "call-1", side_effect_count: int = 0) -> dict[str, object]:
            return {
                "kind": kind,
                "scenarioId": "parallel-tools",
                "q": "compare",
                "sequence": sequence,
                "name": "lookup",
                "toolCallId": tool_call_id,
                "concurrencySafe": True,
                "sideEffectCount": side_effect_count,
            }

        repeated = [event("tool.call", 0), event("tool.call", 1), event("tool.finish", 2)]
        reordered_repeated = [event("tool.call", 0), event("tool.finish", 1), event("tool.call", 2)]
        self.assertTrue(compare_traces(repeated, reordered_repeated))

        side_effect = [event("tool.call", 0, tool_call_id="call-1", side_effect_count=1), event("tool.call", 1, tool_call_id="call-2", side_effect_count=1), event("tool.finish", 2, tool_call_id="call-1", side_effect_count=1)]
        reordered_side_effect = [event("tool.call", 0, tool_call_id="call-1", side_effect_count=1), event("tool.finish", 1, tool_call_id="call-1", side_effect_count=1), event("tool.call", 2, tool_call_id="call-2", side_effect_count=1)]
        self.assertTrue(compare_traces(side_effect, reordered_side_effect))

    def test_non_concurrent_tool_lifecycle_order_remains_semantic(self) -> None:
        def event(kind: str, name: str, sequence: int) -> dict[str, object]:
            return {
                "kind": kind,
                "scenarioId": "ordered-tools",
                "q": "compare",
                "sequence": sequence,
                "name": name,
                "concurrencySafe": False,
            }

        serial = [event("tool.call", "first", 0), event("tool.finish", "first", 1), event("tool.call", "second", 2)]
        interleaved = [event("tool.call", "first", 0), event("tool.call", "second", 1), event("tool.finish", "first", 2)]

        self.assertTrue(compare_traces(serial, interleaved))

    def test_uuid_backed_subagent_references_compare_by_relationship(self) -> None:
        native = subagent_trace(FIRST_SUBAGENT, FIRST_MESSAGE, FIRST_TURN)
        sidecar = subagent_trace(SECOND_SUBAGENT, SECOND_MESSAGE, SECOND_TURN)

        self.assertEqual(canonicalize(native), canonicalize(sidecar))

    def test_wrong_followup_target_is_not_normalized_away(self) -> None:
        native = subagent_trace(FIRST_SUBAGENT, FIRST_MESSAGE, FIRST_TURN)
        wrong_target = subagent_trace(SECOND_SUBAGENT, SECOND_MESSAGE, SECOND_TURN, OTHER_SUBAGENT)

        self.assertNotEqual(canonicalize(native), canonicalize(wrong_target))

    def test_non_generated_subagent_ids_remain_semantic(self) -> None:
        left = {"subagent_id": "review-child"}
        right = {"subagent_id": "build-child"}

        self.assertNotEqual(canonicalize(left), canonicalize(right))

    def test_parent_close_is_an_explicit_oracle_condition(self) -> None:
        records = [{
            "kind": "sidecar.lifecycle",
            "scenarioId": "parent-close",
            "q": "close",
            "sequence": 0,
            "state": "parent_closed",
            "parentClosed": True,
        }]

        self.assertEqual(
            validate_trace_expectations(records, {"expected": {"parentClosed": True}}, "pilotdeck"),
            [],
        )

    def test_parent_and_sidecar_lifecycle_are_independently_ordered_actors(self) -> None:
        parent_request = {"kind": "model.request", "attempt": 2, "modelView": {"messages": []}}
        requested = {"kind": "sidecar.lifecycle", "state": "parent_close_requested", "stage": "child_model_started"}
        closed = {"kind": "sidecar.lifecycle", "state": "parent_closed", "stage": "child_first_drain", "parentClosed": True}
        self.assertEqual(
            compare_traces([requested, parent_request, closed], [parent_request, requested, closed]),
            [],
        )
        self.assertTrue(compare_traces([requested, parent_request, closed], [parent_request, closed, requested]))

    def test_parent_close_forbids_late_model_request(self) -> None:
        closed = {"kind": "sidecar.lifecycle", "state": "parent_closed", "parentClosed": True}
        requested = {"kind": "sidecar.lifecycle", "state": "parent_close_requested"}
        request = {"kind": "model.request", "attempt": 2, "modelView": {"messages": []}}
        self.assertTrue(compare_traces([requested, closed, request], [requested, closed]))

    def test_parent_abort_requires_acknowledgement_and_one_gateway_terminal(self) -> None:
        records = [
            {
                "kind": "sidecar.lifecycle",
                "scenarioId": "parent-abort",
                "q": "abort",
                "sequence": 0,
                "state": "parent_abort_acknowledged",
                "parentAborted": True,
            },
            {
                "kind": "sidecar.lifecycle",
                "scenarioId": "parent-abort",
                "q": "abort",
                "sequence": 1,
                "state": "parent_abort_settled",
                "parentAborted": True,
                "terminalCount": 1,
            },
        ]

        self.assertEqual(
            validate_trace_expectations(
                records,
                {"expected": {"parentAborted": True, "terminalCount": 1}},
                "pilotdeck",
            ),
            [],
        )


if __name__ == "__main__":
    unittest.main()
