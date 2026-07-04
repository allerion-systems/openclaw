#!/usr/bin/env node
// Splice a brain graph JSON into the second-brain shell to produce a
// self-contained artifact (what lives in Drive as Allerion-Brain.html).
// Usage: node build.mjs <graph.json> [out.html]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , dataPath, outPath = "Allerion-Brain.html"] = process.argv;
if (!dataPath) {
  console.error("usage: node build.mjs <graph.json> [out.html]");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(here, "second-brain.html"), "utf8");
const graph = JSON.parse(readFileSync(dataPath, "utf8"));

// sanity: every link must resolve to a node id
const ids = new Set(graph.nodes.map((n) => n.id));
for (const l of graph.links) {
  if (!ids.has(l.source) || !ids.has(l.target)) {
    console.error(`dangling link: ${l.source} -> ${l.target}`);
    process.exit(1);
  }
}

const marker = /(<script id="brainData" type="application\/json">)([\s\S]*?)(<\/script>)/;
if (!marker.test(shell)) {
  console.error("brainData script tag not found in shell");
  process.exit(1);
}
const out = shell.replace(
  marker,
  (_, open, __, close) => open + JSON.stringify(graph, null, 2) + close,
);
writeFileSync(outPath, out);
console.log(`${outPath}: ${graph.nodes.length} nodes, ${graph.links.length} links`);
