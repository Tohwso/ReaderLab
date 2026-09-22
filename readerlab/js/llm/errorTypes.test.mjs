// ============ ReaderLab — Testes: errorTypes (Research Analyst) ============
// Roda direto com `node js/llm/errorTypes.test.mjs`. Módulo puro sob teste.
//
// Cobre a classificação final de falha do Research Analyst (ver seção 8 da
// tarefa "corrigir timeout do Research Analyst"): distinguir uma resposta
// CORTADA (finish_reason="length") de uma resposta genuinamente inválida
// (JSON malformado / evidence fabricada com finish_reason="stop" ou ausente).
import assert from "node:assert/strict";
import { classifyAnalystFinalFailure, classifyEmptyResponseBody, isRetryableErrorType, LLM_ERROR_TYPES } from "./errorTypes.js";

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

// E) finish_reason=length + JSON incompleto -> ANALYST_OUTPUT_TRUNCATED (erro claro, distinto)
test("E) finish_reason='length' -> code ANALYST_OUTPUT_TRUNCATED", () => {
  const r = classifyAnalystFinalFailure("length", ["O modelo retornou um JSON inválido."]);
  assert.equal(r.code, "ANALYST_OUTPUT_TRUNCATED");
  assert.equal(r.errorType, LLM_ERROR_TYPES.INVALID_RESPONSE);
  assert.ok(r.message.includes("finish_reason=length"));
});

test("finish_reason='stop' -> code INVALID_EVIDENCE (nunca ANALYST_OUTPUT_TRUNCATED)", () => {
  const r = classifyAnalystFinalFailure("stop", ["evidence fabricada: metricId inexistente."]);
  assert.equal(r.code, "INVALID_EVIDENCE");
  assert.ok(r.message.includes("evidence fabricada"));
});

test("finish_reason ausente/null -> code INVALID_EVIDENCE", () => {
  const r = classifyAnalystFinalFailure(null, ["O modelo retornou um JSON inválido."]);
  assert.equal(r.code, "INVALID_EVIDENCE");
});

test("mensagem de INVALID_EVIDENCE inclui até 5 erros da última tentativa", () => {
  const errors = ["e1", "e2", "e3", "e4", "e5", "e6", "e7"];
  const r = classifyAnalystFinalFailure("stop", errors);
  assert.ok(r.message.includes("e1") && r.message.includes("e5"));
  assert.ok(!r.message.includes("e6"), "não deveria incluir mais de 5 erros na mensagem");
});

// ---- Regressão: ReadingRun com Kimi K2.6 fez 6 tentativas e falhou com
// "resposta vazia" sem NENHUM usage/finish_reason preservado (ver
// supabase/functions/llm-proxy/index.ts + js/llm/provider.js) ----
test("G) classifyEmptyResponseBody preserva o usage do corpo do erro", () => {
  const usage = { prompt_tokens: 1200, completion_tokens: 3000, total_tokens: 4200 };
  const r = classifyEmptyResponseBody({ error: "empty_response", model: "kimi-k2.6", usage, finish_reason: "stop" });
  assert.deepEqual(r.usage, usage);
  assert.equal(r.model, "kimi-k2.6");
});

test("H) classifyEmptyResponseBody preserva o finish_reason do corpo do erro", () => {
  const r = classifyEmptyResponseBody({ error: "empty_response", finish_reason: "length" });
  assert.equal(r.finishReason, "length");
});

test("I) empty_response com finish_reason=length -> OUTPUT_TRUNCATED, permanente (nunca dispara 6 retries)", () => {
  const r = classifyEmptyResponseBody({ error: "empty_response", finish_reason: "length" });
  assert.equal(r.code, "OUTPUT_TRUNCATED");
  assert.equal(r.errorType, LLM_ERROR_TYPES.INVALID_RESPONSE);
  assert.equal(isRetryableErrorType(r.errorType), false);
});

test("empty_response sem finish_reason conhecido -> EMPTY_RESPONSE, também permanente (nunca 6 retries)", () => {
  const r = classifyEmptyResponseBody({ error: "empty_response" });
  assert.equal(r.code, "EMPTY_RESPONSE");
  assert.equal(r.errorType, LLM_ERROR_TYPES.INVALID_RESPONSE);
  assert.equal(isRetryableErrorType(r.errorType), false);
});

test("classifyEmptyResponseBody sem usage/model/finish_reason -> campos null (nunca undefined/erro)", () => {
  const r = classifyEmptyResponseBody({ error: "empty_response" });
  assert.equal(r.usage, null);
  assert.equal(r.model, null);
  assert.equal(r.finishReason, null);
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Há falhas acima.");
} else {
  console.log("Todos os testes passaram.");
}
