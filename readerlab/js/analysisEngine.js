// ============ ReaderLab — Motor de execução do Research Analyst ============
// Único lugar que chama a LLM para interpretar os resultados de uma
// PopulationRun já concluída. Mesmo padrão do engine.js (PENDING → RUNNING
// → COMPLETED/FAILED, nunca lança para o chamador, snapshot congelado ANTES
// de chamar a LLM) — mas aqui o "snapshot" é o ResearchAnalysisBrief (nunca
// o texto/manuscrito, nunca o PopulationAnalysisDataset completo), e não
// há laço sobre Personas: é uma única chamada de interpretação.
import * as S from "./store.js";
import * as D from "./domain.js";
import { getProvider, ProviderError, providerErrorMessage } from "./llm/provider.js";
import { classifyAnalystFinalFailure } from "./llm/errorTypes.js";
import { buildPopulationAnalysisDataset } from "./analytics/populationAnalysisDatasetBuilder.js";
import { buildResearchAnalysisBrief } from "./analytics/researchAnalysisBriefBuilder.js";
import { buildResearchAnalystPrompt } from "./llm/researchAnalystPromptBuilder.js";
import { validateResearchAnalysis, RESEARCH_ANALYST_EVIDENCE_SCHEMA_VERSION } from "./llm/researchAnalystValidate.js";
import { DemoResearchAnalystProvider } from "./llm/demoResearchAnalyst.js";
import { estimateTokensConservative } from "./llm/tokenEstimate.js";
import { buildModelPricingSnapshot, estimateCostForTokens, computeActualCost, sumTokenUsage } from "./llm/costEstimate.js";
import {
  ANALYST_MAX_PROMPT_CHARS,
  ANALYST_TARGET_PROMPT_CHARS,
  ANALYST_OUTLIERS_PER_SIDE,
  ANALYST_QUALITATIVE_SAMPLES_PER_QUESTION,
  ANALYST_QUALITATIVE_SAMPLE_MAX_CHARS,
  ANALYST_REACTION_SAMPLES_PER_CODE,
  ANALYST_REACTION_SAMPLE_MAX_CHARS,
  ANALYST_REASONING_EFFORT,
  ANALYST_MAX_COMPLETION_TOKENS,
  DEFAULT_EXPECTED_ANALYST_OUTPUT_TOKENS,
} from "./config.js";

// Pipeline de uma tentativa: LLM → parse JSON → schema → evidence semântica
// (ver researchAnalystValidate.js). NO MÁXIMO uma tentativa automática de
// correção (nunca um loop) — se a 2ª tentativa também falhar, a AnalysisRun
// vira FAILED (nunca é persistida como COMPLETED com evidence inválida).
const MAX_ATTEMPTS = 2;

// Gera uma NOVA AnalysisRun para a PopulationRun informada — nunca
// sobrescreve uma análise anterior, o histórico é sempre preservado.
// `segments`: lista opcional de { name, rules } vinda da aba Segmentos do
// hub (só os segmentos efetivamente configurados pelo usuário).
export async function runPopulationAnalysis(popRun, { mode, liveCfg, segments = [], modelId, modelPricing } = {}) {
  const isDemo = mode === "demo";
  // PopulationAnalysisDataset completo — NUNCA destruído/substituído, é a
  // fonte de verdade preservada no ReaderLab. O Research Analyst nunca vê
  // este objeto diretamente: ele só recebe o brief calculado a partir dele
  // (ver analytics/researchAnalysisBriefBuilder.js).
  const dataset = buildPopulationAnalysisDataset(popRun, { segments });
  const sourceDatasetChars = JSON.stringify(dataset).length;

  // Em vez de compactar agressivamente o dataset inteiro conforme a
  // população cresce, o brief seleciona agregados COMPLETOS + uma amostra
  // determinística de evidências individuais — o tamanho resultante
  // escala com número de perguntas/reactionCodes/segmentos, não com o
  // número de Personas (ver researchAnalysisBriefBuilder.js).
  const brief = buildResearchAnalysisBrief(dataset, {
    outliersPerSide: ANALYST_OUTLIERS_PER_SIDE,
    qualitativeSamplesPerQuestion: ANALYST_QUALITATIVE_SAMPLES_PER_QUESTION,
    qualitativeSampleMaxChars: ANALYST_QUALITATIVE_SAMPLE_MAX_CHARS,
    reactionSamplesPerCode: ANALYST_REACTION_SAMPLES_PER_CODE,
    reactionSampleMaxChars: ANALYST_REACTION_SAMPLE_MAX_CHARS,
  });
  const briefChars = JSON.stringify(brief).length;
  const { system, user, promptVersion } = buildResearchAnalystPrompt(brief);
  const compressionRatio = sourceDatasetChars ? Math.round((1 - briefChars / sourceDatasetChars) * 1000) / 1000 : null;
  // Alvo recomendado (nunca um limite rígido — ver config.js) só para
  // observabilidade; nunca bloqueia o envio nem falha a análise sozinho.
  const analysisBriefLargerThanTarget = user.length > ANALYST_TARGET_PROMPT_CHARS;

  const analysisRun = D.blankAnalysisRun();
  analysisRun.populationRunId = popRun.id;
  analysisRun.provider = isDemo ? "demo-local" : liveCfg.provider;
  analysisRun.model = isDemo ? "demo-analyst-v1" : "";
  analysisRun.promptVersion = promptVersion;
  // executionSnapshot guarda exatamente o brief enviado à LLM — nunca o
  // dataset completo de novo dentro da AnalysisRun (ver seção 14 da tarefa).
  analysisRun.executionSnapshot = brief;
  analysisRun.requestMetadata = {
    researchAnalysisBriefVersion: brief.researchAnalysisBriefVersion,
    sourceDatasetVersion: dataset.analysisDatasetVersion,
    populationRunId: popRun.id,
    personaCount: dataset.population.personas.length,
    completedRuns: dataset.populationRun.completed,
    failedRuns: dataset.populationRun.failed,
    quantitativeMetricCount: dataset.quantitativeMetrics.length,
    qualitativeQuestionCount: (dataset.qualitativeQuestions || []).length,
    segmentCount: dataset.segments.length,
    systemPromptChars: system.length,
    userPromptChars: user.length,
    promptChars: system.length + user.length,
    estimatedTokensApprox: estimateTokensConservative(user),
    analystMaxPromptChars: ANALYST_MAX_PROMPT_CHARS,
    analystTargetPromptChars: ANALYST_TARGET_PROMPT_CHARS,
    sourceDatasetChars,
    briefChars,
    compressionRatio,
    quantitativeOutlierCount: brief.quantitativeOutliers.reduce((sum, q) => sum + q.low.length + q.high.length, 0),
    qualitativeSamplesIncluded: brief.qualitativeEvidence.reduce((sum, q) => sum + q.samples.length, 0),
    reactionSamplesIncluded: brief.reactionEvidence.reduce((sum, r) => sum + r.samples.length, 0),
    analysisBriefLargerThanTarget,
    // Parâmetros efetivamente enviados ao provider real nesta execução —
    // fonte única de verdade: js/config.js (nunca hardcoded aqui nem
    // reaproveitados de LLM_READER_*, ver comentário em config.js).
    reasoningEffort: ANALYST_REASONING_EFFORT,
    maxCompletionTokens: ANALYST_MAX_COMPLETION_TOKENS,
    purpose: "analyst",
    // Seleção EXPLÍCITA de modelo para o Research Analyst — SEPARADA da
    // seleção de modelo das ReadingRuns da mesma PopulationRun (nunca a
    // mesma escolha/custo, ver seção 25 da tarefa "model catalog").
    ...(!isDemo && modelId && modelPricing
      ? {
          requestedModelId: modelId,
          modelPricingSnapshot: buildModelPricingSnapshot(modelPricing),
          estimatedCost: estimateCostForTokens({
            pricing: modelPricing,
            estimatedInputTokens: estimateTokensConservative(user),
            estimatedOutputTokens: DEFAULT_EXPECTED_ANALYST_OUTPUT_TOKENS,
          }),
        }
      : {}),
  };
  await S.saveAnalysisRun(analysisRun);

  // Orçamento estourado mesmo com o brief (cenário raro — muitas
  // perguntas/reactionCodes/segmentos configurados) — nunca chamar o
  // provider (nunca descobrir isto via 413); falha com um erro específico
  // e mensagem amigável (ver ui.js para exibição). NUNCA aumentar
  // ANALYST_MAX_PROMPT_CHARS, dividir em múltiplas chamadas ou resumir com
  // outra LLM como "solução" para este caso.
  if (user.length > ANALYST_MAX_PROMPT_CHARS) {
    analysisRun.status = "FAILED";
    analysisRun.completedAt = D.nowISO();
    analysisRun.errorMessage =
      "Os resultados desta população são grandes demais para análise em uma única chamada com a configuração atual. " +
      `Research brief muito grande: ${user.length} caracteres; limite ${ANALYST_MAX_PROMPT_CHARS}.`;
    await S.saveAnalysisRun(analysisRun);
    return { ok: false, analysisRun, error: new ProviderError("ANALYSIS_INPUT_TOO_LARGE", analysisRun.errorMessage) };
  }

  analysisRun.status = "RUNNING";
  analysisRun.startedAt = D.nowISO();
  await S.saveAnalysisRun(analysisRun);

  try {
    const provider = isDemo ? new DemoResearchAnalystProvider({ dataset: brief }) : getProvider(liveCfg);

    let userPrompt = user;
    let model;
    let attempt = 0;
    let value = null;
    let lastErrors = [];
    let lastFinishReason = null;
    // Usage de CADA tentativa cobrada pelo provider (sucesso ou falha) —
    // nunca sobrescrito por `usage = res.usage` (bug real: a 1ª tentativa
    // falhar na validação e a 2ª suceder perdia o custo da 1ª chamada, que
    // já tinha sido cobrada). Ver mesma lógica em engine.js/ReadingRun.
    const attemptUsage = [];

    while (attempt < MAX_ATTEMPTS && !value) {
      attempt++;
      // reasoning_effort/max_completion_tokens aplicados a TODAS as
      // tentativas do Analyst, inclusive o retry de correção após
      // INVALID_EVIDENCE — nunca aumentados automaticamente entre
      // tentativas (truncamento nunca é "corrigido" com mais tokens em loop).
      // purpose: "analyst" NUNCA muda para "reader" no retry — mantém o
      // Research Analyst sempre roteado para LLM_ANALYST_MODEL no servidor.
      let res;
      try {
        res = await provider.complete({
          systemPrompt: system,
          userPrompt,
          purpose: "analyst",
          ...(isDemo ? {} : { modelId, reasoningEffort: ANALYST_REASONING_EFFORT, maxCompletionTokens: ANALYST_MAX_COMPLETION_TOKENS }),
        });
      } catch (err) {
        // Uma falha do provider (ex.: empty_response) pode já ter sido
        // cobrada pelo upstream (ver ProviderError.usage, llm/provider.js) —
        // preserva esse custo em requestMetadata ANTES de propagar o erro,
        // já que este loop nunca tenta de novo uma falha de provider (só
        // JSON inválido/evidence reprovada, ver comentário no topo do arquivo).
        if (err?.usage) {
          attemptUsage.push({ attempt, ...err.usage });
          const totalUsage = sumTokenUsage(attemptUsage);
          analysisRun.requestMetadata = { ...analysisRun.requestMetadata, tokenUsage: totalUsage, attemptUsage };
          const actualCost = computeActualCost({ pricingSnapshot: analysisRun.requestMetadata.modelPricingSnapshot, usage: totalUsage });
          if (actualCost) analysisRun.requestMetadata = { ...analysisRun.requestMetadata, actualCost };
        }
        throw err;
      }
      model = res.model;
      if (res.usage) attemptUsage.push({ attempt, ...res.usage });
      lastFinishReason = res.finishReason ?? null;

      let parsed;
      try {
        parsed = JSON.parse(res.content);
      } catch (_) {
        lastErrors = ["O modelo retornou um JSON inválido."];
        if (attempt < MAX_ATTEMPTS) userPrompt = buildResearchAnalystPrompt(brief, { retryErrors: lastErrors }).user;
        continue;
      }

      // validateResearchAnalysis(analysis, brief): schema + evidence
      // semântica contra o ResearchAnalysisBrief — qualquer evidence
      // fabricada/incorreta reprova a tentativa inteira.
      const validation = validateResearchAnalysis(parsed, brief);
      if (validation.ok) {
        value = validation.value;
      } else {
        lastErrors = validation.errors;
        if (attempt < MAX_ATTEMPTS) userPrompt = buildResearchAnalystPrompt(brief, { retryErrors: lastErrors }).user;
      }
    }

    if (!isDemo && model) analysisRun.model = model;
    // tokenUsage/actualCost refletem o TOTAL acumulado de TODAS as
    // tentativas cobradas (attemptUsage), nunca só a última — ver comentário
    // acima sobre a mesma correção em engine.js/ReadingRun.
    if (attemptUsage.length) {
      const totalUsage = sumTokenUsage(attemptUsage);
      analysisRun.requestMetadata = { ...analysisRun.requestMetadata, tokenUsage: totalUsage, attemptUsage };
      const actualCost = computeActualCost({ pricingSnapshot: analysisRun.requestMetadata.modelPricingSnapshot, usage: totalUsage });
      if (actualCost) analysisRun.requestMetadata = { ...analysisRun.requestMetadata, actualCost };
    }
    analysisRun.requestMetadata = { ...analysisRun.requestMetadata, attempts: attempt, retried: attempt > 1, finishReason: lastFinishReason };

    if (!value) {
      // finish_reason === "length" na última tentativa indica que o modelo
      // foi cortado por max_completion_tokens antes de terminar o JSON —
      // classificado distintamente de uma resposta genuinamente
      // malformada/com evidence fabricada (ver errorTypes.js).
      const failure = classifyAnalystFinalFailure(lastFinishReason, lastErrors);
      throw new ProviderError(failure.code, failure.message, { errorType: failure.errorType });
    }

    analysisRun.analysisJson = value;
    analysisRun.analysisSchemaVersion = RESEARCH_ANALYST_EVIDENCE_SCHEMA_VERSION;
    analysisRun.status = "COMPLETED";
    analysisRun.completedAt = D.nowISO();
    await S.saveAnalysisRun(analysisRun);
    return { ok: true, analysisRun };
  } catch (err) {
    analysisRun.status = "FAILED";
    analysisRun.completedAt = D.nowISO();
    analysisRun.errorMessage = providerErrorMessage(err);
    await S.saveAnalysisRun(analysisRun);
    return { ok: false, analysisRun, error: err };
  }
}

