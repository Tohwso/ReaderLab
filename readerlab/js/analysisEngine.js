// ============ ReaderLab — Motor de execução do Research Analyst ============
// Único lugar que chama a LLM para interpretar os resultados de uma
// PopulationRun já concluída. Mesmo padrão do engine.js (PENDING → RUNNING
// → COMPLETED/FAILED, nunca lança para o chamador, snapshot congelado ANTES
// de chamar a LLM) — mas aqui o "snapshot" é o dataset analítico
// determinístico (nunca o texto/manuscrito), e não há laço sobre Personas:
// é uma única chamada de interpretação.
import * as S from "./store.js";
import * as D from "./domain.js";
import { getProvider, ProviderError, providerErrorMessage } from "./llm/provider.js";
import { buildPopulationAnalysisDataset } from "./analytics/populationAnalysisDatasetBuilder.js";
import { buildResearchAnalystPrompt } from "./llm/researchAnalystPromptBuilder.js";
import { validateResearchAnalysis, RESEARCH_ANALYST_EVIDENCE_SCHEMA_VERSION } from "./llm/researchAnalystValidate.js";
import { compactAnalysisDatasetForBudget, measureDatasetSectionChars } from "./llm/researchAnalystCompaction.js";
import { DemoResearchAnalystProvider } from "./llm/demoResearchAnalyst.js";
import { estimateTokensConservative } from "./llm/tokenEstimate.js";
import {
  ANALYST_MAX_PROMPT_CHARS,
  ANALYST_MAX_REACTION_REASONS_PER_CODE,
  ANALYST_MAX_QUALITATIVE_ANSWERS_PER_QUESTION,
  ANALYST_MAX_QUALITATIVE_ANSWER_CHARS,
  ANALYST_MAX_REACTION_REASON_CHARS,
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
export async function runPopulationAnalysis(popRun, { mode, liveCfg, segments = [] } = {}) {
  const isDemo = mode === "demo";
  const dataset = buildPopulationAnalysisDataset(popRun, { segments });
  const datasetOriginalChars = JSON.stringify(dataset).length;

  // Preflight determinístico: NUNCA chamar o provider com um prompt que o
  // próprio ReaderLab já sabe que a Edge Function vai rejeitar (413) —
  // mede o userPrompt EXATO que seria enviado (mesma função usada na
  // chamada real) e, se exceder o orçamento, aplica compactação
  // determinística (ver llm/researchAnalystCompaction.js) ANTES de decidir
  // se prossegue.
  const measureUserPromptChars = (ds) => buildResearchAnalystPrompt(ds).user.length;
  const preflight = compactAnalysisDatasetForBudget(
    dataset,
    {
      maxPromptChars: ANALYST_MAX_PROMPT_CHARS,
      maxReactionReasonsPerCode: ANALYST_MAX_REACTION_REASONS_PER_CODE,
      maxQualitativeAnswersPerQuestion: ANALYST_MAX_QUALITATIVE_ANSWERS_PER_QUESTION,
      maxQualitativeAnswerChars: ANALYST_MAX_QUALITATIVE_ANSWER_CHARS,
      maxReactionReasonChars: ANALYST_MAX_REACTION_REASON_CHARS,
    },
    measureUserPromptChars
  );
  // A partir daqui, `finalDataset` é a ÚNICA fonte de verdade: é o que vai
  // no prompt, no executionSnapshot e na validação de evidence — nunca
  // validar a resposta da LLM contra o dataset original se ele foi
  // compactado (evidence é verificada contra o que foi de fato enviado).
  const finalDataset = preflight.dataset;
  const { system, user, promptVersion } = buildResearchAnalystPrompt(finalDataset);
  const datasetFinalChars = JSON.stringify(finalDataset).length;
  // Breakdown de tamanho por seção (seção 10 da tarefa) — diagnóstico para
  // identificar futuras explosões de tamanho numa seção específica.
  const datasetSectionCharsBefore = measureDatasetSectionChars(dataset);
  const datasetSectionCharsAfter = measureDatasetSectionChars(finalDataset);

  const analysisRun = D.blankAnalysisRun();
  analysisRun.populationRunId = popRun.id;
  analysisRun.provider = isDemo ? "demo-local" : liveCfg.provider;
  analysisRun.model = isDemo ? "demo-analyst-v1" : "";
  analysisRun.promptVersion = promptVersion;
  analysisRun.executionSnapshot = finalDataset;
  analysisRun.requestMetadata = {
    datasetVersion: dataset.analysisDatasetVersion,
    populationRunId: popRun.id,
    personaCount: dataset.population.personas.length,
    completedRuns: dataset.populationRun.completed,
    failedRuns: dataset.populationRun.failed,
    quantitativeMetricCount: dataset.quantitativeMetrics.length,
    // v2 renomeia qualitativeAnswers -> qualitativeQuestions (ver builder);
    // fallback cobre só o caminho explícito de comparação com version:1.
    qualitativeQuestionCount: (dataset.qualitativeQuestions || dataset.qualitativeAnswers || []).length,
    segmentCount: dataset.segments.length,
    truncatedFieldCount: dataset.truncatedFields.length,
    systemPromptChars: system.length,
    userPromptChars: user.length,
    promptChars: system.length + user.length,
    estimatedTokensApprox: estimateTokensConservative(user),
    analystMaxPromptChars: ANALYST_MAX_PROMPT_CHARS,
    datasetOriginalChars,
    datasetFinalChars,
    datasetSectionCharsBefore,
    datasetSectionCharsAfter,
    compactionApplied: preflight.compactionApplied,
    compactionSteps: preflight.stepsApplied,
    ...preflight.stats,
  };
  await S.saveAnalysisRun(analysisRun);

  // Orçamento estourado mesmo após a compactação determinística completa —
  // nunca chamar o provider (nunca descobrir isto via 413); falha com um
  // erro específico e mensagem amigável (ver ui.js para exibição).
  if (!preflight.fits) {
    analysisRun.status = "FAILED";
    analysisRun.completedAt = D.nowISO();
    analysisRun.errorMessage =
      "Os resultados desta população são grandes demais para análise em uma única chamada com a configuração atual. " +
      `Dataset analítico muito grande: ${user.length} caracteres após compactação; limite ${ANALYST_MAX_PROMPT_CHARS}.`;
    await S.saveAnalysisRun(analysisRun);
    return { ok: false, analysisRun, error: new ProviderError("ANALYSIS_INPUT_TOO_LARGE", analysisRun.errorMessage) };
  }

  analysisRun.status = "RUNNING";
  analysisRun.startedAt = D.nowISO();
  await S.saveAnalysisRun(analysisRun);

  try {
    const provider = isDemo ? new DemoResearchAnalystProvider({ dataset: finalDataset }) : getProvider(liveCfg);

    let userPrompt = user;
    let model, usage;
    let attempt = 0;
    let value = null;
    let lastErrors = [];

    while (attempt < MAX_ATTEMPTS && !value) {
      attempt++;
      const res = await provider.complete({ systemPrompt: system, userPrompt });
      model = res.model;
      usage = res.usage;

      let parsed;
      try {
        parsed = JSON.parse(res.content);
      } catch (_) {
        lastErrors = ["O modelo retornou um JSON inválido."];
        if (attempt < MAX_ATTEMPTS) userPrompt = buildResearchAnalystPrompt(finalDataset, { retryErrors: lastErrors }).user;
        continue;
      }

      // validateResearchAnalysis(analysis, dataset): schema + evidence
      // semântica contra o dataset determinístico numa única chamada —
      // qualquer evidence fabricada/incorreta reprova a tentativa inteira.
      const validation = validateResearchAnalysis(parsed, finalDataset);
      if (validation.ok) {
        value = validation.value;
      } else {
        lastErrors = validation.errors;
        if (attempt < MAX_ATTEMPTS) userPrompt = buildResearchAnalystPrompt(finalDataset, { retryErrors: lastErrors }).user;
      }
    }

    if (!isDemo && model) analysisRun.model = model;
    if (usage) analysisRun.requestMetadata = { ...analysisRun.requestMetadata, tokenUsage: usage };
    analysisRun.requestMetadata = { ...analysisRun.requestMetadata, attempts: attempt, retried: attempt > 1 };

    if (!value) {
      throw new ProviderError("INVALID_EVIDENCE", "Resposta inválida após correção: " + lastErrors.slice(0, 5).join(" | "));
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
