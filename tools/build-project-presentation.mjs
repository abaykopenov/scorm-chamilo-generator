import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const unpackDir = path.join(root, "docs", "presentation", "template_unzip");
const slidesDir = path.join(unpackDir, "ppt", "slides");
const mediaDir = path.join(unpackDir, "ppt", "media");

function escapeXml(text) {
  return `${text ?? ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const replacements = {
  1: {
    1: "SCORM + RAG Course Generator for Chamilo",
    2: "Project:",
    3: "Team",
    5: "Advisor:",
    8: "Digital Learning Lab",
    10: "Science and Technology Innovation Competition - 2026"
  },
  2: {
    1: "Goal",
    3: "Project Objectives and Challenges",
    9: "Automate SCORM 1.2 course production from a short brief.",
    10: "Use local LLM + RAG over uploaded files to generate grounded content.",
    11: "Reduce manual authoring time while preserving course structure quality.",
    12: "Publish ready SCORM ZIP packages directly into Chamilo LMS."
  },
  3: {
    1: "Key Capabilities"
  },
  4: {
    1: "Client + API",
    2: "RAG Pipeline",
    3: "Data + Delivery",
    4: "SCORM Build",
    5: "User UI",
    6: "Retriever",
    7: "LLM Client",
    8: "Vector DB",
    9: "SCORM ZIP",
    10: "Chamilo LMS",
    11: "Upload",
    12: "Index",
    13: "Generate",
    14: "Functional architecture",
    15: "SCORM Generator platform",
    16: "System",
    17: "architecture with three layers",
    18: "2026",
    19: "Next.js + Local LLM + Qdrant",
    20: "",
    21: "Production-oriented MVP",
    22: ""
  },
  5: {
    15: "End-to-end workflow",
    17: "1) Upload and index source materials",
    19: "2) Generate draft course with structure controls",
    20: "3) Export SCORM and publish to Chamilo",
    21: "Why it matters:"
  },
  6: {
    6: "Technology stack",
    7: "Next.js APIs, local LLM providers, Qdrant/LangChain retrieval",
    10: "Quality metrics",
    11: "Generation latency",
    12: "Content coverage",
    13: "Question quality",
    14: "Publishing success rate",
    16: "Prompting strategy",
    17: "Outline JSON + line-plan + fallback + quality gate",
    19: "RAG strategy",
    20: "Chunking, embeddings, top-K retrieval, and traceability",
    27: "Engineering focus"
  },
  7: {
    1: "What has been implemented",
    2: "and",
    3: "Current project status"
  },
  8: {
    1: "Architecture modules (v1.0)",
    2: "CORE",
    3: "Frontend UI",
    4: "API Layer",
    5: "Course Generator",
    6: "RAG Service",
    7: "Document Parser",
    8: "Material Indexer",
    9: "Vector Search (Qdrant)",
    10: "SCORM Exporter",
    11: "Chamilo Client",
    12: "Local LLM Adapter",
    13: "Fallback Engine",
    14: "Quality Gate",
    15: "Diagnostics",
    16: "Local Data Storage",
    17: "SCORM 1.2 Runtime",
    18: "Course JSON Model",
    19: "Streaming Progress",
    20: "Upload Limits",
    21: "Operational Logging",
    22: "+"
  },
  9: {
    1: "Results and deliverables"
  },
  10: {
    1: "The platform transforms raw materials into structured SCORM 1.2 courses with configurable hierarchy, tests, and runtime constraints.",
    2: "The architecture is modular: client/API, RAG+generation pipeline, and data+delivery layer. This supports local-first deployment and Chamilo integration.",
    3: "Conclusion and next steps"
  }
};

for (let slide = 1; slide <= 10; slide += 1) {
  const filePath = path.join(slidesDir, `slide${slide}.xml`);
  let xml = fs.readFileSync(filePath, "utf8");
  let idx = 0;
  const map = replacements[slide] || {};
  xml = xml.replace(/<a:t>([\s\S]*?)<\/a:t>/g, (_full, existing) => {
    idx += 1;
    if (Object.prototype.hasOwnProperty.call(map, idx)) {
      return `<a:t>${escapeXml(map[idx])}</a:t>`;
    }
    return `<a:t>${existing}</a:t>`;
  });
  fs.writeFileSync(filePath, xml, "utf8");
}

const architectureDir = path.join(root, "docs", "architecture");
const imageMap = {
  "image6.png": "architecture-1-client-api.png",
  "image8.png": "architecture-2-rag-pipeline.png",
  "image9.png": "architecture-3-data-delivery.png",
  "image1.png": "architecture-large.png"
};

for (const [targetName, sourceName] of Object.entries(imageMap)) {
  const source = path.join(architectureDir, sourceName);
  const target = path.join(mediaDir, targetName);
  fs.copyFileSync(source, target);
}

console.log("Template content updated.");
