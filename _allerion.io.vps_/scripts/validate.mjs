#!/usr/bin/env node
// Zero-dependency validator for index.json. Checks the structural rules that
// matter operationally (shapes, enums, unique ids/ports, cross-references)
// without pulling in a full JSON Schema engine.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));

const STATUSES = new Set(["planned", "active", "deprecated", "retired"]);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const errors = [];
const fail = (msg) => errors.push(msg);

const requireFields = (entry, fields, where) => {
  for (const f of fields) {
    if (entry[f] === undefined || entry[f] === "") fail(`${where}: missing "${f}"`);
  }
};
const checkStatus = (entry, where) => {
  if (!STATUSES.has(entry.status)) fail(`${where}: bad status "${entry.status}"`);
};
const checkPort = (p, where) => {
  if (!Number.isInteger(p) || p < 1 || p > 65535) fail(`${where}: bad port ${p}`);
};
const checkUnique = (values, where) => {
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) fail(`${where}: duplicate "${v}"`);
    seen.add(v);
  }
};

if (index.name !== "_/allerion.io.vps\\_") fail(`name must be "_/allerion.io.vps\\_"`);
if (!index.host?.hostname) fail("host.hostname is required");

for (const key of ["domains", "services", "ports", "jobs", "backups"]) {
  if (!Array.isArray(index[key])) fail(`"${key}" must be an array`);
}

const domains = new Set();
for (const d of index.domains ?? []) {
  const where = `domains[${d.domain}]`;
  requireFields(d, ["domain", "owner", "status"], where);
  checkStatus(d, where);
  domains.add(d.domain);
}

const serviceIds = new Set();
for (const s of index.services ?? []) {
  const where = `services[${s.id}]`;
  requireFields(s, ["id", "kind", "owner", "status"], where);
  if (!ID_RE.test(s.id ?? "")) fail(`${where}: id must match ${ID_RE}`);
  checkStatus(s, where);
  for (const p of s.ports ?? []) checkPort(p, where);
  for (const d of s.domains ?? []) {
    if (!domains.has(d)) fail(`${where}: unknown domain "${d}"`);
  }
  serviceIds.add(s.id);
}
checkUnique([...(index.services ?? [])].map((s) => s.id), "services");

for (const p of index.ports ?? []) {
  const where = `ports[${p.port}/${p.protocol}]`;
  requireFields(p, ["port", "protocol", "service", "exposure", "status"], where);
  checkPort(p.port, where);
  if (!["tcp", "udp"].includes(p.protocol)) fail(`${where}: bad protocol`);
  if (!["public", "internal", "localhost"].includes(p.exposure)) fail(`${where}: bad exposure`);
  checkStatus(p, where);
  // Port entries name either a declared service or a host daemon like sshd;
  // only flag names that collide with nothing (typo protection, not a registry).
  if (!serviceIds.has(p.service) && !/^[a-z0-9][a-z0-9-]*$/.test(p.service)) {
    fail(`${where}: bad service name "${p.service}"`);
  }
}
checkUnique((index.ports ?? []).map((p) => `${p.port}/${p.protocol}`), "ports");

for (const j of index.jobs ?? []) {
  const where = `jobs[${j.id}]`;
  requireFields(j, ["id", "schedule", "owner", "status"], where);
  if (!ID_RE.test(j.id ?? "")) fail(`${where}: id must match ${ID_RE}`);
  checkStatus(j, where);
}
checkUnique((index.jobs ?? []).map((j) => j.id), "jobs");

for (const b of index.backups ?? []) {
  const where = `backups[${b.id}]`;
  requireFields(b, ["id", "source", "destination", "owner", "status"], where);
  if (!ID_RE.test(b.id ?? "")) fail(`${where}: id must match ${ID_RE}`);
  checkStatus(b, where);
}
checkUnique((index.backups ?? []).map((b) => b.id), "backups");

if (errors.length > 0) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}
console.log("✓ index.json is valid — _/\\_");
