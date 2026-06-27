# ADR 0002: Multi-Account Safety

## Status

Accepted.

## Context

The user has two accounts on UTS HPC and two accounts on UTS iHPC. Those accounts may differ in permissions, project membership, quotas, queues, or node-group access.

Using several accounts as one pooled quota would create policy and fairness risk.

## Decision

Every live operation must specify exactly one `profile_id`.

The package must:

- refresh live limits for that profile before submission;
- record profile id in every run record;
- require confirmation before account switches after planning;
- block automatic cross-account distribution;
- avoid storing secrets in profiles.

## Consequences

Agents can still work efficiently across accounts, but every switch is explicit and auditable.

This makes some workflows more deliberate, especially high-throughput experiment sweeps, but it keeps the package aligned with platform rules and user accountability.
