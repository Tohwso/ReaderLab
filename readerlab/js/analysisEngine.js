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
import { validateResearchAnalysis } from "./llm/researchAnalystValidate.js";
import { DemoResearchAnalystProvider } from "./llm/demoResearchAnalyst.js";

// Gera uma NOVA AnalysisRun para a PopulationRun informada — nunca
// sobrescreve uma análise anterior, o histórico é sempre preservado.
// `segments`: lista opcional de { name, rules } vinda da aba Segmentos do
// hub (só os segmentos efetivamente configurados pelo usuário).
export async function runPopulationAnalysis(popRun, { mode, liveCfg, segments = [] } = {}) {
  const isDemo = mode === "demo";
  const dataset = buildPopulationAnalysisDataset(popRun, { segments });
  const { system, user, promptVersion } = buildResearchAnalystPrompt(dataset);

  const analysisRun = D.blankAnalysisRun();
  analysisRun.populationRunId = popRun.id;
  analysisRun.provider = isDemo ? "demo-local" : liveCfg.provider;
  analysisRun.model = isDemo ? "demo-analyst-v1" : "";
  analysisRun.promptVersion = promptVersion;
  analysisRun.executionSnapshot = dataset;
  analysisRun.requestMetadata = {
    datasetVersion: dataset.analysisDatasetVersion,
    populationRunId: popRun.id,
    personaCount: dataset.population.personas.length,
    completedRuns: dataset.populationRun.completed,
    failedRuns: dataset.populationRun.failed,
    quantitativeMetricCount: dataset.quantitativeMetrics.length,
    qualitativeQuestionCount: dataset.qualitativeAnswers.length,
    segmentCount: dataset.segments.length,
    truncatedFieldCount: dataset.truncatedFields.length,
    promptChars: system.length + user.length,
  };
  await S.saveAnalysisRun(analysisRun);

  analysisRun.status = "RUNNING";
  analysisRun.startedAt = D.nowISO();
  await S.saveAnalysisRun(analysisRun);

  try {
    const provider = isDemo ? new DemoResearchAnalystProvider({ dataset }) : getProvider(liveCfg);
    const { content, model, usage } = await provider.complete({ systemPrompt: system, userPrompt: user });
    if (!isDemo && model) analysisRun.model = model;
    if (usage) analysisRun.requestMetadata = { ...analysisRun.requestMetadata, tokenUsage: usage };

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      throw new ProviderError("INVALID_JSON", "O modelo retornou um JSON inválido.");
    }
    const validation = validateResearchAnalysis(parsed);
    if (!validation.ok) {
      throw new ProviderError("INVALID_SCHEMA", "Resposta fora do schema: " + validation.errors.slice(0, 5).join(" | "));
    }

    analysisRun.analysisJson = validation.value;
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
