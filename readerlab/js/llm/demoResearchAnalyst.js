// ============ ReaderLab — DemoResearchAnalystProvider (simulador local) ============
// Gera uma análise plausível e DETERMINÍSTICA a partir do próprio dataset
// (sem rede, sem key, sem backend) — mesmo papel do llm/demoProvider.js
// para ReadingRun, mas para o Research Analyst. Permite testar todo o
// fluxo (geração → validação → persistência → UI) sem um backend LLM
// configurado. NÃO é uma LLM: apenas espelha, em texto, números que já
// estão no dataset. Nunca use em produção.

export class DemoResearchAnalystProvider {
  constructor({ dataset }) {
    this.dataset = dataset;
  }

  async complete() {
    // Simula latência de rede para a UI mostrar o estado "Gerando…".
    await new Promise((r) => setTimeout(r, 700 + Math.random() * 500));

    const d = this.dataset;
    const metricsWithData = d.quantitativeMetrics.filter((m) => m.n > 0);
    const consensusMetric = metricsWithData.find((m) => m.divergenceClassification === "Consenso alto");
    const polarizedMetric = [...metricsWithData].sort((a, b) => (b.divergence ?? 0) - (a.divergence ?? 0))[0];
    const topReaction = [...d.reactionAggregates].sort((a, b) => b.readerCount - a.readerCount)[0];
    const comparison = d.segmentComparisons[0];

    const json = {
      executiveSummary: `Análise de demonstração (modo offline, sem chamada real a um modelo de linguagem) gerada a partir de ${d.populationRun.sampleSize} leitor(es) sintético(s), dos quais ${d.populationRun.completed} concluíram a leitura. Todos os números citados abaixo vêm diretamente do dataset determinístico do ReaderLab.`,
      consensus: consensusMetric ? [{
        title: `Consenso em "${consensusMetric.questionText}"`,
        observation: `A população apresentou baixa divergência nesta pergunta (média ${consensusMetric.mean}, N=${consensusMetric.n}).`,
        evidence: [{ type: "metric", reference: consensusMetric.questionText, value: `mean=${consensusMetric.mean}; divergence=${Math.round((consensusMetric.divergence ?? 0) * 100)}%` }],
      }] : [],
      polarization: polarizedMetric ? [{
        title: `Divergência em "${polarizedMetric.questionText}"`,
        observation: `Esta métrica apresentou o maior índice de divergência da execução (${Math.round((polarizedMetric.divergence ?? 0) * 100)}%, N=${polarizedMetric.n}).`,
        interpretation: "Modo demo: interpretação ilustrativa — não reflete a análise real de um modelo de linguagem.",
        evidence: [{ type: "metric", reference: polarizedMetric.questionText, value: `divergence=${Math.round((polarizedMetric.divergence ?? 0) * 100)}%` }],
      }] : [],
      outliers: [],
      segmentInsights: d.segments.map((s) => ({
        segment: s.name,
        observation: `Segmento com N=${s.n} leitor(es).`,
        interpretation: "Modo demo: interpretação ilustrativa.",
        evidence: [],
      })),
      reactionPatterns: topReaction ? [{
        reactionCode: topReaction.reactionCode,
        observation: `Reação mais frequente entre os leitores válidos: ${topReaction.reactionName} (${topReaction.percentage}% de ${topReaction.validReaderCount} leitor(es)).`,
        evidence: [{ type: "reaction", reference: topReaction.reactionCode, value: `${topReaction.percentage}%` }],
      }] : [],
      qualitativePatterns: [],
      interestingContradictions: [],
      investigationPoints: comparison ? [{
        title: `Diferença entre ${comparison.segmentA} e ${comparison.segmentB}`,
        hypothesis: "Modo demo: hipótese ilustrativa sobre a diferença entre os segmentos configurados.",
        whyInvestigate: `N(${comparison.segmentA})=${comparison.nA}; N(${comparison.segmentB})=${comparison.nB}.`,
        confidence: Math.min(comparison.nA, comparison.nB) < 3 ? "low" : "medium",
        evidence: [],
      }] : [],
      limitations: [
        "Esta é uma análise de demonstração (modo offline) — não representa a interpretação real de um modelo de linguagem.",
        "População sintética: os resultados não devem ser generalizados para leitores humanos.",
        d.populationRun.sampleSize < 5 ? `Tamanho de amostra pequeno (N=${d.populationRun.sampleSize}) — leia as conclusões com cautela.` : null,
      ].filter(Boolean),
    };

    return { content: JSON.stringify(json), model: "demo-analyst-v1" };
  }
}
