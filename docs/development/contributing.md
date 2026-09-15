# Contributing to Aegis

Thank you for your interest in contributing to Aegis. This document describes the conventions and process for contributing changes.

---

## Prerequisites

Before contributing, ensure your development environment is set up correctly by following [setup.md](./setup.md).

---

## Branching Strategy

We use a **trunk-based development** approach:

| Branch                   | Purpose                                    |
| ------------------------ | ------------------------------------------ |
| `main`                   | Production-ready code. Always deployable.  |
| `feat/<description>`     | New features                               |
| `fix/<description>`      | Bug fixes                                  |
| `chore/<description>`    | Tooling, dependency updates, CI            |
| `docs/<description>`     | Documentation changes                      |
| `refactor/<description>` | Code restructuring without behavior change |

Branch names should be lowercase and use hyphens, not underscores.

**Example:**

```bash
git checkout -b feat/agent-repository-implementation
```

---

## Commit Convention

We follow the **Conventional Commits** specification.

### Format

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type       | When to use                                             |
| ---------- | ------------------------------------------------------- |
| `feat`     | A new feature                                           |
| `fix`      | A bug fix                                               |
| `chore`    | Build process, tooling, dependency updates              |
| `docs`     | Documentation changes only                              |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test`     | Adding or fixing tests                                  |
| `perf`     | Performance improvements                                |
| `ci`       | CI/CD configuration changes                             |

### Examples

```
feat(contracts): add ITaskExecutor interface

chore: update typescript to 5.7

docs(adr): add ADR 0005 for event streaming decision

fix(logger): resolve incorrect log level severity ordering

test(foundation): add edge cases for aggregatePlatformHealth
```

### Rules

- **Subject line**: Imperative mood, lowercase, no period at the end
- **Scope**: The package or component affected (e.g., `logger`, `api`, `contracts`)
- **Body**: Explain the _why_, not the _what_ (the diff shows the what)
- **Breaking changes**: Add `!` after the type/scope and a `BREAKING CHANGE:` footer

---

## Pull Request Process

1. **Create a branch** from `main` following the naming convention above
2. **Make your changes** following the code standards below
3. **Ensure all checks pass** locally:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   ```
4. **Write a clear PR description** explaining:
   - What this PR changes
   - Why this change is needed
   - Any testing instructions
5. **Request a review** from at least one team member
6. **Squash and merge** — each PR results in a single commit on `main`

---

## Code Standards

### TypeScript

- Use the strictest TypeScript settings (already configured in `tsconfig.base.json`)
- Prefer `type` over `interface` for pure type aliases; use `interface` for contracts that implementations satisfy
- Always use `const` unless reassignment is required
- Avoid `any` — use `unknown` and narrow properly
- Use `Result<T, E>` from `@aegis/types` for domain operations that can fail
- Use `invariant()` from `@aegis/foundation` for runtime assertions

### Module Imports

- Use explicit file extensions in imports within packages: `import { foo } from "./bar.js"`
  (Note: `.js` extension is required even for TypeScript files when using Node16 module resolution)
- Organize imports in this order (ESLint enforces this):
  1. Node.js built-ins (`node:fs`, `node:path`)
  2. External packages
  3. `@aegis/*` internal packages
  4. Relative imports

### Testing

- Place unit tests alongside source files: `health.ts` → `health.test.ts`
- Test file names match the source file they test
- Use `describe` blocks to group related tests
- Aim for meaningful test names that document behavior
- Test the public API, not implementation details

### Documentation

- All public exports must have JSDoc comments
- Internal helpers should have at minimum a one-line comment
- Keep `README.md` files in each package up to date

---

## Package Boundary Rules

Never violate the dependency graph defined in [ADR 0003](../adr/0003-package-boundaries.md):

```
foundation → types → contracts → apps
               ↓
            config
               ↓
            logger
```

If you think you need to add a dependency that would create a cycle, open a discussion first.

---

## Adding a New Package

1. Create the directory under `packages/` or `apps/`
2. Add `package.json` with the `@aegis/<name>` scope
3. Add `tsconfig.json` extending `../../tsconfig.base.json` with appropriate `references`
4. Add an `src/index.ts` barrel export
5. Add a `README.md` describing the package's responsibility and dependency rules
6. Add the package to the root `tsconfig.json` `references` array
7. Update `docs/development/project-structure.md`
