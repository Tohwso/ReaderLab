// ============ ReaderLab — Testes: modelCatalog (llm-proxy) ============
// Roda direto com `node supabase/functions/llm-proxy/modelCatalog.test.mjs`.
// Módulo puro sob teste (sem Deno.env/fetch, ver modelCatalog.mjs).
import assert from "node:assert/strict";
import {
  MODEL_CATALOG,
  getActiveModels,
  findModel,
  isModelActive,
  isModelSuitableForPurpose,
  sanitizeModelForClient,
  intersectWithProviderModels,
} from "./modelCatalog.mjs";

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

test("catálogo cadastra kimi-k2.6 e kimi-k3, ambos ativos", () => {
  const active = getActiveModels();
  const ids = active.map((m) => m.id);
  assert.ok(ids.includes("kimi-k2.6"));
  assert.ok(ids.includes("kimi-k3"));
});

test("A) catálogo ∩ provider retorna K2.6 e K3 quando o provider lista ambos + outros", () => {
  const providerModelIds = ["kimi-k2.6", "kimi-k3", "kimi-k2.7-code", "outro-modelo"];
  const result = intersectWithProviderModels(getActiveModels(), providerModelIds);
  const ids = result.map((m) => m.id).sort();
  assert.deepEqual(ids, ["kimi-k2.6", "kimi-k3"]);
});

test("B) modelo desconhecido retornado pelo provider não entra na lista selecionável", () => {
  const providerModelIds = ["kimi-k2.7-code", "outro-modelo"];
  const result = intersectWithProviderModels(getActiveModels(), providerModelIds);
  assert.equal(result.length, 0);
});

test("intersectWithProviderModels nunca inclui modelo do catálogo ausente na lista do provider", () => {
  const result = intersectWithProviderModels(getActiveModels(), ["kimi-k3"]);
  assert.deepEqual(result.map((m) => m.id), ["kimi-k3"]);
});

test("findModel/isModelActive retornam null/false para modelo inexistente", () => {
  assert.equal(findModel("gpt-qualquer-coisa"), null);
  assert.equal(isModelActive("gpt-qualquer-coisa"), false);
});

test("critério D: isModelSuitableForPurpose rejeita purpose desconhecido mesmo para modelo válido", () => {
  assert.equal(isModelSuitableForPurpose("kimi-k3", "outro-purpose"), false);
});

test("isModelSuitableForPurpose: ambos modelos são compatíveis com reader e analyst", () => {
  for (const id of ["kimi-k2.6", "kimi-k3"]) {
    assert.equal(isModelSuitableForPurpose(id, "reader"), true);
    assert.equal(isModelSuitableForPurpose(id, "analyst"), true);
  }
});

test("isModelSuitableForPurpose retorna false para modelo inexistente", () => {
  assert.equal(isModelSuitableForPurpose("gpt-qualquer-coisa", "reader"), false);
});

test("sanitizeModelForClient nunca vaza campos além do schema documentado", () => {
  const sanitized = sanitizeModelForClient(findModel("kimi-k3"));
  assert.deepEqual(Object.keys(sanitized).sort(), ["capabilities", "category", "contextTokens", "displayName", "id", "pricing", "provider", "tags"].sort());
});

test("catálogo nunca contém modelos especulativos além dos dois cadastrados", () => {
  assert.equal(MODEL_CATALOG.length, 2);
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Há falhas acima.");
} else {
  console.log("Todos os testes passaram.");
}
