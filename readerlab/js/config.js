// ============ ReaderLab — Configuração pública (sem segredos) ============
// A anon key do Supabase é uma chave PÚBLICA protegida por Row Level
// Security (RLS) — pode ficar no bundle do frontend com segurança. Nenhuma
// API key de LLM deve aparecer aqui: aquela fica exclusivamente no servidor
// (Supabase Edge Function), veja /supabase/functions/llm-proxy.
//
// Preencha após criar o projeto no Supabase (veja /supabase/README.md), ou
// defina em runtime via window.READERLAB_SUPABASE_URL /
// window.READERLAB_SUPABASE_ANON_KEY / window.READERLAB_LLM_ENDPOINT antes
// de js/app.js ser carregado (útil para hospedagens que injetam config sem
// tocar no código-fonte).

export const SUPABASE_URL = "https://xgpvazsqgxczqtbtpafq.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhncHZhenNxZ3hjenF0YnRwYWZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MDAzMjMsImV4cCI6MjEwNDk3NjMyM30.Ap-4j4iVN0YHkPfuMZ9irsuYWN52BBtK7KuemoBiKeI";

// Endpoint da Edge Function que faz o proxy seguro para a API de LLM.
// Formato esperado: `${SUPABASE_URL}/functions/v1/llm-proxy`
export const LLM_PROXY_ENDPOINT = "https://xgpvazsqgxczqtbtpafq.supabase.co/functions/v1/llm-proxy";
