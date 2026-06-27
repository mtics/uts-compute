# Research Basis

Last verified from this machine: 2026-06-15, Australia/Sydney.

## MCP vs Skills

Use MCP when the agent needs a live capability or authoritative external state:

- checking VPN/SSH reachability;
- querying queues, nodes, jobs, quotas, and modules;
- rendering and validating job specs against schemas;
- submitting, monitoring, logging, cancelling, staging, fetching, and auditing jobs;
- exposing structured resources such as queue snapshots, account profiles, and template catalogs.

Use Skills when the agent needs procedural knowledge:

- choosing between UTS HPC and UTS iHPC;
- deciding which account profile to use and when to ask for confirmation;
- estimating resources and translating an experiment into a job spec;
- following PBS and iHPC workflows;
- monitoring, recovering, collecting artifacts, and summarizing results.

Use MCP resources when the agent needs reusable context selected by the host or inspected across turns:

- profile summaries;
- quota snapshots;
- template catalogs;
- cached UTS documentation;
- run records and recent audit events.

Use `docs.refresh` when current official UTS documentation needs to be cached for later resource reads. It is limited to fixed official UTS source ids and does not replace `quotas.refresh` for account-specific limits.

Use MCP prompts only for reusable user-invoked workflows. Prompts can help standardize "plan a PBS job" or "triage a failed run", but they must not hide approval or execution.

Use plugins as distribution wrappers. The plugin should not contain divergent platform logic. Codex and Claude Code should share the same `skills/`, `mcp-server/`, `schemas/`, `profiles/`, and `templates/` directories.

Primary references:

- Codex Skills: https://developers.openai.com/codex/skills
- Codex Plugins: https://developers.openai.com/codex/plugins
- Codex MCP: https://developers.openai.com/codex/mcp
- Claude Code Skills: https://code.claude.com/docs/en/skills
- Claude Code Plugins: https://code.claude.com/docs/en/plugins
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Agent Skills core format: https://agentskills.io/home

## UTS HPC

UTS HPC is the PBS Pro batch platform at https://hpc.research.uts.edu.au/.

Relevant operational facts:

- The platform is intended for UTS research computing.
- It uses PBS Professional.
- Large compute should be submitted through PBS, not run on login nodes.
- Queue information is available through `qstat -Q` and `qstat -Qf`.
- Node information is available through `pbsnodes -a`; JSON output should be preferred when available through `pbsnodes -F json -a`.
- GPU jobs use `gpuq` and request GPU resources with `ngpus`, for example `#PBS -l ngpus=1`.
- Do not request GPU resources unless the code actually uses GPU.
- The public status page https://hpc.research.uts.edu.au/statuspbs/queues is an HTML view backed by PBS data.
- External access and documentation access may require UTS VPN.

Queue snapshot from https://hpc.research.uts.edu.au/statuspbs/queues on 2026-06-15:

| Queue | Published max CPUs | Published max memory | Published max walltime | Published max running jobs | Notes |
| --- | ---: | ---: | --- | ---: | --- |
| `workq` | None | None | `200:00:00` | 20 | Public status says None for some limits. Treat None as unpublished, not unlimited. |
| `smallq` | 4 | 32gb | `08:00:00` | 30 | Small jobs. |
| `medq` | 16 | 64gb | `100:00:00` | 15 | Medium jobs. |
| `interq` | 16 | 100gb | `02:00:00` | 2 | Interactive queue. |
| `gpuq` | None | None | `48:00:00` | 6 | Restricted; GPU only when needed. |
| `expressq` | None | None | `200:00:00` | 4 | Restricted. |
| `riskyq` | None | None | `200:00:00` | 10 | Restricted. |
| `testq` | 62 | None | None | None | Restricted. |
| `ciq` | 64 | None | None | 100 | Restricted/private. |
| `priv05_08` | 64 | None | None | 100 | Restricted/private. |

The MCP server must refresh these values at runtime instead of relying on the snapshot.

UTS HPC references:

- Home: https://hpc.research.uts.edu.au/
- Access: https://hpc.research.uts.edu.au/getting_started/access/
- PBS overview: https://hpc.research.uts.edu.au/pbs/
- PBS job scripts: https://hpc.research.uts.edu.au/pbs/job_scripts/
- Queues: https://hpc.research.uts.edu.au/pbs/queues/
- Nodes: https://hpc.research.uts.edu.au/pbs/nodes/
- Queue status: https://hpc.research.uts.edu.au/statuspbs/queues
- GPU submit: https://hpc.research.uts.edu.au/gpu/job_submit/
- GPU monitoring: https://hpc.research.uts.edu.au/gpu/smi/

## UTS iHPC

UTS iHPC is the interactive compute platform documented at https://ihpc.research.uts.edu.au/help/documentation-rhel-810/.

Relevant operational facts:

- It is an interactive node environment, not a PBS or Slurm batch cluster.
- `access.ihpc.uts.edu.au` is a gateway for SSH and file transfer, not a compute node.
- Typical SSH flow is to connect to the access host, then select or connect to compute nodes with `cnode` and SSH.
- Off-campus access requires UTS VPN.
- The platform has node-family limits by user group and session concurrency constraints.
- Long or disconnected inactive sessions may be terminated by platform monitoring.
- CPU User and GPU User groups have additional eligibility and usage expectations.
- Storage has distinct roles for home, data, project volumes, scratch, shared temporary space, and memory-backed temporary space.

Public group/node limits recorded from the iHPC node limits documentation:

| Group | Mars | Mercury | Venus | Jupiter | Saturn/Neptune | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Staff Research | 2 | 2 | 2 | 0 | 0 | 2 |
| Research | 2 | 2 | 2 | 0 | 0 | 2 |
| Student | 1 | 1 | 1 | 0 | 0 | 1 |
| External | 1 | 1 | 1 | 0 | 0 | 1 |
| Business | 2 | 2 | 2 | 0 | 0 | 2 |
| Science | 2 | 2 | 2 | 0 | 0 | 2 |
| CPU User | 2 | 2 | 2 | 1 | 0 | 2 |
| GPU User | 2 | 2 | 2 | 0 | 1 | 2 |

Session-time documents have conflicting values across iHPC pages. The implementation must treat published values as conservative defaults and refresh live status with platform commands such as `sessiontime` where available.

iHPC references:

- Documentation entry: https://ihpc.research.uts.edu.au/help/documentation-rhel-810/
- Node limits: https://ihpc.research.uts.edu.au/help/about/node-limits/
- Usage policy: https://ihpc.research.uts.edu.au/help/about/usage-policy/
- SSH connection: https://ihpc.research.uts.edu.au/help/documentation-rhel-810/access-and-connectivity/connecting-via-ssh-command-line/
- Off-campus access: https://ihpc.research.uts.edu.au/help/documentation-rhel-810/access-and-connectivity/off-campus-access/
- Maximum session time: https://ihpc.research.uts.edu.au/help/documentation-rhel-810/access-and-connectivity/maximum-session-time/
- Node usage monitoring: https://ihpc.research.uts.edu.au/help/documentation-rhel-810/administration/node-usage-monitoring/
- CPU User group: https://ihpc.research.uts.edu.au/help/about/cpu-user-group/
- GPU User group: https://ihpc.research.uts.edu.au/help/about/gpu-user-group/
- Home directory: https://ihpc.research.uts.edu.au/help/documentation-rhel-810/file-systems/home-directory/
- Data directory: https://ihpc.research.uts.edu.au/help/documentation-rhel-810/file-systems/data-directory/
- Scratch directory: https://ihpc.research.uts.edu.au/help/documentation-rhel-810/file-systems/scratch-directory/

## Unknowns To Resolve With Live Accounts

The user has two accounts on each platform. Public documentation does not determine the real per-account quotas, queue ACLs, project memberships, or node-group access.

The first implemented MCP milestone must support read-only quota refresh:

- HPC: `whoami`, `id`, `groups`, `qstat -Q`, `qstat -Qf`, `qstat -u "$USER"`, `pbsnodes -F json -a`, storage quota and usage checks.
- iHPC: portal or command-derived account limits, `cnode avail`, `cnode all`, `cnode mynodes`, `sessiontime`, `du`, `projvolu`, and storage checks.

No agent may infer that multiple accounts can be pooled to bypass fair-use limits.
