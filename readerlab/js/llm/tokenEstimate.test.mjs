// ============ ReaderLab — Testes: estimativa conservadora de tokens ============
// Roda direto com `node js/llm/tokenEstimate.test.mjs`. Módulo puro.
import assert from "node:assert/strict";
import { estimateTokensConservative } from "./tokenEstimate.js";

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

test("A) texto vazio/ausente -> 0", () => {
  assert.equal(estimateTokensConservative(""), 0);
  assert.equal(estimateTokensConservative(null), 0);
  assert.equal(estimateTokensConservative(undefined), 0);
});

test("B) ~1 token a cada 3 caracteres, arredondado para cima", () => {
  assert.equal(estimateTokensConservative("abc"), 1);
  assert.equal(estimateTokensConservative("abcd"), 2);
  assert.equal(estimateTokensConservative("a".repeat(300)), 100);
});

test("C) é conservadora (superestima) frente à régua comum de ~4 chars/token", () => {
  const text = "a".repeat(400);
  const conservative = estimateTokensConservative(text);
  const commonRuleOfThumb = Math.ceil(text.length / 4);
  assert.ok(conservative >= commonRuleOfThumb, "a estimativa conservadora deveria ser >= à régua comum de 4 chars/token");
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Alguns testes falharam.");
} else {
  console.log("Todos os testes passaram.");
}
