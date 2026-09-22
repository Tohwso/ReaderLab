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
import { normalizeReadingResultResponse } from "./llm/readingResultNormalizer.js";
import { DemoProvider } from "./llm/demoProvider.js";
import { runWithRetry } from "./llm/retry.js";
import { kimiRateLimitManager } from "./llm/rateLimitManager.js";
import { estimateTokensConservative } from "./llm/tokenEstimate.js";
import { LLM_READER_REASONING_EFFORT, LLM_READER_MAX_COMPLETION_TOKENS, DEFAULT_EXPECTED_READER_OUTPUT_TOKENS } from "./config.js";
import { LLM_ERROR_TYPES, sanitizeErrorMessage } from "./llm/errorTypes.js";
import { buildModelPricingSnapshot, estimateCostForTokens, computeActualCost, sumTokenUsage } from "./llm/costEstimate.js";

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
export async function executeReadingRun(run, { persona, survey, attributes, reactions, mode, liveCfg, isCancelled = () => false, modelId, modelPricing }) {
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
      purpose: "reader",
      // Usage de CADA tentativa cobrada pelo provider (sucesso ou falha —
      // ver onAttempt abaixo), preservado através de um retomada em
      // WAITING_RETRY (nunca reiniciado aqui, já que esta atribuição roda
      // de novo a cada chamada de executeReadingRun, inclusive retomadas).
      // tokenUsage/actualCost abaixo são sempre o TOTAL acumulado desta
      // lista, nunca só a última tentativa (ver bug real: 6 tentativas de
      // Kimi K2.6, custo real só refletia a última quando havia usage).
      attemptUsage: run.requestMetadata?.attemptUsage || [],
      // Parâmetros efetivamente enviados ao provider real nesta execução —
      // ausente em demo (não bate em API nenhuma). Fonte única de verdade:
      // js/config.js (nunca hardcoded aqui, ver LLM_READER_*).
      ...(isDemo ? {} : { readerLLMParams: { reasoningEffort: LLM_READER_REASONING_EFFORT, maxCompletionTokens: LLM_READER_MAX_COMPLETION_TOKENS } }),
      // Seleção EXPLÍCITA de modelo (ver js/components/llmExecutionDialog.js) —
      // `modelPricingSnapshot` é uma cópia CONGELADA do preço do catálogo no
      // momento desta execução (nunca a referência viva do catálogo — futuras
      // atualizações de preço nunca alteram o custo já registrado aqui).
      ...(!isDemo && modelId && modelPricing
        ? {
            requestedModelId: modelId,
            modelPricingSnapshot: buildModelPricingSnapshot(modelPricing),
            estimatedCost: estimateCostForTokens({
              pricing: modelPricing,
              estimatedInputTokens: estimateTokensConservative(system + user),
              estimatedOutputTokens: DEFAULT_EXPECTED_READER_OUTPUT_TOKENS,
            }),
          }
        : {}),
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
      purpose: "reader",
      ...(isDemo ? {} : { modelId, reasoningEffort: LLM_READER_REASONING_EFFORT, maxCompletionTokens: LLM_READER_MAX_COMPLETION_TOKENS }),
    });
    const guardedCall = isDemo ? callProvider : () => kimiRateLimitManager.run(callProvider, {
      isCancelled,
      // Estimativa CONSERVADORA (prompt + teto de saída configurado) usada
      // SOMENTE para o orçamento preventivo de RPM/TPM ANTES desta request
      // acontecer — substituída pelo usage real assim que ela conclui (ver
      // rateLimitManager.js). Nunca calculada/usada em demo.
      estimatedTokens: estimateTokensConservative(system + user) + LLM_READER_MAX_COMPLETION_TOKENS,
    });

    // Retry automático só para falhas TRANSITÓRIAS do provider (rate limit,
    // sobrecarga, rede, timeout, erro de servidor — ver llm/errorTypes.js).
    // Erros permanentes (auth, cota, request inválido) propagam já na 1ª
    // tentativa. A cada falha transitória, a run vai para WAITING_RETRY com
    // um next_retry_at persistido (nunca um setTimeout como única fonte de
    // verdade) — nunca vira FAILED só por causa de um 429/503 isolado
    // (critério de aceite desta funcionalidade).
    const { content, model, usage, structuredOutputMode } = await runWithRetry(
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
        onAttempt: async ({ attempt, ok, errorType, retryable, error, result }) => {
          run.attemptCount = attempt;
          run.lastAttemptAt = D.nowISO();
          run.lastErrorType = ok ? null : errorType;
          run.lastErrorMessage = ok ? "" : sanitizeErrorMessage(providerErrorMessage(error));
          // Usage desta tentativa (sucesso: result.usage; falha: error.usage
          // — ver ProviderError em llm/provider.js) — nunca descartado só
          // porque a tentativa falhou depois de o upstream já ter cobrado
          // tokens de reasoning (ex.: resposta vazia). Acumulado em vez de
          // sobrescrito para refletir o custo REAL de todas as tentativas.
          const attemptTokenUsage = ok ? result?.usage : error?.usage;
          if (attemptTokenUsage) {
            run.requestMetadata = {
              ...run.requestMetadata,
              attemptUsage: [...(run.requestMetadata.attemptUsage || []), { attempt, ...attemptTokenUsage }],
            };
          }
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
    // tokenUsage/actualCost refletem o TOTAL acumulado de TODAS as
    // tentativas cobradas (attemptUsage, ver onAttempt acima), nunca só a
    // última tentativa bem-sucedida — um retry falho que já consumiu
    // tokens de reasoning não pode ser "esquecido" do custo real.
    if (usage) {
      const totalUsage = run.requestMetadata.attemptUsage?.length
        ? sumTokenUsage(run.requestMetadata.attemptUsage)
        : usage;
      run.requestMetadata = { ...run.requestMetadata, tokenUsage: totalUsage };
      // Custo REAL (ver js/llm/costEstimate.js) — só calculável quando havia
      // um pricing snapshot congelado (seleção explícita de modelo) e o
      // provider retornou tokenUsage; nunca recalcula a partir do preço
      // "atual" do catálogo.
      const actualCost = computeActualCost({ pricingSnapshot: run.requestMetadata.modelPricingSnapshot, usage: totalUsage });
      if (actualCost) run.requestMetadata = { ...run.requestMetadata, actualCost };
    }
    // Mecanismo de contrato de saída efetivamente usado nesta chamada (ver
    // supabase/functions/llm-proxy — "json_mode" | "prompt_only"), decidido
    // pelo servidor, nunca pelo frontend. Permite comparar taxas de
    // INVALID_RESPONSE por modo (nunca disponível em demo).
    if (structuredOutputMode) run.requestMetadata = { ...run.requestMetadata, structuredOutputMode };

    // Etapa explícita raw -> normalization -> JSON.parse -> schema ->
    // semântica (ver llm/readingResultNormalizer.js). `run.rawResponse`
    // acima NUNCA é substituído pelo texto normalizado — só o texto usado
    // para o parse é que muda. Desvios mecânicos (ex.: fences Markdown)
    // viram warning; texto explicativo significativo em volta do JSON
    // continua quebrando o JSON.parse normalmente (INVALID_RESPONSE).
    const { normalizedText, warnings: normalizationWarnings } = normalizeReadingResultResponse(content);
    if (normalizationWarnings.length) {
      run.requestMetadata = { ...run.requestMetadata, normalizationWarnings };
    }

    let parsed;
    try {
      parsed = JSON.parse(normalizedText);
    } catch (_) {
      throw new ProviderError("INVALID_JSON", "O modelo retornou um JSON inválido.", { errorType: LLM_ERROR_TYPES.INVALID_RESPONSE });
    }
    const validation = validateLLMResponse(parsed, { reactions: activeReactions, survey });
    // Metadata de completude da pesquisa (ver validate.js): calculada e
    // persistida mesmo quando a validação falha — observabilidade sobre
    // required/optional respondidos não depende da resposta ser aceita.
    if (validation.surveyCompleteness) {
      run.requestMetadata = { ...run.requestMetadata, surveyCompleteness: validation.surveyCompleteness };
    }
    if (!validation.ok) {
      throw new ProviderError("INVALID_SCHEMA", "Resposta fora do schema: " + validation.errors.join(" | "), { errorType: LLM_ERROR_TYPES.INVALID_RESPONSE });
    }

    run.status = "COMPLETED";
    run.completedAt = D.nowISO();
    await S.saveRun(run);
    const validationWarnings = [...normalizationWarnings, ...(validation.warnings || [])];
    await S.saveResult({ ...D.blankResult(run.id), ...validation.value, validationWarnings });
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
    // Mesmo numa falha definitiva (todas as tentativas exauridas/erro
    // permanente), tentativas anteriores podem ter sido cobradas pelo
    // provider (ver onAttempt acima) — nunca deixar "custo real
    // indisponível" quando já temos usage acumulado de pelo menos uma
    // tentativa.
    if (run.requestMetadata?.attemptUsage?.length) {
      const totalUsage = sumTokenUsage(run.requestMetadata.attemptUsage);
      run.requestMetadata = { ...run.requestMetadata, tokenUsage: totalUsage };
      const actualCost = computeActualCost({ pricingSnapshot: run.requestMetadata.modelPricingSnapshot, usage: totalUsage });
      if (actualCost) run.requestMetadata = { ...run.requestMetadata, actualCost };
    }
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
const isDemoMode = (mode) => mode === "demo";

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
    // modelId/modelPricing vêm SEMPRE de popRun (congelados uma única vez em
    // executePopulationRun, antes da 1ª Persona) — nunca reselecionados por
    // Persona, e idênticos numa retomada (resumePopulationRun) porque já
    // estão persistidos em popRun, não num parâmetro efêmero desta chamada.
    const { ok } = await executeReadingRun(run, {
      persona, survey, attributes, reactions, mode, liveCfg, isCancelled,
      modelId: popRun.requestedModelId, modelPricing: popRun.modelPricingSnapshot,
    });
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
export async function executePopulationRun(popRun, { population, personas, survey, mode, liveCfg, onProgress, modelId, modelPricing }) {
  if (inFlight.has(popRun.id)) return popRun;
  inFlight.add(popRun.id);
  try {
    popRun.status = "RUNNING";
    popRun.startedAt = D.nowISO();
    // Congela a seleção de modelo UMA ÚNICA VEZ para toda a PopulationRun —
    // toda Persona (runPopulationLoop) e qualquer retomada futura reusam
    // exatamente isto, nunca uma nova seleção por Persona (ver critério
    // "PopulationRun inteira usa o mesmo modelId congelado").
    if (!isDemoMode(mode) && modelId && modelPricing) {
      popRun.requestedModelId = modelId;
      popRun.modelPricingSnapshot = buildModelPricingSnapshot(modelPricing);
    }
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
