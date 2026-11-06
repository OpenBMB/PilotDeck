# Skills and plugins

Discovers skills and plugins and composes their commands, prompts, hooks, tools and MCP contributions.

Entry points: [index.ts](index.ts), [skills](skills), [plugins](plugins).

SKILL.md, plugin commands and their referenced Markdown resources are runtime inputs. Keep them separate from developer documentation and delivery reports.

Standalone skills are enabled by default. The Skills library exposes a switch for each built-in, user and project entry through `skill_set_enabled` (`POST /api/skills/set-enabled`). Preferences live in `PILOT_HOME/skill-preferences.json`, outside the application payload; project entries are keyed by their absolute project path. Disabling an override restores the next enabled scope in project > user > built-in order. The management lists keep disabled entries readable and editable; conversation search and runtime prompt loading expose only enabled effective entries, including in existing sessions. Instructions already present in a running turn or conversation history are not retroactively removed.

Tests: [tests/extension](../../tests/extension). See the [test guide](../../docs/testing.md) for runner selection.
