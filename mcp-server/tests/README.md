# MCP Server Tests

Implemented test layers:

- schema validation tests;
- template rendering golden tests;
- profile redaction tests;
- local dry-run planning tests;
- M2a `access.check` tests with mocked DNS, TCP, and SSH command execution;
- M2 fixed-source `docs.refresh` tests with mocked HTTP fetching, cache schema validation, MIME/size/redirect/source-id rejection, and docs-cache resource coverage;
- M2b UTS HPC `quotas.refresh` tests with mocked SSH, PBS, and storage command execution;
- M2c UTS iHPC `quotas.refresh` tests with mocked SSH, iHPC node/session, and storage command execution;
- M3a approval-state tests for deterministic plan hashes, quota snapshot binding, expiry, rejection, and trusted-token decisions;
- M3e approval-policy tests for server-derived plan risk reasons, operation-specific reasons, profile-switch context, approval reuse checks, and protocol-level approval requests;
- M3b UTS HPC `jobs.submit` tests with mocked SSH/qsub stdin execution and approval consumption;
- M3c UTS iHPC `jobs.submit` tests with mocked SSH/supervisor stdin execution, active cnode evidence, `command_argv` validation, and approval consumption;
- M3d UTS HPC `jobs.status`, `jobs.logs`, and `jobs.cancel` tests with mocked SSH/qstat/tail/qdel execution;
- M3d UTS iHPC `jobs.status`, `jobs.logs`, and `jobs.cancel` tests with mocked SSH/fixed-Python-helper execution;
- M3f `jobs.retry.plan` tests for retry lineage, cancelled-run reason requirements, source plan tamper rejection, ambiguous workdir rejection, protocol schema coverage, UTS HPC retry submit approval isolation, and UTS iHPC supervised retry start approval/lineage isolation;
- M4 `artifacts.list`, `artifacts.fetch`, `artifacts.fetch.batch`, `artifacts.summarize`, `artifacts.cleanup.plan`, and `artifacts.cleanup.execute` tests with mocked SSH/fixed-Python-helper execution, manifest artifact ids, manifest hash checks, checksum verification, batch/cleanup approval scope hashes, terminal-run cleanup rejection, captured-checksum/size cleanup requirements, unlink-regular-files-only cleanup helpers, schema validation, approval consumption, symlink-boundary helper requirements, sanitized artifact resources, bounded JSON/JSONL/NDJSON/CSV/TSV metric extraction, tokenized filename allowlists, secret-filename/key skips, symlink skips, and local-only summary/cleanup checks;
- M4 `transfers.plan` and `transfers.execute` tests with saved transfer plans, scoped approvals, mocked SSH preflight and upload post-check helpers, helper metadata/checksum-policy mismatch rejection, mocked fixed rsync execution, bounded SHA-256 verification for checksum-eligible upload/download files, checksum mismatch rejection, skipped-large evidence, download post-rsync local verification for missing files, symlinks, parent symlink escapes, directories, partial writes, and size mismatches, total byte limits, approval consumption, sanitized transfer resources, and transfer evidence schema validation;
- M5 plugin package validation tests for shared Codex/Claude shims, plugin-root-relative paths, shared MCP config, and unsafe path rejection;
- M5 host-neutral plugin smoke checks through `npm run smoke:plugin:host-neutral`, which launches the packaged MCP server from `.mcp.json` in a temporary plugin root and runs offline tool/resource checks;
- M5 host-neutral smoke boundary tests to ensure local profile files are not copied and secret-like parent environment variables are not inherited;
- M5 client-installed smoke evidence validator tests for required Codex plus Claude Code evidence, required Skills/tools/resources/templates, manifest binding, and leak rejection;
- M5 MCP prompt protocol/static tests for guided workflow prompt inventory, required/enum arguments, all prompt bodies, no local state changes, sensitive prompt-argument redaction, Skill/approval guard language, and no live/state/action imports;
- M5 hardening tests for expanded redaction corpus and PBS qstat/tail/qdel failure behavior;
- M5 schema migration dry-run/apply tests for optional `schema_version`, unsupported version rejection, corrupt/escaped state reporting, no-write guarantees, plan-hash binding, trusted confirmation, backup creation, and approval/run-state immutability;
- MCP stdio protocol smoke tests for tool inventory, prompt inventory, structured output envelopes, allowlisted docs search, fixed-source docs refresh, strict top-level rejection of dangerous extra tool arguments before handlers run, tool-call business errors, iHPC status/log/cancel calls, resource listing, resource templates, transfer-state resources, symlink rejection, and resource reads.

Planned release evidence:

- actual evidence files captured inside real Codex and Claude Code plugin hosts and validated with `npm run client-smoke:validate -- --require-both ...`.

Default tests must not touch real VPN, DNS, TCP, SSH, UTS hosts, known_hosts, `qsub`, `qstat`, `qdel`, `pbsnodes`, `cnode`, remote filesystems, artifact paths, cleanup commands, or `rsync`; submission, job-operation, and artifact tests must use mock executors.
