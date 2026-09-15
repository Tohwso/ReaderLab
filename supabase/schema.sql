-- ============ ReaderLab — Schema Supabase (Postgres) ============
-- Este schema é o backend real por trás de js/db.js. Uma tabela por
-- "store" do frontend, cada uma guardando o objeto de domínio inteiro em
-- `data` (jsonb) — mesma forma que já existia em IndexedDB/localStorage —
-- mais uma coluna `owner_id` (dono da linha = auth.uid() de quem gravou).
-- Colunas geradas (STORED) expõem campos-chave para indexação/consulta,
-- sem impor FKs rígidas entre stores: o app original permite referências
-- "soltas" (ex.: apagar uma persona não apaga suas execuções antigas),
-- então preservamos esse comportamento aqui.
--
-- IMPORTANTE — este arquivo é para PROJETOS NOVOS (banco vazio). Se você
-- já tem um ReaderLab rodando com o schema antigo (workspace anônimo
-- compartilhado, sem owner_id), NÃO rode este arquivo: use a migration em
-- supabase/migrations/0001_owner_id_and_auth.sql, que converte o banco
-- existente sem apagar dados.
--
-- Autenticação: e-mail + senha, sem cadastro público — contas são criadas
-- manualmente em Authentication → Users no Dashboard (ver
-- supabase/README.md). Não há mais sessão anônima nem workspace
-- compartilhado: RLS restringe cada tabela ao próprio owner_id.
--
-- Como aplicar: Supabase Dashboard → SQL Editor → cole este arquivo → Run.
-- (ou `supabase db push` / `psql` apontando para o projeto).

-- ------------------------------------------------------------- utilidades
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- --------------------------------------------------------------- personas
create table if not exists personas (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  code text generated always as (data->>'code') stored,
  name text generated always as (data->>'name') stored,
  status text generated always as (data->>'status') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists personas_owner_idx on personas (owner_id);
create index if not exists personas_status_idx on personas (status);
create index if not exists personas_code_idx on personas (code);

-- -------------------------------------------------------------- attributes
create table if not exists attributes (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  slug text generated always as (data->>'slug') stored,
  "group" text generated always as (data->>'group') stored,
  status text generated always as (data->>'status') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists attributes_owner_idx on attributes (owner_id);
create index if not exists attributes_group_idx on attributes ("group");

-- --------------------------------------------------------------- reactions
create table if not exists reactions (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  code text generated always as (data->>'code') stored,
  polarity text generated always as (data->>'polarity') stored,
  status text generated always as (data->>'status') stored,
  "order" int generated always as (coalesce((data->>'order')::int, 0)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reactions_owner_idx on reactions (owner_id);
create index if not exists reactions_order_idx on reactions ("order");

-- ----------------------------------------------------------------- surveys
create table if not exists surveys (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  kind text generated always as (data->>'kind') stored,
  status text generated always as (data->>'status') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists surveys_owner_idx on surveys (owner_id);

-- -------------------------------------------------------------------- tags
create table if not exists tags (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  name text generated always as (data->>'name') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tags_owner_idx on tags (owner_id);
create index if not exists tags_name_idx on tags (name);

-- ------------------------------------------------------------- populations
create table if not exists populations (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  name text generated always as (data->>'name') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists populations_owner_idx on populations (owner_id);

-- ----------------------------------------------------------------- runs
create table if not exists runs (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  persona_id text generated always as (data->>'personaId') stored,
  survey_id text generated always as (data->>'surveyId') stored,
  status text generated always as (data->>'status') stored,
  population_run_id text generated always as (data->>'populationRunId') stored,
  -- Projeção de data->>'nextRetryAt' (ver js/domain.js/blankRun) — permite
  -- localizar ReadingRuns em WAITING_RETRY sem carregar a tabela inteira;
  -- `data` continua sendo a única fonte de verdade, isto é só um índice.
  -- `text` (não timestamptz): cast text->timestamptz não é IMMUTABLE no
  -- Postgres, então não pode ser usado numa coluna gerada; strings ISO
  -- 8601 ordenam corretamente como texto.
  next_retry_at text generated always as (data->>'nextRetryAt') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists runs_owner_idx on runs (owner_id);
create index if not exists runs_persona_idx on runs (persona_id);
create index if not exists runs_survey_idx on runs (survey_id);
create index if not exists runs_status_idx on runs (status);
create index if not exists runs_population_run_idx on runs (population_run_id);
create index if not exists runs_next_retry_at_idx on runs (next_retry_at) where status = 'WAITING_RETRY';

-- ------------------------------------------------------- population_runs
-- Orquestra N ReadingRuns (uma por Persona de uma Population) sobre o
-- mesmo texto/Survey/config de modelo. Vínculo é feito pelo lado de
-- `runs` (runs.population_run_id) — apagar uma population_run NÃO apaga
-- as ReadingRuns já geradas por ela (mesmo padrão de referência solta já
-- usado no restante do schema).
create table if not exists population_runs (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  population_id text generated always as (data->>'populationId') stored,
  survey_id text generated always as (data->>'surveyId') stored,
  status text generated always as (data->>'status') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists population_runs_owner_idx on population_runs (owner_id);
create index if not exists population_runs_population_idx on population_runs (population_id);
create index if not exists population_runs_status_idx on population_runs (status);

-- ------------------------------------------------------- analysis_runs
-- Uma AnalysisRun representa UMA interpretação, por IA, dos resultados JÁ
-- produzidos por uma PopulationRun (Research Analyst — ver
-- js/analysisEngine.js). Nunca lê nem altera ReadingRuns/ReadingResults;
-- cada geração cria uma nova linha (histórico completo, nunca sobrescrito).
create table if not exists analysis_runs (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  population_run_id text generated always as (data->>'populationRunId') stored,
  status text generated always as (data->>'status') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists analysis_runs_owner_idx on analysis_runs (owner_id);
create index if not exists analysis_runs_population_run_idx on analysis_runs (population_run_id);
create index if not exists analysis_runs_status_idx on analysis_runs (status);

-- --------------------------------------------------------------- results
create table if not exists results (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  reading_run_id text generated always as (data->>'readingRunId') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists results_owner_idx on results (owner_id);
create index if not exists results_run_idx on results (reading_run_id);

-- ------------------------------------------------------------------- meta
-- key/value simples (flags de seed, preferências de app). A mesma `key`
-- pode existir uma vez por usuário sem colidir — chave primária composta.
create table if not exists meta (
  owner_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb,
  updated_at timestamptz not null default now(),
  primary key (owner_id, key)
);

-- ------------------------------------------------------- trigger updated_at
do $$
declare t text;
begin
  for t in select unnest(array['personas','attributes','reactions','surveys','tags','populations','runs','results','population_runs','analysis_runs','meta'])
  loop
    execute format('drop trigger if exists trg_%1$s_updated_at on %1$s;', t);
    execute format('create trigger trg_%1$s_updated_at before update on %1$s for each row execute function set_updated_at();', t);
  end loop;
end $$;

-- ================================================================== RLS
-- Cada usuário só enxerga/edita as próprias linhas: toda operação exige
-- owner_id = auth.uid(). Não há mais workspace compartilhado nem acesso
-- ao papel `anon` — apenas `authenticated` com sessão de e-mail+senha
-- (supabase.auth.signInWithPassword, ver js/db.js). Mantenha "Allow
-- anonymous sign-ins" DESABILITADO em Authentication → Settings.
do $$
declare t text;
begin
  for t in select unnest(array['personas','attributes','reactions','surveys','tags','populations','runs','results','population_runs','analysis_runs','meta'])
  loop
    execute format('alter table %1$s enable row level security;', t);
    execute format('drop policy if exists %1$s_rw on %1$s;', t);
    execute format('drop policy if exists %1$s_select on %1$s;', t);
    execute format('drop policy if exists %1$s_insert on %1$s;', t);
    execute format('drop policy if exists %1$s_update on %1$s;', t);
    execute format('drop policy if exists %1$s_delete on %1$s;', t);
    execute format('create policy %1$s_select on %1$s for select to authenticated using (owner_id = auth.uid());', t);
    execute format('create policy %1$s_insert on %1$s for insert to authenticated with check (owner_id = auth.uid());', t);
    execute format('create policy %1$s_update on %1$s for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());', t);
    execute format('create policy %1$s_delete on %1$s for delete to authenticated using (owner_id = auth.uid());', t);
  end loop;
end $$;

