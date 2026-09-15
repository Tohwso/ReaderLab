// ============ ReaderLab — Motor de execução (ReadingRun / PopulationRun) ============
// Único lugar que efetivamente conversa com o provider (demo local ou LLM
// real via proxy) para levar uma ReadingRun do estado PENDING até um status
// final. Usado tanto pela execução individual (ui.js/viewNewRun) quanto
// pela orquestração sequencial de uma PopulationRun — a segunda NUNCA
// reimplementa o motor: apenas dispara N ReadingRuns através dele.
import * as S from "./store.js";
import * as D from "./domain.js";
import { getProvider, ProviderError, providerErrorMessage } from "./llm/provider.js";
import { buildReadingPrompt } from "./llm/promptBuilder.js";
import { validateLLMResponse } from "./llm/validate.js";
import { DemoProvider } from "./llm/demoProvider.js";

// Executa uma ReadingRun já criada (persistida em PENDING) até seu status
// final (COMPLETED|FAILED). Nunca lança para o chamador: falhas do
// provider/validação viram run.status = "FAILED" + run.errorMessage — quem
// chama decide o que fazer a seguir (ex.: continuar as próximas personas de
// uma PopulationRun mesmo que esta tenha falhado).
export async function executeReadingRun(run, { persona, survey, mode, liveCfg }) {
  run.status = "RUNNING";
  run.startedAt = D.nowISO();
  await S.saveRun(run);

  const isDemo = mode === "demo";
  try {
    const activeReactions = S.state.reactions.filter((r) => r.status === "ativa");
    const { system, user } = buildReadingPrompt({
      persona, attributes: S.state.attributes, reactions: activeReactions, survey, text: run.inputText,
    });
    // Snapshot criado ANTES de chamar a LLM: congela persona/atributos/survey/reações
    // usados nesta execução, imunes a edições futuras dessas entidades.
    run.executionSnapshot = D.buildExecutionSnapshot({
      persona, attributes: S.state.attributes, survey, reactions: activeReactions,
      provider: run.provider, model: run.model, promptVersion: run.promptVersion,
    });
    run.requestMetadata = {
      promptChars: system.length + user.length,
      reactionCount: activeReactions.length,
      questionCount: survey.questions.length,
      snapshotVersion: 1,
    };
    const provider = isDemo
      ? new DemoProvider({ persona, attributes: S.state.attributes, reactions: activeReactions, survey })
      : getProvider(liveCfg);
    const { content, model } = await provider.complete({ systemPrompt: system, userPrompt: user });
    run.rawResponse = content;
    if (!isDemo && model) {
      run.model = model;
      run.executionSnapshot.llmConfig.model = model;
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      throw new ProviderError("INVALID_JSON", "O modelo retornou um JSON inválido.");
    }
    const validation = validateLLMResponse(parsed, { reactions: activeReactions, survey });
    if (!validation.ok) {
      throw new ProviderError("INVALID_SCHEMA", "Resposta fora do schema: " + validation.errors.join(" | "));
    }

    run.status = "COMPLETED";
    run.completedAt = D.nowISO();
    await S.saveRun(run);
    await S.saveResult({ ...D.blankResult(run.id), ...validation.value });
    return { ok: true, run };
  } catch (err) {
    run.status = "FAILED";
    run.completedAt = D.nowISO();
    run.errorMessage = providerErrorMessage(err);
    await S.saveRun(run);
    return { ok: false, run, error: err };
  }
}

// Orquestra uma PopulationRun: cria e executa, SEQUENCIALMENTE (uma de
// cada vez, sem paralelismo nesta primeira versão), uma ReadingRun
// independente por Persona — mesmo texto, mesma Survey, mesma config de
// modelo. Personas não compartilham resposta/memória/contexto entre si.
// Falha de uma Persona não cancela as demais (falha parcial vira PARTIAL).
export async function executePopulationRun(popRun, { population, personas, survey, mode, liveCfg, onProgress }) {
  popRun.status = "RUNNING";
  popRun.startedAt = D.nowISO();
  const activeReactions = S.state.reactions.filter((r) => r.status === "ativa");
  popRun.executionSnapshot = D.buildPopulationExecutionSnapshot({
    population, personas, survey, reactions: activeReactions,
    provider: popRun.provider, model: popRun.model, promptVersion: popRun.promptVersion,
  });
  await S.savePopulationRun(popRun);

  let completed = 0, failed = 0;
  for (const persona of personas) {
    const run = D.blankRun();
    run.populationRunId = popRun.id;
    run.title = popRun.title ? `${popRun.title} — ${persona.name}` : `População — ${persona.name}`;
    run.personaId = persona.id;
    run.surveyId = survey.id;
    run.inputText = popRun.inputText;
    const isDemo = mode === "demo";
    run.provider = isDemo ? "demo-local" : liveCfg.provider;
    run.model = isDemo ? "simulador-v1" : "";
    run.promptVersion = liveCfg.promptVersion;
    await S.saveRun(run);
    onProgress?.({ phase: "start", persona, run, completed, failed, total: personas.length });

    const { ok } = await executeReadingRun(run, { persona, survey, mode, liveCfg });
    if (ok) completed++; else failed++;
    onProgress?.({ phase: "done", persona, run, ok, completed, failed, total: personas.length });
  }

  popRun.completedAt = D.nowISO();
  popRun.status = failed === 0 ? "COMPLETED" : completed === 0 ? "FAILED" : "PARTIAL";
  if (failed > 0) popRun.errorMessage = `${failed} de ${personas.length} leitura(s) falharam.`;
  await S.savePopulationRun(popRun);
  return popRun;
}
