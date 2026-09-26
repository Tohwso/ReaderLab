#!/usr/bin/env node
// Executa toda a suíte *.test.mjs do ReaderLab (frontend + Edge Functions),
// sequencialmente, sem dependências npm. Usado localmente e pelo CI
// (.github/workflows/ci.yml) — o mesmo comando roda nos dois lugares.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SEARCH_DIRS = ["readerlab", "supabase/functions"];
const IGNORE_DIRS = new Set(["node_modules", ".git"]);

function findTestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) found.push(...findTestFiles(full));
    else if (entry.endsWith(".test.mjs")) found.push(full);
  }
  return found;
}

const files = SEARCH_DIRS
  .map((d) => join(ROOT, d))
  .flatMap((d) => findTestFiles(d))
  .map((f) => relative(ROOT, f).split(sep).join("/"))
  .sort();

if (files.length === 0) {
  console.error("Nenhum arquivo *.test.mjs encontrado em: " + SEARCH_DIRS.join(", "));
  process.exit(1);
}

let totalTests = 0;
let totalTestsKnown = true;

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  console.log(`\nRunning ${i + 1}/${files.length} — ${file}`);
  const result = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: "utf8" });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();

  const match = output.match(/(\d+) teste\(s\) passaram/);
  if (match) totalTests += Number(match[1]);
  else totalTestsKnown = false;

  if (result.status !== 0) {
    if (output) console.log(output);
    console.error(`\nFAIL — ${file} (exit code ${result.status})`);
    console.error(`${i} de ${files.length} arquivo(s) de teste passaram antes da falha.`);
    process.exit(result.status || 1);
  }
  console.log("PASS");
}

console.log(`\n${files.length} test file(s) passed.`);
if (totalTestsKnown) console.log(`${totalTests} teste(s) passaram no total.`);
