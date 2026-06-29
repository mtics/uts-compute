# WebUI Visual Redesign Spec

Date: 2026-06-17

## Purpose

This spec defines the visual and interaction redesign direction for the optional
`uts-compute` WebUI in `webui/`. It builds on `docs/dashboard-design.md`, but
focuses on product feel, visual hierarchy, page composition, and phased UI
improvements.

The WebUI should become a quiet, high-density local operations console for UTS
HPC and UTS iHPC experiment runs. It should not become a SaaS-style experiment
platform, a Grafana replacement, or a bypass around MCP safety gates.

## Current State

The current WebUI is already functional:

- `webui/server.mjs` serves a localhost-only Node HTTP API and static frontend.
- `webui/public/index.html` loads Tabler, Tabler Icons, ApexCharts, and List.js
  from CDNs.
- `webui/public/app.js` implements a vanilla clean-route SPA with Runs, Run
  detail, Explore, Capacity Snapshot, and Projects views.
- The server imports built MCP domain functions from `mcp-server/dist/*` and
  reads already-redacted local state under `.uts-computing/`.
- Write actions route through the same MCP domain functions used by tools:
  clone uses retry planning, submit uses job submission, abort uses job
  cancellation, autonomous submit/retry depends on server-side conformance, and
  token-confirmed operations keep the trusted confirmation token server-side.

The main gap is not basic function. The gap is visual hierarchy and workflow
clarity. The interface currently feels like a default Tabler admin surface:
usable, but not yet shaped around the user's most important questions:

- What is running right now?
- What failed or needs attention?
- What evidence explains this run?
- Did this run over-request resources?
- Is an action ready and safe to trigger?

### Implementation Audit Checklist

These items began as the first implementation gap checklist. Keep them as audit
items even when a first pass is implemented: each item should be verified in the
rendered UI, regression tests, and future edits before it is considered closed.

- Navigation and page title use `Capacity Snapshot` until true worker monitoring
  exists.
- Capacity Snapshot uses `/capacity` as the canonical clean route; legacy
  `/queue` links are compatibility-only and should be replaced in visible UI.
- Clean route matching supports query-bearing routes such as
  `/runs?view=active`.
- Status badges show color, icon or shape, text, reason, and typed
  unknown/stale states.
- Runs places the table before broad charts because the table is the control
  center.
- Run detail uses `Plan & Resources` and surfaces action readiness, evidence
  completeness, and resource fit in the overview.
- Action flows use local modal flows with visible evidence and MCP gate
  language instead of browser `prompt()` / `confirm()`.
- Explore has filters, right-sizing candidate explanations, chart-to-table
  linking, and resource-fit cells that show visual state plus numeric values.
- Projects renders as a compact index table whose project names and status
  counts link to filtered Runs while preserving project filters in URL state.

## Product Positioning

Use this positioning as the design anchor:

> A local, read-mostly HPC experiment operations console that makes run state,
> evidence, and resource fit obvious without weakening the MCP safety model.

The WebUI should feel:

- calm and work-focused;
- dense enough for repeated use;
- explicit about status, evidence, and missing data;
- cautious around destructive or irreversible actions;
- clearly local and single-user.

It should avoid:

- marketing-style dashboard decoration;
- large SaaS workspace complexity;
- arbitrary user-defined panels or executable widgets;
- any UI that implies broad cluster control beyond saved local state;
- any visual shortcut that hides approval, quota, or conformance boundaries.

## Research Summary

This section records product and design-system patterns that should shape the
redesign. The goal is not to copy another console. The goal is to extract
patterns that fit a localhost, read-mostly HPC experiment operations surface.

### 2026 Research Synthesis

The cross-product research converges on one rule: make the UI a verifiable
operations console, not a prettier dashboard template.

Adopt these synthesis points as binding design constraints:

- Runs is the main workbench. It must make status, attention reason, evidence,
  and safe next actions visible in the first screen.
- Run detail is an evidence packet. It should connect status to plan, resources,
  lifecycle events, logs, artifacts, reproducibility, authorization,
  conformance, and quota evidence.
- Explore is an analytical workspace for resource fit and comparison. It is not
  a general-purpose chart builder.
- Capacity is a profile-scoped snapshot interpreter. It is not live cluster
  health unless a future MCP data source explicitly provides that evidence.
- Status, severity, and action readiness are separate concepts. A run can be
  `failed`, have `high` severity, and still have only `clone` ready.
- Visual polish should come from alignment, spacing, table rhythm, tokens, and
  honest states, not from decorative gradients, large illustrations, or chart
  walls.
- Every risky or irreversible action must show its MCP gate and evidence before
  execution.
- Missing data must be typed. "No data" is not a valid design state.

### 2026 External Design Principle Synthesis

The general Web UI research reinforces the same direction as the product
precedent research, but it makes the quality bar more concrete:

- NN/g's usability heuristics support persistent system-status visibility,
  recognition over recall, error prevention, user control, and minimalist
  presentation. For this WebUI, that means status and readiness must be visible
  in-place, actions must show their gate before execution, and dense screens
  should remove decoration before removing evidence.
- Apple HIG's design-principle guidance supports clarity, deference to content,
  and meaningful hierarchy. The console should let run state, evidence, and
  resource fit carry the page, not brand treatment or oversized visual chrome.
- Material Design 3 and Atlassian design-token guidance support named semantic
  tokens instead of hardcoded colors, especially when light/dark mode and state
  layers are required. Tokens should be named by usage, not by current color.
- Carbon's data-table and status patterns support toolbar-driven filtering,
  sorting, progressive disclosure, and row actions for dense operational data.
  This reinforces the Runs table as the primary control surface.
- Atlassian's badge/lozenge guidance separates numeric badges from state labels.
  The WebUI should use counts for quantities and state chips for lifecycle,
  evidence, authorization, and resource-fit states.
- Fluent 2 motion guidance treats motion as a way to clarify relationships and
  state changes. In this console, motion should be functional and reduced-motion
  aware, limited to loading, active polling, and modal/route transitions.
- GOV.UK error-message and error-summary patterns reinforce that errors must be
  specific, adjacent to the affected control or surface, and summarized when
  more than one user action is needed. Generic red banners are insufficient.
- WCAG 2.2 anchors the visual requirements: visible focus, non-text contrast,
  target sizing, status messages, and non-color-only state representation are
  part of the aesthetic system, not a later accessibility pass.

### Design-Principle Research Update

The broader Web UI research adds a stricter quality bar for the visual redesign:

- Operational pages need preattentive scanning. NN/g's dashboard guidance
  distinguishes operational dashboards from analytical dashboards, which
  supports making Runs and Capacity exception-first while keeping Explore as the
  investigative surface.
- Dashboard cards should be selected and ordered before layout. PatternFly's
  dashboard guidance supports a short KPI strip with clear priority instead of
  a wall of equally weighted cards.
- Tables remain the most honest interface for dense operational data. Material,
  PatternFly, and NN/g table guidance support semantic tables with query tools,
  stable columns, sorting/filtering, and adjacent visualizations rather than
  chart-only summaries.
- Accessibility is part of visual style, not a separate cleanup phase. Carbon
  and WCAG guidance require visible focus, sufficient non-text contrast, and
  states that do not rely on hue alone.
- Data visualization should facilitate comparison, provide structure, and keep
  the underlying data available. Material and Carbon visualization guidance
  supports pairing charts with tables, direct labels or legends, and consistent
  palette semantics.
- Responsive data tables should avoid breaking the viewport. Wide tables may
  scroll in a bounded container, but priority columns, row identity, and status
  must remain discoverable on narrow screens.
- Product precedents in ClearML, MLflow, W&B, Neptune, Kubernetes Dashboard,
  OpenShift, Open OnDemand, and Slurm-web all reinforce the same pattern:
  list/table first for operational selection, detail pages for evidence, and
  charts for comparison or investigation.

### Experiment Tracking Products

MLflow emphasizes experiment and run exploration through run listing,
parameter/metric search, metric visualization, and artifact access. Its visual
style is comparatively plain and developer-oriented, which fits local tools well.
Reference: https://mlflow.org/docs/latest/ml/tracking/

Aim is explorer-first. Its high-value pattern is dense comparison across many
runs using metric selection, queries, grouping, and context tables. This is the
best model for future Explore improvements.
Reference: https://aimstack.readthedocs.io/en/latest/ui/pages/explorers.html

ClearML is closest to compute operations. Its task table supports table,
details, and comparison views, auto-refresh, and state-gated actions such as
clone and enqueue. This is the strongest model for Runs and Run detail.
References:

- https://clear.ml/docs/latest/docs/webapp/webapp_exp_table/
- https://clear.ml/docs/latest/docs/webapp/webapp_overview/

Weights & Biases, Neptune, and Comet share an important interaction pattern:
the runs table controls what enters charts, dashboards, side-by-side views, or
reports. Neptune's visible-run selection is especially useful because filtering
candidate runs and choosing compared runs are separate actions.
References:

- https://docs.wandb.ai/models/track/workspaces
- https://docs.neptune.ai/select_runs
- https://www.comet.com/docs/v2/guides/experiment-management/analyze-experiments/

### HPC And Operations Products

Open OnDemand organizes the world by resource domains such as Files, Jobs,
Clusters, and Interactive Apps. The useful lesson is not to copy the navigation,
but to keep compute concepts explicit and predictable.
Reference: https://osc.github.io/ood-documentation/latest/customizations.html

Slurm-web emphasizes jobs, nodes, GPU availability, and resource allocation in a
reactive web UI. The useful pattern is immediate visibility into utilization and
available capacity, not decorative cluster graphics.
Reference: https://docs.rackslab.io/slurm-web/overview/overview.html

Kubernetes Dashboard and OpenShift Console organize work around concrete
resource domains, then use detail pages to connect status, spec, logs, and
related objects. OpenShift's topology work is useful as a caution: topology is
valuable only when it summarizes real relationships and health, not when it
becomes ornamental. For this project, use resource-domain clarity but avoid a
cluster topology canvas unless a real profile-scoped relationship model exists.
References:

- https://kubernetes.io/docs/tasks/access-application-cluster/web-ui-dashboard/
- https://openshift.github.io/openshift-origin-design/designs/developer/topology-43/

Datadog separates status-board dashboards, exploratory timeboards, and
free-form storytelling views. `uts-compute` should adopt the distinction, not
the customization breadth: Runs and Capacity are operational, Explore is
analytical, and there should be no arbitrary dashboard builder in P0/P1.
Reference: https://docs.datadoghq.com/dashboards/

Grafana's useful lesson is that visual alerts should point to the data needed
for investigation. For `uts-compute`, warnings should link the user back to run
events, logs evidence, quota snapshots, or resource-fit data.
Reference:
https://grafana.com/docs/grafana/latest/alerting/alerting-rules/link-alert-rules-to-panels/

### General Dashboard And Design-System Principles

Nielsen Norman Group distinguishes operational dashboards, which must surface
time-sensitive exceptions quickly, from analytical dashboards, which support
investigation. It also recommends visual encodings based on position and length
for fast quantitative comparison, and using color primarily as a categorical or
secondary cue. This supports placing operational run health before charts, and
using bar/scatter/table views over decorative gauges or donuts when precision is
needed.
Reference: https://www.nngroup.com/articles/dashboards-preattentive/

PatternFly's dashboard guidance starts by listing and prioritizing cards before
laying out a grid. A card should carry one metric or a tightly related group of
metrics, and important cards belong higher in the layout. For `uts-compute`, the
card list should be driven by user questions, not by available JSON fields.
Reference: https://www.patternfly.org/patterns/dashboard/design-guidelines/

Carbon's status-indicator guidance reserves red, orange, yellow, green, blue,
gray, and purple for semantic states, and Carbon's data-visualization guidance
allows texture or non-color distinctions in legends for accessibility. This
supports a status system that combines text, icon, shape, and tooltip instead
of hue alone.
References:

- https://carbondesignsystem.com/patterns/status-indicator-pattern/
- https://carbondesignsystem.com/data-visualization/legends/

Atlassian's design-token approach is useful because it makes color, elevation,
spacing, and dark mode explicit. The WebUI should use local CSS custom
properties for operational tokens even while keeping Tabler as the component
base.
Reference: https://atlassian.design/foundations/color

## Design Decision Matrix

| Product pattern | Adopt | Adapt | Avoid |
|---|---|---|---|
| MLflow run detail | Parameters, metrics, artifacts, code/version evidence | Add HPC-specific plan, quota, approval, and resource-fit evidence | Hosted experiment-platform scope |
| Aim explorers | Query, grouping, scatter, context table | Start with resource-fit analysis before generic charting | Complex query language in P0 |
| ClearML task table | Dense task list, state-gated actions, clone/rerun flow | Map actions to MCP gates and local evidence | Worker/queue claims without live data |
| W&B workspaces | Runs table controls visual comparison | Separate visible/filter set from compare set | Custom panel builder in P0/P1 |
| Neptune run selection | Visible/selected run distinction | Use compare selector with explicit non-mutating label | Batch mutation affordance |
| Kubernetes/OpenShift | Resource-domain IA and status/spec/log linkage | Keep profile-scoped and local-state-scoped | Broad cluster administration |
| Datadog/Grafana | Status-board vs analysis distinction; alerts link to evidence | Use alerts as investigation launch points | Free-form dashboard editing |
| Open OnDemand/Slurm-web | HPC terms stay visible: jobs, queues, nodes, storage | Use Capacity Snapshot language until true monitoring exists | Global queue or worker observability claims |
| Linear/Raycast/VS Code | Fast filters, stable commands, keyboard discoverability | Add URL-backed views first, command palette later | Hidden shortcuts as the only path |

## Design Principles

1. Make state explain itself.
   Status UI must combine color, icon, text, and reason. Do not rely on color
   alone.

2. Prefer operational hierarchy over generic dashboard hierarchy.
   The first screen should answer "what needs attention?" before showing broad
   historical charts.

3. Treat the runs table as the control center.
   Filtering, sorting, saved views, and compare selection should begin in Runs.

4. Separate filtering from comparison.
   A filtered table defines the candidate set. A selected set defines what feeds
   Explore, side-by-side comparison, or copied summaries.

5. Show evidence, not trust.
   Plan hash, quota snapshot, events, saved logs evidence, artifacts, git state,
   conformance state, and token-confirmation state should be surfaced near
   actions and statuses.

6. Be honest about missing data.
   Empty states should distinguish "not captured yet", "not supported yet",
   "not applicable", and "requires a refreshed snapshot".

7. Keep destructive actions visually cautious.
   Abort, cleanup, and other irreversible operations should never be presented
   as casual primary actions.

8. Stay local and client-neutral.
   The UI may visualize and trigger existing MCP-backed actions, but it must not
   add generic remote shell capability, arbitrary file browsing, or secret reads.

9. Separate operational and analytical surfaces.
   Runs and Capacity must optimize for fast exception recognition. Explore may
   optimize for comparison and investigation. Do not make every page a dashboard.

10. Let density come from structure.
    Use compact tables, consistent columns, short labels, and stable filters.
    Do not create density by shrinking text until evidence, states, and actions
    become hard to scan.

11. Tie every action to its gate.
    Submit, retry, transfer, fetch, abort, cleanup, and migration flows must
    show the operation name, target resource, relevant hash/snapshot/evidence,
    and whether the server-side MCP gate is autonomous-conformant, blocked,
    advisory-only, or requires token confirmation.

12. Make missingness typed.
    "No data" is not one state. The UI must distinguish not captured yet,
    unsupported, not applicable, stale, blocked, and failed-to-load.

13. Prefer evidence-linked state over standalone status.
    Any failed, blocked, stale, unknown, or risky state should link or point to
    the evidence source that explains it: event, log evidence, quota snapshot,
    approval record, artifact manifest, plan hash, or git state.

14. Separate status, severity, and readiness.
    Status describes what the run is doing. Severity describes operational
    attention. Readiness describes whether an action may proceed through its MCP
    gate. Do not infer one from the other through color alone.

15. Make compare selection visibly non-mutating.
    Compare or visibility controls may feed Explore and side-by-side views, but
    must not look like batch mutation checkboxes.

16. Keep safety context persistent but quiet.
    The UI should continuously signal that it is localhost, read-mostly, and
    MCP-gated without turning that context into a marketing banner.

## Visual Language

Use the working name "Quiet Ops Console".

### Aesthetic Direction

The selected style is an operational developer console, not a consumer analytics
dashboard. It should feel close to a polished local tool: more deliberate than a
raw admin template, but less branded and less decorative than a SaaS workspace.

Adopt:

- neutral surfaces with clear borders rather than heavy shadows;
- compact tables with strong column rhythm;
- restrained blue for primary non-destructive actions;
- semantic color only for status, risk, and resource fit;
- monospace only for identifiers, hashes, paths, commands, and snapshot ids;
- small, precise icons from Tabler Icons for controls and state labels;
- visual hierarchy through spacing, grouping, typography, and pinned controls.

Avoid:

- marketing hero sections, large empty cards, decorative gradients, and
  full-page illustrations;
- colorful chart walls on the first operational screen;
- dashboard-builder aesthetics with draggable panels;
- faux terminal styling as a blanket theme;
- topology canvases or node maps without real relationship data;
- palettes dominated by one hue family.

Rejected style directions:

| Direction | Why rejected |
|---|---|
| SaaS analytics workspace | Implies hosted collaboration, dashboards, and broad customization that are out of scope |
| Dark observability wall | Looks dramatic but reduces evidence density and local-tool clarity |
| HPC control room | Risks implying live cluster-wide control beyond profile-scoped local state |
| Notebook/report surface | Better for analysis narratives than repeated operations triage |
| Raw Tabler admin | Functional but too generic; does not make state, gates, and evidence obvious |

### Visual Quality Bar

The redesign should look intentionally engineered rather than decorated. A
screen passes the visual quality bar when a user can identify hierarchy,
selection, risk, and evidence source before reading every label.

Composition rules:

- Align page headers, toolbars, tables, and panels to a predictable grid. Visual
  polish should come from alignment and rhythm before ornament.
- Keep the first desktop viewport purposeful. Runs should show context, KPIs,
  filters, and the top of the table; Explore may show filters, chart, candidate
  list, and the top of the evidence table.
- Use whitespace to separate decision zones, not to create empty spectacle.
  Dense operational pages still need breathing room between toolbar, summary,
  table, and secondary analysis.
- Use borders and muted surface shifts for grouping. Avoid nested cards, large
  shadows, floating panels inside panels, or decorative background effects.

Aesthetic rules:

- Prefer neutral, slightly cool surfaces with crisp borders and restrained
  accents. This keeps the product closer to a developer operations console than
  a consumer analytics dashboard.
- Use one accent family for primary non-destructive actions and navigation.
  Reserve red, orange, yellow, and green for semantic states and risk.
- Use icons sparingly and consistently: state icons, action icons, filter icons,
  and evidence icons should each have a stable meaning.
- Use motion only for active work or loading. Terminal states, warnings, and
  evidence chips should be static.
- Avoid novelty typography. Hierarchy should come from size, weight, spacing,
  and proximity, not from display fonts or viewport-scaled type.

Density rules:

- Increase density through column discipline, tabular numerals, concise labels,
  and compact controls.
- Do not hide state text, evidence labels, or focus rings in order to make a row
  shorter.
- Compact mode may reduce padding and secondary copy, but it must preserve
  status text, run identity, attention reason, and action readiness.
- Numeric cells should align on decimal or unit patterns where practical, and
  units should remain visible near the values.

Failure rules:

- A visually polished but semantically vague screen fails the redesign. Pretty
  charts without evidence links, colored badges without reason, or empty states
  that hide missingness are regressions.
- Any visual treatment that implies live cluster control, global worker
  monitoring, arbitrary file browsing, or ungated execution fails the redesign.

### Layout

- Use a compact top navigation for the four primary work modes: Runs, Explore,
  Capacity, Projects. Do not reintroduce a wide left rail unless the
  information architecture grows beyond these modes.
- Use dense tables and compact panels.
- Avoid oversized hero blocks or marketing-like cards.
- Avoid nested cards. Use cards for repeated items, modals, and framed tools.
- Keep page-level sections as full-width bands or constrained layouts.

### Interaction State Contract

Every interactive component needs visible states:

- default;
- hover, where pointer hover exists;
- focused, with keyboard-visible focus;
- active or pressed;
- selected, when the control changes inclusion or visibility;
- loading or busy, when a request is pending;
- disabled or blocked, with the reason inspectable.

Icon buttons and compact controls should have stable dimensions. Their labels
may be visually hidden, but the accessible name must describe the action and the
target when the target is not otherwise obvious.

Selection state must be visually different from action readiness. For example,
including a run in comparison is a non-mutating selection state; submitting or
cancelling a run is an MCP-gated action readiness state. Do not reuse the same
checkbox, color, or language for both concepts.

### Token Contract

Define WebUI-specific CSS custom properties in `webui/public/app.css`, layered
over Tabler. The exact hex values may evolve, but the semantic token names
should remain stable:

```css
:root {
  --ops-bg: #f6f8fb;
  --ops-surface: #ffffff;
  --ops-surface-muted: #f1f5f9;
  --ops-border: #d9e2ec;
  --ops-text: #172033;
  --ops-text-muted: #667085;
  --ops-focus: #2563eb;
  --ops-shadow-panel: 0 1px 2px rgba(15, 23, 42, 0.08);

  --ops-status-planned: #64748b;
  --ops-status-submitting: #b7791f;
  --ops-status-submitted: #b7791f;
  --ops-status-running: #2563eb;
  --ops-status-finished: #16833a;
  --ops-status-failed: #c0262d;
  --ops-status-cancelled: #c05621;
  --ops-status-unknown: #6b7280;

  --ops-severity-high: #c0262d;
  --ops-severity-medium: #b7791f;
  --ops-severity-low: #2563eb;
  --ops-severity-none: #64748b;

  --ops-risk-info: #2563eb;
  --ops-risk-attention: #b7791f;
  --ops-risk-danger: #c0262d;
  --ops-risk-safe: #16833a;

  --ops-action-ready: #16833a;
  --ops-action-confirm: #b7791f;
  --ops-action-blocked: #c0262d;
  --ops-action-disabled: #6b7280;

  --ops-chart-category-1: #2563eb;
  --ops-chart-category-2: #0f766e;
  --ops-chart-category-3: #7c3aed;
  --ops-chart-category-4: #475569;
  --ops-chart-sequential-low: #dbeafe;
  --ops-chart-sequential-high: #1d4ed8;
}

[data-bs-theme="dark"] {
  --ops-bg: #111827;
  --ops-surface: #182235;
  --ops-surface-muted: #1f2a3d;
  --ops-border: #334155;
  --ops-text: #e5e7eb;
  --ops-text-muted: #9ca3af;
  --ops-focus: #60a5fa;
}
```

Use tokens for custom CSS, charts, and focus rings. Tabler utility classes may
remain for simple components, but any new operational component should use
`--ops-*` tokens so light/dark behavior and status semantics stay consistent.

Token rules:

- `--ops-status-*` describes object lifecycle state only.
- `--ops-severity-*` describes attention level or operational impact only.
- `--ops-action-*` describes MCP gate and action readiness only.
- `--ops-risk-*` describes resource fit, safety, or quota risk.
- `--ops-chart-*` is for charts. Do not reuse status colors as arbitrary chart
  series colors.
- Light and dark themes need separate chart palette review. Do not assume a
  light-mode color remains legible or semantically clear on dark surfaces.

Token usage matrix:

| Component | Required token family | Non-color cue | Notes |
|---|---|---|---|
| Lifecycle status badge | `--ops-status-*` | Icon plus lifecycle text | Never encode severity here |
| Attention rail/reason | `--ops-severity-*` | Left rail, icon shape, reason text | Row-level severity cue, not lifecycle |
| Action readiness chip/card | `--ops-action-*` | Readiness label and gate icon | Maps to `authorization_state` |
| Authorization chip | `--ops-action-*` | State label and evidence summary | Avoid approval wording unless token-confirmed |
| Evidence chip | `--ops-risk-*` or neutral state layer | Evidence type, state label, source tooltip | Color communicates presence/freshness only |
| Resource-fit chip | `--ops-risk-*` | Numeric requested/used reason | Do not reuse lifecycle status color |
| Compare selection | neutral selected state layer | Compare icon and selected label | Non-mutating; never danger/submit color |
| Blocked action | `--ops-action-blocked` | Disabled/block icon plus reason | Must remain inspectable |
| Selected table row | neutral selected state layer | Outline or selected marker | Must be distinct from severity rail |
| Chart category series | `--ops-chart-category-*` | Legend label, marker shape, line style | Do not use status color unless status is the grouping |
| Chart sequential scale | `--ops-chart-sequential-*` | Axis labels and adjacent table | Use for magnitude, not status |

Light/dark acceptance:

- Every token family needs a light and dark review for contrast, semantic
  recognition, hover/focus/selected states, and disabled states.
- Focus rings should remain visually stronger than hover states.
- Selected, stale, and blocked states must remain distinguishable in grayscale
  screenshots.
- Chart palettes must be checked against both `--ops-surface` and
  `--ops-bg`, not only white backgrounds.

### Color

Use a restrained neutral base with status colors reserved for semantic meaning:

- `planned`: neutral gray.
- `submitting` and `submitted`: amber/yellow.
- `running`: blue or green-blue.
- `finished`: green.
- `failed`: red.
- `cancelled`: orange or muted red-orange.
- `unknown`: gray.
- `needs attention`: yellow with explicit reason.

Avoid one-note palettes. The current Tabler palette can remain the base, but the
custom CSS should introduce a clear operational hierarchy and more deliberate
status treatment.

Do not use red, orange, yellow, or green for decorative accents. Those colors
are reserved for status, risk, or resource-fit meaning. Use blue only for
progress, neutral emphasis, and primary non-destructive actions.

Status color is not severity by itself. For example, `running` may be blue and
low severity, while `running with missing remote id` may be blue status plus a
medium or high attention reason. The component must show both pieces of
information when both exist.

### Typography And Density

- Use compact headings inside panels.
- Use code styling only for identifiers, hashes, paths, and commands.
- Put explanatory copy in empty states, alerts, and tooltips, not as long page
  instructions.
- Keep tables scannable with short labels and consistent column order.
- Body text and table text should not scale with viewport width.
- Use `font-variant-numeric: tabular-nums` for counts, durations, memory, core
  hours, GPU hours, and timestamps.
- Prefer 12-14 px UI text inside tables and controls; reserve 18-24 px headings
  for page and section headings only.
- Keep card radius at 6-8 px. Avoid large rounded cards and nested cards.
- Dense mode may reduce row padding, but must not remove status text, labels,
  focus rings, or tooltips.

### Layout And Density Rules

- Keep the top navigation compact on desktop. On small screens, collapse it
  into Tabler's existing responsive navigation.
- Use `container-xl` unless a specific table or Explore panel needs wider space;
  do not introduce full-bleed marketing sections.
- Use a four-column KPI grid on desktop, two columns on tablet, one column on
  narrow mobile.
- Page header, filter toolbar, and primary table should fit in the first
  desktop viewport for Runs when data exists.
- Operational charts belong below the run table in Runs. Explore may lead with
  charts because it is the analytical workspace.
- Tables may horizontally scroll on narrow screens, but the run id and status
  should remain visible through column order or a sticky first column.
- Use stable min/max dimensions for badges, icon buttons, charts, and summary
  tiles so hover, loading, or empty states do not shift layout.

### Table Density Contract

Runs and Explore tables are core product surfaces. They should feel compact, not
compressed.

Default table behavior:

- Default row height should target roughly 40-44 px on desktop.
- Compact mode may target roughly 32-36 px, but must preserve readable status
  text, focus rings, and evidence labels.
- Table headers should remain visible when a page has enough rows to scroll
  locally or vertically.
- Use tabular numerals for durations, memory, CPU efficiency, core-hours,
  GPU-hours, counts, and timestamps.
- Numeric columns should align consistently, usually right-aligned or
  decimal-aligned when practical.
- Long identifiers, paths, and commands should truncate on one line with title,
  tooltip, popover, or detail-route access to the full value.
- Priority columns for Runs are run id, status, attention reason, evidence, and
  actions. Priority columns for Explore are run id, resource-fit state,
  requested/used values, and Run Detail link.
- On narrow screens, wide tables may scroll in a bounded responsive container.
  The table must not push the whole page wider than the viewport.
- Sticky first column or sticky status column is preferred when implementation
  complexity stays low; if not sticky, column order must keep identity and state
  early.
- Large histories should use pagination, bounded rendering, or virtualization
  before the DOM becomes sluggish. Do not add infinite unbounded rows.

Hover, selected, focused, stale, and blocked row states should use subtle state
layers plus text or icon changes. Avoid saturated full-row backgrounds except
for high-risk blocking errors.

### Chart Contract

Charts are evidence navigation aids. They must not become opaque decoration.

Every chart should provide:

- title that states the comparison;
- axis labels and units;
- sample count or plotted-row count;
- active filters or scope;
- source freshness when the chart depends on usage or quota evidence;
- tooltip with run id, project, status, requested value, used value, and evidence
  age when available;
- adjacent table data for the same insight;
- empty and missing-data states that do not plot missing values as zero.

Explore chart-specific rules:

- Requested-vs-used charts must show requested and used units directly on axes
  or in labels.
- The chart card must keep a compact scope grid near the chart that names the
  active scope, plotted/filtered/total sample counts, axes, grouping dimension,
  freshness, and typed missing-data count when relevant. These scope items must
  wrap or truncate locally instead of pushing the page wider.
- Group legends should be accompanied by a compact group summary when plotted
  points exist. Each summary should expose plotted count plus resource-fit signal
  such as review count, memory headroom, or request/use ratio, and may act as a
  URL-backed filter shortcut for the current grouping dimension.
- Outliers should remain visible unless the user explicitly applies a filter.
- Resource-fit thresholds must be documented in nearby text, tooltip, legend, or
  chip copy.
- Small sample sizes should favor table-first presentation; a chart with fewer
  than three plotted runs should not pretend to show a trend.
- Group colors are limited to stable dimensions such as project, status,
  platform, or queue. Resource-fit severity should use chips or annotations, not
  arbitrary series color reuse.
- Chart-to-table highlighting must include a non-color cue such as focus,
  outline, scroll target, label, or row selection state.

### Refresh And Staleness Contract

The WebUI reads local state and saved evidence, so freshness must be explicit.

- Every auto-refreshing or reloadable page should show last UI refresh time.
- Every evidence-driven panel should show source observed time when available.
- Refresh failure should keep the previous data visible and mark it stale rather
  than clearing the page.
- Action submit/cancel/clone flows should disable duplicate submission while the
  request is pending and show loading state in the triggering modal or control.
- Optimistic UI may show `pending local refresh`, but must not present an MCP
  action as successful until the server response succeeds.
- Capacity should always distinguish UI refresh time from quota snapshot
  observed time.
- Runs and Run Detail should distinguish `not captured yet`, `loading`, `stale`,
  and `failed to load`.

### Mobile Triage Mode

Mobile is primarily for triage, not full analytical comparison.

- Runs on narrow screens should prioritize run id, status, attention reason,
  project, updated time, and the safest relevant next action.
- Mobile run rows should use this anatomy:
  - first line: run id, lifecycle status, updated time;
  - second line: attention reason and project/job type;
  - third line: evidence completeness and action-readiness summary;
  - disclosure area: requested/used resources, queue/node family, profile, and
    secondary timestamps.
- Secondary metrics, long resource details, and charts may move behind an
  expansion row or below the table.
- Dangerous or token-confirmed actions still require the full Gate Evidence
  Block and must not be compressed into swipe gestures or icon-only shortcuts.
- Dangerous actions are never icon-only on mobile. They must include operation
  text such as `Cancel run` and an irreversible/token-confirmation cue.
- Explore may use a horizontally scrollable table for detailed resource-fit
  evidence, but the page must still begin with filters, result count, and a
  concise candidate summary.
- Charts may collapse below tables on mobile when the table carries the more
  reliable evidence.
- Mobile layout must not introduce global horizontal overflow. Any table
  overflow must be contained and keyboard reachable.
- Touch targets for primary controls should meet the project accessibility
  target-size requirement or have enough spacing to avoid adjacent activation.

### Status Components

#### Attention Visual Grammar

Status, attention severity, and action readiness must be visible as separate
layers:

- Lifecycle status is a compact badge inside the status cell or detail header.
  It uses `--ops-status-*`, an icon, and a lifecycle label such as `running` or
  `failed`.
- Attention severity is a row/detail cue. Use a thin left rail, warning/info
  icon shape, and a short reason label such as `snapshot stale` or
  `logs missing`. Do not recolor the whole row unless the state blocks safe use.
- Action readiness is an action-surface cue. Use chips or cards with
  `ready`, `advisory-only`, `requires-token-confirmation`, or `blocked`
  language.
- KPI tiles may aggregate counts by severity, but the row that caused the count
  must still show its reason. A KPI color alone is not an explanation.
- Detail headers may show all three layers side by side: lifecycle badge,
  attention reason, and action-readiness summary. They must not collapse into a
  single red/yellow/green badge.

Severity levels:

| Severity | Row treatment | Detail treatment | Examples |
|---|---|---|---|
| `high` | Red rail, alert icon, explicit reason | Prominent attention strip with route to evidence | failed run, blocked destructive action, schema-invalid state |
| `medium` | Amber rail, warning icon, reason text | Inline attention card near affected action | stale snapshot, missing remote id, missing saved logs |
| `low` | Blue/neutral rail or info icon | Compact advisory note | advisory-only resource warning, under-observed usage |
| `none` | No rail | No attention block | finished with complete evidence |

Every status component should include:

- icon;
- label;
- color;
- optional animated dot for active states only;
- tooltip or inline reason when status is blocked, failed, pending, stale, or
  unknown.

Recommended icon map:

| Status | Icon | Motion | Default reason behavior |
|---|---|---|---|
| `planned` | `ti-file-description` | none | Show plan hash availability |
| `submitting` | `ti-loader` | animated dot only | Show submission gate in progress |
| `submitted` | `ti-clock-hour-4` | animated dot only | Show remote id or queued state |
| `running` | `ti-player-play` | animated dot only | Show node/supervisor when known |
| `finished` | `ti-circle-check` | none | Show completion time and usage |
| `failed` | `ti-alert-triangle` | none | Show failure class or last event |
| `cancelled` | `ti-ban` | none | Show cancel evidence when present |
| `unknown` | `ti-help-circle` | none | Show why status is unknown |

Do not use animation for terminal states. Use shape and text with color because
some users will not perceive hue differences reliably.

Status components should render from a structured state object rather than from
status text alone:

| Field | Meaning | Examples |
|---|---|---|
| `run_status` | Lifecycle state | `planned`, `submitted`, `running`, `finished`, `failed`, `cancelled`, `unknown`, `stale` (iHPC: node no longer held, outcome unknown) |
| `attention_reason` | Why the user may need to inspect it | `snapshot_stale`, `token_confirmation_required`, `blocked_nonconformant`, `missing_remote_id`, `dirty_git`, `resource_over_requested`, `logs_missing` |
| `severity` | Operational attention level | `none`, `low`, `medium`, `high` |
| `reason_source` | Evidence source explaining the reason | `last_event`, `diagnose`, `quota_snapshot`, `conformance`, `authorization`, `missing_evidence`, `usage`, `git` |
| `action_readiness` | Whether a visible action can proceed | `ready`, `requires-confirmation`, `blocked`, `not-applicable` |

The UI may derive these client-side, but it must keep the concepts visually
separate. A failed run is not automatically a dangerous action. A stale snapshot
is not automatically a failed run. A blocked action is not automatically a high
severity incident.

Recommended attention reason codes:

| Code | Typical source | UI requirement |
|---|---|---|
| `status_failed` | `RunRecord.status`, latest event, diagnosis | Link to Lifecycle or Logs |
| `status_unknown` | `RunRecord.status`, parse/load issue | Explain why state cannot be known |
| `snapshot_missing` | quota capacity snapshot | Link to Capacity Snapshot or show required profile |
| `snapshot_stale` | snapshot observed time | Show age and freshness threshold |
| `token_confirmation_required` | token-confirmed operation such as cancel, cleanup, or migration apply | Show operation and approval id when present |
| `blocked_nonconformant` | server-side conformance result | Show violated limit or policy and safe next step |
| `missing_remote_id` | submission/supervisor metadata | Show which action depends on the missing id |
| `plan_missing` | saved plan evidence | Show that submit readiness is blocked |
| `logs_missing` | logs evidence | Say not captured yet, not "empty logs" |
| `artifact_manifest_missing` | artifact manifest evidence | Say manifest not captured yet |
| `dirty_git` | reproducibility evidence | Show branch/SHA/dirty summary |
| `resource_over_requested` | requested resources and usage | Show requested vs used values |
| `low_cpu_efficiency` | usage evidence | Show efficiency and denominator when available |

### Component Contracts

#### Operational KPI

- Contains a short label, numeric value, optional delta/reason, and icon.
- Must answer one operational question.
- May link to a filtered Runs view.
- Must not contain a chart unless the chart adds trend evidence.

#### Evidence Chip

- Represents a concrete evidence object or missing evidence category.
- Examples: `plan hash`, `quota snapshot`, `logs saved`, `artifact manifest`,
  `git dirty`, `events`, `remote id`, `supervisor`, `qstat/cnode evidence`,
  `usage`, `diagnosis`, `conformance`, and `token confirmation`.
- Uses `data-state="present|missing|stale|blocked|not-applicable"`.
- Tooltip names the source field or API resource.
- Runs and Run detail should use a stable triage order:
  `remote execution`, `events`, `plan`, `quota/conformance`, `authorization`,
  `usage/diagnosis`, `reproducibility`, `logs`, `artifacts`, `lineage`.
- Chip width may be compact, but hover, loading, or missing states must not
  shift table columns or surrounding controls.

Evidence chip matrix:

| Dimension | Allowed values | UI requirement |
|---|---|---|
| `evidence_type` | `remote-execution`, `events`, `plan`, `quota`, `conformance`, `authorization`, `usage`, `diagnosis`, `reproducibility`, `logs`, `artifacts`, `lineage` | Stable label and icon |
| `source_kind` | `run-record`, `saved-plan`, `quota-snapshot`, `approval-record`, `job-operation`, `artifact-manifest`, `derived-client-state`, `mcp-action-evidence` | Tooltip or provenance row names source |
| `platform_branch` | `uts-hpc`, `uts-ihpc`, `shared` | Copy uses queue/PBS or cnode/supervisor language correctly |
| `freshness` | `fresh`, `stale`, `not-observed`, `not-applicable`, `unknown` | Show observed time or missingness reason |
| `scope` | `run`, `profile`, `project`, `snapshot`, `artifact-manifest` | Provenance shows the scope id when available |
| `redaction_level` | `summary-only`, `bounded-tail`, `manifest-scoped`, `hash-only`, `server-side-token` | Never expose raw secrets, arbitrary paths, or general browsing |
| `route_target` | Run Detail tab, Capacity Snapshot, Logs, Artifacts, Compare, none | Chip can navigate or open provenance without hidden side effects |

Minimum evidence by run state:

| Run state | Required visible evidence classes |
|---|---|
| `planned` | plan, quota/conformance when available, authorization state, reproducibility |
| `submitted` / `running` | remote execution, events, quota/conformance, logs availability |
| `finished` | events, usage when captured, logs, artifacts when captured, reproducibility |
| `failed` / `unknown` | events, diagnosis when available, logs, remote execution, missingness reason |
| `cancelled` | remote execution, token-confirmed authorization, events, logs availability |

Evidence provenance:

- Clicking or focusing an evidence chip may open a compact popover or drawer.
- The provenance view should show source type, resource reference, observed
  time, profile id, snapshot id or hash when relevant, freshness, redaction
  note, and related event or route link.
- It should not expose raw JSON by default, arbitrary local paths, arbitrary
  remote paths, cleartext secrets, or a general file browser.
- Provenance copy should distinguish saved local evidence from live reads,
  cached documentation, derived client-side state, and MCP action evidence.

#### Resource-Fit Chip

- Uses `good`, `watch`, `over-requested`, `under-observed`, or `unknown`.
- Must include a text reason, such as `32 GB requested / 6.2 GB used`.
- Low CPU efficiency should be detectable even when memory usage is missing.
- Memory over-requesting should be described as a clear candidate only when the
  waste is meaningful, for example at least 4 GB or used/requested memory is at
  or below 80%. Small differences may be shown as normal variance or `good`.
- CPU efficiency warnings should include the threshold used by the UI, such as
  `below 40%`.

#### Action Readiness Card

- Shows one action, readiness state, required evidence, and next step.
- States: `ready`, `requires-confirmation`, `blocked`, `not-applicable`.
- Submit and retry readiness depend on saved plan evidence, plan hash, and a
  fresh quota snapshot that passes server-side conformance. They should not be
  shown as token-approval blocked when the operation is conformant under ADR
  0004.
- Abort readiness depends on active run state, remote job id or supervisor
  metadata, and a decided `jobs.cancel` approval.
- The action menu itself should expose readiness. Blocked items may remain
  inspectable, but should open an explanation, not execute.
- Green should not be used as the primary submit/retry color. Use neutral or
  blue for reversible non-destructive actions, and reserve danger styling for
  irreversible or token-confirmed operations.
- Every action modal includes a Gate Evidence Block:
  - operation name;
  - target run id;
  - profile id and platform;
  - plan hash when relevant;
  - quota snapshot id and freshness when relevant;
  - approval id and approval state when relevant;
  - conformance or blocked reason;
  - explicit note when a trusted server-side token is required and not exposed
    to the browser.

#### Authorization State

Authorization state is separate from lifecycle status, severity, and selection.
Use these display states for action surfaces:

| State | Meaning | Typical actions | UI treatment |
|---|---|---|---|
| `autonomous-conformant` | Server-side conformance can authorize the action with a fresh quota snapshot | submit, retry, transfer, fetch | Show snapshot id, freshness, conformance pass, and no token requirement |
| `advisory-only` | The plan has human-readable risk notes but they do not block autonomous conformance | GPU request, restricted queue note, high memory note | Show as neutral or informational, not as blocked |
| `requires-token-confirmation` | A trusted local human token is still required server-side | cancel, cleanup, state migration apply | Show irreversible/structural warning and token remains server-side |
| `blocked-nonconformant` | The request violates profile, queue, node-family, storage, or saved plan constraints | submit, retry, transfer, fetch | Show violated limit and safe next step |
| `blocked-stale-snapshot` | A required quota snapshot is missing or stale | submit, retry, capacity-derived actions | Link to Capacity Snapshot or quota refresh evidence |

Do not use approval language for advisory-only reasons. The UI may say a plan
has advisory notes, but it must not make those notes look like a human approval
gate. Where a trusted token is required, the browser never displays, stores, or
asks the user to paste `UTS_COMPUTING_APPROVAL_TOKEN`.

Authorization copy contract:

- Use `authorization_state` as the product concept for all action surfaces.
- Reserve `approval`, `approval id`, and `requires approval` for operations that
  require a trusted local confirmation token server-side, such as `jobs.cancel`,
  artifact cleanup execution, and state migration apply.
- For submit/retry/transfer/fetch paths covered by server-side conformance, use
  `autonomous-conformant`, `blocked-nonconformant`,
  `blocked-stale-snapshot`, or `advisory-only`.
- Do not show `approval pending` for GPU, high-memory, restricted queue, or
  other advisory plan notes unless the underlying server operation truly
  requires a token-confirmed approval.
- Safe copy examples:
  - `Conformance passed with fresh quota snapshot; no human token required.`
  - `Blocked: quota snapshot is stale. Refresh capacity evidence before submit.`
  - `Advisory: GPU request requires attention, but it is not a token gate.`
  - `Token confirmation required server-side for jobs.cancel.`
- Unsafe copy examples:
  - `Submit approval pending` for an otherwise conformant ADR 0004 submit.
  - `Paste approval token` anywhere in the browser.
  - `Switch profile to bypass quota`.

#### Empty State

- Must be specific and typed.
- Include exactly one next step when useful.
- Avoid broad copy such as "No data" or "Nothing here".
- Uses one of these `data-empty-kind` values:
  `not-captured-yet`, `unsupported`, `not-applicable`, `stale`, `blocked`,
  `failed-to-load`, `filtered-empty`, `history-empty`.
- Do not use `0`, blank strings, or hidden rows as substitutes for a typed
  empty state.

#### Error State

Errors are typed states, not generic banners. Use one of these error kinds when
possible:

- `failed-to-load-local-state`;
- `schema-invalid`;
- `api-error`;
- `mcp-refused`;
- `conformance-blocked`;
- `token-required-server-side`;
- `network-localhost-unavailable`;
- `stale-local-state`.

Every error state should show:

- what failed;
- which page, panel, action, or evidence source is affected;
- whether old data is being kept as stale evidence;
- the safe next step, if one exists;
- a concise technical detail suitable for bug reports.

Error states must not suggest reading secrets, bypassing MCP, running arbitrary
remote shell commands, weakening SSH host-key policy, or switching accounts to
evade quotas.

#### Table Toolbar

- Contains preset view controls, project/status/platform filters, search, clear
  filters, result count, and compare-set affordance.
- Filter state should round-trip through URL parameters where practical.
- Search and filter controls need accessible names.

#### Local Safety Context Bar

- Appears in the page header or near the global toolbar.
- Shows `localhost`, read-mostly state, `profile_id`, platform, selected
  snapshot id/freshness when known, per-profile scope, and `MCP-gated actions`.
- Should be compact and persistent. It must not become a hero banner or
  marketing explanation.
- Links to relevant safety documentation or a short modal are acceptable.
- Profile switching copy must say that profiles are separate safety/quota
  scopes. It must never imply that switching accounts is a way to pool capacity
  or evade quota limits.
- Any capacity summary in the bar must be scoped to the selected profile and
  observed snapshot. Avoid aggregate capacity language across profiles.

#### Modal

- Replaces `prompt()` and `confirm()` for all action flows.
- Uses a visible operation name, target run id, read-only evidence block, inputs,
  risk label, and primary/secondary actions.
- Focus must move into the modal on open and return to the trigger on close.
  Escape and cancel must be supported for non-final confirmations.
  Irreversible operations must not use a generic `OK` label.
- Buttons must expose distinct `enabled`, `disabled`, `hover`, `focus`,
  `pressed`, and `loading` states.
- Primary action text must be the concrete operation, such as `Submit run`,
  `Clone run`, or `Cancel run`.
- Server errors remain in the modal, are announced through the status region,
  and do not clear the user's inputs unless the route changes.

## Information Architecture

### Platform-Specific Vocabulary

UTS HPC and UTS iHPC should share visual patterns but not pretend to be the same
platform.

- UTS HPC vocabulary: `queue`, `PBS job`, `queued`, `running`, `walltime`,
  `exec host when known`, `qstat`, and `quota snapshot`.
- UTS iHPC vocabulary: `node family`, `active cnode/session`, `supervisor`,
  `session status`, `storage headroom`, and `cnode evidence`.
- Shared column labels may use paired terms such as `Queue / Node family` or
  `Job / Session`, but tooltips and detail rows must explain the platform branch
  actually used by the run.
- Do not use `worker` as a generic synonym for either PBS jobs or iHPC
  supervised runs unless a future worker data source exists.
- Capacity Snapshot may show PBS queues and iHPC node families with different
  layouts. A single mixed visual metaphor should not hide the platform
  difference.

### Platform Branch Anatomy

Shared page structure is allowed, but the visible anatomy should branch by
platform wherever the underlying operational model differs.

Runs row anatomy:

| Branch | Primary compute fields | Evidence fields | Capacity/readiness fields |
|---|---|---|---|
| UTS HPC | queue, PBS job id, qstat status, exec host/node when known, walltime | plan hash, qstat/job-operation evidence, events, logs, usage/accounting | quota snapshot id, queue limits, run headroom, conformance result |
| UTS iHPC | node family, active cnode/session, supervisor id/status, session time | supervisor metadata, cnode/session evidence, events, logs, storage evidence | active session evidence, node-family fit, storage headroom, conformance result |

Run Detail overview anatomy:

- UTS HPC overview starts with PBS lifecycle, queue, job id, qstat/usage
  evidence, requested walltime/resources, and queue conformance.
- UTS iHPC overview starts with supervisor lifecycle, node family, active
  cnode/session evidence, session/storage headroom, and supervised-start
  conformance.
- Shared sections such as reproducibility, events, logs, artifacts, lineage, and
  resource fit may reuse the same visual components after the platform branch is
  explicit.

Capacity Snapshot anatomy:

- When a saved or latest snapshot is available, loaded capacity evidence should
  render before snapshot controls. Snapshot controls should collapse into a
  compact `Change capacity snapshot` disclosure so the first viewport is about
  headroom and evidence, not form chrome.
- When no snapshot is loaded or no saved snapshots exist, the snapshot controls
  may open by default and lead with the typed empty state.
- UTS HPC uses queue rows with open/closed/stale/unknown state, running/queued
  counts, run headroom, recommended parallelism, and observed queue limits.
- UTS iHPC uses node-family/session rows with active cnode/session, family fit,
  storage headroom, and supervisor-start readiness.
- Mixed dashboards must not aggregate capacity across profiles or platforms.
  Cross-profile totals are allowed only as counts of local records, not as quota
  or capacity pools.

### Runs

Runs becomes the primary operational workspace.

Top summary should prioritize:

- active runs;
- failed runs;
- runs needing attention;
- recently finished runs;
- total core-hours;
- total GPU-hours.

The first table should be the main control surface. Recommended columns:

- compare selector, explicitly labeled as non-mutating;
- run id;
- status, reason, and last update;
- attention reason, when present;
- project and job type;
- profile and platform;
- queue or node;
- requested resources;
- usage summary when available;
- created, submitted, and updated time;
- duration;
- lineage indicator for retries or clones;
- evidence completeness.

Column rules:

- `run id`, `status`, `attention reason`, `evidence`, and `action readiness`
  are priority columns. They should stay early in the reading order.
- The compare selector should use an eye or compare icon with an accessible
  label such as `Include in comparison`; avoid a generic checkbox unless a
  separate batch-action design exists.
- Evidence chips use the stable triage order defined in Component Contracts.
- Action menus should show blocked or confirmation-required states before
  opening a modal. A blocked action should explain itself.
- Column visibility may be saved locally, but P0/P1 should not allow arbitrary
  metric-column explosion.
- Result counts and filter chips must update when URL-backed filters change.

Preset filters:

- All;
- Active;
- Queued or submitted;
- Failed;
- Planned;
- Finished;
- Needs attention;
- Over-requested;
- Dirty git;
- Evidence gap.

First viewport order:

1. Page title, auto-refresh, and local/safety context.
2. Operational KPI strip: active, failed, needs attention, recently finished,
   total core-hours, total GPU-hours.
3. Runs toolbar and table.
4. Secondary charts: status distribution and project core-hours.

The existing status distribution and project core-hour charts should move below
the table. They are supporting context, not the primary control surface.

`needs_attention` should be derived client-side from:

- `failed` or `unknown` status;
- stale or missing quota snapshot when required for submit readiness;
- token-confirmed authorization required for a visible action, or
  nonconformance that blocks an autonomous action;
- active run without remote id or supervisor metadata;
- missing saved plan evidence for a planned run;
- missing logs/artifact evidence where a terminal run should normally have it;
- dirty git state;
- resource-fit warnings such as memory over-request or low CPU efficiency.

### Run Detail

Run detail should move from a mostly field-based view to an evidence-oriented
view.

Header:

- run id;
- large status badge;
- last updated time;
- project;
- platform/profile;
- queue/node;
- state-gated actions.

Top summary band:

- current status explanation;
- action readiness;
- resource fit;
- reproducibility summary;
- lineage, if cloned or retry-derived.

Tabs:

- Overview;
- Plan & Resources;
- Lifecycle;
- Logs;
- Artifacts;

Future additive tabs:

- Metrics, after usage samples or richer metric history exist;
- Trace, after optional agent trace data exists.

Tab intent:

- Overview: state explanation, readiness, resource fit, and evidence
  completeness. This is the first-stop triage view.
- Plan & Resources: normalized job spec, command, requested resources, plan
  hash, quota snapshot id, profile, queue/node, and approval bindings.
- Lifecycle: stage steps plus event timeline. Retry or clone lineage must be
  visible near the steps, not buried in raw JSON.
- Logs: saved evidence or live tail must be labeled as such. Show capture time,
  byte limit, and whether the content is partial.
- Metrics: future tab for aggregate and trend charts after data exists. Current
  aggregate usage belongs in Overview and Plan & Resources.
- Artifacts: manifest-scoped files and checksum metadata only.
- Trace: future tab with a typed empty state unless optional agent trace data
  exists.

Overview should answer:

- What is this run doing or what happened?
- Is it safe or ready to act on?
- What evidence exists?
- What is missing?

Lifecycle should combine steps and event timeline. Logs should explicitly say
whether the content is saved evidence or live tail. Artifacts should show
manifest scope and checksum metadata without implying arbitrary file browsing.

Artifacts table contract:

- Current columns: relative path, size, SHA-256 or checksum status, and source
  manifest.
- Future additive columns may include artifact id, type, captured at, and
  manifest-scoped actions.
- Actions may copy a manifest path, open a manifest-scoped local artifact when
  already fetched, or trigger existing MCP-backed artifact fetch flows.
- The table must not expose arbitrary local browsing, arbitrary remote paths,
  glob cleanup, recursive deletion, or raw shell commands.
- Missing artifacts use `artifact_manifest_missing` or `not-captured-yet`, not a
  blank table.

### Explore

Explore should become the resource optimization and comparison workspace.

Initial scope:

- compact `Current analysis` summary that states active scope, total/filtered
  runs, plotted runs, group dimension, active filter count, and missing usage;
- requested vs used memory scatter grouped by fixed dimensions such as status,
  project, platform, or queue;
- core-hours and GPU-hours table;
- CPU efficiency;
- walltime requested vs actual, when both exist;
- right-sizing candidate list;
- project/status/platform/queue filters plus the fixed group-by selector in a
  responsive filter grid;
- clickable group summaries that convert the current group dimension into the
  matching URL-backed filter;
- run selection handoff from Runs;
- chart-to-table highlighting.

Resource-fit table formatting:

- Memory, CPU efficiency, core-hours, GPU-hours, and walltime should use
  tabular numerals.
- Requested-vs-used values should render as compact bars or threshold chips when
  that improves scanning, with the numeric values still visible.
- Missing usage must not be interpolated or silently converted to zero. Use a
  typed `under-observed`, `not-captured-yet`, or `not-applicable` state.
- Low CPU efficiency can be flagged without memory evidence when CPU usage
  exists.
- Every chart mark must map to one table row and one Run Detail link.
- Chart interaction should highlight or scroll the corresponding row, and table
  row focus should preserve keyboard accessibility.
- Grouping is limited to fixed dimensions such as project, status, platform, and
  queue in P1. The current scatter supports these fixed group-by modes through
  URL-backed state. Do not add arbitrary query language in this redesign phase.
- On mobile, Explore controls should remain compact enough for the first
  viewport to show analysis context. Use two-column filter layout when space
  permits, with the group selector spanning the row; fall back to one column only
  when required by actual container width.

Later scope:

- richer grouping-specific summaries beyond point counts;
- richer walltime trend or distribution views after enough usage samples exist;
- over-requested candidates list;
- side-by-side diff for selected runs;
- multi-line metric charts after usage samples exist.

P1 Explore should not become a generic chart editor. Its first job is to make
resource-fit recommendations inspectable from existing data. Every plotted dot
must have a corresponding table row, tooltip, and run-detail link.

### Capacity

Rename Queue & Workers to Capacity Snapshot unless true worker monitoring is
added. The current `quotas.capacity` model reads a saved, profile-scoped quota
snapshot; it is a snapshot interpreter, not a cluster-wide live monitor.

Do not use these labels in the UI unless a future MCP data source provides
fresh, profile-scoped evidence for them:

- `Workers`;
- `live cluster health`;
- `node monitor`;
- `cluster-wide capacity`;
- `queue ETA`;
- `rack view`;
- `topology`.

If a future feature does add live monitoring, the page must display source,
profile, observed time, freshness, and scope beside the live label.

The page should explain:

- which profile and snapshot are being viewed;
- platform;
- snapshot age;
- whether the snapshot is fresh or stale;
- queue state;
- running and queued counts;
- run headroom;
- recommended parallelism;
- storage notes when available;
- iHPC available families and active sessions.

Avoid implying live cluster-wide worker observability unless a real monitoring
data source is added.

For UTS HPC, show queues as rows with `open/full/closed/stale/unknown` states.
For UTS iHPC, show available node families, active sessions, and storage
headroom. Each branch should have a typed empty state when no snapshot is loaded.

### Projects

Projects should remain a rollup page, but the primary surface should be a
compact project index table, not a broad card grid. Each project row should
route into a filtered Runs view.

Project index row content:

- project name and hash;
- total runs;
- active, failed, planned, and finished status links;
- platforms and profiles;
- latest update;
- health label;
- ordered status composition bar.

Project rows should be compact. The project title should be a link to
`/runs?project=<project>`, preserving the project filter in URL state. The
numeric status links, health label, and ordered status composition must be
visible without relying on chart-only encodings.

## Interaction Patterns

### Compare Selection

Add a selection or visibility control to Runs. This selected set is for visual
comparison only. It must not imply batch mutation.

Use an eye, compare, or chart-inclusion affordance instead of a generic checkbox.
Recommended label: `Include in comparison`. Recommended limit: 4 to 8 selected
runs, with side-by-side comparison optimized for 2 to 4 runs.

Selected runs can feed:

- Explore filters;
- side-by-side run comparison;
- copied Markdown summaries;
- artifact or log evidence comparison, if supported later.

The compare selector must not enable batch submit, batch abort, or batch cleanup.
Any future batch operation needs a separate safety design and is out of scope
for this visual redesign.

### Side-By-Side Run Compare

Side-by-side compare should be a fixed, evidence-oriented diff view before any
generic report builder is considered.

Default field groups:

- Status: status, attention reason, last event, last updated.
- Plan: plan hash, command summary, job type, normalized resources.
- Capacity: profile, platform, queue or node family, quota snapshot id,
  freshness, conformance result when available.
- Usage: core-hours, GPU-hours, CPU efficiency, requested memory, used memory,
  walltime requested and actual when present.
- Reproducibility: git SHA, branch, dirty state, project hash.
- Evidence: logs, artifact manifest, approval record, lifecycle events.
- Lineage: retry source, clone source, parent run.

Interaction rules:

- Default to showing differences first, with a toggle to show all fields.
- Long strings are truncated in cells but inspectable in a modal or detail
  drawer.
- Missing values use typed empty states.
- The comparison view must not introduce mutation actions. Links may navigate to
  Run Detail, Logs, Artifacts, or Explore.
- Pinning a reference run is allowed for visual comparison only.

### Modal Actions

Replace `prompt()` and `confirm()` with local modal flows.

Clone modal:

- source run id;
- source status;
- new run id;
- reason;
- resulting operation: `jobs.retry.plan`.

Submit modal:

- run id;
- platform/profile;
- requested resources;
- plan hash;
- quota snapshot id;
- conformance state and any advisory-only reasons;
- explicit note that submission still runs through MCP conformance gates and
  does not require a human token when conformant under ADR 0004.

Abort modal:

- run id;
- remote job id or supervisor metadata summary when available;
- approval id;
- irreversible warning;
- explicit operation: `jobs.cancel`;
- clear statement that the trusted token remains server-side.

Shared modal acceptance:

- The modal title starts with the concrete operation: `Clone run`, `Submit run`,
  `Cancel run`.
- The primary button repeats the operation, not `OK`.
- The payload fields are visible before submit.
- The Gate Evidence Block is visible before submit.
- The action readiness state is shown as `ready`, `requires-confirmation`,
  `blocked`, or `not-applicable`.
- Human-token language appears only for operations that still require trusted
  local confirmation. The browser never displays, stores, or asks for
  `UTS_COMPUTING_APPROVAL_TOKEN`.
- Server errors remain in the modal and are also surfaced through a toast.
- Success toast links to the affected run when possible.

### Empty States

Empty states should be specific:

- "No saved logs evidence yet."
- "Usage metrics appear after a status or usage poll records them."
- "Trace data is not captured for this run."
- "Capacity requires a quota snapshot."
- "Artifact manifest not captured yet."

### Saved Views

P1 should support lightweight local saved views through URL parameters or
localStorage, not server-side state.

Examples:

- `/runs?view=active`
- `/runs?project=my-project&status=failed`
- `/explore?project=my-project&selected=run-a,run-b`

The router must treat hash query parameters as part of the route, not as an
unknown page. Saved state priority should be:

1. Explicit URL parameters.
2. Local saved view defaults.
3. Built-in defaults.

Persistable state:

- Runs view preset;
- project/status/platform/queue filters;
- search text;
- sort field and direction;
- compact density preference;
- selected compare set;
- visible column set;
- named Runs saved views that bundle filters, search, sort, density, and visible
  columns.

Do not persist server-side UI preferences. Named Runs views are local-only and
must not hide priority identity/status columns.

## Data Use

Prefer existing data first:

- `RunRecord.status`;
- `RunRecord.events`;
- `RunRecord.submission`;
- `RunRecord.usage`;
- `RunRecord.reproducibility`;
- `RunRecord.approval`;
- `RunRecord.retry_of`;
- saved plan artifacts;
- artifact manifests;
- saved logs or job-operation evidence;
- quota capacity snapshots.

Derived client-side fields are acceptable:

- `needs_attention`;
- `attention_reason`;
- `severity`;
- `resource_fit`;
- `evidence_completeness`;
- `is_active`;
- `is_terminal`;
- `is_retry`;
- `is_over_requested`.

Suggested derived-field definitions:

| Field | Inputs | States |
|---|---|---|
| `needs_attention` | status, authorization, conformance, reproducibility, usage, plan, manifest, snapshot | `true` / `false`, plus reason list |
| `attention_reason` | status, events, authorization, conformance, snapshot, evidence, usage, git | enumerated reason codes such as `snapshot_stale`, `token_confirmation_required`, `blocked_nonconformant`, `resource_over_requested` |
| `severity` | attention reason, operation risk, evidence freshness | `none`, `low`, `medium`, `high` |
| `resource_fit` | requested resources, usage, duration | `good`, `watch`, `over-requested`, `under-observed`, `unknown` |
| `evidence_completeness` | plan, logs, manifest, events, authorization, conformance, reproducibility | `complete`, `partial`, `missing`, `not-applicable` |
| `action_readiness` | status, plan hash, snapshot, conformance, token-confirmation, remote id | per-action readiness state |
| `snapshot_freshness` | snapshot observed time, current time, policy threshold | `fresh`, `stale`, `missing` |

Derived fields must stay display-only unless promoted into server APIs later.
They must not weaken MCP conformance, approval, checksum, or profile-scope gates.

Existing tool output can be used visually before new schemas exist:

- `RunRecord.usage` and `jobs.usage` output may drive resource-fit chips,
  Explore rows, and usage evidence provenance when present.
- `jobs.diagnose` output may drive failure attention reasons and diagnosis
  evidence chips when persisted or available through a bounded action result.
- `RunRecord.reproducibility` may drive git and environment evidence chips even
  before richer trend data exists.
- P2 persistence work should improve history and trendability; it is not a
  prerequisite for showing already-captured evidence in the UI.

Additive future data:

- `RunUsageSample[]` for per-step usage and trend charts;
- persisted failure diagnosis from `jobs.diagnose`;
- latest quota snapshot index for profile/snapshot selection;
- optional agent trace records under `.uts-computing/agent-traces/`.

## Phased Plan

### P0: Visual Hierarchy And Safer Local Interactions

No new backend capability.

Current done:

- Runs top summary includes active, failed, needs attention, recent completions,
  core-hours, and GPU-hours.
- Broad Runs charts sit below the Runs table.
- Runs has URL-backed route support, preset/project/search filters, clear
  filters, result count, active filter chips, compact density toggle, and
  compare selection.
- Run detail includes status summary, action readiness, resource fit,
  reproducibility, lifecycle, saved log evidence, and artifact evidence.
- Action flows use local modal flows instead of browser `prompt()` /
  `confirm()`.
- Queue & Workers is reframed as Capacity Snapshot.
- The frontend includes baseline Quiet Ops Console CSS, surface tokens, and
  focused action styling.
- Key empty and error states now carry typed state attributes and quiet visible
  state labels.
- Action cards and modals expose the Authorization State visual contract for
  conformance-ready, local dry-run, token-confirmed, and blocked paths.
- Run Detail action buttons now carry inline `data-action-state`,
  keyboard/screen-reader linkage to the gate reason, and distinct button-level
  styling for conformant, local dry-run, token-confirmed, and blocked paths.
- A global assistive status region announces filter result counts, action
  feedback, and capacity load outcomes.
- Refresh status badges now expose explicit state semantics through
  `data-refresh-state`, `data-refresh-severity`, `aria-busy`, and a readable
  `aria-label`, so fresh, refreshing, stale, and paused states are not conveyed
  by color or icon alone.
- Action modals restore focus to the triggering control after close.
- Action and evidence provenance modals support Escape/cancel close paths,
  restore focus to their triggering controls, and announce open/close state
  through the global assistive status region without overwriting submit success
  feedback.
- Runs has platform and queue/node-family filters that round-trip through URL
  parameters without server-side preference state.
- Runs evidence chips expose `data-state`, are keyboard-focusable, and open a
  provenance modal with source, state, run/profile/platform scope, observed
  time, and redaction context.
- Runs table now includes an `Action readiness` column with
  `data-action-readiness-state`, visible authorization/readiness pill, and a
  short gate reason before the user opens an action modal.
- Runs table now includes a `Resources / fit` column that combines requested
  resources, compact usage summary, and resource-fit chips from the list API's
  compact requested/usage projection.
- Runs table priority fields now have visible, keyboard-operable sorting with
  `aria-sort`, active sort icons, assistive announcements, and URL-backed
  `sort` / `dir` state for repeatable filtered workbench views.
- Runs table now has a local column-visibility menu for optional columns. The
  default workbench view keeps compare, run id, status, action readiness,
  resources, project, and evidence visible; lower-priority platform/queue,
  cluster/node, created, and duration fields can be shown or hidden through a
  saved local view preference. Legacy unversioned column preferences migrate to
  this tighter default.
- Runs table keeps priority identity/status columns early and visible by
  column order. Only the compare selector remains sticky; run id and status
  scroll with the table to avoid the column-overlay failures seen in dense
  compare/resource/project layouts.
- Runs now has local-only named saved views for current filters, search, sort,
  compact/comfortable density, and optional column visibility. Applying a saved
  view updates the clean `/runs` URL parameters for shareable filter/sort state
  and restores local-only density/column preferences from `localStorage`.
- Runs now includes a compact Current view summary inside the workbench toolbar,
  showing the active filter scope, result count, sort, visible-column footprint,
  and density so saved views and column pruning remain legible.
- Runs table column widths have been tightened so the compare/run/status/action
  priority columns read as a compact workbench instead of a sparse wide report,
  while the detailed columns remain horizontally scrollable.
- Lifecycle status badges now render as structured status components with a
  status-specific icon, semantic status dot, lifecycle text, `data-lifecycle-status`,
  and explicit `aria-label` / `title` text. This keeps lifecycle status separate
  from attention severity and action readiness while improving non-color-only
  recognition. When a full run record is available, the lifecycle badge title
  and accessible label also include a short evidence-backed reason such as
  remote job id, plan-hash availability, usage capture, or failure/unknown
  attention reason.
- Runs global empty state no longer renders the full table header or horizontal
  scroller when there are no saved runs; the workbench collapses inert filters
  and compare actions into a light result-count strip, then shows one calm typed
  empty panel. Empty chart cards are also withheld until at least one saved run
  exists.
- The former left navigation has been replaced by a compact top navigation.
  The freed horizontal page space is used for the workbench content, while a
  small top-bar safety baseline keeps `local`, `read-mostly`, and `MCP-gated`
  state visible as separate short chips without becoming a hero banner.
  On narrow screens, a slim mobile safety baseline remains visible outside the
  collapsed navigation so the local/read-mostly/MCP boundary is not hidden
  behind the menu toggle.
- The top-bar safety context now carries page-specific scope chips. Runs and
  Explore show the current candidate row/profile/platform scope, Run Detail
  shows the run profile/platform/snapshot binding, Capacity shows the selected
  quota snapshot scope and freshness, and Projects shows rollup scope without
  implying shared capacity pools. Scope chips include visible dimension labels
  and collapse lower-priority chips at medium widths before the navigation
  becomes cramped.
- Explore now has a compact `Current analysis` summary above its filters. It
  makes the active filter scope, result count, plotted count, group dimension,
  active filter count, and typed missing-usage count visible before the chart.
- Explore filters now use a responsive grid instead of a loose row of controls:
  desktop distributes project/status/platform/queue/group controls evenly, while
  mobile uses two columns and lets the group selector span the row to reduce
  first-viewport height.
- Explore memory scatter now shows compact group summaries beside the legend.
  They report per-group plotted count plus memory headroom/request-use signal and
  click through to the corresponding URL-backed filter.
- Runs prunes stale compare selections against the currently loaded run ids
  before enabling the compare affordance, preventing stale local selections from
  surfacing as actionable state.
- Runs preset filters now include `Over-requested`, `Dirty git`, and
  `Evidence gap`, backed by client-side derived state over compact
  resource, reproducibility, and evidence projections.
- Runs severity grammar now derives a deduplicated attention-reason list per row.
  The table shows the primary reason plus a compact `+N` affordance when more
  flags are present, while row metadata preserves the full reason list for
  inspection and exported compare summaries.
- Runs now includes a triage rail above the workbench that summarizes
  `Needs attention`, `Over-requested`, `Evidence gap`, and `Dirty git` as
  clickable visual scanning entries wired to the same URL-backed filters.
- The Quiet Ops Console CSS now defines baseline risk tokens for blocked,
  attention, warning, and info states in both light and dark themes.
- Run Detail evidence packets now reuse the provenance modal with a stable
  evidence order across remote execution, events, plan, conformance,
  authorization, usage, reproducibility, logs, artifacts, node evidence, and
  lineage; each chip carries evidence type, source kind, and route-target
  metadata.
- Run Detail Lifecycle now applies the same severity grammar to timeline
  events: event cards carry danger/warning/success/info/neutral state, icons,
  compact badges, and terminal step labels for failed/cancelled/unknown runs.
- Run Detail Logs now renders stream-level evidence rows before the raw bounded
  log preview. Each saved stream exposes captured/partial/not-captured state,
  stream name, detail text, and a compact state pill so users do not need to
  parse raw log text first.
- Capacity Snapshot now exposes quota-snapshot provenance chips for snapshot
  freshness, PBS queue or iHPC family/session evidence, and storage headroom.
  These chips reuse the same provenance modal while showing a snapshot scope
  instead of pretending the evidence belongs to a run.
- Capacity Snapshot now renders loaded evidence before the snapshot loader when
  a saved/latest snapshot is available. Snapshot selection remains available in
  a compact `Change capacity snapshot` disclosure below the evidence.
- Projects now renders as a compact project index table instead of a broad card
  wall. Each row keeps project identity, health, status composition, status
  count links into filtered Runs views, scope, and latest-update evidence in one
  scan line.
- Typed error states now render as structured alert panels with assertive live
  semantics, scope/kind metadata, readable messages, and optional recovery
  actions for route-level and compare failures. Route, Compare, and Log evidence
  failures also update the shared status region.
- Action modal failures now stay inside the modal as structured `action-failed`
  typed errors. The duplicate-submit guard remains active while the request is
  in flight, failures update the shared status region, and focus moves to the
  inline error so keyboard users do not need to hunt for a toast.

Current partial:

- Status reason rendering, action readiness, and Run Detail lifecycle timelines
  now carry visible severity and authorization states; future work should extend
  the same severity grammar into any new action-history surfaces.
- Evidence chips now cover Runs, Run Detail, and Capacity Snapshot provenance;
  future work should tune evidence type labels as new diagnosis sources are
  added.
- Resource-fit chips exist in Run Detail and Explore, but should continue to
  align to the documented thresholds and typed missingness states.
- Empty and error states have typed attributes in key surfaces, but future work
  should extend them to any new panels as they are added.
- Keyboard-visible focus states, Explore table equivalence, modal Escape/focus
  return, and modal status-region announcements exist in the browser stack, but
  broader status/error announcements still need DOM tests beyond static
  affordance checks and manual browser QA.
- Reduced-motion CSS now disables refresh/status animation paths, but additional
  rendered accessibility checks should keep validating the behavior as more
  animated elements are added.
- `--ops-*` surface and baseline risk tokens exist; semantic status, severity,
  action, chart, and richer state tokens need full CSS implementation and
  light/dark review.

Implementation gap ledger:

| Gap | Current implementation shape | Spec target |
|---|---|---|
| Evidence chips | Runs exposes compact events, remote id, node, and lineage provenance; Run Detail exposes a broader evidence matrix with type/source/route metadata plus stream-level log evidence rows; Capacity Snapshot exposes quota-snapshot provenance for freshness, queue/family/session, and storage evidence | Extend the same evidence contract to future diagnosis evidence |
| Runs priority columns | Action readiness and a compact resources/fit summary are first-class; Project and Evidence stay visible in the default workbench, while platform/queue/created and other detail columns can be hidden locally; compare remains sticky, and run/status remain early in the column order without overlaying later columns | Keep run id, status, attention reason, evidence, resource fit, project context, and action readiness early |
| Runs sorting | Run, status, project, platform, queue, cluster, node, and created columns are keyboard-sortable with visible state and URL persistence | Keep sorted views recognizable and never hide priority identity/status columns |
| Runs saved views | Local-only named views save filters, search, sort, density, and optional columns; applying a view restores clean URL params plus local density/column preferences; the Current view summary makes the active scope, sort, density, and visible-column footprint explicit | Extend only if future views keep priority identity/status columns discoverable |
| Preset filters | Over-requested, dirty git, missing evidence, and needs-attention visual triage entries exist; future work should tune thresholds and add richer source-specific evidence counts | Add presets once derived fields are reliable |
| Severity grammar | Status and attention reasons now emit `data-run-severity`, a full `data-run-attention-reasons` list, primary reason text, and compact `+N` overflow for multi-flag rows; Run Detail lifecycle events now expose event severity, icon, badge, and terminal state styling | Extend the same severity layer into future action-history surfaces |
| Action readiness in menus | Runs table shows readiness before modal open; Run Detail action buttons now show blocked/confirmation/local-dry-run styling inline; action modal failures now show scoped inline typed errors instead of relying on transient toasts | Extend the same button-level grammar to any future Runs-row direct action entry |
| Refresh/staleness | Auto-refresh keeps the previous page visible on failure, marks the refresh badge stale, and includes the last successful UI refresh time; Run Detail Logs now has an independent saved-evidence reload control that preserves previous log evidence on refresh failure | Extend this stale-data grammar to future evidence panels that refresh independently |
| Refresh accessibility | Refresh badges and the Logs evidence reload pill expose readable state labels, busy state, severity metadata, and reduced-motion animation suppression | Add broader DOM/Playwright coverage for stale/failure announcements across independently refreshed panels |
| Global empty state | Runs and Explore with zero saved records show dedicated typed empty panels instead of empty table/chart shells; Capacity uses a purpose-built snapshot loader plus typed empty state when no snapshot is loaded; stale compare ids are pruned before display | Keep extending the pattern to any future data-absent panels |
| Missing/unsupported navigation | Missing Run Detail and unknown route states now include typed state labels plus explicit `Back to Runs` / `Open Explore` actions; route and compare error panels now expose scoped recovery actions and assertive alert semantics | Keep every route-level failed or unsupported state recoverable without browser back |
| Projects index | Projects uses a dense table with health, status mix, status-filter links, scope, and latest update per project | Keep project groups as an operational index into Runs, not a decorative card wall |
| A11y tests | Static string assertions cover many affordances; browser QA is manual | Add DOM/Playwright coverage for focus trap/return, status region, overflow, chart equivalence |
| Explore analysis toolbar | Current analysis summary, responsive filter grid, URL-backed fixed group-by selector, result/plotted/missing counts, and mobile two-column controls exist | Keep scope visible before charts and prevent filter controls from consuming the whole first viewport |
| Explore group summaries | Memory scatter groups now expose plotted count, review/headroom or request/use signal, and clickable URL-backed filter shortcuts | Extend only with grouping summaries that remain evidence-backed and table-linked |
| Explore chart equivalence | Chart-to-table and table-focus highlighting exist; tooltip metadata now includes run/project/status/platform/queue/freshness/resource-fit context; chart scope is shown as a local wrapping grid with sample, axes, group, freshness, and missing-data pills | Keep enriching chart/table parity as new resource dimensions appear |

Remaining P0:

- Add broader DOM or Playwright coverage for independently refreshed evidence
  panels beyond the current Logs reload static coverage; route, Compare, Log
  evidence, and action-modal failures now have scoped alert semantics and
  status-region announcements.

### P1: Actionable Analysis From Existing Data

No schema-breaking changes.

Current done:

- Runs filter state and key routes are URL-backed.
- Capacity Snapshot now uses `/capacity` as the canonical top-navigation route,
  while legacy `/queue` is normalized for backwards compatibility.
- Capacity Snapshot prioritizes loaded headroom/evidence above the snapshot
  loader and collapses snapshot controls once a saved/latest snapshot is loaded.
- Runs sort state is URL-backed for the fixed priority columns.
- Runs optional column visibility is saved locally without affecting URL-backed
  filters or compare selection.
- Runs named saved views are local-only and restore filters, search, sort,
  density, and optional columns without adding server-side preference state.
- Compare selection is non-mutating and persists locally.
- Side-by-side run comparison exists with fixed evidence groups.
- Compare can copy a Markdown summary for the selected runs as a
  visibility-only reporting aid; it does not introduce batch actions.
- Compare defaults to a differences-first view, supports All fields mode,
  reference-run pinning, and per-cell long-value inspection without expanding
  every row.
- Explore has a `Current analysis` summary, responsive
  project/status/platform/queue/group controls, right-sizing candidates,
  resource-fit table cells, and chart-to-table highlighting.
- Explore chart cards show visible scope, plotted/filtered/total sample counts,
  axis units, latest evidence freshness, and missing-usage counts next to the
  chart/table pairing.
- Explore now includes walltime requested-vs-actual evidence from existing
  requested walltime and recorded usage seconds: a compact review panel plus a
  matching table column, without adding backend schema requirements.
- Explore now visualizes walltime requested-vs-actual evidence with a horizontal
  used/requested ratio chart, while keeping the compact review panel and table
  column as text-equivalent fallbacks.
- Projects index rows link into filtered Runs and include visible failed,
  active, planned, and finished status text so the status composition bar is not
  the only way to read project health.
- Resource-fit UI uses requested vs used resources and CPU efficiency where
  evidence exists.
- Capacity Snapshot discovers saved local quota snapshots, auto-loads the
  latest profile-scoped snapshot when no saved form exists, and provides a
  compact local snapshot picker without triggering live refresh.
- Capacity Snapshot key facts now include provenance chips for saved
  quota-snapshot freshness, PBS queue or iHPC family/session evidence, and
  storage headroom, with source kind, snapshot scope, profile, platform, and
  observed time in the modal.
- Run Detail Logs now renders a compact saved-evidence toolbar with an
  independent reload button, readable refresh-state pill, and stale failure
  behavior that keeps prior bounded log evidence visible instead of replacing
  it with a full-panel error.

Current partial:

- Explore has a fixed-dimension grouped resource-fit scatter, compact analysis
  toolbar, responsive filters, clickable group summaries, and table with visible
  chart scope metadata plus walltime ratio chart/review evidence, but broader
  resource dimensions are future work.
- Projects now exposes failed, active, planned, and finished count text inside
  the compact index table, sorts rows by operational health, and uses the
  ordered status composition bar as the visual summary. Trend deltas remain
  future work until project rollups expose historical snapshots cleanly.
- Saved Runs views are intentionally local-only. Cross-page saved views and
  team/shared presets remain out of scope unless a future safe persistence model
  is designed.

Remaining P1:

- Extend current group summaries to future resource dimensions once they remain
  evidence-backed and table-linked.
- Extend saved views across Explore only if they keep priority columns
  discoverable and avoid server-side preference state.
- Add evidence provenance for future diagnosis chips once persisted diagnosis
  summaries exist.

### P2: Additive Data Enhancements

Requires schema or API additions, but no safety-boundary relaxation.

- Add optional usage samples for trend charts.
- Persist diagnosis summaries for failed runs so diagnosis evidence can survive
  route reloads and support history/trend views.
- Add optional Metrics tab after usage samples exist.
- Add optional trace storage and Trace tab.
- Add richer artifact metadata such as artifact id, type, captured-at, and
  manifest-scoped actions.
- Consider a profile-scoped lightweight event/log evidence index only if it
  remains bounded and does not become a general log explorer.
- Consider a true queue or worker monitor only if it can remain allowlisted,
  profile-scoped, redacted, and separate from arbitrary shell access.

## Page-Level Acceptance Criteria

### Runs Acceptance

- Active, failed, needs-attention, recently-finished, core-hours, and GPU-hours
  are visible before secondary charts.
- The table appears before broad charts on desktop and remains the primary
  control surface.
- Filter state can be represented in the URL.
- Clearing filters is one click.
- Empty filtered results differ from truly empty history.
- Status cells include text, icon or shape, semantic color, and reason when
  available.
- Attention reason is visible for attention-needed rows, not only aggregated in
  a KPI count.
- Evidence chips appear in stable order and do not change column layout when
  loading or missing.
- Compare selection is visibly non-mutating.
- Compare controls do not enable batch submit, batch abort, or batch cleanup.

### Run Detail Acceptance

- A user can understand current state, safety readiness, resource fit, and
  evidence completeness without opening raw JSON.
- Planned runs show whether submit is ready or blocked and why.
- Active runs show whether abort is possible and what evidence is required.
- Terminal runs show clone/rerun availability and lineage.
- Logs and artifacts say whether evidence is saved, missing, partial, or not
  captured.
- Artifact rows are manifest-scoped and include path, size, checksum state, and
  source manifest when available.
- The tab formerly named Parameters is renamed or reframed as Plan & Resources.
- Any risky action shows a Gate Evidence Block before execution.

### Compare Acceptance

- Compare selection uses non-mutating language and iconography.
- Side-by-side compare shows fixed groups for status, plan, capacity, usage,
  reproducibility, evidence, and lineage.
- Differences can be emphasized without hiding typed missing values.
- Long values are inspectable without expanding every row.
- The compare view links to Run Detail but does not add mutation actions.

### Explore Acceptance

- The first Explore release answers resource-fit questions from existing data.
- Memory requested vs used scatter has tooltips and corresponding table rows.
- Scatter groups plotted memory points by fixed dimensions such as status,
  project, platform, or queue, with visible legend labels.
- Walltime requested vs actual is visible when both requested walltime and
  recorded usage seconds exist.
- Low CPU efficiency can be flagged even when memory evidence is absent.
- Project/status/platform/queue filters do not require server-side UI state.
- No-usage cases explain that metrics appear only after status or usage polling
  records them.
- Missing usage is not plotted as zero unless the source value is actually zero.
- Chart marks can highlight or navigate to the corresponding table row.
- Resource-fit table cells show both visual indicators and numeric values.

### Capacity Acceptance

- The page title and navigation do not imply true worker monitoring unless that
  data source exists.
- Profile id, snapshot id, platform, age, and freshness are visible.
- Queue rows expose running, queued, run headroom, recommended parallelism, and
  notes.
- iHPC sessions and available families use a separate layout from PBS queues.
- Stale or missing snapshot states are visually distinct from full queues.
- The page avoids `live cluster health`, `node monitor`, `rack view`, and
  `topology` labels unless a future data source supports them with freshness and
  scope metadata.

### Projects Acceptance

- Each project index row links to a filtered Runs view.
- Active and failed counts are textual, not chart-only.
- Rows are ordered by operational health, so failed, unknown, active, and
  planned projects appear before quiet finished-only projects.
- Status composition is visible as an ordered semantic bar and remains readable
  by text/tooltip, not color alone.
- Latest update is shown as relative time with absolute time available via
  tooltip.
- Project hash remains visible but secondary to project name and health.

### Visual Signoff Checklist

Use this checklist before considering a visual redesign slice complete:

- At 1366 x 768, Runs shows the page header/safety context, KPI strip, triage
  rail, filters, and the top of the runs table before any broad chart wall.
- At a narrow mobile viewport, the page has no global horizontal overflow; any
  table overflow is contained and keyboard reachable.
- Table row height stays in the documented default or compact range, and
  identity/status/attention/evidence remain readable.
- Status, severity, and readiness use distinct visual treatments and remain
  distinguishable in grayscale.
- Light and dark screenshots show equivalent hierarchy, visible focus, and
  chart legibility.
- No nested cards, floating panels inside panels, decorative background effects,
  or marketing-style hero sections appear on operational pages.
- Risk, blocked, and stale states include text reasons and source/evidence
  pointers, not only color.
- Dangerous or token-confirmed actions include operation text, gate evidence,
  and confirmation state before execution.
- The first viewport communicates "local, read-mostly, MCP-gated" without
  becoming a large banner.

## Accessibility And QA Requirements

- Do not rely on color alone for status, chart groups, or resource-fit warnings.
- Icon-only controls require `aria-label` or equivalent accessible names.
- Form controls need labels or `aria-label`; placeholder text is not enough.
- Modals need focus management, Escape behavior, and trigger focus restoration.
- Tabs must remain keyboard navigable.
- Use semantic tables for Runs and Explore. Do not use ARIA grid unless arrow-key
  grid navigation is fully implemented.
- All actionable controls must show a visible focus ring in light and dark mode.
- Focus indicators should be at least 2 px or meet an equivalent visible area,
  and the focus change should meet at least 3:1 contrast against the unfocused
  state where practical.
- Non-text UI boundaries that communicate state, such as focus rings, selected
  rows, chart marks, status icons, and warning borders, should meet at least 3:1
  contrast against adjacent colors.
- Compact icon buttons should be at least 24 x 24 CSS px, or have enough spacing
  to avoid accidental adjacent activation.
- Charts need text fallback or adjacent table data for the same insight.
- Chart legends should not rely on hue alone. Use direct labels, shapes, line
  styles, or table pairing when multiple groups are shown.
- Dynamic updates such as filter result counts, refresh completion, action
  success, and modal errors should be announced through a status region such as
  `role="status" aria-atomic="true"`. Destructive or blocking errors may use an
  alert pattern, but should not steal focus unnecessarily.
- Check 1366 x 768 desktop and a narrow mobile viewport for horizontal overflow,
  text clipping, and incoherent overlap.
- Browser QA should include console-error checks after route changes, theme
  toggle, filter changes, and modal open/close.
- Browser QA should also check `prefers-reduced-motion`, keyboard-only route
  traversal, focus return after modal close, and light/dark chart legibility when
  practical.

### A11y Acceptance Matrix

| Component | Keyboard requirement | Screen reader text | Non-color cue | QA note |
|---|---|---|---|---|
| Status badge | Reachable when interactive or linked | Lifecycle state plus reason when present | Icon or shape plus label | Verify failed/stale/unknown states |
| Evidence chip | Focusable when it opens provenance | Evidence type, state, source, freshness | State label and icon/outline | Verify fixed order and missing states |
| Runs table | Tabbable links/actions in row order | Column headers identify each cell | Text status and attention reason | Verify no global mobile overflow |
| Explore chart | Chart interaction has table equivalent | Adjacent table contains plotted data | Highlight outline or focused row | Verify missing values are not plotted as zero |
| Action modal | Focus enters modal and returns to trigger | Operation, target, gate state, error text | Explicit readiness label | Verify Escape/cancel and duplicate-submit guard |
| Tabs | Arrow or Tab navigation remains predictable | Selected tab announced | Active underline or border plus text | Verify deep route reloads |
| Compare control | Toggle reachable and named | `Include in comparison`, target run id | Icon plus selected label/state | Verify no batch mutation affordance |
| Error state | Next step and details reachable | Error kind, scope, stale-data note | Icon plus typed heading | Verify no unsafe workaround copy |

### Test Coverage Boundary

Current `node:test` coverage may verify:

- server API guard behavior;
- action POST routing;
- static frontend affordances and route strings;
- presence of required CSS classes, labels, and component functions.

DOM or Playwright coverage is required for:

- modal focus management, Escape, and focus restoration;
- visible focus rings across theme modes;
- status-region announcements;
- chart-to-table highlighting and keyboard equivalence;
- mobile overflow and text clipping;
- reduced-motion behavior;
- light/dark chart legibility;
- real rendered state of typed empty and error components.

Do not treat static string assertions as proof of accessibility or visual
quality. They are regression anchors, not rendered UX validation.

## Non-Goals

- No generic remote shell.
- No arbitrary local or remote file browser.
- No user-supplied executable dashboard panels.
- No free-form dashboard builder or report editor in P0/P1.
- No multi-user hosted SaaS mode.
- No cluster-wide visibility beyond authorized, redacted profile-scoped data.
- No topology canvas, rack map, or node relationship graph without real
  relationship data and freshness metadata.
- No arbitrary log explorer beyond bounded saved log evidence or allowlisted MCP
  log reads.
- No cluster-wide admin posture.
- No destructive shortcuts outside MCP approval and conformance gates.
- No exact queue ETA unless an authoritative data source supports it.
- No claim that saved logs are complete historical logs unless retention
  guarantees are implemented.

## Success Criteria

The redesign is successful when:

- a user can identify active, failed, and attention-needed runs within one
  screen;
- every risky action shows the evidence and gate it depends on;
- Run detail explains state and evidence without requiring raw JSON inspection;
- Explore helps identify over-requested resources from existing run data;
- missing data is clearly labeled as missing, unsupported, or not yet captured;
- the WebUI still reads redacted local state and routes actions through MCP
  domain functions only;
- tests continue to pass with no live VPN, SSH, UTS, qsub, qstat, qdel, cnode,
  or rsync dependency.

## Source-To-Planning Mapping

### Fact Alignment

If this spec conflicts with project fact or safety documents, resolve the
conflict in this order:

1. `docs/accounts-and-safety.md` for multi-account usage, quota boundaries,
   approvals, tokens, destructive operations, and forbidden shortcuts.
2. `docs/fact-registry.md` for verified implementation/platform facts and their
   verification status.
3. `docs/research-basis.md` for UTS HPC/iHPC platform research and terminology.
4. This visual redesign spec for UI presentation, sequencing, and acceptance.

Current fact dependencies:

- ADR 0004 / quota-envelope autonomy: conformant submit/retry/transfer/fetch
  paths should not be visually framed as human approval pending.
- UTS HPC is PBS-oriented; show queue, PBS job id, qstat, walltime, queue limits,
  and quota snapshot evidence.
- UTS iHPC is an interactive node/supervisor environment, not PBS or Slurm; show
  active cnode/session, node family, supervisor, storage headroom, and session
  evidence.
- `jobs.usage`, `jobs.diagnose`, reproducibility capture, artifact manifests,
  logs evidence, and quota snapshots are evidence inputs for the UI when
  present.
- Profiles are separate safety/quota scopes. Never aggregate capacity across
  profiles in a way that implies quota pooling or account switching as a bypass.

- NN/g dashboard guidance supports the split between operational Runs/Capacity
  surfaces and analytical Explore surfaces.
- PatternFly dashboard guidance supports card prioritization, KPI placement,
  and avoiding generic chart walls.
- Carbon, WCAG, and Atlassian guidance support the token contract, non-color-only
  status components, focus visibility, and light/dark color separation.
- Apple HIG supports content-first clarity, precise controls, and restrained
  hierarchy.
- Material Design 3 supports design tokens, semantic color roles, typography
  scale, and interaction state layers.
- Carbon data-table guidance supports toolbar-driven dense tables with sorting,
  filtering, display settings, row expansion, and row/batch actions only when
  the action model is explicit.
- Atlassian label/badge guidance supports using badges for numeric counts and
  lozenges/chips for non-numeric status.
- Fluent 2 motion guidance supports motion only when it clarifies relationships
  and state changes.
- GOV.UK error patterns support adjacent, specific error messages plus summary
  treatment when multiple fields or actions are affected.
- MLflow, Aim, W&B, Neptune, ClearML, and Comet support table-first run
  exploration, compare selection, side-by-side diffing, and artifact evidence
  tables.
- Open OnDemand, Slurm-web, Kubernetes Dashboard, OpenShift, Ray, Datadog,
  Grafana, and Argo support explicit resource-domain navigation, detail pages
  that connect status/spec/logs/events, and cautious claims about live capacity.
- `docs/accounts-and-safety.md` constrains all action surfaces: no secrets in the
  browser, no generic remote shell, no arbitrary file browsing, and no bypass of
  conformance gates or the remaining trusted-token approval gates.

## Source List

- MLflow Tracking UI: https://mlflow.org/docs/latest/ml/tracking/
- MLflow Search Runs: https://mlflow.org/docs/latest/ml/search/search-runs/
- Aim Explorers: https://aimstack.readthedocs.io/en/latest/ui/pages/explorers.html
- ClearML Task Table: https://clear.ml/docs/latest/docs/webapp/webapp_exp_table/
- ClearML WebApp overview: https://clear.ml/docs/latest/docs/webapp/webapp_overview/
- ClearML task tracking and artifacts: https://clear.ml/docs/latest/docs/webapp/webapp_exp_track_visual/
- ClearML comparing tasks: https://clear.ml/docs/latest/docs/webapp/webapp_exp_comparing/
- W&B Workspaces: https://docs.wandb.ai/models/track/workspaces
- W&B run display customization: https://docs.wandb.ai/models/runs/customize-run-display
- W&B compare runs: https://docs.wandb.ai/models/runs/compare-runs
- Neptune run comparison: https://docs.neptune.ai/select_runs
- Neptune runs table: https://docs.neptune.ai/runs_table
- Neptune side-by-side comparison: https://docs.neptune.ai/side-by-side
- Comet experiment analysis: https://www.comet.com/docs/v2/guides/experiment-management/analyze-experiments/
- Comet project overview: https://www.comet.com/docs/v2/guides/comet-ui/experiment-management/project-pages/overview/
- Comet single experiment page: https://www.comet.com/docs/v2/guides/comet-ui/experiment-management/single-experiment-page/
- Comet artifacts: https://www.comet.com/docs/v2/guides/artifacts/using-artifacts/
- Open OnDemand navigation: https://osc.github.io/ood-documentation/latest/customizations.html
- Open OnDemand Active Jobs: https://osc.github.io/ood-documentation/release-1.7/applications/active-jobs.html
- Open OnDemand Job Composer: https://osc.github.io/ood-documentation/release-1.8/applications/job-composer.html
- Slurm-web overview: https://docs.rackslab.io/slurm-web/overview/overview.html
- Slurm-web product overview: https://slurm-web.com/
- Ray Dashboard observability: https://docs.ray.io/en/latest/ray-observability/getting-started.html
- Grafana alert panel linking: https://grafana.com/docs/grafana/latest/alerting/alerting-rules/link-alert-rules-to-panels/
- Kubernetes Dashboard: https://kubernetes.io/docs/tasks/access-application-cluster/web-ui-dashboard/
- OpenShift topology design: https://openshift.github.io/openshift-origin-design/designs/developer/topology-43/
- Datadog dashboards: https://docs.datadoghq.com/dashboards/
- Datadog logs explorer: https://docs.datadoghq.com/logs/explorer/
- Datadog events explorer: https://docs.datadoghq.com/events/explorer/
- Argo Workflows server UI: https://argo-workflows.readthedocs.io/en/latest/argo-server/
- Argo archive logs: https://argo-workflows.readthedocs.io/en/latest/configure-archive-logs/
- Nielsen Norman Group dashboard visualization guidance: https://www.nngroup.com/articles/dashboards-preattentive/
- Nielsen Norman Group usability heuristics: https://www.nngroup.com/articles/ten-usability-heuristics/
- Nielsen Norman Group visibility of system status: https://www.nngroup.com/articles/visibility-system-status/
- Nielsen Norman Group data tables: https://www.nngroup.com/articles/data-tables/
- Nielsen Norman Group empty states: https://www.nngroup.com/articles/empty-state-interface-design/
- Nielsen Norman Group button states: https://www.nngroup.com/articles/button-states-communicate-interaction/
- PatternFly dashboard design guidelines: https://www.patternfly.org/patterns/dashboard/design-guidelines/
- PatternFly status and severity: https://www.patternfly.org/patterns/status-and-severity/
- PatternFly table design guidelines: https://www.patternfly.org/components/table/design-guidelines
- Apple Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines
- Apple HIG design principles: https://developer.apple.com/design/human-interface-guidelines/design-principles
- Microsoft Fluent 2: https://fluent2.microsoft.design/
- Microsoft Fluent 2 motion: https://fluent2.microsoft.design/motion
- Carbon status indicator pattern: https://carbondesignsystem.com/patterns/status-indicator-pattern/
- Carbon color overview: https://carbondesignsystem.com/elements/color/overview/
- Carbon data table usage: https://carbondesignsystem.com/components/data-table/usage/
- Carbon data table style: https://carbondesignsystem.com/components/data-table/style/
- Carbon data visualization color palettes: https://carbondesignsystem.com/data-visualization/color-palettes/
- Carbon data visualization legends: https://carbondesignsystem.com/data-visualization/legends/
- Carbon chart anatomy: https://carbondesignsystem.com/data-visualization/chart-anatomy/
- Atlassian color/design-token foundation: https://atlassian.design/foundations/color
- Atlassian design tokens: https://atlassian.design/tokens/design-tokens
- Atlassian components overview: https://atlassian.design/components
- Atlassian lozenge component: https://atlassian.design/components/lozenge
- Material Design data tables: https://m2.material.io/develop/web/components/data-tables
- Material Design 3 design tokens: https://m3.material.io/foundations/design-tokens
- Material Design data visualization accessibility: https://m3.material.io/blog/data-visualization-accessibility
- Material Design color roles: https://m3.material.io/styles/color/roles
- Material Design typography: https://m3.material.io/styles/typography/overview
- Material Design state layers: https://m3.material.io/foundations/interaction/states/state-layers
- GOV.UK error message: https://design-system.service.gov.uk/components/error-message/
- GOV.UK error summary: https://design-system.service.gov.uk/components/error-summary/
- WCAG 2.2: https://www.w3.org/TR/WCAG22/
- WCAG focus appearance: https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html
- WCAG non-text contrast: https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- WCAG status messages: https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- WCAG target size minimum: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- WCAG 2.2 new criteria summary: https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- Project WebUI design baseline: `docs/dashboard-design.md`
- Project fact registry: `docs/fact-registry.md`
- Project research basis: `docs/research-basis.md`
- Safety policy baseline: `docs/accounts-and-safety.md`
