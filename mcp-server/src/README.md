# Source Layout

Current implementation keeps the MCP entrypoint small and puts platform-specific behavior behind narrow modules:

```text
src/
  index.ts              MCP stdio entrypoint
  config.ts             profile loading, validation, and redaction
  docs.ts               allowlisted local docs catalog/search and fixed-source docs cache refresh
  planner.ts            job-spec validation, template rendering, plan hashing
  submit.ts             approved UTS HPC PBS and UTS iHPC live starts
  jobs.ts               status, bounded logs, and cancellation adapters
  artifacts.ts          M4 manifest list/fetch/batch-fetch/summary/cleanup-plan/cleanup-execute tools
  transfer.ts           fixed-file transfer planning and execution adapter
  migrations.ts         read-only local state schema migration dry-run scanner
  quotas.ts             read-only platform quota/session snapshots
  access.ts             read-only VPN/DNS/TCP/SSH preflight
  resources.ts          read-only MCP resources
  prompts.ts            user-invoked workflow prompt templates
  audit.ts              local run records and redaction
```

Keep platform-specific SSH and command logic inside narrow adapters and helper modules. Do not add a generic remote shell tool.
