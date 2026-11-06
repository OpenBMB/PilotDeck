# Bundled skills

Runtime instruction packages shipped with PilotDeck. Each skill directory has a SKILL.md entry and may include scripts, references or runtime assets.

The [skill manager](../src/extension/skills) discovers these packages; desktop and Docker builds distribute them. Markdown here is product input, not a development handoff report. Keep names, relative resource paths, licensing and platform requirements consistent when editing a skill.

The bundled catalog focuses on general document, browser, development and local workflow capabilities. Application-specific integrations such as password managers, personal note services, mail and task boards can be installed as user skills when needed. Bundled changes never delete user-installed copies.

See [extension architecture](../src/extension/README.md) and its [tests](../tests/extension/skills).
