// ============ ReaderLab — Abstração LLMProvider ============
//
// NENHUMA API KEY EXISTE NESTE CÓDIGO. O provider nunca chama uma API de
// LLM diretamente do browser: ele fala APENAS com um endpoint proxy
// configurável (getLLMConfig().endpoint) — a Supabase Edge Function
// `llm-proxy` (ver /supabase/functions/llm-proxy) — cuja única
// responsabilidade no servidor é segurar o secret e repassar a requisição
// à API real (compatível com o formato de chat da OpenAI).
//
// Arquitetura (seam único de integração):
//   ReaderLab (estático)  --HTTPS-->  Supabase Edge Function (segura a key)
//                                      --HTTPS--> API de LLM (OpenAI-compatível)
//
// Trocar de provider = trocar variáveis de ambiente da Edge Function (ou
// implementar outra classe *Provider com a mesma interface).

import { getAccessToken, getAnonKey } from "../db.js";
import { LLM_PROXY_ENDPOINT } from "../config.js";

export const LLM_PROXY_CONFIG = {
  endpoint: LLM_PROXY_ENDPOINT, // ex.: "https://<ref>.supabase.co/functions/v1/llm-proxy"
  provider: "openai-compatible",
  model: "",
  promptVersion: "v1",
  temperature: 0.7,
  timeoutMs: 140000,
};

// Hook de configuração NÃO-secreta: o endpoint do proxy é apenas uma URL
// pública. Pode ser definido pelo hospedeiro da página sem rebuild:
// window.READERLAB_LLM_ENDPOINT = "https://..."
export function getLLMConfig() {
  let endpoint = LLM_PROXY_CONFIG.endpoint;
  try {
    if (typeof window !== "undefined" && window.READERLAB_LLM_ENDPOINT) {
      endpoint = window.READERLAB_LLM_ENDPOINT;
    }
  } catch (_) { /* ambiente sem window */ }
  return { ...LLM_PROXY_CONFIG, endpoint };
}

export class ProviderError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ProviderError";
    this.code = code; // NOT_CONFIGURED | NETWORK | TIMEOUT | AUTH | RATE_LIMIT | HTTP | INVALID_JSON | INVALID_SCHEMA | EMPTY
    this.detail = detail;
  }
}

// Mensagens amigáveis (sem stack trace, sem secrets) para o frontend.
export function providerErrorMessage(err) {
  if (err instanceof ProviderError) return err.message;
  if (err && err.name === "AbortError") return "A chamada foi interrompida (timeout).";
  return "Erro inesperado durante a execução. Tente novamente.";
}

// Interface conceitual LLMProvider:
//   complete({ systemPrompt, userPrompt }) -> { content: string, raw: any }
export class KimiProvider {
  constructor(cfg = getLLMConfig()) {
    this.cfg = cfg;
  }

  async complete({ systemPrompt, userPrompt }) {
    if (!this.cfg.endpoint) {
      throw new ProviderError(
        "NOT_CONFIGURED",
        "Nenhum backend LLM configurado. Conecte um proxy seguro (com a API Key no servidor) para executar leituras reais."
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    // A Edge Function do Supabase exige um JWT válido no Authorization
    // header (a sessão anônima aberta por db.js serve para isso).
    const token = getAccessToken() || getAnonKey();

    let res;
    try {
      res = await fetch(this.cfg.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          provider: this.cfg.provider,
          model: this.cfg.model,
          temperature: this.cfg.temperature,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === "AbortError") {
        throw new ProviderError("TIMEOUT", `A chamada à LLM excedeu o limite de ${Math.round(this.cfg.timeoutMs / 1000)}s.`);
      }
      throw new ProviderError("NETWORK", "Falha de rede ao contatar o backend LLM.");
    }
    clearTimeout(timer);

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError("AUTH", "Falha de autenticação com a API de LLM (verifique a chave no servidor).");
      }
      if (res.status === 429) {
        throw new ProviderError("RATE_LIMIT", "Limite de requisições atingido (rate limit). Aguarde e tente novamente.");
      }
      throw new ProviderError("HTTP", `O backend retornou erro HTTP ${res.status}.`);
    }

    let data;
    try {
      data = await res.json();
    } catch (_) {
      throw new ProviderError("INVALID_JSON", "Resposta inválida do backend LLM (não era JSON).");
    }

    // O proxy normalmente retorna { content: "<texto do modelo>" };
    // aceitamos também o formato estilo OpenAI para futuros providers.
    const content =
      typeof data.content === "string" ? data.content
      : typeof data?.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content
      : null;

    if (!content || !content.trim()) {
      throw new ProviderError("EMPTY", "O modelo retornou uma resposta vazia.");
    }
    return { content: content.trim(), raw: data };
  }
}

// Fábrica — ponto único de troca de provider no futuro
// (OpenAIProvider, AnthropicProvider, GeminiProvider, LocalModelProvider).
export function getProvider(cfg = getLLMConfig()) {
  return new KimiProvider(cfg);
}
