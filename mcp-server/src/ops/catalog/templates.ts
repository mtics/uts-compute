import fs from "node:fs";
import { resolveProjectPath } from "../../core/paths.js";

export const TEMPLATE_CATALOG = [
  {
    id: "pbs-cpu",
    platform: "uts-hpc",
    path: "templates/pbs/cpu.pbs.hbs",
    description: "UTS HPC CPU PBS dry-run script"
  },
  {
    id: "pbs-gpu",
    platform: "uts-hpc",
    path: "templates/pbs/gpu.pbs.hbs",
    description: "UTS HPC GPU PBS dry-run script"
  },
  {
    id: "pbs-array",
    platform: "uts-hpc",
    path: "templates/pbs/array.pbs.hbs",
    description: "UTS HPC PBS array dry-run script"
  },
  {
    id: "ihpc-background",
    platform: "uts-ihpc",
    path: "templates/ihpc/background-run.sh.hbs",
    description: "UTS iHPC supervised background run dry-run script"
  },
  {
    id: "transfer-rsync",
    platform: "both",
    path: "templates/transfer/rsync-stage.sh.hbs",
    description: "Rsync staging dry-run script template"
  }
] as const;

export type TemplateId = (typeof TEMPLATE_CATALOG)[number]["id"];

export function listTemplates() {
  return TEMPLATE_CATALOG;
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderTemplate(templateId: TemplateId, variables: Record<string, string | number>): string {
  const template = TEMPLATE_CATALOG.find((candidate) => candidate.id === templateId);
  if (!template) {
    throw new Error(`Unknown template id: ${templateId}`);
  }

  const templateText = fs.readFileSync(resolveProjectPath(template.path), "utf8");
  return templateText.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, rawKey: string) => {
    if (!(rawKey in variables)) {
      throw new Error(`Missing template variable ${rawKey} for ${templateId}`);
    }
    return String(variables[rawKey]);
  });
}
