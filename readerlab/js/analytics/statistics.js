// ============ ReaderLab — Estatísticas descritivas (funções puras) ============
// Sem dependências externas — nativo é suficiente para as necessidades atuais.
// Usadas para descrever a dispersão das respostas quantitativas de uma
// PopulationRun (aba Heatmap). Nenhuma função aqui lê o DOM ou o store.

export function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Desvio padrão POPULACIONAL (divide por N, não por N-1): decisão deliberada.
// Estamos descrevendo a população sintética efetivamente executada nesta
// PopulationRun — não inferindo, a partir de uma amostra, uma população
// externa maior. Se essa premissa mudar no futuro, revisar aqui.
export function standardDeviation(values) {
  if (!values.length) return null;
  if (values.length === 1) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// Índice de Divergência = desvio padrão / amplitude da escala da pergunta
// (question.max - question.min), como fração 0–1 (multiplicar por 100 para %).
// Ex.: desvio 18 numa escala 0–100 → divergência 0.18 (18%).
// Exemplos verificáveis (projeto não possui runner de testes):
//   normalizedDivergence(standardDeviation([20,20,80,80]), 0, 100) === 0.3   // 30%
//   normalizedDivergence(standardDeviation([48,49,51,52]), 0, 100) ≈ 0.0158  // ~1.6%
export function normalizedDivergence(stdDev, min, max) {
  if (stdDev == null) return null;
  const range = max - min;
  if (!range) return null; // escala degenerada (max === min): divergência indefinida
  return Math.max(0, Math.min(1, stdDev / range));
}

// Faixas heurísticas internas do ReaderLab (não são afirmações estatísticas
// científicas) — apenas uma classificação visual de apoio à leitura do índice.
export function classifyDivergence(divergence) {
  if (divergence == null) return null;
  const pct = divergence * 100;
  if (pct <= 10) return { label: "Consenso alto", cls: "ok" };
  if (pct <= 20) return { label: "Consenso moderado", cls: "accent" };
  if (pct <= 30) return { label: "Polarização moderada", cls: "warn" };
  return { label: "Polarização alta", cls: "bad" };
}

// Resumo completo de uma pergunta quantitativa a partir das respostas
// válidas (ignora null/undefined/NaN — nunca trata ausência como zero).
export function describeQuestionValues(values, { min, max }) {
  const valid = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  const n = valid.length;
  if (!n) return { n: 0, mean: null, median: null, min: null, max: null, standardDeviation: null, divergence: null, classification: null };
  const stdDev = standardDeviation(valid);
  const divergence = normalizedDivergence(stdDev, min, max);
  return {
    n,
    mean: mean(valid),
    median: median(valid),
    min: Math.min(...valid),
    max: Math.max(...valid),
    standardDeviation: stdDev,
    divergence,
    classification: classifyDivergence(divergence),
  };
}
