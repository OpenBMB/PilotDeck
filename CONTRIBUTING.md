# Contributing

Use Node.js 22 and the pnpm version declared in package.json. Start with the [code map](src/README.md), [module guides](docs/README.md) and [test guide](docs/testing.md).

## Documentation

These are PilotDeck conventions; the line targets are guidance, not external standards.

- Keep one short English README.md at each public package or substantial subsystem boundary. Aim for 15–40 lines covering responsibility, real entry points, validation and links. Small internal folders use the parent guide.
- Put detailed, maintained API/protocol contracts and operational how-to guides in docs/. Keep one canonical description per topic. Write all maintained API, protocol, configuration, testing and explanatory documentation in English; keep one English version rather than parallel translations. Product UI translations and runtime instruction assets follow their functional requirements.
- Change documentation in the same PR when behavior, build commands, tests, configuration or release steps change. Verify links and commands against the current code.
- Do not commit task plans, agent conversations, handoff/completion reports, dated acceptance logs, machine-specific benchmark results, screenshot inventories or unimplemented comparison proposals. Put one-run evidence in the PR or CI artifacts. A deliberate long-lived design decision should state the decision and rationale, not recount an implementation session.
- SKILL.md, plugin commands, prompt templates and referenced runtime Markdown are product inputs. Licenses and required notices are distribution inputs. Do not remove them based on file extension or lack of static imports.

## Tests and tools

- Put backend regression cases under tests/, UI/server cases alongside their modules, browser/Electron acceptance under ui/e2e/, and desktop helper cases under apps/desktop/scripts/. Use the existing runners; retain distinct security, data-integrity and platform boundaries.
- A test must assert an observable result or contract and fail for a meaningful regression. Console-only probes, screenshot generators and temporary provider mocks are not regression cases.
- Use temporary profiles, PILOT_HOME, databases and workspaces. Stop only owned processes and clean up temporary resources. Real provider calls must be explicit opt-in and must not inherit user secrets.
- Keep reusable build/diagnostic tools in scripts/ with a documented consumer or use. Read-only import reports identify review candidates; dynamic loaders, assets and test helpers need manual checks before deletion.
- Verify the affected behavior first, then the relevant module suite. Changes to native resources, shared protocols or build inputs need the corresponding native/integration checks. Do not weaken assertions or ignore tests to make cleanup pass.

## Artifacts and privacy

- Local logs, screenshots, request dumps, preview builds, recordings and benchmark JSON belong in ignored artifacts/<topic>/ or outputs/<topic>/. They must not become required input files for a clean checkout.
- Keep fixtures synthetic and minimal. Use example.com and generic paths; inspect office/document metadata as well as visible content. Do not commit real names, personal documents, private conversations, credentials, internal endpoints or machine-specific home paths.
- Review both content and metadata of binary assets. Hydrate Git LFS media before claiming a visual privacy review; a pointer alone is not an inspected image or recording.
- Trace generation, package installation and runtime consumers before removing generated or apparently unused files. Some committed outputs are current installation inputs until the build flow is redesigned.
- Routine cleanup does not include rewriting shared Git history, deleting checkpoint refs, pruning recovery data or deleting remote branches. Handle those as explicit coordinated operations.

## Commits and review

Keep commits focused on one concern, using subjects such as chore(docs):, chore(assets):, fix(gitignore): or test(tui):. Before committing, inspect the staged diff including binary changes, run git diff --check and the relevant checks, and state the resulting behavior and validation in the PR. Link ongoing design/implementation reasoning to code where it remains useful; do not add another delivery report.

## Basis for the conventions

[GitHub README guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) motivates short entry points; [Diátaxis](https://diataxis.fr/) separates user needs and document types; [Google code review guidance](https://google.github.io/eng-practices/review/reviewer/looking-for.html) treats useful tests, maintained documentation and simplicity as code health requirements.
