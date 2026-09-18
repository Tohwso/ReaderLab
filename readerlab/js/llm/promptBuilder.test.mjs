// ============ ReaderLab — Testes: Prompt Builder (otimização de tokens) ============
// Roda direto com `node js/llm/promptBuilder.test.mjs`. Módulo puro, sem
// dependência de store.js/db.js.
import assert from "node:assert/strict";
import { buildReadingPrompt } from "./promptBuilder.js";

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

const attributes = [
  { id: "a1", name: "Orientação a ideias", min: 0, max: 100 },
  { id: "a2", name: "Orientação a enredo", min: 0, max: 100 },
  { id: "a3", name: "Atributo não usado por ninguém", min: 0, max: 100 },
];

const survey = {
  name: "Pesquisa de leitura",
  questions: [{ id: "q1", text: "Como você avalia o ritmo?", type: "scale", min: 0, max: 10, required: true }],
};

const reactions = [
  { code: "TENSAO", name: "Tensão", polarity: "negativa", intensityEnabled: true },
];

function basePersona(overrides = {}) {
  return {
    id: "p1",
    code: "P001",
    name: "Persona Teste",
    attributeValues: { a1: 80, a2: 40 }, // a3 fica de fora de propósito (não definido)
    ...overrides,
  };
}

test("A) atributos NÃO definidos pela Persona nunca aparecem no prompt (só os explicitamente definidos)", () => {
  const { user } = buildReadingPrompt({ persona: basePersona(), attributes, reactions, survey, text: "Era uma vez." });
  assert.ok(user.includes("Orientação a ideias"));
  assert.ok(user.includes("Orientação a enredo"));
  assert.ok(!user.includes("Atributo não usado por ninguém"));
});

test("B) sem tags -> linha 'Tags:' é omitida (nunca um campo vazio no prompt)", () => {
  const { user } = buildReadingPrompt({ persona: basePersona(), attributes, reactions, survey, text: "x" });
  assert.ok(!user.includes("Tags:"));
});

test("C) com tags -> linha 'Tags:' aparece com os valores", () => {
  const { user } = buildReadingPrompt({ persona: basePersona({ tags: ["jovem", "urbano"] }), attributes, reactions, survey, text: "x" });
  assert.ok(user.includes("Tags: jovem, urbano"));
});

test("D) sem instructions -> seção INSTRUÇÕES COMPORTAMENTAIS inteira é omitida", () => {
  const { user } = buildReadingPrompt({ persona: basePersona(), attributes, reactions, survey, text: "x" });
  assert.ok(!user.includes("INSTRUÇÕES COMPORTAMENTAIS"));
});

test("E) com instructions -> seção aparece com o conteúdo", () => {
  const { user } = buildReadingPrompt({ persona: basePersona({ instructions: "Seja cético." }), attributes, reactions, survey, text: "x" });
  assert.ok(user.includes("INSTRUÇÕES COMPORTAMENTAIS"));
  assert.ok(user.includes("Seja cético."));
});

test("F) schema de saída declara os limites de tamanho (reactions<=8, notes<=3, confusions/predictions<=5)", () => {
  const { user } = buildReadingPrompt({ persona: basePersona(), attributes, reactions, survey, text: "x" });
  assert.ok(/reactions.*m[aá]ximo 8/i.test(user.replace(/\n/g, " ")));
  assert.ok(/spontaneous_notes.*m[aá]ximo 3/i.test(user.replace(/\n/g, " ")));
  assert.ok(/confusions.*predictions.*m[aá]ximo 5/i.test(user.replace(/\n/g, " ")));
});

test("G) system prompt instrui concisão explicitamente", () => {
  const { system } = buildReadingPrompt({ persona: basePersona(), attributes, reactions, survey, text: "x" });
  assert.ok(/CONCIS[ÃA]O/i.test(system));
});

test("I) system prompt instrui a não duplicar/inventar question_ids", () => {
  const { system } = buildReadingPrompt({ persona: basePersona(), attributes, reactions, survey, text: "x" });
  assert.ok(/no m[aá]ximo uma vez/i.test(system));
  assert.ok(/nunca crie question_ids/i.test(system));
});

test("J) system prompt proíbe Markdown/fences no output (raw JSON only)", () => {
  const { system } = buildReadingPrompt({ persona: basePersona(), attributes, reactions, survey, text: "x" });
  assert.ok(/raw JSON only/i.test(system));
  assert.ok(/n[ãa]o use markdown/i.test(system));
  assert.ok(/n[ãa]o envolva o json em blocos de c[oó]digo/i.test(system));
});

test("K) schema de saída declara enum explícito de reaction_code e question_id (IDs reais, não fabricados)", () => {
  const { user } = buildReadingPrompt({ persona: basePersona(), attributes, reactions, survey, text: "x" });
  assert.ok(user.includes("[TENSAO]"));
  assert.ok(user.includes("[q1]"));
});

test("L) system prompt instrui a OMITIR pergunta opcional sem resposta (nunca value: null)", () => {
  const { system } = buildReadingPrompt({ persona: basePersona(), attributes, reactions, survey, text: "x" });
  assert.ok(/OMITA a entrada/i.test(system));
  assert.ok(system.includes('value": null'));
});

test("M) system prompt instrui intensity obrigatória quando habilitada, omitida quando não", () => {
  const { system } = buildReadingPrompt({ persona: basePersona(), attributes, reactions, survey, text: "x" });
  assert.ok(/intensity.*obrigat[óo]rio.*habilitada/i.test(system.replace(/\n/g, " ")));
});

test("H) prompt de uma Persona minimalista (sem tags/instructions/narrativa) é mais enxuto que uma com todos os campos preenchidos", () => {
  const minimal = buildReadingPrompt({ persona: basePersona(), attributes, reactions, survey, text: "x" });
  const full = buildReadingPrompt({
    persona: basePersona({
      tags: ["a", "b"],
      instructions: "Instrução.",
      shortDescription: "Desc curta.",
      narrativeDescription: "Desc narrativa.",
      tastes: "Gosta de ficção.",
      aversions: "Não gosta de romance.",
      expectations: "Espera ritmo rápido.",
      behaviors: "Comenta em voz alta.",
      contradictions: "Diz uma coisa, faz outra.",
    }),
    attributes, reactions, survey, text: "x",
  });
  assert.ok(full.user.length > minimal.user.length);
});

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) {
  console.log("Alguns testes falharam.");
} else {
  console.log("Todos os testes passaram.");
}
