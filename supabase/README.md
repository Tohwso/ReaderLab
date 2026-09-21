# ReaderLab — Backend Supabase

Este diretório contém tudo que roda no "backend": o schema Postgres e a
Edge Function que faz o proxy seguro para a API de LLM. O frontend estático
(`/readerlab`) não muda de arquitetura — apenas `readerlab/js/db.js` e
`readerlab/js/llm/provider.js` falam com este backend.

O ReaderLab é uma aplicação **privada e autenticada**: não existe cadastro
público nem workspace compartilhado. Cada conta só enxerga os próprios
dados (personas, execuções, resultados, etc.), garantido por Row Level
Security (RLS) no Postgres.

## 1. Criar o projeto

1. Crie um projeto em https://supabase.com/dashboard.
2. Em **Authentication → Sign In / Providers**, mantenha **"Allow
   anonymous sign-ins" DESABILITADO** — o app usa e-mail+senha, não sessão
   anônima.
3. Guarde a **Project URL** e a **anon public key** (Settings → API). A anon
   key é pública por design (protegida por RLS) — não é um secret.

## 2. Aplicar o schema

- **Projeto novo (banco vazio):** abra **SQL Editor** no dashboard, cole o
  conteúdo de [`schema.sql`](./schema.sql) e execute. Isso cria as tabelas
  `personas`, `attributes`, `reactions`, `surveys`, `tags`, `populations`,
  `runs`, `results`, `population_runs`, `analysis_runs`, `meta` (uma por
  "store" do frontend), cada uma com uma coluna `owner_id` e RLS exigindo
  `owner_id = auth.uid()` em toda operação (select/insert/update/delete).
- **Projeto já existente** (rodando o schema antigo, anônimo/compartilhado):
  **não** rode `schema.sql` de novo — use a migration não-destrutiva em
  [`migrations/0001_owner_id_and_auth.sql`](./migrations/0001_owner_id_and_auth.sql).
  Ver seção 3 abaixo.
- **Projeto já em uso que ainda não tem PopulationRun** (já rodou a
  0001): aplique também
  [`migrations/0002_population_runs.sql`](./migrations/0002_population_runs.sql)
  — cria a tabela `population_runs` e a coluna gerada
  `runs.population_run_id`, sem tocar em nenhum dado existente.
- **Projeto já em uso que ainda não tem o Research Analyst** (já rodou a
  0002): aplique também
  [`migrations/0003_analysis_runs.sql`](./migrations/0003_analysis_runs.sql)
  — cria a tabela `analysis_runs` (histórico de análises geradas por IA
  sobre uma PopulationRun), sem tocar em nenhum dado existente.

Alternativa via CLI:
```
supabase link --project-ref <seu-project-ref>
supabase db push --file supabase/schema.sql
```

## 3. Criar seu usuário e migrar dados existentes (projetos já em uso)

Como não há cadastro público, contas são criadas manualmente:

1. **Authentication → Users → Add user**: informe e-mail e senha, marque
   "Auto Confirm User" e salve. Copie o **User UID** gerado (coluna "User
   UID"/"UID" da tabela de usuários).
2. Abra [`migrations/0001_owner_id_and_auth.sql`](./migrations/0001_owner_id_and_auth.sql),
   substitua `COLOQUE-AQUI-O-UUID-DO-USUARIO` (Passo 0, no topo do arquivo)
   pelo UUID copiado.
3. Cole o arquivo inteiro no **SQL Editor** e clique em **Run**.
   - Não é destrutivo: nenhuma linha é apagada. Todos os dados existentes
     (personas, execuções, resultados, etc.) passam a pertencer ao usuário
     indicado.
   - Ao final, RLS passa a exigir `owner_id = auth.uid()` em toda operação,
     e a tabela `meta` passa a ter chave composta `(owner_id, key)`.
4. Em **Authentication → Settings**, confirme que **"Allow anonymous
   sign-ins" está desabilitado** — não é mais usado (`js/db.js` não chama
   mais `signInAnonymously()`).
5. Se quiser dar acesso a mais pessoas, repita o passo 1 para cada uma —
   cada usuário começa com um workspace vazio (sem os dados de outros
   usuários); não há forma de "compartilhar" dados entre contas nesta fase.

## 4. Configurar o frontend

Edite `readerlab/js/config.js`:
```js
export const SUPABASE_URL = "https://<seu-project-ref>.supabase.co";
export const SUPABASE_ANON_KEY = "<anon-public-key>";
export const LLM_PROXY_ENDPOINT = "https://<seu-project-ref>.supabase.co/functions/v1/llm-proxy";
```
(Ou defina `window.READERLAB_SUPABASE_URL`, `window.READERLAB_SUPABASE_ANON_KEY`
e `window.READERLAB_LLM_ENDPOINT` num `<script>` antes de `js/app.js`, se
preferir não commitar os valores.)

Ao abrir o app sem sessão válida, você verá a tela de login (e-mail+senha).
Faça login com a conta criada no passo 3 (ou 1, para projeto novo).

## 5. Deploy da Edge Function (proxy de LLM)

A função em [`functions/llm-proxy`](./functions/llm-proxy/index.ts) fala
com qualquer API compatível com o formato de chat completions da OpenAI
(Kimi/Moonshot, OpenAI, Groq, DeepSeek, etc.), mas **não é** um proxy
genérico aberto: é um endpoint restrito ao ReaderLab, com autenticação,
autorização por dono e CORS por allowlist (ver "Segurança" abaixo).

```
supabase functions deploy llm-proxy
supabase secrets set LLM_API_KEY=sk-...                                  # obrigatório
supabase secrets set LLM_API_BASE_URL=https://api.moonshot.ai/v1         # opcional (default: OpenAI)
supabase secrets set LLM_READER_MODEL=kimi-k3                            # opcional — modelo das ReadingRuns (default: LLM_MODEL, depois gpt-4o-mini)
supabase secrets set LLM_ANALYST_MODEL=kimi-k2.6                         # opcional — modelo do Research Analyst (default: LLM_MODEL, depois gpt-4o-mini)
supabase secrets set LLM_MODEL=kimi-k3                                   # legado — fallback comum quando o específico acima não está configurado
supabase secrets set READERLAB_OWNER_USER_ID=<uuid-do-seu-usuario>       # obrigatório
supabase secrets set READERLAB_ALLOWED_ORIGINS=https://<seu-usuario>.github.io,http://localhost:5173  # obrigatório
```

A API key **nunca** entra no frontend nem neste repositório — fica apenas
nos secrets da função.

### Segurança do `llm-proxy`

- **Autenticação:** a função valida o JWT recebido chamando
  `supabase.auth.getUser(token)` no servidor (não confia apenas em o
  frontend ter enviado o header `Authorization`). Sem JWT válido → `401`.
- **Autorização:** fase single-user — só o `auth.uid()` igual a
  `READERLAB_OWNER_USER_ID` pode executar leituras. Qualquer outro usuário
  autenticado recebe `403`. Não coloque esse UUID no código-fonte — só no
  secret.
- **CORS:** sem `Access-Control-Allow-Origin: *`. Só as origens listadas em
  `READERLAB_ALLOWED_ORIGINS` (separadas por vírgula) recebem os headers de
  CORS; outras origens são bloqueadas (`403`) já no preflight.
- **Modelo/URL fixos no servidor, com seleção explícita opcional via allowlist:**
  o frontend manda `{ systemPrompt, userPrompt, purpose?, modelId?, reasoning_effort? }`
  — nunca `baseUrl` ou `messages` arbitrários. `purpose` (`"reader"` ou
  `"analyst"`, default `"reader"`) escolhe QUAL secret de modelo é usado
  quando `modelId` não é enviado (`LLM_READER_MODEL`/`LLM_ANALYST_MODEL`,
  com `LLM_MODEL` como fallback comum). Se o cliente enviar `modelId`, ele
  só é aceito se existir no **Model Catalog** (`functions/llm-proxy/modelCatalog.mjs`,
  allowlist fixa no servidor), estiver `active` e for adequado ao `purpose`
  enviado — caso contrário a requisição falha com `400 invalid_request` e
  **nunca** há substituição silenciosa por outro modelo. Ver seção 7.
- **Payload limitado:** `systemPrompt`/`userPrompt` precisam ser strings
  não vazias, com tamanho máximo (20k/200k caracteres) para evitar abuso
  acidental; `reasoning_effort`, se enviado, só aceita `low`/`medium`/`high`/`max`.
- **Resposta enxuta:** `{ content, model, usage? }` — nunca o objeto cru da
  API de LLM, nem API key, headers do upstream ou stack traces.
- **Logs:** a função nunca loga o texto do manuscrito/prompt, só código e
  mensagem curta de erros do upstream.

## 6. Model Catalog, seleção de modelo e custo (estimado e real)

Desde a task "seleção explícita de modelo LLM + catálogo + custo", toda
execução real de LLM (ReadingRun avulsa, PopulationRun, Research Analyst)
mostra ao usuário um diálogo (`readerlab/js/components/llmExecutionDialog.js`)
para escolher explicitamente o modelo ANTES de disparar a chamada — o app
**nunca** escolhe "o melhor"/"o mais barato" modelo sozinho, e cancelar o
diálogo aborta a execução (sem fallback silencioso para nenhum modelo).

- **Catálogo (allowlist do servidor):** [`functions/llm-proxy/modelCatalog.mjs`](./functions/llm-proxy/modelCatalog.mjs)
  — lista fixa de modelos permitidos (hoje: `kimi-k2.6`, `kimi-k3`), cada um
  com `active`, `capabilities` (inclui se é adequado para `purpose:"reader"`
  e/ou `"analyst"`) e `pricing` (`currency`, `inputPerMillionTokens`,
  `outputPerMillionTokens`, `cachedInputPerMillionTokens` — `null` até
  confirmarmos o valor real do provedor, nunca um chute — e
  `pricingUpdatedAt`). **Para adicionar/atualizar um modelo, edite só este
  arquivo** (não precisa mexer em `index.ts`).
- **Descoberta (discovery):** `GET ?action=models` ou `POST {"action":"models"}`
  no mesmo endpoint `llm-proxy` — o servidor consulta `${LLM_API_BASE_URL}/models`
  no provedor (nunca expõe API key/baseUrl ao cliente) e retorna a
  interseção com o catálogo local `active`; se a consulta ao provedor
  falhar, retorna o catálogo `active` completo com `availabilityUnverified: true`
  em vez de quebrar a tela.
- **Seleção do modelo pelo cliente:** o body pode incluir `modelId?: string`.
  O servidor valida com `validateRequestedModel({modelId, purpose})` (existe
  no catálogo + `active` + adequado ao `purpose`) — se inválido, `400
  invalid_request`; nunca há substituição automática por outro modelo.
- **Custo estimado** (antes da execução): `readerlab/js/llm/costEstimate.js`
  calcula a partir do preço do catálogo + uma estimativa conservadora de
  tokens de entrada/saída — mostrado no próprio diálogo de seleção.
- **Custo real** (depois da execução): calculado a partir do `usage`
  (`prompt_tokens`/`completion_tokens`) que o provedor de fato retornou,
  usando uma "pricing snapshot" **congelada** no momento da execução
  (`buildModelPricingSnapshot` — cópia independente, nunca uma referência
  viva do catálogo) — então uma atualização de preço no catálogo nunca
  altera o custo já registrado de execuções passadas. Persistido em
  `run.requestMetadata`/`analysisRun.requestMetadata` (`requestedModelId`,
  `modelPricingSnapshot`, `estimatedCost`, `actualCost`) e exibido no
  relatório de leitura, no resumo da PopulationRun (soma de todos os
  leitores) e no relatório do Research Analyst (linha separada, nunca
  somada ao custo dos leitores).
- **PopulationRun:** o modelo é escolhido **uma única vez** para toda a
  execução (não por Persona) — congelado em campos top-level `popRun.
  requestedModelId`/`popRun.modelPricingSnapshot`, reusados por toda
  Persona inclusive ao retomar (`resumePopulationRun`).
- **Execuções antigas** (antes desta feature, sem `requestedModelId`)
  mostram "Informação de custo não disponível para esta execução." — nunca
  tentam calcular um custo retroativo.
- Nenhuma conversão de moeda é feita; nenhum "melhor modelo" é sugerido
  automaticamente; nenhum scraping de página de preços — os valores em
  `modelCatalog.mjs` são mantidos manualmente.

## 7. Rodar localmente (opcional)

```
supabase start                       # Postgres + Auth + Functions locais
supabase functions serve llm-proxy --env-file supabase/.env.local
```
Aponte `js/config.js` para a URL local (`http://localhost:54321`) e a anon
key exibida por `supabase start`.

## Modelo de dados

Cada tabela guarda o objeto de domínio inteiro em uma coluna `data jsonb`
(mesmo formato que já existia em IndexedDB) — `id`, `owner_id`, timestamps
e alguns campos de relação (`persona_id`, `survey_id`, `reading_run_id`,
etc.) são colunas próprias (algumas geradas a partir de `data`, apenas para
indexação/consulta), sem impor FKs rígidas entre stores (uma persona pode
ser excluída sem apagar execuções antigas que a referenciam, mesmo
comportamento do app original). `owner_id` é sempre resolvido por
`js/db.js` a partir da sessão autenticada — nunca aceito vindo do
frontend/formulários — e é a única coisa que RLS usa para isolar os dados
de cada usuário.

## Autenticação e sessão

- Login: e-mail + senha (`supabase.auth.signInWithPassword`). Sem tela de
  cadastro — contas só são criadas no Dashboard (seção 3).
- Sessão persiste no navegador (`persistSession: true`) e sobrevive a
  reload de página.
- Logout: botão "Sair" na barra lateral do app (`supabase.auth.signOut()`).
- Sessão expirada/inválida (ex.: refresh token revogado): o app detecta via
  `onAuthStateChange` e volta automaticamente para a tela de login, sem
  perder dados no Postgres (o estado em memória do navegador é apenas
  limpo para não vazar para o próximo usuário que logar no mesmo
  navegador).

