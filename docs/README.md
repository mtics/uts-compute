# Documentation Map

This folder captures the research basis, implementation plan, and safety policy for `uts-compute`.

Recommended reading order:

1. [research-basis.md](research-basis.md): what we know about UTS HPC, UTS iHPC, MCP, Skills, and client compatibility.
2. [fact-registry.md](fact-registry.md): source-backed facts and whether they are stable or dynamic.
3. [architecture.md](architecture.md): how MCP, Skills, profiles, schemas, templates, and plugin manifests fit together.
4. [architecture-overview.md](architecture-overview.md): cross-cutting whole-project map — layered architecture, the safety-gated experiment lifecycle, the safety spine, distribution, and ADRs (with concept diagrams).
4b. [dashboard-design.md](dashboard-design.md): baseline functional design for the lightweight Tabler experiment-tracking web UI over run records (absorbs MLflow / Aim / ClearML ideas).
4c. [webui-visual-redesign-spec.md](webui-visual-redesign-spec.md): unified visual + interaction redesign spec for the implemented webui ("Quiet Ops Console") — safety/fact baseline, profile-first attention IA, table workbench behavior, accessibility/feedback states, modal/evidence-oriented interactions, visual system, data definitions, phased P0 baseline → P1 visual skin → P2 ops-IA → P3 existing-data analysis → P4 additive data. Grounded in product/UI research and the project safety docs.
5. [mcp-skills-composition-review.md](mcp-skills-composition-review.md): official-doc and agent-audit conclusions for composing MCP, Skills, resources, prompts, and plugin shims.
5. [accounts-and-safety.md](accounts-and-safety.md): multi-account model, quota refresh, approval gates, and forbidden behavior.
6. [implementation-plan.md](implementation-plan.md): milestones, acceptance criteria, and initial project structure.
7. [validation-checklist.md](validation-checklist.md): checks before plugin installation or milestone handoff.
8. [plugin-setup.md](plugin-setup.md): shared Codex/Claude plugin setup and validation commands.
9. [client-installed-smoke-evidence.md](client-installed-smoke-evidence.md): manual release-gate evidence for real Codex and Claude Code plugin hosts.
10. [schema-migration-plan.md](schema-migration-plan.md): compatibility and dry-run rules for future persisted-state schema changes.
11. [failure-playbooks.md](failure-playbooks.md): safe triage steps for access, quota, PBS, iHPC, cancellation, artifact, and transfer failures.
12. [distribution.md](distribution.md): the distribution surfaces (Claude Code plugin, standard MCP config, etc.) and the single shared MCP server + Skills source of truth behind them.
13. [adr/0001-shared-mcp-and-skills-package.md](adr/0001-shared-mcp-and-skills-package.md): decision to share MCP and Skills across Codex and Claude Code.
14. [adr/0002-multi-account-safety.md](adr/0002-multi-account-safety.md): decision to make every account explicit and audited.
15. [adr/0003-plugin-shim-contract.md](adr/0003-plugin-shim-contract.md): decision to keep client shims thin and plugin-root relative.
16. [adr/0004-quota-envelope-autonomy.md](adr/0004-quota-envelope-autonomy.md): decision to bound autonomous actions within a refreshed quota envelope.
17. [adr/0005-standards-first-distribution.md](adr/0005-standards-first-distribution.md): decision to distribute on open standards (supersedes the dual-plugin parts of ADR 0001 and ADR 0003).

Both UTS platform documentation sites require the local UTS VPN in some access contexts. On 2026-06-15 from this machine, both target documentation URLs returned `HTTP 200 OK`, which indicates the local environment could access them at the time of verification. Use `docs.refresh` to refresh only the fixed official UTS documentation source allowlist into `.uts-computing/docs-cache/`; arbitrary URL fetching remains outside the implemented MCP boundary.
