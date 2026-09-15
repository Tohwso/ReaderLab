// ============ ReaderLab — Métricas de população (funções puras) ============
// Única fonte de verdade para agregações sobre ReadingRuns de uma
// PopulationRun (estatísticas por pergunta, agregados de reação, filtro de
// segmento por regras). Extraído do hub de resultados (ui.js) para que
// outros consumidores (ex.: o dataset do Research Analyst) reutilizem
// exatamente as mesmas fórmulas — nunca reimplementadas em paralelo.
import { describeQuestionValues } from "./statistics.js";

// Operadores suportados pelos filtros de segmento — comparação simples e
// determinística, sem clustering automático.
export const SEGMENT_RULE_OPS = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "==": (a, b) => a === b,
};

// Persona sem valor EXPLÍCITO para um atributo da regra nunca entra no
// segmento — nunca tratamos ausência como o valor default (ex.: 50).
export function personaMatchesRules(persona, rules) {
  return rules.every((r) => {
    const v = persona.attributeValues ? persona.attributeValues[r.attributeId] : undefined;
    if (v == null || typeof v !== "number" || !r.attributeId || r.value === "" || r.value == null) return false;
    const cmp = SEGMENT_RULE_OPS[r.op];
    return cmp ? cmp(v, Number(r.value)) : false;
  });
}

export function filterPersonasBySegment(personas, rules) {
  return rules.length ? personas.filter((p) => personaMatchesRules(p, rules)) : personas;
}

// Estatísticas por pergunta (N, média, mediana, faixa, desvio populacional
// e Índice de Divergência) — só sobre respostas válidas dos leitores que
// concluíram a leitura; ausência de resposta nunca vira zero. Guarda quem
// deu o maior/menor valor para permitir navegar até o leitor de origem.
// `getResult(runId)` é injetado pelo chamador (ex.: S.getResultForRun).
export function computeQuestionStats(questions, runsSubset, personas, getResult) {
  return questions.map((q) => {
    const entries = runsSubset
      .filter((r) => r.status === "COMPLETED")
      .map((r) => {
        const ans = getResult(r.id)?.surveyAnswers.find((a) => a.questionId === q.id);
        if (!ans || typeof ans.value !== "number") return null;
        return { run: r, persona: personas.find((p) => p.id === r.personaId), value: ans.value };
      })
      .filter(Boolean);
    const stats = describeQuestionValues(entries.map((e) => e.value), { min: q.min ?? 0, max: q.max ?? 100 });
    return {
      question: q, stats,
      maxEntry: stats.n ? entries.find((e) => e.value === stats.max) : null,
      minEntry: stats.n ? entries.find((e) => e.value === stats.min) : null,
    };
  });
}

// Só agrega reaction_code presentes na taxonomia informada (ex.: o snapshot
// congelado da PopulationRun) — reações criadas/renomeadas depois não
// contaminam o histórico.
export function computeReactionAggregates(reactionDefs, runsSubset, personas, getResult) {
  const validEntries = runsSubset
    .filter((r) => r.status === "COMPLETED")
    .map((r) => ({ run: r, result: getResult(r.id) }))
    .filter((x) => x.result);
  const validCount = validEntries.length;
  const stats = reactionDefs.map((def) => {
    const matches = validEntries
      .map(({ run, result }) => {
        const rr = result.reactions.find((x) => x.reactionCode === def.code);
        if (!rr) return null;
        const persona = personas.find((p) => p.id === run.personaId);
        return { run, rr, persona };
      })
      .filter(Boolean);
    const intensities = def.intensityEnabled ? matches.map((m) => m.rr.intensity).filter((v) => typeof v === "number") : [];
    const count = matches.length;
    return {
      def, matches, count,
      pct: validCount ? Math.round((count / validCount) * 100) : 0,
      avg: intensities.length ? Math.round(intensities.reduce((a, b) => a + b, 0) / intensities.length) : null,
      min: intensities.length ? Math.min(...intensities) : null,
      max: intensities.length ? Math.max(...intensities) : null,
    };
  });
  return { validCount, stats };
}
