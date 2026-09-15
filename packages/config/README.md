# @aegis/config

**Centralized configuration handling for the Aegis platform.**

## Responsibility

This package provides typed, validated access to configuration values. All platform services read their configuration through this package — never directly from `process.env`.

## Current State (Phase 0)

The Phase 0 implementation provides minimal environment variable helpers:

| Export                      | Description                                     |
| --------------------------- | ----------------------------------------------- |
| `getNodeEnv()`              | Returns the current `NODE_ENV` as a typed value |
| `isProduction()`            | Returns true in production environments         |
| `requireEnv(key)`           | Reads a required env var, throws if missing     |
| `optionalEnv(key, default)` | Reads an optional env var with fallback         |
| `loadBaseConfig()`          | Returns a typed `BaseConfig` object             |

## Future State

In future phases this package will:

- Validate all configuration using `zod` schemas
- Support config file loading (`.env`, JSON, YAML)
- Provide per-service config objects (`ApiConfig`, `WorkerConfig`, etc.)
- Support hot-reloading for non-sensitive config

## Dependency Rule

```
@aegis/config
    ↑         ↑
@aegis/types  @aegis/foundation
```

## Usage

```ts
import { loadBaseConfig, requireEnv } from "@aegis/config";

const config = loadBaseConfig();
const dbUrl = requireEnv("DATABASE_URL");
```
