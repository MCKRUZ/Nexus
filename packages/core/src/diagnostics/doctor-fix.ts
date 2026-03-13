/**
 * Doctor Fix Engine — auto-remediation for common health issues.
 *
 * Fix A: autoLinkFamilies — detect project families by name prefix and set parentId
 * Fix B: syncStaleProjects — bulk sync projects that have never synced or are stale (>7d)
 */

import fs from 'node:fs';
import path from 'node:path';
import type { NexusService } from '../service.js';

const MAX_SECTION_CHARS = 6000;
const SECTION_START = '<!-- nexus:start -->';
const SECTION_END = '<!-- nexus:end -->';

export interface DoctorFixResult {
  linkedFamilies: Array<{ rootName: string; children: string[] }>;
  syncedProjects: string[];
  skippedProjects: string[];
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Detect project families by name prefix and link children to roots.
 * Shortest name = root candidate. A project Q is a child of P when
 * Q.normalizedName starts with P.normalizedName + "-".
 * Idempotent: skips projects that already have a parentId.
 */
export function autoLinkFamilies(svc: NexusService): DoctorFixResult['linkedFamilies'] {
  const projects = svc.listProjects();
  const sorted = [...projects].sort(
    (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
  );

  const familyMap = new Map<string, string[]>();

  for (const root of sorted) {
    const rootNorm = normalizeName(root.name);

    for (const candidate of sorted) {
      if (candidate.id === root.id) continue;
      if (candidate.parentId) continue; // already linked

      const candidateNorm = normalizeName(candidate.name);
      if (candidateNorm.startsWith(rootNorm + '-')) {
        svc.setProjectParent(candidate.id, root.id, 'cli');

        const existing = familyMap.get(root.name) ?? [];
        existing.push(candidate.name);
        familyMap.set(root.name, existing);
      }
    }
  }

  return Array.from(familyMap.entries()).map(([rootName, children]) => ({
    rootName,
    children,
  }));
}

/**
 * Check if a project's CLAUDE.md Nexus section exceeds the token budget.
 */
function hasOversizedSection(projectPath: string): boolean {
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath) === false) return false;
  const content = fs.readFileSync(claudeMdPath, 'utf8');
  const startIdx = content.indexOf(SECTION_START);
  const endIdx = content.indexOf(SECTION_END);
  if (startIdx === -1 || endIdx === -1) return false;
  const sectionLen = endIdx + SECTION_END.length - startIdx;
  return sectionLen > MAX_SECTION_CHARS;
}

/**
 * Sync all projects where lastSyncAge is null, > 7 days, or Nexus section is oversized.
 * Skips projects whose path doesn't exist on disk.
 */
export function syncStaleProjects(
  svc: NexusService,
): Pick<DoctorFixResult, 'syncedProjects' | 'skippedProjects'> {
  const report = svc.getDoctorReport();
  const allProjects = svc.listProjects();
  const staleIds = new Set(
    report.projects
      .filter((p) => p.lastSyncAge === null || p.lastSyncAge / 24 > 7)
      .map((p) => p.projectId),
  );

  // Also include projects with oversized Nexus sections
  for (const proj of allProjects) {
    if (fs.existsSync(proj.path) && hasOversizedSection(proj.path)) {
      staleIds.add(proj.id);
    }
  }

  const staleProjects = report.projects.filter((p) => staleIds.has(p.projectId));

  const syncedProjects: string[] = [];
  const skippedProjects: string[] = [];

  for (const ph of staleProjects) {
    const project = svc.getProjectById(ph.projectId);
    if (!project) {
      skippedProjects.push(ph.projectName);
      continue;
    }

    if (!fs.existsSync(project.path)) {
      skippedProjects.push(ph.projectName);
      continue;
    }

    try {
      const result = svc.syncProject(project.id);
      if (result) {
        syncedProjects.push(ph.projectName);
      } else {
        skippedProjects.push(ph.projectName);
      }
    } catch {
      skippedProjects.push(ph.projectName);
    }
  }

  return { syncedProjects, skippedProjects };
}

/**
 * Run all doctor fixes: link families then sync stale projects.
 */
export function runDoctorFix(svc: NexusService): DoctorFixResult {
  const linkedFamilies = autoLinkFamilies(svc);
  const { syncedProjects, skippedProjects } = syncStaleProjects(svc);

  return { linkedFamilies, syncedProjects, skippedProjects };
}
