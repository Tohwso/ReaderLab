# ReaderLab — Backend Supabase

Este diretório contém tudo que roda no "backend": o schema Postgres e a
Edge Function que faz o proxy seguro para a API de LLM. O frontend estático
(`/readerlab`) não muda de arquitetura — apenas `readerlab/js/db.js` e
`readerlab/js/llm/provider.js` falam com este backend.

## 1. Criar o projeto

1. Crie um projeto em https://supabase.com/dashboard.
2. Em **Authentication → Sign In / Providers**, habilite **"Allow anonymous
   sign-ins"**. O app não tem tela de login: cada visitante recebe uma
   sessão anônima (JWT) usada tanto para acessar o banco (RLS) quanto para
   chamar o proxy de LLM.
3. Guarde a **Project URL** e a **anon public key** (Settings → API). A anon
   key é pública por design (protegida por RLS) — não é um secret.

## 2. Aplicar o schema

Abra **SQL Editor** no dashboard, cole o conteúdo de [`schema.sql`](./schema.sql)
e execute. Isso cria as tabelas `personas`, `attributes`, `reactions`,
`surveys`, `tags`, `populations`, `runs`, `results`, `meta` (uma por "store"
do frontend) com RLS exigindo apenas uma sessão autenticada.

Alternativa via CLI:
```
supabase link --project-ref <seu-project-ref>
supabase db push --file supabase/schema.sql
```

## 3. Configurar o frontend

Edite `readerlab/js/config.js`:
```js
export const SUPABASE_URL = "https://<seu-project-ref>.supabase.co";
export const SUPABASE_ANON_KEY = "<anon-public-key>";
export const LLM_PROXY_ENDPOINT = "https://<seu-project-ref>.supabase.co/functions/v1/llm-proxy";
```
(Ou defina `window.READERLAB_SUPABASE_URL`, `window.READERLAB_SUPABASE_ANON_KEY`
e `window.READERLAB_LLM_ENDPOINT` num `<script>` antes de `js/app.js`, se
preferir não commitar os valores.)

## 4. Deploy da Edge Function (proxy de LLM)

A função em [`functions/llm-proxy`](./functions/llm-proxy/index.ts) é
genérica: fala com qualquer API compatível com o formato de chat
completions da OpenAI (Kimi/Moonshot, OpenAI, Groq, DeepSeek, etc.).

```
supabase functions deploy llm-proxy
supabase secrets set LLM_API_KEY=sk-...              # obrigatório
supabase secrets set LLM_API_BASE_URL=https://api.moonshot.cn/v1  # opcional (default: OpenAI)
supabase secrets set LLM_MODEL=kimi-k3                # opcional (default: gpt-4o-mini)
```

A API key **nunca** entra no frontend nem neste repositório — fica apenas
nos secrets da função. Mantenha a verificação de JWT ativa (comportamento
padrão do `supabase functions deploy`): o proxy só aceita chamadas com um
JWT válido do seu projeto (a sessão anônima do app já cobre isso).

## 5. Rodar localmente (opcional)

```
supabase start                       # Postgres + Auth + Functions locais
supabase functions serve llm-proxy --env-file supabase/.env.local
```
Aponte `js/config.js` para a URL local (`http://localhost:54321`) e a anon
key exibida por `supabase start`.

## Modelo de dados

Cada tabela guarda o objeto de domínio inteiro em uma coluna `data jsonb`
(mesmo formato que já existia em IndexedDB) — `id`, timestamps e alguns
campos de relação (`persona_id`, `survey_id`, `reading_run_id`, etc.) são
extraídos como colunas geradas apenas para indexação/consulta, sem impor
FKs rígidas (uma persona pode ser excluída sem apagar execuções antigas que
a referenciam, mesmo comportamento do app original).
