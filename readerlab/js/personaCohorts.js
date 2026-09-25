// ============ ReaderLab — Cohorts sintéticos de Personas (score determinístico) ============
// Engine PURA (sem store.js/db.js) para compor as 5 Populations seed focadas
// em perfis de leitura (ver ui.js/personaFilter.js para o seletor manual de
// membros — este módulo só serve para CALCULAR a composição inicial da seed;
// depois de criada, `Population.personaIds` é a única fonte de verdade —
// nunca recalculado automaticamente).
import { slugify } from "./domain.js";

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Resolve sempre por nome normalizado (nunca por ID fixo) — atributos são
// recriados a cada workspace com IDs gerados por banco.
export function resolveAttributeByName(attributes, name) {
  const target = slugify(name);
  return (attributes || []).find((a) => (a.slug || slugify(a.name)) === target) || null;
}

// Normaliza um valor bruto para 0–100 usando o min/max REAL do Attribute
// (nunca assume 0–100 fixo) — retorna null quando não há valor definido, o
// chamador decide o tratamento conservador (ver COHORT_NEUTRAL_FALLBACK).
export function normalizeAttributeValue(rawValue, attribute) {
  if (rawValue == null || typeof rawValue !== "number") return null;
  const min = typeof attribute?.min === "number" ? attribute.min : 0;
  const max = typeof attribute?.max === "number" ? attribute.max : 100;
  if (max <= min) return 50;
  return clamp(((rawValue - min) / (max - min)) * 100, 0, 100);
}

// Tratamento conservador e documentado para Persona sem o atributo citado no
// cohort: não penaliza nem beneficia — entra como neutro (ponto médio da
// escala normalizada). Fica visível em `contributions[].usedFallback`.
export const COHORT_NEUTRAL_FALLBACK = 50;

// Score determinístico 0–100 (nunca via LLM) — soma ponderada das
// contribuições normalizadas de cada atributo do cohort; `inverse: true`
// inverte a contribuição (100 - normalizado) para atributos onde valor BAIXO
// é o que importa (ex.: pouca tolerância a ritmo lento). Retorna também a
// trilha de auditoria completa (seção 10 da tarefa), útil para debugging.
export function scorePersonaForCohort(persona, attributes, cohortDefinition) {
  const contributions = [];
  let totalWeight = 0;
  let totalContribution = 0;
  for (const w of cohortDefinition.weights) {
    const attribute = resolveAttributeByName(attributes, w.attribute);
    const rawValue = attribute ? persona?.attributeValues?.[attribute.id] : undefined;
    let normalizedValue = normalizeAttributeValue(rawValue, attribute);
    const usedFallback = normalizedValue == null;
    if (usedFallback) normalizedValue = COHORT_NEUTRAL_FALLBACK;
    const effectiveValue = w.inverse ? 100 - normalizedValue : normalizedValue;
    const contribution = effectiveValue * w.weight;
    contributions.push({
      attributeName: w.attribute,
      attributeId: attribute ? attribute.id : null,
      rawValue: rawValue == null ? null : rawValue,
      normalizedValue,
      weight: w.weight,
      inverse: !!w.inverse,
      contribution,
      usedFallback,
    });
    totalWeight += w.weight;
    totalContribution += contribution;
  }
  // Dividir pelo total de pesos (em vez de assumir soma=1) garante 0–100
  // mesmo que os pesos de uma definição futura não somem exatamente 1.
  const score = totalWeight > 0 ? clamp(totalContribution / totalWeight, 0, 100) : COHORT_NEUTRAL_FALLBACK;
  return { personaId: persona.id, personaCode: persona.code, score, contributions };
}

// Só Personas ativas e cujo `code` está na lista permitida (ex.: R001–R100)
// participam da seed — nunca uma Persona criada manualmente pelo usuário.
export function filterEligiblePersonas(personas, allowedCodes) {
  const allowed = new Set(allowedCodes || []);
  return (personas || []).filter((p) => p.status !== "arquivada" && allowed.has(p.code));
}

// TOP N por score, com desempate determinístico por `persona.code` ASC —
// duas execuções com a mesma entrada (em qualquer ordem) produzem
// exatamente os mesmos membros.
export function computeFocusedPopulationMembers({ personas, attributes, cohort, size = 20 }) {
  const audits = (personas || []).map((p) => scorePersonaForCohort(p, attributes, cohort));
  audits.sort((a, b) => b.score - a.score || (a.personaCode || "").localeCompare(b.personaCode || ""));
  return audits.slice(0, size);
}

// Guard de idempotência usado por store.js#ensureSeedFocusedPopulations —
// uma Population seed já existente (mesmo id) NUNCA é recalculada/sobrescrita,
// mesmo que o usuário já tenha editado seus membros manualmente.
export function isPopulationAlreadySeeded(existingPopulations, id) {
  return (existingPopulations || []).some((p) => p.id === id);
}

// Média de um atributo (por nome) num conjunto de Personas — usado para
// validar qualidade da seleção (cohort deve ficar acima da média geral) e
// disponível para eventual uso futuro em telas de auditoria.
export function averageAttributeValue(personas, attributes, attributeName) {
  const attribute = resolveAttributeByName(attributes, attributeName);
  const values = (personas || [])
    .map((p) => (attribute ? p?.attributeValues?.[attribute.id] : undefined))
    .filter((v) => typeof v === "number");
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------------------------------------------------- Definições dos 5 cohorts
export const COHORT_DEFINITIONS = {
  action: {
    weights: [
      { attribute: "Necessidade de ação", weight: 0.35 },
      { attribute: "Necessidade de progressão narrativa", weight: 0.30 },
      { attribute: "Orientação a enredo", weight: 0.20 },
      { attribute: "Tendência ao abandono", weight: 0.10 },
      { attribute: "Tolerância a ritmo lento", weight: 0.05, inverse: true },
    ],
  },
  contemplative: {
    weights: [
      { attribute: "Tolerância a ritmo lento", weight: 0.25 },
      { attribute: "Orientação a ideias", weight: 0.25 },
      { attribute: "Interesse por filosofia", weight: 0.20 },
      { attribute: "Tolerância a ambiguidades", weight: 0.15 },
      { attribute: "Tolerância a complexidade", weight: 0.10 },
      { attribute: "Necessidade de ação", weight: 0.05, inverse: true },
    ],
  },
  characterEmotion: {
    weights: [
      { attribute: "Orientação a personagens", weight: 0.30 },
      { attribute: "Orientação emocional", weight: 0.25 },
      { attribute: "Interesse por relacionamentos", weight: 0.20 },
      { attribute: "Interesse por drama", weight: 0.15 },
      { attribute: "Sensibilidade a diálogos artificiais", weight: 0.10 },
    ],
  },
  coherence: {
    weights: [
      { attribute: "Sensibilidade a inconsistências", weight: 0.30 },
      { attribute: "Exigência de realismo científico", weight: 0.25 },
      { attribute: "Exigência de realismo", weight: 0.15 },
      { attribute: "Criticidade geral", weight: 0.15 },
      { attribute: "Afinidade com ficção científica", weight: 0.10 },
      { attribute: "Tolerância a complexidade", weight: 0.05 },
    ],
  },
  humorAbsurd: {
    weights: [
      { attribute: "Afinidade com humor absurdo", weight: 0.35 },
      { attribute: "Afinidade com sátira", weight: 0.25 },
      { attribute: "Afinidade com humor", weight: 0.25 },
      { attribute: "Tolerância a ambiguidades", weight: 0.10 },
      { attribute: "Exigência de realismo", weight: 0.05, inverse: true },
    ],
  },
};

// IDs fixos (nunca uid aleatório) — ver store.js#ensureSeedFocusedPopulations.
export const SEED_FOCUSED_POPULATION_DEFS = [
  {
    id: "pop_seed_action",
    name: "Ávidos por Ação",
    description: "Leitores sintéticos orientados a movimento narrativo, conflito e avanço constante. Tendem a perder interesse quando a narrativa permanece parada por muito tempo.",
    cohortKey: "action",
    size: 20,
  },
  {
    id: "pop_seed_contemplative",
    name: "Contemplativos e Introspectivos",
    description: "Leitores sintéticos confortáveis com ritmo contemplativo, ambiguidade e exploração conceitual. Tendem a aceitar pouca ação quando percebem profundidade ou desenvolvimento de ideias.",
    cohortKey: "contemplative",
    size: 20,
  },
  {
    id: "pop_seed_character_emotion",
    name: "Orientados a Personagens e Emoção",
    description: "Leitores sintéticos cujo vínculo com a narrativa depende principalmente de personagens, relações e impacto emocional.",
    cohortKey: "characterEmotion",
    size: 20,
  },
  {
    id: "pop_seed_coherence",
    name: "Céticos de Coerência",
    description: "Leitores sintéticos especialmente atentos à consistência interna, plausibilidade e rigor das explicações. São mais propensos a perceber contradições, regras arbitrárias e tecnobaboseira.",
    cohortKey: "coherence",
    size: 20,
  },
  {
    id: "pop_seed_humor_absurd",
    name: "Humor, Absurdo e Sátira",
    description: "Leitores sintéticos particularmente receptivos a humor, estranhamento, absurdo deliberado e sátira, inclusive quando essas escolhas quebram expectativas tradicionais de realismo.",
    cohortKey: "humorAbsurd",
    size: 20,
  },
];
