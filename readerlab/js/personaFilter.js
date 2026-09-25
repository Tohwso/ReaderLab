// ============ ReaderLab — Engine puro de filtro/seleção de Personas ============
// Único lugar com a lógica de "quem aparece" ao editar os membros de uma
// Population (ver ui.js/membersModal). Módulo PURO (sem fetch/DOM/store) —
// testável direto com `node personaFilter.test.mjs`. NUNCA decide "quem
// pertence" à Population (isso é sempre `selectedIds`, mutado só por ações
// explícitas do usuário) — filtrar só decide o que fica visível.
import { slugify } from "./domain.js";

// Accent/case-insensitive — "Filosofia" e "filosofia" e "FILOSOFIA" (e
// buscas com/sem acento) devem casar igual.
export function normalizeSearchText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Estrutura default de filtros do editor de membros (ver ui.js). Nunca
// inclui `selectedIds` — isso é um Set separado, mantido pelo chamador.
export function blankMemberFilters() {
  return {
    search: "",
    tags: [],
    tagMode: "any", // "any" | "all"
    membership: "all", // "all" | "selected" | "unselected"
    attributeFilters: [], // [{ attributeId, operator: "gte"|"lte"|"between", value, min, max }]
    sortBy: "code", // "code" | "name" | "selected" | "adherence"
  };
}

export function matchesSearch(persona, search) {
  const q = normalizeSearchText(search).trim();
  if (!q) return true;
  const haystacks = [
    persona.code,
    persona.name,
    persona.shortDescription,
    ...(Array.isArray(persona.tags) ? persona.tags : []),
  ];
  return haystacks.some((h) => h && normalizeSearchText(h).includes(q));
}

export function matchesTags(persona, tags, tagMode = "any") {
  if (!Array.isArray(tags) || tags.length === 0) return true;
  const personaTags = new Set((Array.isArray(persona.tags) ? persona.tags : []).map((t) => normalizeSearchText(t)));
  const wanted = tags.map((t) => normalizeSearchText(t));
  return tagMode === "all" ? wanted.every((t) => personaTags.has(t)) : wanted.some((t) => personaTags.has(t));
}

export function matchesMembership(persona, membership, selectedIds) {
  if (!membership || membership === "all") return true;
  const isSelected = selectedIds.has(persona.id);
  return membership === "selected" ? isSelected : !isSelected;
}

export const ATTRIBUTE_FILTER_OPERATORS = Object.freeze({ gte: "gte", lte: "lte", between: "between" });

// Avalia UM critério de atributo contra UMA persona — nunca decide sozinho
// se a persona passa no filtro completo (ver evaluatePersonaAttributeFilters,
// que combina todos os critérios com AND). Persona sem valor definido para
// o atributo (attributeValues[attributeId] ausente) NUNCA passa.
export function evaluateAttributeFilter(persona, attribute, filter) {
  const rawValue = persona?.attributeValues ? persona.attributeValues[filter.attributeId] : undefined;
  const base = { attributeId: filter.attributeId, attribute, operator: filter.operator, filter, rawValue: rawValue ?? null };
  if (rawValue == null || typeof rawValue !== "number") return { ...base, pass: false };
  if (filter.operator === "gte") return { ...base, pass: rawValue >= filter.value };
  if (filter.operator === "lte") return { ...base, pass: rawValue <= filter.value };
  if (filter.operator === "between") return { ...base, pass: rawValue >= filter.min && rawValue <= filter.max };
  return { ...base, pass: false };
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

// Score DETERMINÍSTICO de aderência — só para ORDENAÇÃO ("Maior aderência",
// ver ui.js), nunca decide quem passa no filtro (isso é sempre
// evaluateAttributeFilter acima). Normalizado usando o min/max REAL do
// Attribute (nunca assume 0–100) — ver seção 12/5 da tarefa.
export function computeAttributeAdherence(rawValue, filter, attribute) {
  if (rawValue == null || typeof rawValue !== "number") return null;
  const attrMin = typeof attribute?.min === "number" ? attribute.min : 0;
  const attrMax = typeof attribute?.max === "number" ? attribute.max : 100;
  if (filter.operator === "gte") {
    const range = attrMax - filter.value;
    if (range <= 0) return rawValue >= filter.value ? 1 : 0;
    return clamp01((rawValue - filter.value) / range);
  }
  if (filter.operator === "lte") {
    const range = filter.value - attrMin;
    if (range <= 0) return rawValue <= filter.value ? 1 : 0;
    return clamp01((filter.value - rawValue) / range);
  }
  if (filter.operator === "between") {
    const center = (filter.min + filter.max) / 2;
    const halfWidth = (attrMax - attrMin) / 2;
    if (halfWidth <= 0) return rawValue === filter.min ? 1 : 0;
    return clamp01(1 - Math.abs(rawValue - center) / halfWidth);
  }
  return null;
}

// Combina TODOS os critérios de atributo com AND (ver seção 1 da tarefa) —
// `attributesById` é um Map/objeto `{ [attributeId]: Attribute }`.
export function evaluatePersonaAttributeFilters(persona, attributesById, attributeFilters) {
  const filters = Array.isArray(attributeFilters) ? attributeFilters : [];
  if (filters.length === 0) return { pass: true, matches: [], adherenceScore: null };
  const matches = filters.map((f) => evaluateAttributeFilter(persona, attributesById[f.attributeId], f));
  const pass = matches.every((m) => m.pass);
  const scores = filters.map((f) => computeAttributeAdherence(
    persona?.attributeValues ? persona.attributeValues[f.attributeId] : undefined,
    f,
    attributesById[f.attributeId]
  ));
  const validScores = scores.filter((s) => typeof s === "number");
  const adherenceScore = validScores.length ? validScores.reduce((a, b) => a + b, 0) / validScores.length : null;
  return { pass, matches, adherenceScore };
}

function sortResults(results, sortBy) {
  const byCode = (a, b) => (a.persona.code || "").localeCompare(b.persona.code || "");
  const list = [...results];
  if (sortBy === "name") {
    list.sort((a, b) => (a.persona.name || "").localeCompare(b.persona.name || "") || byCode(a, b));
  } else if (sortBy === "selected") {
    list.sort((a, b) => (Number(b.selected) - Number(a.selected)) || byCode(a, b));
  } else if (sortBy === "adherence") {
    list.sort((a, b) => {
      const sa = a.adherenceScore ?? -1;
      const sb = b.adherenceScore ?? -1;
      return sb - sa || byCode(a, b);
    });
  } else {
    list.sort(byCode);
  }
  return list;
}

// Ponto único de entrada — NUNCA muta `personas`/`attributes`/`filters`/
// `selectedIds` (ver critério O da suíte de testes: filtrar não altera
// seleção). Retorna só as Personas que passam em TODOS os filtros ativos,
// já ordenadas conforme `filters.sortBy`.
export function filterPersonas({ personas, attributes, filters, selectedIds }) {
  const f = { ...blankMemberFilters(), ...(filters || {}) };
  const selectedSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const attributesById = {};
  (attributes || []).forEach((a) => { attributesById[a.id] = a; });

  const results = [];
  for (const persona of personas || []) {
    if (!matchesSearch(persona, f.search)) continue;
    if (!matchesTags(persona, f.tags, f.tagMode)) continue;
    if (!matchesMembership(persona, f.membership, selectedSet)) continue;
    const { pass, matches, adherenceScore } = evaluatePersonaAttributeFilters(persona, attributesById, f.attributeFilters);
    if (!pass) continue;
    results.push({ persona, matches, adherenceScore, selected: selectedSet.has(persona.id) });
  }
  return sortResults(results, f.sortBy);
}

// Atalhos rápidos (ver seção 13 da tarefa) — NUNCA hardcoda IDs de
// atributo: resolve sempre por slug/nome a partir do catálogo atual
// (`S.state.attributes`, injetado pelo chamador). Atributo ausente no
// catálogo (ex.: renomeado/excluído) faz o preset ser omitido, nunca falha.
const MEMBER_FILTER_PRESET_DEFS = Object.freeze([
  { label: "Alta necessidade de ação", attributeName: "Necessidade de ação", operator: "gte", value: 70 },
  { label: "Contemplativos", attributeName: "Tolerância a ritmo lento", operator: "gte", value: 70 },
  { label: "Orientados a personagens", attributeName: "Orientação a personagens", operator: "gte", value: 70 },
  { label: "Orientados a ideias", attributeName: "Orientação a ideias", operator: "gte", value: 70 },
  { label: "Críticos", attributeName: "Criticidade geral", operator: "gte", value: 70 },
]);

export function resolveMemberFilterPresets(attributes) {
  const bySlug = {};
  (attributes || []).forEach((a) => { bySlug[a.slug || slugify(a.name)] = a; });
  return MEMBER_FILTER_PRESET_DEFS
    .map((preset) => {
      const attribute = bySlug[slugify(preset.attributeName)];
      if (!attribute) return null;
      return { label: preset.label, attributeId: attribute.id, operator: preset.operator, value: preset.value };
    })
    .filter(Boolean);
}

export const OPERATOR_LABELS = Object.freeze({ gte: "≥", lte: "≤", between: "entre" });

// Texto curto e determinístico para o "feedback de match" (ver seção 11) —
// nunca via LLM, só formatação do resultado já calculado em
// evaluateAttributeFilter.
export function describeAttributeMatch(match) {
  const name = match.attribute ? match.attribute.name : "(atributo removido)";
  const value = match.rawValue == null ? "—" : match.rawValue;
  const symbol = match.pass ? "✓" : "✗";
  if (match.operator === "between") {
    return `${name} ${value} entre ${match.filter.min} e ${match.filter.max} ${symbol}`;
  }
  return `${name} ${value} ${OPERATOR_LABELS[match.operator] || match.operator} ${match.filter.value} ${symbol}`;
}
