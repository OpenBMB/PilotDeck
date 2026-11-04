# Industry Landscape Research — Agent Skill v2.2

> A structured methodology that turns an LLM-based agent into a systematic industry analyst.  
> 102 files · 85 source assets · 8-step framework · 7 base archetypes + 1 modifier · 6 JSON schemas · 12 visualization templates · 5 domain-specific source recipes

---

## What Is This?

This is an **Agent Skill** — a portable knowledge package designed to be loaded into LLM-based agents (Claude, GPT, Qwen, etc.) to give them a repeatable, auditable, professional-grade industry research capability.

Instead of writing a 50-page prompt every time you want an AI to do market research, you load this skill and it knows:

- How to structure the research (8-step framework)
- What to look for depending on industry type (7 archetypes)
- How to validate data quality (L1-L4 grading + JSON Schema)
- How to avoid common pitfalls (7 cognitive biases, including LLM training-cutoff bias)
- How to produce consistent deliverables (12 visualization templates, editorial dark theme)

---

## The Problem It Solves

When you ask an LLM "research the MaaS industry", you typically get:

- Surface-level summaries rehashing Wikipedia
- Outdated model names and prices (training cutoff bias)
- No source citations or data quality grading
- No framework for what "complete" means
- Inconsistent output formats every time

This skill transforms that into:

- Structured 8-step research with explicit coverage audits
- Every data point carries a 4-tuple: `{value, source, as_of_date, grade}`
- Blocking gates that prevent the agent from proceeding with incomplete data
- Recency guardrails that force live-fetching for fast-moving industries
- Reproducible deliverable templates

---

## Architecture

```
industry-landscape-research/
├── SKILL.md              # Main entry — framework + archetype selector + quick start
├── INDEX.md              # One-page file index (this is the map)
├── archetypes/           # 7 base industry archetypes + 1 modifier
│   ├── platform.md       #   Two-sided platforms
│   ├── saas-vertical.md  #   Vertical SaaS
│   ├── marketplace.md    #   Marketplaces
│   ├── consumer.md       #   Consumer apps
│   ├── deeptech-hardware.md  # DeepTech / Hardware
│   ├── infrastructure.md #   Cloud / Infra
│   ├── content-media.md  #   Content / Media
│   └── _modifier-rapidly-evolving.md  # ⚡ Overlay for fast-moving catalog industries
├── workflows/            # Step-by-step SOPs
│   ├── 00-execution-plan.md
│   ├── 01-research-charter.md
│   ├── 02-three-round-search.md   # Includes R0 Recency Sweep gate
│   ├── 03-analysis-frameworks.md
│   ├── 04-coverage-audit.md
│   ├── 05-quant-modeling.md
│   ├── 06-thesis-synthesis.md
│   └── 07-deliverable-assembly.md
├── schemas/              # JSON Schema for data validation
│   ├── company.schema.json
│   ├── event.schema.json
│   ├── racetrack.schema.json
│   ├── sku.schema.json          # v2.2: SKU-level data
│   ├── source.schema.json
│   └── deliverable.schema.json
├── references/           # Deep reference library
│   ├── bias-checklist.md        # 7 cognitive biases (incl. training-cutoff)
│   ├── recency-guardrail.md     # 6 gates against stale data
│   ├── refresh-cadence.md       # Data freshness matrix
│   ├── side-channel-intel.md    # 6 alternative intelligence sources
│   ├── source-recipes/          # Domain-specific data sourcing
│   │   ├── maas-and-models.md   # MaaS / LLM APIs
│   │   ├── medical.md
│   │   ├── semiconductor.md
│   │   ├── auto.md
│   │   ├── fintech.md
│   │   └── energy.md
│   └── ...
├── templates/
│   ├── subagent-*.md            # 5 sub-agent prompt templates
│   ├── calculators/             # Unit economics (Python + Excel)
│   └── visualizations/          # 12 SVG/HTML editorial dark-theme skeletons
├── scripts/
│   ├── validate.py              # Pure-stdlib JSON Schema validator
│   └── Makefile                 # make validate / unit-economics / all
└── examples/             # 5 complete worked examples
    ├── ex-aigc-image/
    ├── ex-saas-legaltech/
    ├── ex-marketplace-crossborder/
    ├── ex-deeptech-autonomous/
    └── ex-maas-llm/             # v2.2: Demonstrates recency guardrails
```

---

## The 8-Step Framework

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Charter        Define scope, sign-off, kill criteria         │
│ 2. Decompose      Break into racetracks + sub-ecosystems        │
│ 3. Three-Round    R0 Recency Sweep → R1 Breadth → R2 Depth     │
│    Search         → R3 Fill gaps + cross-validate               │
│ 4. Coverage       Quantified completeness gate (🔴 blocks)      │
│    Audit                                                        │
│ 5. Frameworks     Porter 5 / 7 Powers / Wardley / JTBD          │
│ 6. Quant Model    Unit economics, TAM/SAM/SOM, profit pool      │
│ 7. Thesis         House View + 3 scenarios + Pre-mortem          │
│ 8. Deliverable    6+2 chapter report + 15 artifacts             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### Why "Archetypes + Modifiers"?

A SaaS company and a hardware company require fundamentally different analysis. Rather than one-size-fits-all, the skill has 7 base archetypes (each with mandatory analysis items) plus orthogonal **modifiers** that overlay additional requirements.

Example: Researching MaaS = `Infrastructure` archetype + `Rapidly-Evolving Catalog` modifier.

### Why a "Data 4-Tuple"?

Every single number in the output carries:

```json
{
  "value": 2.5,
  "source": "https://openai.com/pricing",
  "as_of": "2026-06-20",
  "grade": "L1"
}
```

This makes every claim auditable and tells you exactly when it will expire.

### Why "Training Cutoff Bias" as a First-Class Concern?

LLMs confidently state outdated facts. In fast-moving industries (AI models, SaaS tools, crypto), this produces reports that look complete but are 6-18 months stale. The skill addresses this with:

- **Today Date Stamp** — force the agent to acknowledge the current date
- **Recency Sweep** — mandatory search for "last 90 days" before anything else
- **Live Pricing Fetch** — never quote a price from memory, always `curl` the page
- **Third-Party Aggregator Cross-Check** — OpenRouter, ArtificialAnalysis, LMArena
- **Self-Disclosure** — agent must state its training cutoff and flag affected fields

---

## Quick Start

### For Agent Platforms (QoderWork, Claude Projects, GPTs)

1. Upload the `.skill` file (or point to this repo)
2. The agent automatically loads `SKILL.md` as its system knowledge
3. Ask: "帮我做一个 MaaS 行业调研" or "Research the autonomous driving landscape"

### For Manual Use

1. Read `workflows/00-execution-plan.md` for the overall flow
2. Fill the `workflows/01-research-charter.md` template
3. Pick 1-2 archetypes from `archetypes/`
4. Follow Steps 3-8 in sequence

---

## Example Cases

### Case 1: "Compare LLM API pricing across vendors"

**Triggers**: `_modifier-rapidly-evolving.md` (monthly releases, SKU > 20, pricing changes)

**What the skill does differently**:
- Forces R0 Recency Sweep before R1 (fetches each vendor's pricing page live)
- Outputs a SKU Matrix with 13+ models, not just "the famous 3"
- Cross-checks against OpenRouter/ArtificialAnalysis for completeness
- Prices carry `as_of` dates and L-grades; anything > 7 days old is flagged

**Output**: SKU Pricing Matrix (HTML) + Version Timeline (SVG) + companies.jsonl + skus.jsonl

---

### Case 2: "全景分析跨境电商 Marketplace"

**Triggers**: `marketplace.md` archetype (GMV, take rate, liquidity, two-sided dynamics)

**What the skill does differently**:
- Enforces Marketplace-specific metrics: GMV ≠ Revenue, take rate decomposition, supply-side vs demand-side unit economics
- Requires 15+ companies per racetrack (not just Shein/Temu/Amazon)
- Dead Pool tracking for failed cross-border attempts
- Regulatory landscape (tariff changes, Entity List, VAT rules)

**Output**: Landscape Grid (SVG) + Valuation Leaderboard (HTML) + Unit Economics table + 3-scenario thesis

---

### Case 3: "Legal Tech SaaS competitive landscape"

**Triggers**: `saas-vertical.md` archetype (NRR, CAC payback, vertical know-how depth)

**What the skill does differently**:
- NRR / GRR / Magic Number / Rule of 40 / Burn Multiple mandatory
- Sources include court filing databases, bar association publications, legal tech conference decks
- Distinguishes "horizontal legal tools" from "true vertical SaaS with domain-embedded AI"
- Coverage Audit blocks delivery until Tier 2/3 companies are also profiled

**Output**: Company Deep-Dive Cards (HTML) + Unit Economics Calculator output + Porter 5 Forces Radar (SVG)

---

## Iteration History

| Version | Date | Theme |
|---------|------|-------|
| v1.0 | 2026-06 | Single-file prompt (~4K tokens) |
| v2.0 | 2026-06-24 | Multi-file package: 8 steps, 7 archetypes, SSOT, schemas, Coverage Audit |
| v2.1 | 2026-06-24 | +3 examples, +validators, +calculators, +10 visualizations, +5 source recipes, +glossary |
| v2.2 | 2026-06-24 | Training-cutoff bias fix: modifier system, recency guardrails, SKU schema, side-channel intel, MaaS example |

### Design Philosophy Behind Each Iteration

**v1 → v2**: A single prompt couldn't enforce process. Breaking into files = each step becomes a gate, not a suggestion. The agent can be told "don't proceed past Step 4 until Coverage Audit passes."

**v2.0 → v2.1**: Methods without tools are just advice. Adding validators, calculators, and visualization templates means the agent can actually *run* the methodology (not just describe it).

**v2.1 → v2.2**: Real-world failure mode exposed: LLMs confidently output stale catalogs for fast-moving industries. Fix = make "recency" a first-class architectural concern (modifier + guardrails + live-fetch enforcement), not an afterthought.

### What's Next (Roadmap)

- **v2.3** (planned): `tests/` directory with golden-file regression tests for validate.py; `data/` directory with a live-state example; CI pipeline for automated freshness checks
- **v2.4** (planned): Additional modifiers (Regulatory-Heavy, B2G/Government, Creator Economy); multi-language Charter templates (EN/CN/JP)
- **v3.0** (exploratory): MCP server wrapper — expose the skill as a tool server that any MCP-compatible agent can call directly

---

## How to Contribute

1. **New archetype?** Copy any file in `archetypes/`, follow the structure (Trigger Conditions → Mandatory Outputs → Metrics → Pitfalls)
2. **New source recipe?** Copy `references/source-recipes/medical.md` as template, fill 6 sections
3. **New visualization?** Follow the editorial dark theme spec in `templates/visualizations/README.md` (#0F1115 + #C9A87C + #4A90E2)
4. **Found a bias pattern?** Add to `references/bias-checklist.md` following the Symptom → Self-Check → Countermeasure format

Run `make validate` before submitting to ensure 0 errors.

---

## License

MIT

---

## Acknowledgments

Built through iterative real-world testing: AIGC image generation landscape, legal tech SaaS, cross-border e-commerce, autonomous driving, and MaaS/LLM API research. Each iteration fixed failures discovered in actual agent-driven research sessions.