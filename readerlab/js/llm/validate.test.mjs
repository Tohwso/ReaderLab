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

test("G) questionId desconhecido com value=null é descartado com warning (não invalida)", () => {
  const answers = [{ question_id: "q1", value: 7 }, { question_id: "qst_x_extra", value: null }];
  const { ok, value, warnings } = validateLLMResponse(validResponse({ survey_answers: answers }), { reactions, survey });
  assert.equal(ok, true);
  assert.equal(value.surveyAnswers.length, 1);
  assert.ok(warnings.some((w) => w.includes("qst_x_extra")));
});

test("H) questionId desconhecido com conteúdo não-nulo continua INVALID (não aceita conteúdo inventado)", () => {
  const answers = [{ question_id: "q1", value: 7 }, { question_id: "qst_x_extra", value: "algo inventado" }];
  const { ok, errors } = validateLLMResponse(validResponse({ survey_answers: answers }), { reactions, survey });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("qst_x_extra")));
});

test("I) reação conhecida sem intensity obrigatória é descartada com warning (não invalida)", () => {
  const reactionsPayload = [
    { reaction_code: "TENSAO", reason: "sem intensidade" }, // intensity ausente, obrigatória
    { reaction_code: "ALIVIO", reason: "ok" },
  ];
  const { ok, value, warnings } = validateLLMResponse(validResponse({ reactions: reactionsPayload }), { reactions, survey });
  assert.equal(ok, true);
  assert.equal(value.reactions.length, 1);
  assert.equal(value.reactions[0].reactionCode, "ALIVIO");
  assert.ok(warnings.some((w) => w.includes("TENSAO")));
});

// ---- Correspondência determinística Survey <-> surveyAnswers (endurecimento) ----
const richSurvey = {
  name: "Pesquisa completa",
  questions: [
    { id: "q1", text: "Nota geral?", type: "scale", min: 0, max: 10, required: true },
    { id: "q2", text: "Comente sua experiência.", type: "short_text", required: true },
    { id: "q3", text: "Nota extra (opcional)?", type: "number", min: 0, max: 100, required: false },
    { id: "q4", text: "Recomendaria?", type: "single_choice", options: ["sim", "não"], required: false },
  ],
};

function richAnswers() {
  return [
    { question_id: "q1", value: 8 },
    { question_id: "q2", value: "Gostei bastante." },
  ];
}

test("J) [Survey] todos os IDs corretos, incl. opcionais respondidos -> PASS", () => {
  const answers = [...richAnswers(), { question_id: "q3", value: 90 }, { question_id: "q4", value: "sim" }];
  const { ok, errors, surveyCompleteness } = validateLLMResponse({ reactions: [], survey_answers: answers }, { reactions, survey: richSurvey });
  assert.equal(ok, true, errors.join(" | "));
  assert.equal(surveyCompleteness.expectedQuestionCount, 4);
  assert.equal(surveyCompleteness.answeredQuestionCount, 4);
  assert.equal(surveyCompleteness.requiredQuestionCount, 2);
  assert.deepEqual(surveyCompleteness.missingOptionalQuestionIds, []);
});

test("K) [Survey] questionId duplicado -> FAIL", () => {
  const answers = [...richAnswers(), { question_id: "q1", value: 5 }];
  const { ok, errors } = validateLLMResponse({ reactions: [], survey_answers: answers }, { reactions, survey: richSurvey });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("Duplicate survey answer for questionId: q1")));
});

test("L) [Survey] pergunta obrigatória ausente -> FAIL", () => {
  const answers = [{ question_id: "q1", value: 8 }]; // q2 é obrigatória e não foi respondida
  const { ok, errors } = validateLLMResponse({ reactions: [], survey_answers: answers }, { reactions, survey: richSurvey });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("obrigatória ausente")));
});

test("M) [Survey] pergunta opcional ausente é permitida, nunca preenchida artificialmente -> PASS", () => {
  const answers = richAnswers(); // q3/q4 (opcionais) ficam de fora de propósito
  const { ok, value, surveyCompleteness } = validateLLMResponse({ reactions: [], survey_answers: answers }, { reactions, survey: richSurvey });
  assert.equal(ok, true);
  assert.ok(!value.surveyAnswers.some((a) => a.questionId === "q3"));
  assert.ok(!value.surveyAnswers.some((a) => a.questionId === "q4"));
  assert.deepEqual(surveyCompleteness.missingOptionalQuestionIds.sort(), ["q3", "q4"]);
  assert.equal(surveyCompleteness.answeredQuestionCount, 2);
});

test("N) [Survey] texto onde deveria ser número -> FAIL", () => {
  const answers = [{ question_id: "q1", value: "não sei" }, { question_id: "q2", value: "ok" }];
  const { ok, errors } = validateLLMResponse({ reactions: [], survey_answers: answers }, { reactions, survey: richSurvey });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("não numérica")));
});

test("O) [Survey] número onde deveria ser texto -> FAIL", () => {
  const answers = [{ question_id: "q1", value: 8 }, { question_id: "q2", value: 42 }];
  const { ok, errors } = validateLLMResponse({ reactions: [], survey_answers: answers }, { reactions, survey: richSurvey });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("deve ser texto")));
});

test("P) [Survey] single_choice fora das opções -> FAIL", () => {
  const answers = [...richAnswers(), { question_id: "q4", value: "talvez" }];
  const { ok, errors } = validateLLMResponse({ reactions: [], survey_answers: answers }, { reactions, survey: richSurvey });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("Opção inválida")));
});

test("Q) [Survey] questionId desconhecido com valor não-nulo -> FAIL", () => {
  const answers = [...richAnswers(), { question_id: "qst_ghost", value: "inventado" }];
  const { ok, errors } = validateLLMResponse({ reactions: [], survey_answers: answers }, { reactions, survey: richSurvey });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("qst_ghost")));
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Alguns testes falharam.");
} else {
  console.log("Todos os testes passaram.");
}
