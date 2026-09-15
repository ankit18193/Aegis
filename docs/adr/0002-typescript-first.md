# ADR 0002 — TypeScript First

| Field        | Value            |
| ------------ | ---------------- |
| **Status**   | Accepted         |
| **Date**     | 2025-01-01       |
| **Deciders** | Engineering Team |

---

## Context

Aegis requires a language for the primary platform implementation. The main candidates are:

1. **TypeScript** (Node.js runtime)
2. **Go**
3. **Python**
4. **Rust**

Key requirements:

- Strong static typing for a complex distributed system
- Rich ecosystem for AI/LLM SDKs (all major providers publish Node.js SDKs first)
- Good async/concurrent programming support
- Monorepo tooling maturity
- Team familiarity

---

## Decision

We will use **TypeScript** as the primary language for all platform components.

**Strict TypeScript configuration** will be enforced from day one, including:

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true,
  "exactOptionalPropertyTypes": true,
  "noPropertyAccessFromIndexSignature": true
}
```

These settings prevent entire classes of runtime errors common in distributed systems:

- `noUncheckedIndexedAccess` prevents array/object access without bounds checking
- `exactOptionalPropertyTypes` prevents `{ key: undefined }` from matching `{ key?: string }`
- `noImplicitOverride` prevents accidental method overriding in class hierarchies

**Runtime:** Node.js 20+ (LTS), targeting ES2022.

**Module system:** Native ES modules (`"type": "module"`) with `"module": "Node16"` resolution.

---

## Consequences

**Positive:**

- All major AI SDK providers (OpenAI, Anthropic, Google) ship official Node.js TypeScript SDKs
- Strict typing catches correctness issues at compile time rather than runtime
- Single language across all packages eliminates context switching
- TypeScript project references enable incremental compilation
- Excellent editor support (VS Code, etc.)

**Negative:**

- TypeScript compilation adds a build step not present in plain JavaScript
- Strict settings (`exactOptionalPropertyTypes` etc.) require more explicit type annotations
- Node.js is not ideal for CPU-intensive workloads (planned mitigation: offload to dedicated workers or native extensions where needed)

**Not chosen:**

- **Go** — Excellent for services, but AI SDK ecosystem is weaker; cross-language monorepo is harder
- **Python** — Rich ML ecosystem but weaker type system and slower ecosystem tooling at scale
- **Rust** — Ideal performance characteristics but steep learning curve and slower iteration cycle
