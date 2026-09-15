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
import { runWithRetry } from "./llm/retry.js";
import { kimiRateLimitManager } from "./llm/rateLimitManager.js";
import { LLM_READER_REASONING_EFFORT, LLM_READER_MAX_COMPLETION_TOKENS } from "./config.js";
import { LLM_ERROR_TYPES, sanitizeErrorMessage } from "./llm/errorTypes.js";

// Executa uma ReadingRun até seu status final (COMPLETED|FAILED) — ou a
// deixa estacionada em WAITING_RETRY aguardando `run.nextRetryAt` (ver
// abaixo). Nunca lança para o chamador: falhas do provider/validação viram
// run.status = "FAILED" + run.errorMessage — quem chama decide o que fazer
// a seguir (ex.: continuar as próximas personas de uma PopulationRun mesmo
// que esta tenha falhado).
//
// RETOMADA: se `run.status` já for "WAITING_RETRY" ao entrar aqui (ex.: a
// aba foi recarregada enquanto esperava, e o chamador — runPopulationLoop —
// passou de novo esta mesma run), NÃO reinicia: aproveita attemptCount/
// nextRetryAt já persistidos, espera só o tempo restante (ou nada, se
// nextRetryAt já passou) e continua a contagem de tentativas de onde parou.
// Isso é o que torna o retry independente da memória da aba (critério de
// aceite) — a fonte de verdade é sempre o que está salvo na ReadingRun, não
// o estado de uma Promise em memória.
//
// `attributes`/`reactions` são OPCIONAIS: quando fornecidos (execução
// disparada por uma PopulationRun), esta ReadingRun NUNCA consulta
// S.state.attributes/S.state.reactions — usa exclusivamente o que o
// chamador já congelou (ver runPopulationLoop, abaixo). Só cai para o
// catálogo/reações ATUAIS quando ausentes, o que só acontece na execução
// avulsa de uma única ReadingRun (ui.js/viewNewRun), que sempre deve
// refletir o cadastro vigente.
//
// `isCancelled()` (opcional): checado enquanto aguarda um retry — se true,
// interrompe a espera sem marcar a run como FAILED (ver runPopulationLoop:
// usado para que uma PopulationRun cancelada nunca inicie uma nova
// tentativa de uma ReadingRun que estava em WAITING_RETRY).
export async function executeReadingRun(run, { persona, survey, attributes, reactions, mode, liveCfg, isCancelled = () => false }) {
  const isResume = run.status === "WAITING_RETRY";
  if (!isResume) {
    run.status = "RUNNING";
    run.startedAt = run.startedAt || D.nowISO();
    await S.saveRun(run);
  }

  const isDemo = mode === "demo";
  const attributeCatalog = attributes || S.state.attributes;
  const activeReactions = reactions || S.state.reactions.filter((r) => r.status === "ativa");
  try {
    const { system, user } = buildReadingPrompt({
      persona, attributes: attributeCatalog, reactions: activeReactions, survey, text: run.inputText,
    });
    // Snapshot criado ANTES de chamar a LLM: congela persona/atributos/survey/reações
    // usados nesta execução, imunes a edições futuras dessas entidades.
    run.executionSnapshot = D.buildExecutionSnapshot({
      persona, attributes: attributeCatalog, survey, reactions: activeReactions,
      provider: run.provider, model: run.model, promptVersion: run.promptVersion,
    });
    run.requestMetadata = {
      promptChars: system.length + user.length,
      reactionCount: activeReactions.length,
      questionCount: survey.questions.length,
      snapshotVersion: 1,
      // Parâmetros efetivamente enviados ao provider real nesta execução —
      // ausente em demo (não bate em API nenhuma). Fonte única de verdade:
      // js/config.js (nunca hardcoded aqui, ver LLM_READER_*).
      ...(isDemo ? {} : { readerLLMParams: { reasoningEffort: LLM_READER_REASONING_EFFORT, maxCompletionTokens: LLM_READER_MAX_COMPLETION_TOKENS } }),
    };
    const provider = isDemo
      ? new DemoProvider({ persona, attributes: attributeCatalog, reactions: activeReactions, survey })
      : getProvider(liveCfg);
    // Provider demo/local nunca bate em API nenhuma — só chamadas REAIS
    // passam pelo coordenador central de rate limit (nunca duplicar isto
    // por ReadingRun: é o mesmo coordenador para toda a aba, ver
    // llm/rateLimitManager.js). reasoning_effort/max_completion_tokens só são
    // enviados aqui (ReadingRun) — nunca viram default dentro do provider em
    // si, para não vazar para outros chamadores (ex.: Research Analyst).
    const callProvider = () => provider.complete({
      systemPrompt: system,
      userPrompt: user,
      ...(isDemo ? {} : { reasoningEffort: LLM_READER_REASONING_EFFORT, maxCompletionTokens: LLM_READER_MAX_COMPLETION_TOKENS }),
    });
    const guardedCall = isDemo ? callProvider : () => kimiRateLimitManager.run(callProvider, { isCancelled });

    // Retry automático só para falhas TRANSITÓRIAS do provider (rate limit,
    // sobrecarga, rede, timeout, erro de servidor — ver llm/errorTypes.js).
    // Erros permanentes (auth, cota, request inválido) propagam já na 1ª
    // tentativa. A cada falha transitória, a run vai para WAITING_RETRY com
    // um next_retry_at persistido (nunca um setTimeout como única fonte de
    // verdade) — nunca vira FAILED só por causa de um 429/503 isolado
    // (critério de aceite desta funcionalidade).
    const { content, model, usage } = await runWithRetry(
      guardedCall,
      {
        startAttempt: (run.attemptCount || 0) + 1,
        initialWaitUntil: isResume && run.nextRetryAt ? new Date(run.nextRetryAt).getTime() : null,
        isCancelled,
        classify: (err) => ({ errorType: err?.errorType || LLM_ERROR_TYPES.UNKNOWN, retryAfterMs: err?.retryAfterMs || 0 }),
        beforeAttempt: async () => {
          if (run.status !== "RUNNING") {
            run.status = "RUNNING";
            run.nextRetryAt = null;
            await S.saveRun(run);
          }
        },
        onWaitingRetry: async ({ attempt, errorType, nextRetryAt }) => {
          run.status = "WAITING_RETRY";
          run.attemptCount = attempt;
          run.lastErrorType = errorType;
          run.nextRetryAt = new Date(nextRetryAt).toISOString();
          run.lastAttemptAt = D.nowISO();
          await S.saveRun(run);
          console.warn(`[ReadingRun ${run.id}] aguardando retry após tentativa ${attempt} (${errorType}) — próxima tentativa às ${run.nextRetryAt}.`);
        },
        onAttempt: async ({ attempt, ok, errorType, retryable, error }) => {
          run.attemptCount = attempt;
          run.lastAttemptAt = D.nowISO();
          run.lastErrorType = ok ? null : errorType;
          run.lastErrorMessage = ok ? "" : sanitizeErrorMessage(providerErrorMessage(error));
          await S.saveRun(run);
          if (!ok) {
            // Log distingue falha definitiva de falha transitória — nunca
            // imprime o manuscrito/prompt, só id/tipo/tentativa.
            console.warn(
              `[ReadingRun ${run.id}] tentativa ${attempt} falhou (${errorType}) — ` +
              (retryable ? "transitória, será repetida." : "falha definitiva, sem retry.")
            );
          }
        },
      }
    );
    run.rawResponse = content;
    if (!isDemo && model) {
      run.model = model;
      run.executionSnapshot.llmConfig.model = model;
    }
    // usage vem do provider real (prompt_tokens/completion_tokens/total_tokens,
    // ou nomenclatura equivalente do backend) — nunca disponível em demo.
    // Persistido para observabilidade/otimização futura (ver requestMetadata).
    if (usage) run.requestMetadata = { ...run.requestMetadata, tokenUsage: usage };

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      throw new ProviderError("INVALID_JSON", "O modelo retornou um JSON inválido.", { errorType: LLM_ERROR_TYPES.INVALID_RESPONSE });
    }
    const validation = validateLLMResponse(parsed, { reactions: activeReactions, survey });
    if (!validation.ok) {
      throw new ProviderError("INVALID_SCHEMA", "Resposta fora do schema: " + validation.errors.join(" | "), { errorType: LLM_ERROR_TYPES.INVALID_RESPONSE });
    }

    run.status = "COMPLETED";
    run.completedAt = D.nowISO();
    await S.saveRun(run);
    await S.saveResult({ ...D.blankResult(run.id), ...validation.value });
    return { ok: true, run };
  } catch (err) {
    if (err?.cancelled) {
      // PopulationRun cancelada enquanto esta ReadingRun aguardava um retry
      // — não é uma falha: a run permanece exatamente como estava persistida
      // (WAITING_RETRY, attemptCount/nextRetryAt intactos), só não tenta de
      // novo (ver isCancelled acima e cancelPopulationRun).
      console.warn(`[ReadingRun ${run.id}] retry interrompido: execução cancelada.`);
      return { ok: false, run, error: err };
    }
    run.status = "FAILED";
    run.completedAt = D.nowISO();
    run.nextRetryAt = null;
    run.lastErrorType = err?.errorType || run.lastErrorType || LLM_ERROR_TYPES.UNKNOWN;
    run.lastErrorMessage = sanitizeErrorMessage(providerErrorMessage(err));
    run.lastAttemptAt = D.nowISO();
    if (!run.attemptCount) run.attemptCount = 1;
    run.errorMessage = providerErrorMessage(err) + (run.attemptCount > 1 ? ` (após ${run.attemptCount} tentativa(s))` : "");
    await S.saveRun(run);
    console.error(`[ReadingRun ${run.id}] falha definitiva (${run.lastErrorType}) após ${run.attemptCount} tentativa(s).`);
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
//
// Reprodutibilidade histórica: survey/reações/atributos usados por TODAS
// as ReadingRuns filhas vêm exclusivamente de popRun.executionSnapshot —
// nunca de S.state.surveys/reactions/attributes. Isso vale tanto no
// disparo inicial quanto numa retomada (após recarregar a página), mesmo
// que a Survey/ReactionDefinitions/AttributeDefinitions originais tenham
// sido editadas, desativadas ou excluídas nesse meio-tempo. A única
// exceção é PopulationRuns antigas (snapshotVersion < 2), que não têm
// attributeDefinitions congeladas — ver resolvePopulationSnapshotAttributes().
async function runPopulationLoop(popRun, { mode, liveCfg, onProgress }) {
  const snapshot = popRun.executionSnapshot;
  const snapshotPersonas = snapshot.personas;
  const survey = snapshot.survey;
  const reactions = snapshot.reactions;
  const total = snapshotPersonas.length;

  const { attributes, legacyFallback } = D.resolvePopulationSnapshotAttributes(popRun, S.state.attributes);
  if (legacyFallback && !popRun.legacyAttributeFallback) {
    // Metadata explícita: esta PopulationRun é anterior à snapshotVersion 2
    // e precisou cair para o catálogo atual de atributos — nunca inventamos
    // um snapshot que não existia.
    popRun.legacyAttributeFallback = true;
    await S.savePopulationRun(popRun);
  }

  for (const persona of snapshotPersonas) {
    const live = S.state.populationRuns.find((p) => p.id === popRun.id) || popRun;
    if (live.status === "CANCELLED") break;

    const existing = S.getReadingRunsForPopulationRun(popRun.id).find((r) => r.personaId === persona.id);
    if (existing && (existing.status === "COMPLETED" || existing.status === "FAILED")) continue;
    // existing.status === "WAITING_RETRY" cai adiante de propósito: é assim
    // que uma retomada (executePopulationRun/resumePopulationRun após um
    // refresh) volta a esperar/tentar essa mesma ReadingRun em vez de criar
    // uma nova (ver executeReadingRun, que detecta isso e não reinicia
    // attemptCount).

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
    const isCancelled = () => (S.state.populationRuns.find((p) => p.id === popRun.id) || popRun).status === "CANCELLED";
    const { ok } = await executeReadingRun(run, { persona, survey, attributes, reactions, mode, liveCfg, isCancelled });
    onProgress?.({ phase: "done", persona, run, ok, total });

    // O modelo efetivamente usado só é conhecido após a 1ª resposta real do
    // provider (ver executeReadingRun) — propaga para a PopulationRun assim
    // que descoberto, para nunca deixar popRun.model vazio numa execução
    // real (modo demo já vem preenchido desde a criação).
    if (!popRun.model && run.model) {
      popRun.model = run.model;
      if (popRun.executionSnapshot?.llmConfig) popRun.executionSnapshot.llmConfig.model = run.model;
      await S.savePopulationRun(popRun);
    }
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
// Personas + AttributeDefinitions + Survey + Reações + config no momento
// do disparo) e então executa, SEQUENCIALMENTE (uma de cada vez, sem
// paralelismo nesta primeira versão), uma ReadingRun independente por
// Persona — mesmo texto, mesma Survey, mesma config de modelo. Personas
// não compartilham resposta/memória/contexto entre si. Falha de uma
// Persona não cancela as demais (falha parcial vira PARTIAL). Nunca
// reimplementa o motor de ReadingRun — cada leitura passa por
// executeReadingRun(). Este é o ÚNICO ponto em que a orquestração ainda lê
// S.state.* diretamente — é exatamente o instante em que a configuração é
// congelada; depois disso, runPopulationLoop() nunca mais toca em S.state
// para montar uma execução (só para checar cancelamento/progresso).
export async function executePopulationRun(popRun, { population, personas, survey, mode, liveCfg, onProgress }) {
  if (inFlight.has(popRun.id)) return popRun;
  inFlight.add(popRun.id);
  try {
    popRun.status = "RUNNING";
    popRun.startedAt = D.nowISO();
    const activeReactions = S.state.reactions.filter((r) => r.status === "ativa");
    popRun.executionSnapshot = D.buildPopulationExecutionSnapshot({
      population, personas, survey, reactions: activeReactions, attributes: S.state.attributes,
      provider: popRun.provider, model: popRun.model, promptVersion: popRun.promptVersion,
    });
    await S.savePopulationRun(popRun);
    return await runPopulationLoop(popRun, { mode, liveCfg, onProgress });
  } finally {
    inFlight.delete(popRun.id);
  }
}

// Retoma uma PopulationRun que ficou presa em RUNNING nesta conta (ex.: a
// aba foi recarregada no meio da execução) — reaproveita o snapshot já
// gravado e continua apenas as Personas ainda sem ReadingRun terminada.
// NUNCA busca novamente Survey/ReactionDefinitions/AttributeDefinitions
// atuais — runPopulationLoop() já resolve tudo a partir do snapshot
// congelado. Não faz nada se já houver um loop ativo para este id nesta
// aba, ou se a PopulationRun não estiver mais em RUNNING.
export async function resumePopulationRun(popRunId, { onProgress } = {}) {
  if (inFlight.has(popRunId)) return null;
  const popRun = S.state.populationRuns.find((p) => p.id === popRunId);
  if (!popRun || popRun.status !== "RUNNING" || !popRun.executionSnapshot) return null;
  inFlight.add(popRunId);
  try {
    const mode = popRun.provider === "demo-local" ? "demo" : "llm";
    const liveCfg = mode === "llm" ? getLLMConfig() : null;
    return await runPopulationLoop(popRun, { mode, liveCfg, onProgress });
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
