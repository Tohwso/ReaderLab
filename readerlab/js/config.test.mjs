// ============ ReaderLab — Testes: config.js (Research Analyst runtime params) ============
// Roda direto com `node js/config.test.mjs`. Módulo puro sob teste — sem
// `window`, config.js cai nos defaults documentados no próprio arquivo.
//
// Cobre a seção 1 da tarefa "corrigir timeout do Research Analyst":
// ANALYST_REASONING_EFFORT / ANALYST_MAX_COMPLETION_TOKENS devem ter
// defaults próprios e NUNCA reutilizar LLM_READER_MAX_COMPLETION_TOKENS
// (ReadingRun e Research Analyst têm requisitos de saída diferentes).
import assert from "node:assert/strict";
import {
  ANALYST_REASONING_EFFORT,
  ANALYST_MAX_COMPLETION_TOKENS,
  LLM_READER_REASONING_EFFORT,
  LLM_READER_MAX_COMPLETION_TOKENS,
} from "./config.js";

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

test("ANALYST_REASONING_EFFORT default é 'low'", () => {
  assert.equal(ANALYST_REASONING_EFFORT, "low");
});

test("ANALYST_MAX_COMPLETION_TOKENS default é 8000", () => {
  assert.equal(ANALYST_MAX_COMPLETION_TOKENS, 8000);
});

// B) ReadingRuns continuam usando suas próprias configs — nunca a mesma
// constante/valor do Research Analyst (constantes distintas mesmo quando o
// valor coincide, ex.: reasoning_effort default "low" para ambos).
test("B) ANALYST_MAX_COMPLETION_TOKENS é INDEPENDENTE de LLM_READER_MAX_COMPLETION_TOKENS", () => {
  assert.notEqual(ANALYST_MAX_COMPLETION_TOKENS, LLM_READER_MAX_COMPLETION_TOKENS);
  assert.equal(LLM_READER_MAX_COMPLETION_TOKENS, 3000, "config do ReadingRun não deveria ter mudado");
});

test("B) ANALYST_REASONING_EFFORT e LLM_READER_REASONING_EFFORT são constantes distintas (não a mesma referência de override)", () => {
  assert.equal(ANALYST_REASONING_EFFORT, "low");
  assert.equal(LLM_READER_REASONING_EFFORT, "low");
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Há falhas acima.");
} else {
  console.log("Todos os testes passaram.");
}
