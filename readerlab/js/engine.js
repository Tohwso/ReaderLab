// ============ ReaderLab — Motor de execução (ReadingRun / PopulationRun) ============
// Único lugar que efetivamente conversa com o provider (demo local ou LLM
// real via proxy) para levar uma ReadingRun do estado PENDING até um status
// final. Usado tanto pela execução individual (ui.js/viewNewRun) quanto
// pela orquestração sequencial de uma PopulationRun — a segunda NUNCA
// reimplementa o motor: apenas dispara N ReadingRuns através dele.
import * as S from "./store.js";
import * as D from "./domain.js";
import { getProvider, getLLMConfig, ProviderError, providerErrorMessage } from "./llm/provider.js";
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

// IDs de PopulationRun com um loop ativo NESTA aba — evita disparar duas
// vezes a mesma orquestração (ex.: a tela de acompanhamento tentando
// "retomar" uma execução que a própria submissão do formulário já está
// rodando em background).
const inFlight = new Set();

// Núcleo do laço sequencial, compartilhado entre início e retomada: opera
// sempre sobre a lista de Personas congelada em popRun.executionSnapshot
// (nunca a Population ao vivo, que pode ter mudado). Pula Personas cuja
// ReadingRun já terminou (COMPLETED/FAILED) — é isso que permite retomar
// uma PopulationRun interrompida (ex.: recarregamento de página) sem
// duplicar leituras já concluídas. Reconsulta o status ao vivo a cada
// iteração para respeitar um cancelamento pedido no meio da execução.
async function runPopulationLoop(popRun, { survey, mode, liveCfg, onProgress }) {
  const snapshotPersonas = popRun.executionSnapshot.personas;
  const total = snapshotPersonas.length;

  for (const persona of snapshotPersonas) {
    const live = S.state.populationRuns.find((p) => p.id === popRun.id) || popRun;
    if (live.status === "CANCELLED") break;

    const existing = S.getReadingRunsForPopulationRun(popRun.id).find((r) => r.personaId === persona.id);
    if (existing && (existing.status === "COMPLETED" || existing.status === "FAILED")) continue;

    let run = existing;
    if (!run) {
      run = D.blankRun();
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
    }
    onProgress?.({ phase: "start", persona, run, total });
    const { ok } = await executeReadingRun(run, { persona, survey, mode, liveCfg });
    onProgress?.({ phase: "done", persona, run, ok, total });
  }

  const latest = S.state.populationRuns.find((p) => p.id === popRun.id) || popRun;
  if (latest.status !== "CANCELLED") {
    const finalRuns = S.getReadingRunsForPopulationRun(popRun.id);
    const completed = finalRuns.filter((r) => r.status === "COMPLETED").length;
    const failed = finalRuns.filter((r) => r.status === "FAILED").length;
    latest.completedAt = D.nowISO();
    latest.status = completed === total ? "COMPLETED" : completed === 0 ? "FAILED" : "PARTIAL";
    if (failed > 0) latest.errorMessage = `${failed} de ${total} leitura(s) falharam.`;
    await S.savePopulationRun(latest);
  }
  return latest;
}

// Orquestra uma PopulationRun nova: cria o snapshot congelado (Population +
// Personas + Survey + Reações + config no momento do disparo) e então
// executa, SEQUENCIALMENTE (uma de cada vez, sem paralelismo nesta
// primeira versão), uma ReadingRun independente por Persona — mesmo
// texto, mesma Survey, mesma config de modelo. Personas não compartilham
// resposta/memória/contexto entre si. Falha de uma Persona não cancela as
// demais (falha parcial vira PARTIAL). Nunca reimplementa o motor de
// ReadingRun — cada leitura passa por executeReadingRun().
export async function executePopulationRun(popRun, { population, personas, survey, mode, liveCfg, onProgress }) {
  if (inFlight.has(popRun.id)) return popRun;
  inFlight.add(popRun.id);
  try {
    popRun.status = "RUNNING";
    popRun.startedAt = D.nowISO();
    const activeReactions = S.state.reactions.filter((r) => r.status === "ativa");
    popRun.executionSnapshot = D.buildPopulationExecutionSnapshot({
      population, personas, survey, reactions: activeReactions,
      provider: popRun.provider, model: popRun.model, promptVersion: popRun.promptVersion,
    });
    await S.savePopulationRun(popRun);
    return await runPopulationLoop(popRun, { survey, mode, liveCfg, onProgress });
  } finally {
    inFlight.delete(popRun.id);
  }
}

// Retoma uma PopulationRun que ficou presa em RUNNING nesta conta (ex.: a
// aba foi recarregada no meio da execução) — reaproveita o snapshot já
// gravado e continua apenas as Personas ainda sem ReadingRun terminada.
// Não faz nada se já houver um loop ativo para este id nesta aba, ou se a
// PopulationRun não estiver mais em RUNNING.
export async function resumePopulationRun(popRunId, { onProgress } = {}) {
  if (inFlight.has(popRunId)) return null;
  const popRun = S.state.populationRuns.find((p) => p.id === popRunId);
  if (!popRun || popRun.status !== "RUNNING" || !popRun.executionSnapshot) return null;
  inFlight.add(popRunId);
  try {
    const survey = S.state.surveys.find((s) => s.id === popRun.surveyId) || popRun.executionSnapshot.survey;
    const mode = popRun.provider === "demo-local" ? "demo" : "llm";
    const liveCfg = mode === "llm" ? getLLMConfig() : null;
    return await runPopulationLoop(popRun, { survey, mode, liveCfg, onProgress });
  } finally {
    inFlight.delete(popRunId);
  }
}

// true enquanto houver um loop de execução desta PopulationRun rodando
// nesta aba — usado pela UI para decidir se ainda vale tentar retomar.
export function isPopulationRunActive(popRunId) {
  return inFlight.has(popRunId);
}

// Cancelamento cooperativo: impede que NOVAS ReadingRuns comecem (o loop
// confere o status a cada iteração e para antes da próxima Persona), mas
// não aborta uma chamada de LLM já em andamento nem apaga resultados já
// concluídos.
export async function cancelPopulationRun(popRunId) {
  const popRun = S.state.populationRuns.find((p) => p.id === popRunId);
  if (!popRun || popRun.status !== "RUNNING") return popRun || null;
  popRun.status = "CANCELLED";
  popRun.completedAt = D.nowISO();
  popRun.errorMessage = "Execução cancelada pelo usuário.";
  await S.savePopulationRun(popRun);
  return popRun;
}
