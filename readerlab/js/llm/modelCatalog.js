// ============ ReaderLab — Model Catalog (frontend) ============
// Wrapper com cache em memória sobre a discovery do backend
// (js/llm/provider.js -> fetchAvailableModels(), que chama
// supabase/functions/llm-proxy com { action: "models" }). Nunca decide
// sozinho quais modelos existem — o backend é a fonte de verdade; este
// módulo só evita bater na rede a cada abertura do diálogo de execução.
//
// FALLBACK_CATALOG espelha manualmente
// supabase/functions/llm-proxy/modelCatalog.mjs para o caso raro de falha
// de rede/timeout ao consultar o backend (nunca por causa de scraping ou
// suposição — os mesmos dois modelos, os mesmos preços cadastrados
// manualmente). Sempre marcado com `availabilityUnverified: true` quando
// usado, para deixar claro que não foi confirmado contra o provider agora.
import { fetchAvailableModels } from "./provider.js";

const FALLBACK_CATALOG = [
  {
    id: "kimi-k2.6",
    displayName: "Kimi K2.6",
    provider: "moonshot",
    category: "econômico",
    contextTokens: 256_000,
    pricing: {
      currency: "CNY",
      inputPerMillionTokens: 6.5,
      cachedInputPerMillionTokens: null,
      outputPerMillionTokens: 27,
      pricingUpdatedAt: "2026-09-21",
    },
    capabilities: {
      jsonMode: true,
      reasoningEffort: false,
      maxCompletionTokens: true,
      customTemperature: false,
      suitableForReader: true,
      suitableForAnalyst: true,
    },
    tags: ["rápido", "econômico"],
  },
  {
    id: "kimi-k3",
    displayName: "Kimi K3",
    provider: "moonshot",
    category: "alta capacidade",
    contextTokens: 1_000_000,
    pricing: {
      currency: "CNY",
      inputPerMillionTokens: 20,
      cachedInputPerMillionTokens: null,
      outputPerMillionTokens: 100,
      pricingUpdatedAt: "2026-09-21",
    },
    capabilities: {
      jsonMode: true,
      reasoningEffort: true,
      maxCompletionTokens: true,
      customTemperature: false,
      suitableForReader: true,
      suitableForAnalyst: true,
    },
    tags: ["reasoning", "alta capacidade"],
  },
];

// TTL curto (seção 29 da tarefa "model catalog") — só para evitar uma
// consulta de rede a cada abertura do diálogo de execução dentro da mesma
// sessão; nunca usado para decidir preço/allowlist (isso é sempre
// revalidado no servidor a cada chamada real).
const CACHE_TTL_MS = 10 * 60 * 1000;

let cache = null; // { models, availabilityUnverified, fetchedAt }
let inFlight = null;

function isCacheFresh() {
  return !!cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

// Filtra pela `purpose` (reader/analyst) — nunca decide "melhor"/"mais
// barato": só remove o que é estruturalmente incompatível.
export function filterModelsForPurpose(models, purpose) {
  const flag = purpose === "analyst" ? "suitableForAnalyst" : "suitableForReader";
  return (Array.isArray(models) ? models : []).filter((m) => m?.capabilities?.[flag] === true);
}

// `forceRefresh` ignora o cache (botão "Atualizar modelos" da UI).
export async function getModelCatalog({ forceRefresh = false } = {}) {
  if (!forceRefresh && isCacheFresh()) return cache;
  if (!forceRefresh && inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const { models, availabilityUnverified } = await fetchAvailableModels();
      cache = { models, availabilityUnverified, fetchedAt: Date.now() };
      return cache;
    } catch (_err) {
      // Nunca quebra o app por isso (seção 30) — cai no catálogo conhecido
      // localmente, sinalizando que a disponibilidade não foi confirmada.
      cache = { models: FALLBACK_CATALOG, availabilityUnverified: true, fetchedAt: Date.now() };
      return cache;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
