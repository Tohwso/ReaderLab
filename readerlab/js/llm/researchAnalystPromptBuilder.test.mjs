// ============ ReaderLab — Testes: Research Analyst Prompt Builder ============
// Sem infraestrutura de testes no projeto — roda direto com
// `node js/llm/researchAnalystPromptBuilder.test.mjs`. Módulo puro sob
// teste (sem I/O, ver researchAnalystPromptBuilder.js).
//
// Cobre a seção 4 da tarefa de redução de tamanho do prompt do Analyst:
// JSON minificado (sem indentação) na seção "DADOS DO EXPERIMENTO" —
// pretty-print é desperdício de caracteres/tokens para uma estrutura
// consumida por máquina.
import assert from "node:assert/strict";
import { buildResearchAnalystPrompt } from "./researchAnalystPromptBuilder.js";

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

const dataset = {
  analysisDatasetVersion: 2,
  populationRun: { id: "pr1", title: "Teste", sampleSize: 3, completed: 3, failed: 0 },
  population: { name: "Pop", personas: [{ code: "R001", name: "Leitor 1" }] },
  quantitativeMetrics: [{ questionId: "q1", questionText: "Q1?", n: 3, mean: 50 }],
  reactionAggregates: [],
  individualResults: [{ personaCode: "R001", quantitativeAnswers: { q1: 50 } }],
  qualitativeQuestions: [],
  reactionEntries: [],
  segments: [],
};

test("user prompt embute o dataset como JSON minificado (sem indentação/pretty-print)", () => {
  const { user } = buildResearchAnalystPrompt(dataset);
  const raw = JSON.stringify(dataset);
  const pretty = JSON.stringify(dataset, null, 2);
  assert.ok(user.includes(raw), "user prompt deveria conter o dataset serializado sem espaços/indentação");
  assert.ok(!user.includes(pretty), "user prompt não deveria conter o dataset com indentação (pretty-print)");
});

test("JSON minificado é estritamente menor que o mesmo dataset com pretty-print (null, 2)", () => {
  const minified = JSON.stringify(dataset);
  const pretty = JSON.stringify(dataset, null, 2);
  assert.ok(minified.length < pretty.length, `minificado (${minified.length}) deveria ser menor que pretty-print (${pretty.length})`);
});

test("estrutura do dataset é preservada (minificação nunca altera os dados)", () => {
  const { user } = buildResearchAnalystPrompt(dataset);
  const raw = JSON.stringify(dataset);
  const idx = user.indexOf(raw);
  assert.ok(idx !== -1, "dataset minificado deveria aparecer literalmente no user prompt");
  const roundTripped = JSON.parse(user.slice(idx, idx + raw.length));
  assert.deepEqual(roundTripped, dataset);
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Há falhas acima.");
} else {
  console.log("Todos os testes passaram.");
}
