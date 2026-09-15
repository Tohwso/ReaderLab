// ============ ReaderLab — Testes: validação da resposta da LLM (validate.js) ============
// Roda direto com `node js/llm/validate.test.mjs`. Módulo puro.
import assert from "node:assert/strict";
import { validateLLMResponse } from "./validate.js";

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

const reactions = [
  { code: "TENSAO", name: "Tensão", polarity: "negativa", intensityEnabled: true },
  { code: "ALIVIO", name: "Alívio", polarity: "positiva", intensityEnabled: false },
];
const survey = {
  name: "Pesquisa",
  questions: [{ id: "q1", text: "Nota?", type: "scale", min: 0, max: 10, required: true }],
};

function validResponse(overrides = {}) {
  return {
    reactions: [{ reaction_code: "TENSAO", intensity: 70, reason: "Trecho tenso." }],
    survey_answers: [{ question_id: "q1", value: 7 }],
    spontaneous_notes: [],
    reader_state: { engagement: 60, curiosity: 50, fatigue: 40, confusions: [], predictions: [] },
    ...overrides,
  };
}

test("A) resposta válida passa sem erros", () => {
  const { ok, errors } = validateLLMResponse(validResponse(), { reactions, survey });
  assert.equal(ok, true, errors.join(" | "));
});

test("B) reação desconhecida é rejeitada", () => {
  const { ok, errors } = validateLLMResponse(validResponse({ reactions: [{ reaction_code: "INEXISTENTE", reason: "x" }] }), { reactions, survey });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("Reação desconhecida")));
});

test("C) mais de 8 reações válidas é cortado para 8 (não falha a validação por isso)", () => {
  const many = Array.from({ length: 12 }, () => ({ reaction_code: "ALIVIO", reason: "ok" }));
  const { ok, value } = validateLLMResponse(validResponse({ reactions: many }), { reactions, survey });
  assert.equal(ok, true);
  assert.equal(value.reactions.length, 8);
});

test("D) mais de 3 spontaneous_notes é cortado para 3", () => {
  const notes = ["a", "b", "c", "d", "e"];
  const { ok, value } = validateLLMResponse(validResponse({ spontaneous_notes: notes }), { reactions, survey });
  assert.equal(ok, true);
  assert.equal(value.spontaneousNotes.length, 3);
  assert.deepEqual(value.spontaneousNotes, ["a", "b", "c"]);
});

test("E) mais de 5 confusions/predictions em reader_state é cortado para 5 cada", () => {
  const readerState = {
    engagement: 50, curiosity: 50, fatigue: 50,
    confusions: ["1", "2", "3", "4", "5", "6", "7"],
    predictions: ["a", "b", "c", "d", "e", "f"],
  };
  const { ok, value } = validateLLMResponse(validResponse({ reader_state: readerState }), { reactions, survey });
  assert.equal(ok, true);
  assert.equal(value.readerState.confusions.length, 5);
  assert.equal(value.readerState.predictions.length, 5);
});

test("F) valor de pesquisa fora da escala é rejeitado", () => {
  const { ok, errors } = validateLLMResponse(validResponse({ survey_answers: [{ question_id: "q1", value: 999 }] }), { reactions, survey });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("fora da escala")));
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Alguns testes falharam.");
} else {
  console.log("Todos os testes passaram.");
}
