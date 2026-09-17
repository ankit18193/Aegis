# Aegis - Antigravity GStack Integration

This directory contains the **Garry Tan GStack Engineering Workflow** adapted natively for **Google Antigravity** in the **Aegis** distributed AI agent execution platform.

---

## Architectural Principles

1. **Native Antigravity Execution**:
   - Workflows run using native Antigravity capabilities: slash commands, `ask_question`, `browser_subagent`, and Planning Mode.
   - Zero dependencies on Claude Code, `~/.claude`, or external proprietary subscription runners.
2. **Engineering Workflow Layer Only**:
   - GStack is strictly a developer and engineering methodology layer.
   - It is **never** imported into Aegis runtime code, never exposed via APIs, and never bundled in production containers.
3. **Repository-Local & Hermetic**:
   - All skills, workflows, and prompts reside within this repository under `.agents/` and `.antigravity/`.
   - Tool execution is deterministic, reproducible, and transparent.

---

## Directory Structure

```text
.agents/
├── ETHOS.md                 # Garry Tan Builder Ethos (Boil the Ocean, Reuse Ladder, Voice)
├── README.md                # This document
├── phases/                  # 5 lifecycle engineering phase runbooks
│   ├── 01-ideation-and-planning.md
│   ├── 02-architecture-and-design.md
│   ├── 03-implementation-and-investigation.md
│   ├── 04-review-qa-and-ship.md
│   └── 05-audit-and-retrospective.md
├── skills/                  # 26 native Antigravity skills with companion checklists & rubrics
│   ├── office-hours/
│   ├── plan-ceo-review/
│   ├── plan-eng-review/
│   ├── review/
│   ├── qa/
│   ├── ship/
│   └── ...
└── workflows/               # Slash-command workflows invokable in Antigravity
    ├── office-hours.md      # /office-hours
    ├── plan-ceo-review.md   # /plan-ceo-review
    ├── plan-eng-review.md   # /plan-eng-review
    ├── review.md            # /review
    ├── qa.md                # /qa
    ├── ship.md              # /ship
    └── ...
```

---

## Slash Command Reference

| Workflow | Slash Command | Primary Focus |
| :--- | :--- | :--- |
| **YC Office Hours** | `/office-hours` | Idea stress-testing, 6 forcing questions on demand reality |
| **CEO Plan Review** | `/plan-ceo-review` | 10-star product vision, strategic ambition, scope expansion |
| **Eng Plan Review** | `/plan-eng-review` | Architecture lock, data flows, failure modes, test matrices |
| **Design Plan Review** | `/plan-design-review` | 10-dimension design rubric, state completeness |
| **DevEx Plan Review** | `/plan-devex-review` | Time-to-Hello-World, onboarding friction, persona traces |
| **Autonomous Review** | `/autoplan` | Sequentially executes CEO → Design → DevEx → Eng review |
| **Design Consultation**| `/design-consultation`| Zero-base design system architecture |
| **Specification Author**| `/spec` | 5-phase executable technical specification authoring |
| **Pre-Landing Review** | `/review` | Multi-perspective code review (concurrency, security, migrations) |
| **Root Cause Debug** | `/investigate` | 4-phase systematic debugging protocol |
| **Autonomous QA** | `/qa` | Headless browser testing & automatic bug fixing |
| **Report-Only QA** | `/qa-only` | Browser audit producing report without touching source |
| **Browser Tool** | `/browse` | Fast visual navigation and element inspection |
| **Automated Shipping** | `/ship` | Test triage, diff review, atomic commits, PR generation |
| **Doc Sync** | `/document-release` | Sync README, architecture docs, and AGENTS.md post-ship |
| **Diataxis Docs** | `/document-generate`| Create tutorial, how-to, reference, explanation docs |
| **Code Health** | `/health` | Composite codebase health score across tests and linters |
| **Performance Audit** | `/benchmark` | Page load speed, Core Web Vitals, regression detection |
| **CSO Security Audit** | `/cso` | Threat modeling, secret archaeology, OWASP Top 10 |
| **Weekly Retro** | `/retro` | Commit cadence, shipping streak, velocity analysis |
| **Safety Guardrails** | `/careful`, `/freeze`, `/guard`, `/unfreeze` | Safe terminal and file modification boundaries |
