---
name: consult-platform-docs
description: Consult the official UTS HPC / iHPC documentation when you are unsure how a platform operation works, hit an unfamiliar error or scheduler behaviour, need an authoritative platform rule (queue / node-limit / GPU / usage-policy), or the user asks for something this plugin's tools do not cover. Refresh and read the official docs (`docs.refresh` → `uts://docs-cache`) BEFORE guessing, fabricating PBS/quota details, or declining.
---

# Consult Official UTS Platform Docs

The official **UTS HPC** ([hpc.research.uts.edu.au](https://hpc.research.uts.edu.au/)) and **UTS iHPC**
([ihpc.research.uts.edu.au](https://ihpc.research.uts.edu.au/)) documentation is a thorough,
authoritative usage guide. When you are uncertain, **read it before you guess**. The plugin already
caches a fixed allowlist of these pages, so you never need (and must never use) a browser or raw `curl`.

## When to reach for this

- You are unsure how a UTS HPC (PBS) or iHPC operation actually works — directive syntax, queue
  selection, GPU request, node families, walltime/memory limits, module/environment setup.
- An error message, `qstat`/scheduler state, or platform behaviour is unfamiliar.
- You need an **authoritative platform rule**: queue limits, **node limits** (per-pool, per-account),
  usage / fair-use policy, or access requirements — anything a user could be banned for getting wrong.
- The user asks for a capability **this plugin's tools do not expose**. Read the docs to learn the
  official procedure, then tell the user plainly what the plugin *can* and *cannot* do — do **not**
  invent a workaround through raw SSH / PBS / `curl`.
- Before asserting any platform fact you are not certain is current.

## How (no browser, no raw fetch)

1. `docs.refresh` — refresh the fixed allowlist of official UTS HPC/iHPC pages into the local cache.
   It accepts only the fixed source ids (no arbitrary URLs, paths, headers, or proxies) and needs local
   VPN access where UTS requires it.
2. Read the page through the `uts://docs-cache/{sourceId}` resource, or use `docs.search` for a bounded
   snippet, then load the full page.
3. The covered official sources include:
   - **UTS HPC:** access / getting-started, PBS overview, **PBS queues**, **PBS nodes**, GPU job
     submission, and live queue status.
   - **UTS iHPC:** the OS/usage documentation, **node limits**, and **usage policy**.
4. When you state a platform rule, **quote the doc and name the `sourceId`** so the user can verify it.

## Guardrails

- The official docs are **authoritative** for platform rules — prefer them over your prior assumptions
  and over stale local notes.
- Consulting docs *informs the plan*; you still **act only through MCP tools**. Reading a doc never
  authorises a raw shell / SSH / PBS / iHPC / transfer command.
- Do **not** fabricate PBS directives, queue names, node-pool caps, or quota numbers. If the docs do
  not answer it and you cannot verify it through a tool, say so and stop — guessing on ban-critical
  rules (node limits, usage policy) is unsafe.
- If `docs.refresh` fails (e.g. VPN down) and no cache exists, surface that and offer
  `access.doctor --export-ssh` for a manual connection handoff — do not silently proceed on guesses.
- These docs describe the **platforms**. For the **plugin's own** capabilities and policy, use
  `docs.search` over the bundled `uts://docs/{docId}` set and [`skills/README.md`](../README.md).
