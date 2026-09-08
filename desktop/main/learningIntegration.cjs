const fs = require("node:fs");
const crypto = require("node:crypto");

const KINDS = ["proofreading", "cut", "scene_boundary", "line_break"];

/** Sampled media identity: stable across renamed/copied projects without reading a whole video. */
function mediaLearningIdentity(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return undefined;
  const fd = fs.openSync(filePath, "r");
  try {
    const hash = crypto.createHash("sha256").update(String(stat.size));
    const buffer = Buffer.alloc(Math.min(65536, stat.size));
    for (const offset of new Set([0, Math.max(0, stat.size - buffer.length)])) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

/** Local/shared are snapshots, never count increments. Empty newer contributions withdraw old examples. */
function combineEditingCorpora(...corpora) {
  const projects = new Map();
  const excludedExampleIds = new Set();
  for (const corpus of corpora) {
    for (const id of corpus?.excludedExampleIds ?? []) if (typeof id === "string") excludedExampleIds.add(id);
    for (const project of corpus?.projects ?? []) {
      if (!project?.projectId || !project.confirmedAt || !Array.isArray(project.examples)) continue;
      const old = projects.get(project.projectId);
      const rank = (p) => {
        const milliseconds = Date.parse(p.confirmedAt);
        return Number.isFinite(milliseconds) ? milliseconds : 0;
      };
      if (!old || rank(project) > rank(old) ||
          (rank(project) === rank(old) && String(project.revision ?? "") > String(old.revision ?? ""))) {
        projects.set(project.projectId, project);
      }
    }
  }
  return {
    version: "1.0.0", kind: "catcut-editing-corpus",
    excludedExampleIds: [...excludedExampleIds].sort(),
    projects: [...projects.values()].sort((a, b) => a.projectId.localeCompare(b.projectId)).map((project) => ({
      ...project, examples: project.examples.filter((example) => !excludedExampleIds.has(example.exampleId)),
    })),
  };
}

function summarizeEditingCorpus(corpus) {
  const active = combineEditingCorpora(corpus);
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  const examples = active.projects.flatMap((project) => project.examples);
  for (const example of examples) if (KINDS.includes(example.kind)) counts[example.kind]++;
  return {
    projects: active.projects.length,
    examples: examples.length,
    counts,
    recentExamples: examples.sort((a, b) => String(b.confirmedAt).localeCompare(String(a.confirmedAt))).slice(0, 20),
  };
}

module.exports = { mediaLearningIdentity, combineEditingCorpora, summarizeEditingCorpus };
