// ============ ReaderLab — Estimativa conservadora de tokens ============
// Usado SOMENTE como entrada preventiva do orçamento de TPM (ver
// rateLimitManager.js) ANTES de uma chamada real acontecer — nunca
// substitui o usage real retornado pelo provider (sempre preferido quando
// disponível: rateLimitManager.js troca a estimativa pelo valor real assim
// que a request conclui). É uma APROXIMAÇÃO deliberadamente conservadora
// (superestima) para o orçamento nunca "furar" por otimismo.
//
// Heurística: ~1 token a cada 3 caracteres — mais conservador que a régua
// usual de ~4 chars/token em inglês, para cobrir texto em português e
// pontuação/JSON do schema, que tendem a tokenizar pior.
//
// Extensão futura: se o provider passar a expor um endpoint oficial de
// contagem de tokens, plugar aqui (trocar o corpo desta função por uma
// chamada a esse endpoint) sem alterar o contrato (recebe texto, devolve
// um número) nem o restante do sistema.
const CHARS_PER_TOKEN_CONSERVATIVE = 3;

export function estimateTokensConservative(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_CONSERVATIVE);
}
