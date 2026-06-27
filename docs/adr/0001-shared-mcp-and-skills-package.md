# ADR 0001: Shared MCP And Skills Package

## Status

Accepted.

## Context

The package must serve both Codex and Claude Code. Both clients can use Skills and MCP, but their plugin manifests and installation details differ.

UTS HPC and UTS iHPC also require live checks because platform documentation, quotas, queues, sessions, and account permissions can change.

## Decision

Use one shared MCP server and one shared `skills/` directory.

Client-specific plugin files remain thin wrappers:

- `.codex-plugin/`
- `.claude-plugin/`
- `.codex.mcp.json`
- `.mcp.json`

The shared implementation owns:

- MCP tools;
- profiles;
- schemas;
- templates;
- audit state;
- platform adapters.

## Consequences

Benefits:

- avoids divergent behavior between Codex and Claude Code;
- makes platform safety policy easier to enforce;
- supports multi-account behavior consistently;
- lets Skills remain short and client-neutral.

Tradeoffs:

- packaging needs two manifest shims;
- client-specific setup must be documented separately;
- exact plugin manifest fields may need adjustment during packaging validation.
