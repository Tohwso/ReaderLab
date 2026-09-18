// ============ ReaderLab — Testes: normalização da resposta bruta (readingResultNormalizer.js) ============
// Roda direto com `node js/llm/readingResultNormalizer.test.mjs`. Módulo puro.
import assert from "node:assert/strict";
import { normalizeReadingResultResponse } from "./readingResultNormalizer.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS - ${name}`);
  } catch (err) {
    console.log(`FAIL - ${name}`);
    console.log("  " + err.message);
    process.exitCode = 1;
  }
}

const SAMPLE_JSON = '{\n  "reactions": [],\n  "survey_answers": []\n}';

test("A) fence genérica (```...```) é removida e o JSON interno permanece intacto", () => {
  const raw = "```\n" + SAMPLE_JSON + "\n```";
  const { normalizedText, warnings } = normalizeReadingResultResponse(raw);
  assert.equal(normalizedText, SAMPLE_JSON);
  assert.ok(warnings.includes("markdown_fence_removed"));
  assert.doesNotThrow(() => JSON.parse(normalizedText));
});

test("B) fence com marcador de linguagem (```json...```) é removida", () => {
  const raw = "  \n```json\n" + SAMPLE_JSON + "\n```\n  ";
  const { normalizedText, warnings } = normalizeReadingResultResponse(raw);
  assert.equal(normalizedText, SAMPLE_JSON);
  assert.ok(warnings.includes("markdown_fence_removed"));
  assert.doesNotThrow(() => JSON.parse(normalizedText));
});

test("C) JSON puro (sem fences) passa sem warnings", () => {
  const { normalizedText, warnings } = normalizeReadingResultResponse(SAMPLE_JSON);
  assert.equal(normalizedText, SAMPLE_JSON);
  assert.deepEqual(warnings, []);
  assert.doesNotThrow(() => JSON.parse(normalizedText));
});

test("D) texto explicativo antes/depois do JSON não é extraído — JSON.parse deve continuar falhando", () => {
  const raw = `Aqui está minha análise:\n${SAMPLE_JSON}\nEspero que ajude!`;
  const { normalizedText, warnings } = normalizeReadingResultResponse(raw);
  assert.equal(normalizedText, raw.trim());
  assert.deepEqual(warnings, []);
  assert.throws(() => JSON.parse(normalizedText));
});

test("H) JSON realmente quebrado continua falhando após normalização", () => {
  const raw = "```json\n{ \"reactions\": [ \n```"; // fence válida, conteúdo interno quebrado
  const { normalizedText } = normalizeReadingResultResponse(raw);
  assert.throws(() => JSON.parse(normalizedText));
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Alguns testes falharam.");
} else {
  console.log("Todos os testes passaram.");
}
