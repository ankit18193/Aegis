# Development Setup

This guide covers everything you need to get Aegis running locally.

---

## Prerequisites

Ensure the following are installed before cloning the repository:

| Tool        | Minimum Version    | Install                                                                  |
| ----------- | ------------------ | ------------------------------------------------------------------------ |
| **Node.js** | 20.0.0 (LTS)       | [nodejs.org](https://nodejs.org) or [nvm](https://github.com/nvm-sh/nvm) |
| **pnpm**    | 9.0.0              | `npm install -g pnpm`                                                    |
| **Git**     | 2.30+              | [git-scm.com](https://git-scm.com)                                       |
| **Docker**  | 24.0+ _(optional)_ | [docker.com](https://www.docker.com)                                     |

> **Recommended:** Use [nvm](https://github.com/nvm-sh/nvm) (Unix/macOS) or [nvm-windows](https://github.com/coreybutler/nvm-windows) to manage Node.js versions.
> The repository includes an `.nvmrc` entry to pin the correct version.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/your-org/aegis.git
cd aegis

# Install all workspace dependencies
pnpm install

# Copy environment configuration
cp .env.example .env
```

---

## Development Commands

All commands are run from the **repository root**.

### Building

```bash
# Build all packages and apps (TypeScript project references)
pnpm build

# Clean all build artifacts
pnpm clean
```

### Code Quality

```bash
# Run ESLint across the entire monorepo
pnpm lint

# Format all files with Prettier
pnpm format

# Check formatting without writing (useful in CI)
pnpm format:check
```

### Type Checking

```bash
# Run TypeScript type checker without emitting files
pnpm typecheck
```

### Testing

```bash
# Run all tests once
pnpm test

# Run tests in watch mode (for development)
pnpm test:watch

# Run tests with coverage report
pnpm test:coverage
```

---

## Running Applications

```bash
# Run the API server (development mode with hot reload)
cd apps/api
pnpm dev

# Run the Worker (development mode)
cd apps/worker
pnpm dev
```

> **Note (Phase 0):** The applications currently log startup info and exit. They will grow into long-running services in future phases.

---

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

For Phase 0, the default values work without changes. Required variables will be documented as infrastructure is added.

See `.env.example` for the full list of current and future variables.

---

## Editor Setup

### VS Code (Recommended)

Install the following extensions for the best experience:

- **ESLint** (`dbaeumer.vscode-eslint`)
- **Prettier** (`esbenp.prettier-vscode`)
- **TypeScript Vue Plugin** (if using frontend tooling later)

The repository includes `.vscode/settings.json` (to be added in a future commit) with recommended workspace settings.

### EditorConfig

The `.editorconfig` file in the repository root sets consistent whitespace and line ending rules. Most editors support EditorConfig natively or via plugin.

---

## Troubleshooting

### `pnpm: command not found`

```bash
npm install -g pnpm
```

### TypeScript errors after `pnpm install`

```bash
# Rebuild all TypeScript project references from scratch
pnpm build
```

### Tests failing with import errors

Ensure you've run `pnpm build` at least once to compile the packages. Vitest uses path aliases that resolve to `src/`, so building is not strictly required for tests, but package TypeScript declarations must be in sync.

### ESLint errors about `project` config

ESLint flat config (`eslint.config.mjs`) requires TypeScript `project` references to be set correctly. Ensure `tsconfig.json` files exist in all packages.

---

## Getting Help

- Review the [architecture overview](../architecture/system-overview.md)
- Read the [ADRs](../adr/) to understand key decisions
- Check [contributing guidelines](./contributing.md) before submitting changes
