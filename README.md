# ReaderLab

Laboratório de leitores sintéticos. Frontend estático (sem build) +
backend Supabase (Postgres + Auth + Edge Functions). Permite modelar
Personas e Pesquisas, executar leituras individuais ou em população
inteira, e explorar os resultados com analytics determinísticos e uma
interpretação assistida por IA (Research Analyst).

## Estrutura

```
readerlab/                 frontend estático — publique este diretório
  index.html
  styles.css
  js/
    app.js                 bootstrap (autenticação → carga do estado → rotas)
    db.js                  ÚNICO seam de backend (Supabase: getAll/put/remove/bulkPut/metaGet/metaSet)
    domain.js               entidades, constantes, seeds e o executionSnapshot
    store.js                estado em memória + ações CRUD (persistidas via db.js)
    ui.js                   todas as telas (roteamento por hash, sem framework)
    engine.js                motor de execução: ReadingRun individual e PopulationRun (laço + resume/cancel)
    analysisEngine.js         motor do Research Analyst: gera uma AnalysisRun a partir de uma PopulationRun concluída
    config.js                SUPABASE_URL / SUPABASE_ANON_KEY / LLM_PROXY_ENDPOINT
    analytics/
      statistics.js          estatística descritiva pura (média, mediana, desvio, índice de divergência)
      populationMetrics.js    agregações sobre ReadingRuns de uma PopulationRun (por pergunta, por reação, por segmento) — única fonte de verdade, reusada pelo hub e pelo dataset do Research Analyst
      populationAnalysisDatasetBuilder.js  monta o dataset determinístico e verificável enviado ao Research Analyst
    components/
      runResultView.js       relatório de leitura individual (ReadingRun + ReadingResult) — reusado em qualquer drill-down
    llm/
      provider.js            fala apenas com o proxy (Edge Function) — zero API key no navegador
      promptBuilder.js         monta o prompt de uma leitura (ReadingRun)
      validate.js              valida/normaliza a resposta da LLM de uma leitura contra a Survey/Reações configuradas
      demoProvider.js           simulador determinístico (sem rede) para leitura individual/população
      researchAnalystPromptBuilder.js  monta o prompt do Research Analyst a partir do dataset de analytics
      researchAnalystValidate.js        valida a análise da LLM: todo dado citado precisa existir, com o mesmo valor, no dataset (nunca aceita métrica/persona/segmento inventado)
      demoResearchAnalyst.js             simulador determinístico do Research Analyst
supabase/                  backend — ver supabase/README.md
  schema.sql                tabelas + RLS (instalação nova)
  migrations/                migrations incrementais (0001 auth/RLS, 0002 PopulationRun, 0003 AnalysisRun)
  functions/
    llm-proxy/                Edge Function: segura a API key da LLM no servidor, autentica e autoriza o dono
    _shared/                  helpers compartilhados pelas Edge Functions (ex.: CORS por allowlist)
```

## Arquitetura e conceitos de domínio

### Módulos principais

- **Frontend**: HTML/CSS/JS puro, sem build nem framework — `ui.js`
  concentra todas as telas e faz roteamento por `location.hash`.
- **Supabase**: Postgres (uma tabela por entidade, cada linha com uma
  coluna `data jsonb` guardando o objeto de domínio inteiro) + Auth
  (e-mail/senha) + Edge Functions (proxy de LLM). Ver
  [`supabase/README.md`](./supabase/README.md).
- **Auth/RLS**: aplicação privada, sem cadastro público. Toda linha tem
  `owner_id = auth.uid()`, e Row Level Security garante que cada conta só
  lê/escreve os próprios dados — `owner_id` nunca vem do frontend.
- **`db.js`**: único arquivo que fala com o Supabase. Expõe a mesma
  interface (`getAll/getOne/put/remove/bulkPut/metaGet/metaSet`)
  independente do backend por trás, isolando `store.js`/`ui.js` de detalhes
  de persistência.
- **`engine.js`**: motor de execução. Leva uma `ReadingRun` de `PENDING` a
  um status final (`COMPLETED`/`FAILED`), chamando o provider (demo ou LLM
  real) e validando a resposta. A execução de uma `PopulationRun` só
  dispara N `ReadingRun`s através deste mesmo motor — nunca duplica a
  lógica de execução.
- **LLM Provider** (`llm/provider.js`): fala exclusivamente com a Edge
  Function `llm-proxy` — nenhuma API key trafega pelo navegador.
- **Prompt Builders**: `llm/promptBuilder.js` (leitura individual) e
  `llm/researchAnalystPromptBuilder.js` (Research Analyst) — cada um monta
  o prompt a partir de dados já persistidos, nunca do texto bruto da
  survey/manuscrito sem contexto.
- **Validators**: `llm/validate.js` (resposta de uma leitura: reações,
  respostas de survey e estado do leitor, contra o que foi configurado) e
  `llm/researchAnalystValidate.js` (evidências da análise do Research
  Analyst: toda métrica/persona/segmento/reação citada precisa existir,
  com o mesmo valor, no dataset — nunca aceita dado fabricado pela LLM).

### Entidades

- **Persona**: leitor sintético configurado (preferências, tolerâncias,
  atributos, instruções) — reutilizável em várias execuções.
- **Population**: um grupo nomeado de Personas, reutilizável para disparar
  execuções em lote.
- **ReadingRun**: uma execução de leitura = 1 Persona + 1 texto + 1
  Survey + taxonomia de reações ativa, do estado `PENDING` até um status
  final.
- **ReadingResult**: o resultado produzido por uma `ReadingRun` — reações,
  respostas da survey, notas espontâneas e estado do leitor.
- **PopulationRun**: uma execução de uma `Population` inteira contra uma
  Survey — orquestra N `ReadingRun`s e congela um `executionSnapshot` no
  disparo.
- **`executionSnapshot`**: cópia congelada (Population/Personas/Survey/
  Reações/AttributeDefinitions/config de LLM) tirada no momento da
  execução. Garante que uma `PopulationRun` e seus analytics nunca mudem de
  significado por causa de uma edição posterior no catálogo ao vivo
  (renomear/reagrupar/excluir um atributo, por exemplo). `PopulationRun`s
  anteriores à introdução do snapshot (`snapshotVersion 2`) caem, somente
  para leitura, num fallback compatível que lê o catálogo atual — nunca
  inventa nem grava retroativamente uma definição histórica.
- **Population Analytics** (`js/analytics/`): cálculos determinísticos
  sobre os `ReadingResult`s de uma `PopulationRun` — média, mediana, desvio
  padrão, índice de divergência, agregados de reação e distribuição de
  respostas por tipo de pergunta.
- **Segments**: filtros determinísticos (regras `atributo` + operador +
  valor) sobre as `AttributeDefinitions` congeladas do snapshot, usados
  para comparar subconjuntos de leitores. Nenhum clustering automático.
- **AnalysisRun**: uma interpretação, por IA, dos resultados já calculados
  de uma `PopulationRun`. Cada geração cria uma nova `AnalysisRun` no
  histórico — nunca sobrescreve uma anterior.
- **Research Analyst** (`analysisEngine.js`): motor que gera uma
  `AnalysisRun`. Nunca recalcula estatísticas — só interpreta, em texto, o
  dataset determinístico já produzido pelo Population Analytics.

### Princípios de domínio

- `Population` ≠ `PopulationRun`: a primeira é configuração reutilizável
  (quem participa); a segunda é uma execução específica, com snapshot
  próprio e resultados próprios.
- `Persona` ≠ `ReadingRun`: a primeira é o leitor configurado; a segunda é
  uma leitura específica realizada por ela.
- `ReadingRun` ≠ `ReadingResult`: a primeira é o registro da execução
  (status, tempos, snapshot, provider/model); a segunda é o conteúdo
  produzido por essa execução.
- `PopulationRun` ≠ `AnalysisRun`: a primeira é a execução em lote das
  leituras; a segunda é uma interpretação posterior, por IA, dos
  resultados já produzidos por ela.

### Analytics × IA

A LLM **não calcula** as métricas principais do ReaderLab. Quem calcula
média, mediana, desvio padrão, índice de divergência, frequências e
segmentos é sempre o próprio sistema (`js/analytics/`), de forma
determinística e reprodutível. O Research Analyst **interpreta**, em
linguagem natural, resultados que já existem — e sua resposta é validada
contra o dataset real antes de ser aceita, para nunca persistir uma
métrica, persona, segmento ou reação inventada.

## Setup rápido

1. Configure o backend: siga [`supabase/README.md`](./supabase/README.md)
   (criar projeto, aplicar `schema.sql`, criar seu usuário, deploy da Edge
   Function `llm-proxy`).
2. Preencha `readerlab/js/config.js` com a URL/anon key do projeto e a URL
   da função.
3. Sirva `readerlab/` com qualquer servidor estático.

## Deploy no GitHub Pages

Configure o Pages do repositório para publicar o diretório `readerlab/`
(Settings → Pages → Build and deployment → Deploy from a branch → escolha
a branch e a pasta `/readerlab`, ou use uma GitHub Action que copie apenas
esse diretório para `gh-pages`). Não publique `supabase/` — é código de
backend (schema SQL e Edge Function), não faz parte do site estático.

## Autenticação

ReaderLab é uma aplicação privada e autenticada: não há cadastro público.
Contas são criadas manualmente no Supabase Dashboard (Authentication →
Users) e o login é feito por e-mail + senha na tela inicial do app. Sem
uma sessão válida, nenhuma tela do ReaderLab é acessível — apenas o login.
Cada conta só enxerga os próprios dados (personas, execuções, resultados
etc.), garantido por Row Level Security no Postgres. Veja
[`supabase/README.md`](./supabase/README.md) para criar seu usuário e,
se estiver migrando um projeto já em uso, aplicar a migration não
destrutiva em `supabase/migrations/`.
