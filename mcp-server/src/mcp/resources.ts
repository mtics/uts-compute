import fs from "node:fs";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { redactProfile, listProfiles, maskUserRootPath } from "../core/config.js";
import { listProjects } from "../ops/profiles/projects.js";
import { jobsHistory } from "../ops/jobs/history.js";
import { DOCS, REMOTE_DOC_SOURCES, formatCachedDoc, listCachedDocs, listDocs, listRemoteDocSources, readCachedDoc, readDoc } from "../ops/catalog/docs.js";
import { assertInsideProject, assertInsideRuntime, projectRoot, assertRealPathInside, RUNTIME_DIRS } from "../core/paths.js";
import { SAFE_RUN_ID_PATTERN } from "../core/ids.js";
import { TEMPLATE_CATALOG, type TemplateId, listTemplates } from "../ops/catalog/templates.js";
import type { JsonObject } from "../core/types.js";
import {
  assertArtifactCleanupExecutionRecord,
  assertArtifactCleanupPlan,
  assertPlannedTransfer,
  assertTransferExecutionRecord
} from "../core/validation.js";
import { redactLocalHome, redactProjectRoot } from "../lib/redact.js";

interface RuntimeJsonResource {
  id: string;
  uri: string;
  path: string;
  mtime: string;
  size: number;
}

interface TransferRunResource {
  id: string;
  uri: string;
  path: string;
  mtime: string;
  size: number;
  has_plan: boolean;
  execution_count: number;
}

interface ArtifactRunResource {
  id: string;
  uri: string;
  path: string;
  mtime: string;
  size: number;
  has_manifest: boolean;
  cleanup_plan_count: number;
  cleanup_execution_count: number;
}

const QUOTA_DIR = RUNTIME_DIRS.quotas;
const RUN_DIR = RUNTIME_DIRS.runs;
const APPROVAL_DIR = RUNTIME_DIRS.approvals;
const ARTIFACT_DIR = RUNTIME_DIRS.artifacts;
const TRANSFER_DIR = RUNTIME_DIRS.transfers;

export function registerUtsResources(server: McpServer): void {
  server.registerResource(
    "profiles",
    "uts://profiles",
    {
      title: "UTS Compute Profiles",
      description: "Redacted configured UTS compute profiles.",
      mimeType: "application/json"
    },
    async (uri) =>
      jsonResource(uri.href, {
        profiles: listProfiles().map((profile) =>
          redactProfile(profile, latestQuotaSnapshotForProfile(profile.profile_id))
        )
      })
  );

  server.registerResource(
    "templates",
    "uts://templates",
    {
      title: "UTS Dry-Run Templates",
      description: "Catalog of dry-run script templates available to jobs.plan and transfers.plan.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, { templates: listTemplates() })
  );

  server.registerResource(
    "projects",
    "uts://projects",
    {
      title: "UTS Compute Projects",
      description: "Read-only per-project rollup across saved local run records, most-active first.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, listProjects())
  );

  server.registerResource(
    "project",
    new ResourceTemplate("uts://projects/{projectHash}", {
      list: async () => ({
        resources: listProjects().projects.map((project) => ({
          uri: `uts://projects/${project.project_hash}`,
          name: `project:${project.project}`,
          title: project.project,
          description: `${project.total} run(s), ${project.active} active`,
          mimeType: "application/json"
        }))
      }),
      complete: {
        projectHash: (value) =>
          listProjects()
            .projects.map((project) => project.project_hash)
            .filter((hash) => hash.startsWith(value))
      }
    }),
    {
      title: "UTS Compute Project",
      description: "Read one project's rollup plus its run summaries, addressed by project hash.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const projectHash = oneVariable(variables.projectHash, "projectHash");
      if (!/^proj-[0-9a-f]{12}$/.test(projectHash)) {
        throw new Error(`Invalid project hash: ${projectHash}`);
      }
      const summary = listProjects().projects.find((project) => project.project_hash === projectHash);
      if (!summary) {
        throw new Error(`Unknown project hash: ${projectHash}`);
      }
      return jsonResource(uri.href, { project: summary, runs: jobsHistory({ project: projectHash, limit: 500 }).runs });
    }
  );

  server.registerResource(
    "template",
    new ResourceTemplate("uts://templates/{templateId}", {
      list: async () => ({
        resources: TEMPLATE_CATALOG.map((template) => ({
          uri: `uts://templates/${template.id}`,
          name: `template:${template.id}`,
          title: template.description,
          description: `Template source at ${template.path}`,
          mimeType: "text/plain"
        }))
      }),
      complete: {
        templateId: (value) => TEMPLATE_CATALOG.map((template) => template.id).filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Template Source",
      description: "Read one allowlisted dry-run template by template id.",
      mimeType: "text/plain"
    },
    async (uri, variables) => {
      const templateId = oneVariable(variables.templateId, "templateId") as TemplateId;
      const template = TEMPLATE_CATALOG.find((candidate) => candidate.id === templateId);
      if (!template) {
        throw new Error(`Unknown template resource id: ${templateId}`);
      }
      const templatePath = assertInsideProject(template.path, "Template resource path");
      return textResource(uri.href, fs.readFileSync(templatePath, "utf8"), "text/plain");
    }
  );

  server.registerResource(
    "quota-snapshots",
    "uts://quota-snapshots",
    {
      title: "UTS Quota Snapshot Index",
      description: "Index of locally captured, redacted quota snapshot evidence.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, { snapshots: listRuntimeJsonResources(QUOTA_DIR, "uts://quota-snapshots") })
  );

  server.registerResource(
    "quota-snapshot",
    new ResourceTemplate("uts://quota-snapshots/{snapshotId}", {
      list: async () => ({
        resources: listRuntimeJsonResources(QUOTA_DIR, "uts://quota-snapshots").map((entry) => ({
          uri: entry.uri,
          name: `quota-snapshot:${entry.id}`,
          title: entry.id,
          description: "Redacted quota snapshot evidence captured by quotas.refresh.",
          mimeType: "application/json",
          size: entry.size,
          annotations: {
            lastModified: entry.mtime
          }
        }))
      }),
      complete: {
        snapshotId: (value) =>
          listRuntimeJsonResources(QUOTA_DIR, "uts://quota-snapshots")
            .map((entry) => entry.id)
            .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Quota Snapshot",
      description: "Read one locally captured, redacted quota snapshot evidence file.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const snapshotId = safeRuntimeId(oneVariable(variables.snapshotId, "snapshotId"), "snapshotId");
      return jsonResource(uri.href, quotaSnapshotOnly(readRuntimeJson(QUOTA_DIR, snapshotId)));
    }
  );

  server.registerResource(
    "profile-latest-quota-snapshot",
    new ResourceTemplate("uts://profiles/{profileId}/quota-snapshot/latest", {
      list: async () => ({
        resources: listProfiles().map((profile) => ({
          uri: `uts://profiles/${profile.profile_id}/quota-snapshot/latest`,
          name: `profile-latest-quota-snapshot:${profile.profile_id}`,
          title: `${profile.profile_id} latest quota snapshot`,
          description: "Latest local quota snapshot for one configured profile, or missing status.",
          mimeType: "application/json"
        }))
      }),
      complete: {
        profileId: (value) => listProfiles().map((profile) => profile.profile_id).filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "Latest Profile Quota Snapshot",
      description: "Read the latest local quota snapshot for one configured profile without refreshing live state.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const profileId = safeRuntimeId(oneVariable(variables.profileId, "profileId"), "profileId");
      const profile = listProfiles().find((candidate) => candidate.profile_id === profileId);
      if (!profile) {
        throw new Error(`Unknown profile_id: ${profileId}`);
      }
      const latest = latestQuotaSnapshotForProfile(profileId);
      return jsonResource(uri.href, latest ?? { profile_id: profileId, freshness: "missing", snapshot: null });
    }
  );

  server.registerResource(
    "run-records",
    "uts://run-records",
    {
      title: "UTS Run Record Index",
      description: "Index of local run records created by dry-run and later live workflows.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, { run_records: listRuntimeJsonResources(RUN_DIR, "uts://run-records") })
  );

  server.registerResource(
    "run-record",
    new ResourceTemplate("uts://run-records/{runId}", {
      list: async () => ({
        resources: listRuntimeJsonResources(RUN_DIR, "uts://run-records").map((entry) => ({
          uri: entry.uri,
          name: `run-record:${entry.id}`,
          title: entry.id,
          description: "Local UTS run record.",
          mimeType: "application/json",
          size: entry.size,
          annotations: {
            lastModified: entry.mtime
          }
        }))
      }),
      complete: {
        runId: (value) =>
          listRuntimeJsonResources(RUN_DIR, "uts://run-records")
            .map((entry) => entry.id)
            .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Run Record",
      description: "Read one local run record.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const runId = safeRuntimeId(oneVariable(variables.runId, "runId"), "runId");
      return jsonResource(uri.href, sanitizeRunRecord(readRuntimeJson(RUN_DIR, runId)));
    }
  );

  server.registerResource(
    "approval-records",
    "uts://approval-records",
    {
      title: "UTS Approval Record Index",
      description: "Index of local approval records bound to plan hashes and quota snapshots.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, { approval_records: listRuntimeJsonResources(APPROVAL_DIR, "uts://approval-records") })
  );

  server.registerResource(
    "approval-record",
    new ResourceTemplate("uts://approval-records/{approvalId}", {
      list: async () => ({
        resources: listRuntimeJsonResources(APPROVAL_DIR, "uts://approval-records").map((entry) => ({
          uri: entry.uri,
          name: `approval-record:${entry.id}`,
          title: entry.id,
          description: "Local approval record bound to one plan hash and quota snapshot.",
          mimeType: "application/json",
          size: entry.size,
          annotations: {
            lastModified: entry.mtime
          }
        }))
      }),
      complete: {
        approvalId: (value) =>
          listRuntimeJsonResources(APPROVAL_DIR, "uts://approval-records")
            .map((entry) => entry.id)
            .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Approval Record",
      description: "Read one local approval record.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const approvalId = safeRuntimeId(oneVariable(variables.approvalId, "approvalId"), "approvalId");
      return jsonResource(uri.href, readRuntimeJson(APPROVAL_DIR, approvalId));
    }
  );

  server.registerResource(
    "artifacts",
    "uts://artifacts",
    {
      title: "UTS Artifact State Index",
      description: "Index of local artifact manifests, cleanup plans, and cleanup execution evidence without exposing local file paths.",
      mimeType: "application/json"
    },
    async (uri) =>
      jsonResource(uri.href, {
        artifacts: listArtifactRunResources().map((entry) => ({
          run_id: entry.id,
          state_uri: `${entry.uri}/state`,
          ...(entry.has_manifest ? { manifest_uri: `${entry.uri}/manifest` } : {}),
          ...(entry.cleanup_plan_count > 0 ? { cleanup_plans_uri: `${entry.uri}/cleanup-plans` } : {}),
          ...(entry.cleanup_execution_count > 0 ? { cleanup_executions_uri: `${entry.uri}/cleanup-executions` } : {}),
          has_manifest: entry.has_manifest,
          cleanup_plan_count: entry.cleanup_plan_count,
          cleanup_execution_count: entry.cleanup_execution_count,
          mtime: entry.mtime,
          size: entry.size
        }))
      })
  );

  server.registerResource(
    "artifact-state",
    new ResourceTemplate("uts://artifacts/{runId}/state", {
      list: async () => ({
        resources: listArtifactRunResources().map((entry) => ({
          uri: `uts://artifacts/${entry.id}/state`,
          name: `artifact-state:${entry.id}`,
          title: entry.id,
          description: "Sanitized aggregate artifact state for one run.",
          mimeType: "application/json",
          size: entry.size,
          annotations: {
            lastModified: entry.mtime
          }
        }))
      }),
      complete: {
        runId: (value) =>
          listArtifactRunResources()
            .map((entry) => entry.id)
            .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Artifact State",
      description: "Read sanitized artifact manifest and cleanup evidence summaries for one run.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const runId = safeArtifactRunId(oneVariable(variables.runId, "runId"));
      return jsonResource(uri.href, readSanitizedArtifactState(runId));
    }
  );

  server.registerResource(
    "artifact-manifest",
    new ResourceTemplate("uts://artifacts/{runId}/manifest", {
      list: async () => ({
        resources: listArtifactRunResources()
          .filter((entry) => entry.has_manifest)
          .map((entry) => ({
          uri: `uts://artifacts/${entry.id}/manifest`,
          name: `artifact-manifest:${entry.id}`,
          title: entry.id,
          description: "Sanitized local artifact manifest captured by artifacts.list.",
          mimeType: "application/json",
          size: entry.size,
          annotations: {
            lastModified: entry.mtime
          }
        }))
      }),
      complete: {
        runId: (value) =>
          listArtifactRunResources()
            .filter((entry) => entry.has_manifest)
            .map((entry) => entry.id)
            .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Artifact Manifest",
      description: "Read one sanitized artifact manifest. Raw remote paths and fetched file contents are not exposed.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const runId = safeArtifactRunId(oneVariable(variables.runId, "runId"));
      return jsonResource(uri.href, readSanitizedArtifactManifest(runId));
    }
  );

  server.registerResource(
    "artifact-cleanup-plans",
    new ResourceTemplate("uts://artifacts/{runId}/cleanup-plans", {
      list: async () => ({
        resources: listArtifactRunResources()
          .filter((entry) => entry.cleanup_plan_count > 0)
          .map((entry) => ({
            uri: `uts://artifacts/${entry.id}/cleanup-plans`,
            name: `artifact-cleanup-plans:${entry.id}`,
            title: entry.id,
            description: "Sanitized artifact cleanup dry-run plans for one run.",
            mimeType: "application/json",
            size: entry.size,
            annotations: {
              lastModified: entry.mtime
            }
          }))
      }),
      complete: {
        runId: (value) =>
          listArtifactRunResources()
            .filter((entry) => entry.cleanup_plan_count > 0)
            .map((entry) => entry.id)
            .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Artifact Cleanup Plans",
      description: "Read sanitized cleanup dry-run plans for one run.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const runId = safeArtifactRunId(oneVariable(variables.runId, "runId"));
      return jsonResource(uri.href, readSanitizedArtifactCleanupPlans(runId));
    }
  );

  server.registerResource(
    "artifact-cleanup-executions",
    new ResourceTemplate("uts://artifacts/{runId}/cleanup-executions", {
      list: async () => ({
        resources: listArtifactRunResources()
          .filter((entry) => entry.cleanup_execution_count > 0)
          .map((entry) => ({
            uri: `uts://artifacts/${entry.id}/cleanup-executions`,
            name: `artifact-cleanup-executions:${entry.id}`,
            title: entry.id,
            description: "Sanitized artifact cleanup execution evidence for one run.",
            mimeType: "application/json",
            size: entry.size,
            annotations: {
              lastModified: entry.mtime
            }
          }))
      }),
      complete: {
        runId: (value) =>
          listArtifactRunResources()
            .filter((entry) => entry.cleanup_execution_count > 0)
            .map((entry) => entry.id)
            .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Artifact Cleanup Executions",
      description: "Read sanitized cleanup execution evidence for one run.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const runId = safeArtifactRunId(oneVariable(variables.runId, "runId"));
      return jsonResource(uri.href, readSanitizedArtifactCleanupExecutions(runId));
    }
  );

  server.registerResource(
    "transfers",
    "uts://transfers",
    {
      title: "UTS Transfer State Index",
      description: "Index of locally saved transfer plans and execution evidence without raw local paths.",
      mimeType: "application/json"
    },
    async (uri) =>
      jsonResource(uri.href, {
        transfers: listTransferRunResources().map((entry) => ({
          run_id: entry.id,
          state_uri: `${entry.uri}/state`,
          ...(entry.has_plan ? { plan_uri: `${entry.uri}/plan` } : {}),
          ...(entry.execution_count > 0 ? { executions_uri: `${entry.uri}/executions` } : {}),
          has_plan: entry.has_plan,
          execution_count: entry.execution_count,
          mtime: entry.mtime,
          size: entry.size
        }))
      })
  );

  server.registerResource(
    "transfer-state",
    new ResourceTemplate("uts://transfers/{runId}/state", {
      list: async () => ({
        resources: listTransferRunResources().map((entry) => ({
          uri: `uts://transfers/${entry.id}/state`,
          name: `transfer-state:${entry.id}`,
          title: entry.id,
          description: "Sanitized aggregate transfer state for one run.",
          mimeType: "application/json",
          size: entry.size,
          annotations: {
            lastModified: entry.mtime
          }
        }))
      }),
      complete: {
        runId: (value) =>
          listTransferRunResources()
            .map((entry) => entry.id)
            .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Transfer State",
      description: "Read sanitized saved transfer plan and execution summaries for one run.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const runId = safeTransferRunId(oneVariable(variables.runId, "runId"));
      return jsonResource(uri.href, readSanitizedTransferState(runId));
    }
  );

  server.registerResource(
    "transfer-plan",
    new ResourceTemplate("uts://transfers/{runId}/plan", {
      list: async () => ({
        resources: listTransferRunResources()
          .filter((entry) => entry.has_plan)
          .map((entry) => ({
            uri: `uts://transfers/${entry.id}/plan`,
            name: `transfer-plan:${entry.id}`,
            title: entry.id,
            description: "Sanitized saved transfer plan.",
            mimeType: "application/json",
            size: entry.size,
            annotations: {
              lastModified: entry.mtime
            }
          }))
      }),
      complete: {
        runId: (value) =>
          listTransferRunResources()
            .filter((entry) => entry.has_plan)
            .map((entry) => entry.id)
            .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Transfer Plan",
      description: "Read one sanitized saved transfer plan without exposing raw script text.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const runId = safeTransferRunId(oneVariable(variables.runId, "runId"));
      return jsonResource(uri.href, readSanitizedTransferPlan(runId));
    }
  );

  server.registerResource(
    "transfer-executions",
    new ResourceTemplate("uts://transfers/{runId}/executions", {
      list: async () => ({
        resources: listTransferRunResources()
          .filter((entry) => entry.execution_count > 0)
          .map((entry) => ({
            uri: `uts://transfers/${entry.id}/executions`,
            name: `transfer-executions:${entry.id}`,
            title: entry.id,
            description: "Sanitized transfer execution evidence records.",
            mimeType: "application/json",
            size: entry.size,
            annotations: {
              lastModified: entry.mtime
            }
          }))
      }),
      complete: {
        runId: (value) =>
          listTransferRunResources()
            .filter((entry) => entry.execution_count > 0)
            .map((entry) => entry.id)
            .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Transfer Executions",
      description: "Read sanitized transfer execution evidence for one run.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const runId = safeTransferRunId(oneVariable(variables.runId, "runId"));
      return jsonResource(uri.href, readSanitizedTransferExecutions(runId));
    }
  );

  server.registerResource(
    "docs",
    "uts://docs",
    {
      title: "UTS Computing Local Documentation Index",
      description: "Allowlisted local project documentation for UTS computing workflows.",
      mimeType: "application/json"
    },
    async (uri) =>
      jsonResource(uri.href, {
        docs: listDocs()
      })
  );

  server.registerResource(
    "doc",
    new ResourceTemplate("uts://docs/{docId}", {
      list: async () => ({
        resources: DOCS.map((doc) => ({
          uri: `uts://docs/${doc.id}`,
          name: `doc:${doc.id}`,
          title: doc.title,
          description: `Allowlisted local documentation file ${doc.path}`,
          mimeType: "text/markdown"
        }))
      }),
      complete: {
        docId: (value) => DOCS.map((doc) => doc.id).filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Computing Local Documentation",
      description: "Read one allowlisted local documentation file.",
      mimeType: "text/markdown"
    },
    async (uri, variables) => {
      const docId = oneVariable(variables.docId, "docId");
      return textResource(uri.href, readDoc(docId).text, "text/markdown");
    }
  );

  server.registerResource(
    "docs-cache",
    "uts://docs-cache",
    {
      title: "UTS Official Documentation Cache Index",
      description: "Index of locally refreshed fixed-source UTS official documentation pages.",
      mimeType: "application/json"
    },
    async (uri) =>
      jsonResource(uri.href, {
        sources: listRemoteDocSources(),
        cached: listCachedDocs()
      })
  );

  server.registerResource(
    "docs-cache-source",
    new ResourceTemplate("uts://docs-cache/{sourceId}", {
      list: async () => ({
        resources: listCachedDocs().map((entry) => ({
          uri: entry.cache_uri,
          name: `docs-cache:${entry.source_id}`,
          title: entry.title,
          description: `Cached fixed-source UTS documentation from ${entry.source_url}`,
          mimeType: "text/plain",
          size: entry.text_chars,
          annotations: {
            lastModified: entry.observed_at
          }
        }))
      }),
      complete: {
        sourceId: (value) => REMOTE_DOC_SOURCES.map((source) => source.id).filter((id) => id.startsWith(value))
      }
    }),
    {
      title: "UTS Official Documentation Cache",
      description: "Read one locally refreshed fixed-source UTS official documentation page.",
      mimeType: "text/plain"
    },
    async (uri, variables) => {
      const sourceId = oneVariable(variables.sourceId, "sourceId");
      return textResource(uri.href, formatCachedDoc(readCachedDoc(sourceId)), "text/plain");
    }
  );
}

function jsonResource(uri: string, value: unknown) {
  return textResource(uri, `${JSON.stringify(value, null, 2)}\n`, "application/json");
}

function textResource(uri: string, text: string, mimeType: string) {
  return {
    contents: [
      {
        uri,
        mimeType,
        text
      }
    ]
  };
}

function listRuntimeJsonResources(runtimeDir: string, uriPrefix: string): RuntimeJsonResource[] {
  const resolvedDir = assertInsideRuntime(runtimeDir, "Runtime resource directory");
  if (!fs.existsSync(resolvedDir)) {
    return [];
  }

  return fs
    .readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const id = safeRuntimeId(entry.name.slice(0, -".json".length), "runtime resource id");
      const resourcePath = path.join(resolvedDir, entry.name);
      const stat = fs.statSync(resourcePath);
      return {
        id,
        uri: `${uriPrefix}/${id}`,
        path: path.relative(projectRoot, resourcePath),
        mtime: stat.mtime.toISOString(),
        size: stat.size
      };
    })
    .sort((left, right) => right.mtime.localeCompare(left.mtime) || left.id.localeCompare(right.id));
}

function listArtifactRunResources(): ArtifactRunResource[] {
  const resolvedDir = assertInsideRuntime(ARTIFACT_DIR, "Artifact resource directory");
  if (!fs.existsSync(resolvedDir)) {
    return [];
  }

  return fs
    .readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const id = safeArtifactRunId(entry.name);
      const runDir = path.join(resolvedDir, entry.name);
      assertRealPathInside(runDir, resolvedDir, "Artifact run directory");
      const files = fs.readdirSync(runDir, { withFileTypes: true });
      const manifestPath = path.join(resolvedDir, entry.name, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        const cleanupPlanFiles = files.filter((file) => file.isFile() && file.name.startsWith("cleanup-plan-") && file.name.endsWith(".json"));
        const cleanupExecutionFiles = files.filter((file) => file.isFile() && file.name.startsWith("cleanup-execute-") && file.name.endsWith(".json"));
        if (cleanupPlanFiles.length === 0 && cleanupExecutionFiles.length === 0) {
          return [];
        }
        const statePaths = [
          ...cleanupPlanFiles.map((file) => path.join(runDir, file.name)),
          ...cleanupExecutionFiles.map((file) => path.join(runDir, file.name))
        ];
        for (const candidate of statePaths) {
          assertRealPathInside(candidate, resolvedDir, "Artifact state file");
        }
        const stats = statePaths.map((candidate) => fs.statSync(candidate));
        const newest = stats.reduce((latest, stat) => Math.max(latest, stat.mtimeMs), 0);
        const size = stats.reduce((total, stat) => total + stat.size, 0);
        return [
          {
            id,
            uri: `uts://artifacts/${id}`,
            path: path.relative(projectRoot, runDir),
            mtime: new Date(newest).toISOString(),
            size,
            has_manifest: false,
            cleanup_plan_count: cleanupPlanFiles.length,
            cleanup_execution_count: cleanupExecutionFiles.length
          }
        ];
      }
      assertRealPathInside(manifestPath, resolvedDir, "Artifact manifest file");
      const cleanupPlanFiles = files.filter((file) => file.isFile() && file.name.startsWith("cleanup-plan-") && file.name.endsWith(".json"));
      const cleanupExecutionFiles = files.filter((file) => file.isFile() && file.name.startsWith("cleanup-execute-") && file.name.endsWith(".json"));
      const statePaths = [
        manifestPath,
        ...cleanupPlanFiles.map((file) => path.join(runDir, file.name)),
        ...cleanupExecutionFiles.map((file) => path.join(runDir, file.name))
      ];
      for (const candidate of statePaths) {
        assertRealPathInside(candidate, resolvedDir, "Artifact state file");
      }
      const stats = statePaths.map((candidate) => fs.statSync(candidate));
      const newest = stats.reduce((latest, stat) => Math.max(latest, stat.mtimeMs), 0);
      const size = stats.reduce((total, stat) => total + stat.size, 0);
      return [
        {
          id,
          uri: `uts://artifacts/${id}`,
          path: path.relative(projectRoot, runDir),
          mtime: new Date(newest).toISOString(),
          size,
          has_manifest: true,
          cleanup_plan_count: cleanupPlanFiles.length,
          cleanup_execution_count: cleanupExecutionFiles.length
        }
      ];
    })
    .sort((left, right) => right.mtime.localeCompare(left.mtime) || left.id.localeCompare(right.id));
}

function listTransferRunResources(): TransferRunResource[] {
  const resolvedDir = assertInsideRuntime(TRANSFER_DIR, "Transfer resource directory");
  if (!fs.existsSync(resolvedDir)) {
    return [];
  }

  return fs
    .readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const id = safeTransferRunId(entry.name);
      const runDir = path.join(resolvedDir, entry.name);
      assertRealPathInside(runDir, resolvedDir, "Transfer run directory");
      const files = fs.readdirSync(runDir, { withFileTypes: true });
      const planPath = path.join(runDir, "plan.json");
      const hasPlan = fs.existsSync(planPath);
      const executionFiles = files.filter((file) => file.isFile() && file.name.startsWith("execute-") && file.name.endsWith(".json"));
      if (!hasPlan && executionFiles.length === 0) {
        return [];
      }
      const paths = [
        ...(hasPlan ? [planPath] : []),
        ...executionFiles.map((file) => path.join(runDir, file.name))
      ];
      for (const candidate of paths) {
        assertRealPathInside(candidate, resolvedDir, "Transfer state file");
      }
      const stats = paths.map((candidate) => fs.statSync(candidate));
      const newest = stats.reduce((latest, stat) => Math.max(latest, stat.mtimeMs), 0);
      const size = stats.reduce((total, stat) => total + stat.size, 0);
      return [
        {
          id,
          uri: `uts://transfers/${id}`,
          path: path.relative(projectRoot, runDir),
          mtime: new Date(newest).toISOString(),
          size,
          has_plan: hasPlan,
          execution_count: executionFiles.length
        }
      ];
    })
    .sort((left, right) => right.mtime.localeCompare(left.mtime) || left.id.localeCompare(right.id));
}

function readSanitizedArtifactManifest(runId: string): JsonObject {
  const resolvedDir = assertInsideRuntime(ARTIFACT_DIR, "Artifact resource directory");
  const safeRunId = safeArtifactRunId(runId);
  const manifestPath = path.join(resolvedDir, safeRunId, "manifest.json");
  const relative = path.relative(resolvedDir, manifestPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Artifact manifest path must stay inside the artifact resource directory");
  }
  assertRealPathInside(manifestPath, resolvedDir, "Artifact manifest file");
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as JsonObject;
  if (raw.run_id !== safeRunId || !Array.isArray(raw.artifacts)) {
    throw new Error("Artifact manifest does not match the requested run");
  }
  return {
    run_id: raw.run_id,
    profile_id: raw.profile_id,
    platform: raw.platform,
    created_at: raw.created_at,
    artifacts: raw.artifacts.map((artifact) => sanitizeArtifactManifestEntry(artifact)),
    truncated: raw.truncated
  };
}

function readSanitizedArtifactState(runId: string): JsonObject {
  const safeRunId = safeArtifactRunId(runId);
  const manifest = artifactManifestExists(safeRunId) ? readSanitizedArtifactManifest(safeRunId) : null;
  const cleanupPlans = readSanitizedArtifactCleanupPlans(safeRunId) as { cleanup_plans: JsonObject[] };
  const cleanupExecutions = readSanitizedArtifactCleanupExecutions(safeRunId) as { cleanup_executions: JsonObject[] };
  return {
    run_id: safeRunId,
    state: cleanupExecutions.cleanup_executions.length > 0 ? "cleanup-executed" : cleanupPlans.cleanup_plans.length > 0 ? "cleanup-planned" : manifest ? "listed" : "missing",
    manifest,
    latest_cleanup_plan: cleanupPlans.cleanup_plans[0] ?? null,
    latest_cleanup_execution: cleanupExecutions.cleanup_executions[0] ?? null,
    cleanup_plans: cleanupPlans.cleanup_plans,
    cleanup_executions: cleanupExecutions.cleanup_executions
  };
}

function artifactManifestExists(runId: string): boolean {
  const resolvedDir = assertInsideRuntime(ARTIFACT_DIR, "Artifact resource directory");
  const manifestPath = path.join(resolvedDir, safeArtifactRunId(runId), "manifest.json");
  return fs.existsSync(manifestPath);
}

function readSanitizedArtifactCleanupPlans(runId: string): JsonObject {
  const { safeRunId, resolvedDir, runDir } = artifactRunDirectory(runId);
  const cleanupPlans = artifactStateFiles(runDir, "cleanup-plan-").map((entry) => {
    const filePath = path.join(runDir, entry.name);
    assertRealPathInside(filePath, resolvedDir, "Artifact cleanup plan file");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    assertArtifactCleanupPlan(raw);
    if (raw.run_id !== safeRunId) {
      throw new Error("Artifact cleanup plan does not match the requested run");
    }
    return sanitizeArtifactCleanupPlanRecord(raw, filePath);
  });
  cleanupPlans.sort((left, right) => String(right.generated_at).localeCompare(String(left.generated_at)));
  return {
    run_id: safeRunId,
    cleanup_plans: cleanupPlans
  };
}

function readSanitizedArtifactCleanupExecutions(runId: string): JsonObject {
  const { safeRunId, resolvedDir, runDir } = artifactRunDirectory(runId);
  const cleanupExecutions = artifactStateFiles(runDir, "cleanup-execute-").map((entry) => {
    const filePath = path.join(runDir, entry.name);
    assertRealPathInside(filePath, resolvedDir, "Artifact cleanup execution file");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    assertArtifactCleanupExecutionRecord(raw);
    if (raw.run_id !== safeRunId) {
      throw new Error("Artifact cleanup execution record does not match the requested run");
    }
    return sanitizeArtifactCleanupExecutionRecord(raw, filePath);
  });
  cleanupExecutions.sort((left, right) => String(right.observed_at).localeCompare(String(left.observed_at)));
  return {
    run_id: safeRunId,
    cleanup_executions: cleanupExecutions
  };
}

function artifactRunDirectory(runId: string): { safeRunId: string; resolvedDir: string; runDir: string } {
  const resolvedDir = assertInsideRuntime(ARTIFACT_DIR, "Artifact resource directory");
  const safeRunId = safeArtifactRunId(runId);
  const runDir = path.join(resolvedDir, safeRunId);
  assertRealPathInside(runDir, resolvedDir, "Artifact run directory");
  return { safeRunId, resolvedDir, runDir };
}

function artifactStateFiles(runDir: string, prefix: string): fs.Dirent[] {
  return fs
    .readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => {
      const matches = entry.name.startsWith(prefix) && entry.name.endsWith(".json");
      if (matches && entry.isSymbolicLink()) {
        throw new Error("Artifact state file must not be a symlink");
      }
      return matches && entry.isFile();
    });
}

function sanitizeArtifactCleanupPlanRecord(record: {
  schema_version?: string;
  mode: "dry-run";
  run_id: string;
  profile_id: string;
  platform: string;
  plan_hash: string;
  cleanup_plan_hash: string;
  generated_at: string;
  remote_candidates: string[];
  local_candidates: string[];
  cleanup_plan_path: string;
  warnings: string[];
}, filePath: string): JsonObject {
  return {
    ...(record.schema_version ? { schema_version: record.schema_version } : {}),
    mode: record.mode,
    run_id: record.run_id,
    profile_id: record.profile_id,
    platform: record.platform,
    plan_hash: record.plan_hash,
    cleanup_plan_hash: record.cleanup_plan_hash,
    generated_at: record.generated_at,
    remote_candidates: record.remote_candidates.map(redactArtifactPath),
    local_candidates: record.local_candidates.map((candidate) => redactArtifactLocalPath(candidate, record.run_id)),
    warnings: record.warnings,
    evidence_ref: safeProjectRelativeRef(filePath)
  };
}

function sanitizeArtifactCleanupExecutionRecord(record: {
  schema_version?: string;
  run_id: string;
  profile_id: string;
  platform: string;
  approval_id: string;
  kind: "cleanup-execute";
  observed_at: string;
  evidence: {
    manifest_hash: string;
    artifact_ids: string[];
    remote_deleted_files: string[];
    remote_missing: string[];
    remote_total_deleted_bytes: number;
    local_deleted_files: string[];
    command: { program: string; args: string[]; remote_argv: string[] };
  };
}, filePath: string): JsonObject {
  return {
    ...(record.schema_version ? { schema_version: record.schema_version } : {}),
    run_id: record.run_id,
    profile_id: record.profile_id,
    platform: record.platform,
    approval_id: record.approval_id,
    kind: record.kind,
    observed_at: record.observed_at,
    evidence: {
      manifest_hash: record.evidence.manifest_hash,
      artifact_ids: record.evidence.artifact_ids,
      remote_deleted_files: record.evidence.remote_deleted_files.map(redactArtifactPath),
      remote_missing: record.evidence.remote_missing.map(redactArtifactPath),
      remote_total_deleted_bytes: record.evidence.remote_total_deleted_bytes,
      local_deleted_files: record.evidence.local_deleted_files.map((candidate) => redactArtifactLocalPath(candidate, record.run_id)),
      command: {
        program: record.evidence.command.program,
        remote_argv: record.evidence.command.remote_argv.map(redactTransferCommandArg)
      }
    },
    evidence_ref: safeProjectRelativeRef(filePath)
  };
}

function readSanitizedTransferPlan(runId: string): JsonObject {
  const resolvedDir = assertInsideRuntime(TRANSFER_DIR, "Transfer resource directory");
  const safeRunId = safeTransferRunId(runId);
  const planPath = path.join(resolvedDir, safeRunId, "plan.json");
  assertRealPathInside(planPath, resolvedDir, "Transfer plan file");
  const raw = JSON.parse(fs.readFileSync(planPath, "utf8")) as unknown;
  assertPlannedTransfer(raw);
  if (raw.run_id !== safeRunId) {
    throw new Error("Transfer plan does not match the requested run");
  }
  return {
    ...(raw.schema_version ? { schema_version: raw.schema_version } : {}),
    mode: raw.mode,
    run_id: raw.run_id,
    profile_id: raw.profile_id,
    platform: raw.platform,
    direction: raw.direction,
    plan_hash: raw.plan_hash,
    ...(raw.quota_snapshot_id ? { quota_snapshot_id: raw.quota_snapshot_id } : {}),
    source: redactTransferEndpoint(raw.source),
    destination: redactTransferEndpoint(raw.destination),
    ...(raw.files ? { files: raw.files } : {}),
    ...(raw.max_total_bytes ? { max_total_bytes: raw.max_total_bytes } : {}),
    script_present: typeof raw.script === "string" && raw.script.length > 0,
    warnings: raw.warnings,
    plan_ref: safeProjectRelativeRef(planPath)
  };
}

function readSanitizedTransferState(runId: string): JsonObject {
  const safeRunId = safeTransferRunId(runId);
  const plan = transferPlanExists(safeRunId) ? readSanitizedTransferPlan(safeRunId) : null;
  const executionState = readSanitizedTransferExecutions(safeRunId) as { executions: JsonObject[] };
  const executions = executionState.executions;
  return {
    run_id: safeRunId,
    state: executions.length > 0 ? "executed" : plan ? "planned" : "missing",
    plan,
    latest_execution: executions[0] ?? null,
    executions
  };
}

function transferPlanExists(runId: string): boolean {
  const resolvedDir = assertInsideRuntime(TRANSFER_DIR, "Transfer resource directory");
  const planPath = path.join(resolvedDir, safeTransferRunId(runId), "plan.json");
  return fs.existsSync(planPath);
}

function readSanitizedTransferExecutions(runId: string): JsonObject {
  const resolvedDir = assertInsideRuntime(TRANSFER_DIR, "Transfer resource directory");
  const safeRunId = safeTransferRunId(runId);
  const runDir = path.join(resolvedDir, safeRunId);
  assertRealPathInside(runDir, resolvedDir, "Transfer run directory");
  const executions = fs
    .readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("execute-") && entry.name.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(runDir, entry.name);
      assertRealPathInside(filePath, resolvedDir, "Transfer execution file");
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      assertTransferExecutionRecord(raw);
      if (raw.run_id !== safeRunId) {
        throw new Error("Transfer execution record does not match the requested run");
      }
      return sanitizeTransferExecutionRecord(raw, filePath);
    })
    .sort((left, right) => String(right.observed_at).localeCompare(String(left.observed_at)));
  return {
    run_id: safeRunId,
    executions
  };
}

function sanitizeTransferExecutionRecord(record: {
  schema_version?: string;
  run_id: string;
  profile_id: string;
  platform: string;
  approval_id?: string;
  kind: string;
  observed_at: string;
  evidence: {
    direction: string;
    source: string;
    destination: string;
    files: Array<{ path: string; size_bytes: number; sha256?: string; checksum_status?: string }>;
    checksum_policy?: { algorithm: string; max_file_bytes: number };
    total_size_bytes: number;
    max_total_bytes: number;
    command: { program: string; args: string[] };
  };
}, filePath: string): JsonObject {
  return {
    ...(record.schema_version ? { schema_version: record.schema_version } : {}),
    run_id: record.run_id,
    profile_id: record.profile_id,
    platform: record.platform,
    ...(record.approval_id ? { approval_id: record.approval_id } : {}),
    kind: record.kind,
    observed_at: record.observed_at,
    evidence: {
      direction: record.evidence.direction,
      source: redactTransferEndpoint(record.evidence.source),
      destination: redactTransferEndpoint(record.evidence.destination),
      files: record.evidence.files.map((file) => ({
        path: file.path,
        size_bytes: file.size_bytes,
        ...(typeof file.sha256 === "string" ? { sha256: file.sha256 } : {}),
        ...(typeof file.checksum_status === "string" ? { checksum_status: file.checksum_status } : {})
      })),
      ...(record.evidence.checksum_policy
        ? {
            checksum_policy: {
              algorithm: record.evidence.checksum_policy.algorithm,
              max_file_bytes: record.evidence.checksum_policy.max_file_bytes
            }
          }
        : {}),
      total_size_bytes: record.evidence.total_size_bytes,
      max_total_bytes: record.evidence.max_total_bytes,
      command: {
        program: record.evidence.command.program,
        args: record.evidence.command.args.map(redactTransferCommandArg)
      }
    },
    evidence_ref: safeProjectRelativeRef(filePath)
  };
}

function sanitizeArtifactManifestEntry(value: unknown): JsonObject {
  if (!isObject(value)) {
    throw new Error("Artifact manifest entry must be an object");
  }
  const displayPath = typeof value.remote_path === "string" ? value.remote_path : typeof value.path === "string" ? value.path : "";
  const relativePath = typeof value.relative_path === "string" && isSafeRelativeArtifactPath(value.relative_path) ? value.relative_path : "";
  return {
    artifact_id: value.artifact_id,
    path: redactArtifactPath(displayPath),
    relative_path: relativePath,
    kind: value.kind,
    ...(typeof value.size_bytes === "number" ? { size_bytes: value.size_bytes } : {}),
    ...(typeof value.sha256 === "string" ? { sha256: value.sha256 } : {}),
    ...(typeof value.checksum_status === "string" ? { checksum_status: value.checksum_status } : {}),
    source_output: typeof value.source_output === "string" ? redactArtifactPath(value.source_output) : ""
  };
}

function readRuntimeJson(runtimeDir: string, id: string): JsonObject {
  const resolvedDir = assertInsideRuntime(runtimeDir, "Runtime resource directory");
  const filename = `${safeRuntimeId(id, "runtime resource id")}.json`;
  const filePath = path.join(resolvedDir, filename);
  const relative = path.relative(resolvedDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Runtime resource path must stay inside its resource directory");
  }
  assertRealPathInside(filePath, resolvedDir, "Runtime resource file");
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonObject;
}

export function latestQuotaSnapshotForProfile(profileId: string): JsonObject | null {
  const snapshots = listRuntimeJsonResources(QUOTA_DIR, "uts://quota-snapshots");
  for (const snapshotRef of snapshots) {
    const raw = readRuntimeJson(QUOTA_DIR, snapshotRef.id);
    const snapshot = quotaSnapshotOnly(raw);
    if (isObject(snapshot) && snapshot.profile_id === profileId) {
      return snapshot;
    }
  }
  return null;
}

function quotaSnapshotOnly(raw: JsonObject): JsonObject {
  if (isObject(raw.snapshot)) {
    return sanitizeQuotaSnapshot(raw.snapshot);
  }
  return sanitizeQuotaSnapshot(raw);
}

function sanitizeQuotaSnapshot(snapshot: JsonObject): JsonObject {
  const sanitized = { ...snapshot };
  if (typeof sanitized.raw_evidence_path === "string") {
    sanitized.raw_evidence_ref = safeProjectRelativeRef(sanitized.raw_evidence_path);
    delete sanitized.raw_evidence_path;
  }
  return sanitized;
}

function sanitizeRunRecord(raw: JsonObject): JsonObject {
  const sanitized = { ...raw };
  if (Array.isArray(sanitized.events)) {
    sanitized.events = sanitized.events.map((event) => {
      if (!isObject(event)) {
        return event;
      }
      const sanitizedEvent = { ...event };
      if (typeof sanitizedEvent.artifact_path === "string") {
        sanitizedEvent.artifact_path = safeProjectRelativeRef(sanitizedEvent.artifact_path);
      }
      return sanitizedEvent;
    });
  }
  return sanitized;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function oneVariable(value: string | string[] | undefined, label: string): string {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new Error(`${label} must contain exactly one value`);
    }
    return value[0];
  }
  if (typeof value !== "string") {
    throw new Error(`${label} is required`);
  }
  return value;
}

function safeRuntimeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(value) || value.startsWith(".") || value.includes("..")) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return value;
}

function safeArtifactRunId(value: string): string {
  if (!SAFE_RUN_ID_PATTERN.test(value)) {
    throw new Error(`Unsafe artifact manifest run id: ${value}`);
  }
  return value;
}

function safeTransferRunId(value: string): string {
  if (!SAFE_RUN_ID_PATTERN.test(value)) {
    throw new Error(`Unsafe transfer run id: ${value}`);
  }
  return value;
}

function isSafeRelativeArtifactPath(value: string): boolean {
  return !value.startsWith("/") && !value.split("/").includes("..") && !/[\0\r\n]/.test(value);
}


function safeProjectRelativeRef(candidatePath: string): string {
  const relative = path.relative(projectRoot, candidatePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "<outside-project>";
  }
  return relative;
}

// Mask the remote username under a known mount root. This resource-display path has no profile in
// hand, so it delegates to config.maskUserRootPath with the default mount prefixes (/data, /scratch,
// /shared/homes) — the single home for that mask, replacing three hand-maintained regexes that drift
// from the canonical prefix list. Manifest paths reaching here were already masked at write time by
// artifacts.ts under the run's full profile-derived prefix set; this is the idempotent display pass.
function redactArtifactPath(value: string): string {
  return maskUserRootPath(value);
}

function redactArtifactLocalPath(value: string, runId: string): string {
  if (value === "<artifact-cache>" || value.startsWith("<artifact-cache>/")) {
    return value;
  }
  const artifactRoot = path.join(assertInsideRuntime(ARTIFACT_DIR, "Artifact resource directory"), safeArtifactRunId(runId));
  const relative = path.relative(artifactRoot, value);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `<artifact-cache>/${relative.split(path.sep).join("/")}`;
  }
  return redactLocalResourcePath(value);
}

function redactLocalResourcePath(value: string): string {
  if (value.startsWith("<")) {
    return value;
  }
  const projectRelative = path.isAbsolute(value) ? path.relative(projectRoot, value) : value;
  if (path.isAbsolute(value) && !projectRelative.startsWith("..") && !path.isAbsolute(projectRelative)) {
    return `<project>/${projectRelative.split(path.sep).join("/")}`;
  }
  return redactLocalHome(redactProjectRoot(value, projectRoot));
}

function redactTransferEndpoint(value: string): string {
  const projectRelative = path.isAbsolute(value) ? path.relative(projectRoot, value) : value;
  if (path.isAbsolute(value) && !projectRelative.startsWith("..") && !path.isAbsolute(projectRelative)) {
    return `<project>/${projectRelative}`;
  }
  // Mask the remote-mount username AND a local /Users/<home>/… segment. A transfer endpoint can be a
  // local source/destination outside the project (e.g. /Users/alice/data); without the local-home
  // mask the OS username leaked to the persisted evidence's source/destination fields. The remote
  // mount mask is idempotent so the local-home pass can safely run on its result.
  return redactLocalHome(redactArtifactPath(value));
}

function redactTransferCommandArg(value: string): string {
  return redactLocalHome(redactProjectRoot(value, projectRoot)).replace(
    /([A-Za-z0-9._@+-]+:)?\/(data|scratch|shared\/homes)\/(?:\$\{USER\}|[A-Za-z0-9._-]+)\//g,
    (_match, prefix: string | undefined, root: string) => `${prefix ? "<profile-host>:" : ""}/${root}/<user>/`
  );
}
