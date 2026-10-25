# Contributing to PilotDeck

We're excited you're interested in contributing to PilotDeck! This guide will help you get started.

## Table of Contents

- [Development Setup](#development-setup)
- [Code Style](#code-style)
- [Commit Messages](#commit-messages)
- [Pull Request Workflow](#pull-request-workflow)
- [Testing](#testing)
- [Project Structure](#project-structure)

## Development Setup

### Prerequisites

- **Node.js** ≥ 22 (see `.node-version` for exact version)
- **npm** (ships with Node.js)

### Getting Started

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/PilotDeck.git
cd PilotDeck

# Install dependencies
npm install

# Build the project
npm run build

# Start the development server
npm run dev
```

## Code Style

PilotDeck uses **TypeScript** with strict mode enabled. Please follow these conventions:

- **Formatting**: Prettier (config in `package.json`)
- **Linting**: ESLint (config in `eslint.config.*`)
- **TypeScript**: Strict mode is enabled — avoid `any` where possible
- **Imports**: Use ES module imports (`import` / `export`)
- **File naming**: PascalCase for classes/components, camelCase for utilities

Run the type checker before submitting:

```bash
npx tsc --noEmit
```

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>

[optional body]
```

Common types:

| Type     | Usage                          |
|----------|--------------------------------|
| `feat`   | A new feature                  |
| `fix`    | A bug fix                      |
| `chore`  | Maintenance/tooling            |
| `docs`   | Documentation changes          |
| `test`   | Adding or updating tests       |
| `ci`     | CI/CD configuration changes    |
| `refactor` | Code change without fix/feature |
| `style`  | Formatting, missing semicolons |

Examples:

```
feat: add support for Claude extended thinking
fix: handle rate limit errors gracefully
docs: add API reference for model providers
test: add unit tests for normalizeModelError
```

## Pull Request Workflow

1. **Fork** the repository on GitHub
2. **Clone** your fork locally
3. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/my-feature main
   ```
4. **Make your changes** with clear commit messages
5. **Push** to your fork:
   ```bash
   git push origin feat/my-feature
   ```
6. **Open a PR** on GitHub against `OpenBMB/PilotDeck:main`
7. **Respond to feedback** — maintainers may request changes

### Branch Naming

Use descriptive branch names with prefixes:

- `feat/` — new features
- `fix/` — bug fixes
- `docs/` — documentation
- `test/` — tests
- `ci/` — CI/CD changes
- `chore/` — maintenance
- `refactor/` — code refactoring

### Before Submitting

- [ ] TypeScript compiles without errors (`npx tsc --noEmit`)
- [ ] Tests pass (`npm test`)
- [ ] No `console.log` leftover in production code
- [ ] No `as any` casts unless absolutely necessary
- [ ] Commit messages follow Conventional Commits

## Testing

PilotDeck uses Node.js built-in test runner (`node:test` and `node:assert/strict`).

### Running Tests

```bash
npm test
```

### Writing Tests

Tests live in `tests/` with a mirror of the `src/` directory structure:

```
tests/
  model/
    errors/
      normalizeModelError.test.ts
    providers/
      openai/
        response.test.ts
```

Use the Node.js test runner:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { myFunction } from "../../src/path/to/module.js";

test("describes what is being tested", () => {
  const result = myFunction(input);
  assert.equal(result, expected);
});
```

## Project Structure

```
PilotDeck/
├── src/              # Source code
│   ├── adapters/     # Platform adapters (Discord, Telegram, etc.)
│   ├── agent/        # Agent loop and lifecycle
│   ├── cli/          # CLI entry point
│   ├── context/      # Context management & memory
│   ├── extension/    # Extension/plugin system
│   ├── model/        # Model providers (OpenAI, Anthropic, etc.)
│   ├── router/       # Message routing
│   └── tool/         # Tool definitions
├── tests/            # Test files
├── ui/               # Terminal UI (Ink/React)
└── scripts/          # Build and utility scripts
```

## Questions?

If you have questions, feel free to open a [Discussion](https://github.com/OpenBMB/PilotDeck/discussions) or reach out to the maintainers.

Happy coding! 🚀
