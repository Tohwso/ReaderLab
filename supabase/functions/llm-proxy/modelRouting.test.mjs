// ============ ReaderLab — Testes: modelRouting (llm-proxy) ============
// Roda direto com `node supabase/functions/llm-proxy/modelRouting.test.mjs`.
// Módulo puro sob teste (sem Deno.env/fetch, ver modelRouting.mjs).
//
// Cobre a seção 15 da tarefa "separar modelo Reader/Analyst por purpose".
import assert from "node:assert/strict";
import { resolvePurpose, resolveModel, getModelCapabilities, buildUpstreamPayload, validateRequestedModel, ALLOWED_PURPOSES } from "./modelRouting.mjs";

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

test("C) purpose inválido -> ok:false com mensagem clara (Edge Function retorna 400 invalid_request)", () => {
  const r = resolvePurpose("qualquer-coisa");
  assert.equal(r.ok, false);
  assert.ok(r.error.includes(ALLOWED_PURPOSES.join(", ")));
});

test("D) purpose ausente -> fallback 'reader'", () => {
  assert.deepEqual(resolvePurpose(undefined), { ok: true, purpose: "reader" });
  assert.deepEqual(resolvePurpose(null), { ok: true, purpose: "reader" });
});

test("purpose='reader'/'analyst' são aceitos como vieram", () => {
  assert.deepEqual(resolvePurpose("reader"), { ok: true, purpose: "reader" });
  assert.deepEqual(resolvePurpose("analyst"), { ok: true, purpose: "analyst" });
});

test("A) purpose='reader' -> seleciona LLM_READER_MODEL quando presente", () => {
  const model = resolveModel({ purpose: "reader", readerModelEnv: "kimi-k3", analystModelEnv: "kimi-k2.6", legacyModelEnv: "gpt-4o-mini", defaultModel: "gpt-4o-mini" });
  assert.equal(model, "kimi-k3");
});

test("B) purpose='analyst' -> seleciona LLM_ANALYST_MODEL quando presente", () => {
  const model = resolveModel({ purpose: "analyst", readerModelEnv: "kimi-k3", analystModelEnv: "kimi-k2.6", legacyModelEnv: "gpt-4o-mini", defaultModel: "gpt-4o-mini" });
  assert.equal(model, "kimi-k2.6");
});

test("E) LLM_READER_MODEL ausente -> usa LLM_MODEL (legado)", () => {
  const model = resolveModel({ purpose: "reader", readerModelEnv: undefined, analystModelEnv: "kimi-k2.6", legacyModelEnv: "kimi-k3-legacy", defaultModel: "gpt-4o-mini" });
  assert.equal(model, "kimi-k3-legacy");
});

test("F) LLM_ANALYST_MODEL ausente -> usa LLM_MODEL (legado)", () => {
  const model = resolveModel({ purpose: "analyst", readerModelEnv: "kimi-k3", analystModelEnv: undefined, legacyModelEnv: "kimi-legacy", defaultModel: "gpt-4o-mini" });
  assert.equal(model, "kimi-legacy");
});

test("sem nenhum env configurado -> cai no defaultModel para ambos os purposes", () => {
  assert.equal(resolveModel({ purpose: "reader", readerModelEnv: undefined, analystModelEnv: undefined, legacyModelEnv: undefined, defaultModel: "gpt-4o-mini" }), "gpt-4o-mini");
  assert.equal(resolveModel({ purpose: "analyst", readerModelEnv: undefined, analystModelEnv: undefined, legacyModelEnv: undefined, defaultModel: "gpt-4o-mini" }), "gpt-4o-mini");
});

test("K) kimi-k3 -> reasoning_effort presente, SEM temperature customizada", () => {
  const payload = buildUpstreamPayload({ model: "kimi-k3", messages: [], reasoningEffort: "low", maxCompletionTokens: 8000, jsonMode: true });
  assert.equal(payload.reasoning_effort, "low");
  assert.equal("temperature" in payload, false);
  assert.equal(payload.max_completion_tokens, 8000);
  assert.deepEqual(payload.response_format, { type: "json_object" });
});

test("L) kimi-k2.6 -> NÃO recebe reasoning_effort (parâmetro exclusivo de K3) nem temperature (K2.6 não suporta valor customizado — só 1 é aceito pelo provider)", () => {
  const payload = buildUpstreamPayload({ model: "kimi-k2.6", messages: [], reasoningEffort: "low", maxCompletionTokens: 8000, jsonMode: true });
  assert.equal("reasoning_effort" in payload, false);
  assert.equal("temperature" in payload, false);
  assert.equal(payload.max_completion_tokens, 8000);
});

test("getModelCapabilities: reasoning_effort e temperature customizada são capabilities independentes (nenhum dos dois modelos do catálogo suporta temperature customizada)", () => {
  assert.deepEqual(getModelCapabilities("kimi-k3"), { supportsReasoningEffort: true, supportsCustomTemperature: false });
  assert.deepEqual(getModelCapabilities("kimi-k2.6"), { supportsReasoningEffort: false, supportsCustomTemperature: false });
  assert.deepEqual(getModelCapabilities("gpt-4o-mini"), { supportsReasoningEffort: false, supportsCustomTemperature: true });
});

// ---- Regressão: "invalid temperature: only 1 is allowed for this model" ----
// kimi-k2.6 chegou a receber temperature: 0.7 porque supportsCustomTemperature
// era (incorretamente) derivado de reasoningEffort !== true. Agora é uma
// capability explícita e independente no catálogo (customTemperature).
test("A) kimi-k2.6 -> payload NÃO contém a propriedade temperature", () => {
  const payload = buildUpstreamPayload({ model: "kimi-k2.6", messages: [], maxCompletionTokens: 8000, jsonMode: true });
  assert.equal("temperature" in payload, false);
});

test("B) kimi-k2.6 -> payload NÃO contém a propriedade reasoning_effort", () => {
  const payload = buildUpstreamPayload({ model: "kimi-k2.6", messages: [], reasoningEffort: "low", maxCompletionTokens: 8000, jsonMode: true });
  assert.equal("reasoning_effort" in payload, false);
});

test("C) kimi-k2.6 -> mantém max_completion_tokens", () => {
  const payload = buildUpstreamPayload({ model: "kimi-k2.6", messages: [], maxCompletionTokens: 8000, jsonMode: true });
  assert.equal(payload.max_completion_tokens, 8000);
});

test("D) kimi-k2.6 -> mantém response_format json_object", () => {
  const payload = buildUpstreamPayload({ model: "kimi-k2.6", messages: [], maxCompletionTokens: 8000, jsonMode: true });
  assert.deepEqual(payload.response_format, { type: "json_object" });
});

test("E) kimi-k3 -> payload NÃO contém a propriedade temperature", () => {
  const payload = buildUpstreamPayload({ model: "kimi-k3", messages: [], reasoningEffort: "low", maxCompletionTokens: 8000, jsonMode: true });
  assert.equal("temperature" in payload, false);
});

test("F) kimi-k3 -> mantém reasoning_effort", () => {
  const payload = buildUpstreamPayload({ model: "kimi-k3", messages: [], reasoningEffort: "medium", maxCompletionTokens: 8000, jsonMode: true });
  assert.equal(payload.reasoning_effort, "medium");
});

test("G) capability de temperature customizada não é inferida a partir de reasoningEffort (kimi-k2.6 tem reasoningEffort=false e MESMO ASSIM não suporta temperature)", () => {
  const caps = getModelCapabilities("kimi-k2.6");
  assert.equal(caps.supportsReasoningEffort, false);
  assert.equal(caps.supportsCustomTemperature, false);
});

test("maxCompletionTokens ausente/0 nunca aparece no payload", () => {
  const payload = buildUpstreamPayload({ model: "kimi-k3", messages: [], reasoningEffort: "low", maxCompletionTokens: null, jsonMode: false });
  assert.equal("max_completion_tokens" in payload, false);
  assert.equal("response_format" in payload, false);
});

test("critério C: modelId inexistente no catálogo -> INVALID_REQUEST", () => {
  const r = validateRequestedModel({ modelId: "gpt-qualquer-coisa", purpose: "reader" });
  assert.equal(r.ok, false);
});

test("critério C: modelId ausente/undefined -> INVALID_REQUEST", () => {
  const r = validateRequestedModel({ modelId: undefined, purpose: "reader" });
  assert.equal(r.ok, false);
});

test("validateRequestedModel aceita kimi-k3/kimi-k2.6 para reader e analyst", () => {
  for (const modelId of ["kimi-k3", "kimi-k2.6"]) {
    for (const purpose of ["reader", "analyst"]) {
      const r = validateRequestedModel({ modelId, purpose });
      assert.equal(r.ok, true);
      assert.equal(r.model, modelId);
    }
  }
});

test("critério D: purpose incompatível com o modelo -> INVALID_REQUEST (simulado forçando purpose inválido)", () => {
  // Purpose fora de ALLOWED_PURPOSES nunca é "compatível" com nenhum modelo.
  const r = validateRequestedModel({ modelId: "kimi-k3", purpose: "outro-purpose" });
  assert.equal(r.ok, false);
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Há falhas acima.");
} else {
  console.log("Todos os testes passaram.");
}
