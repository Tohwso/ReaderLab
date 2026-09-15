-- ============ ReaderLab — Migration: PopulationRun ============
-- Adiciona o conceito de PopulationRun (orquestração de N ReadingRuns
-- independentes — uma por Persona de uma Population — sobre o mesmo
-- texto/Survey/config de modelo) a um projeto ReaderLab JÁ EXISTENTE.
-- Não apaga nem altera nenhum dado de personas/runs/results existentes.
--
-- Rode isto UMA VEZ, direto no SQL Editor do Supabase Dashboard (cole o
-- arquivo inteiro e clique em Run) — ou via `npx supabase@latest db push`.
--
-- Pré-requisito: já ter aplicado 0001_owner_id_and_auth.sql (owner_id +
-- RLS por usuário já configurados nas demais tabelas).

-- ---------------------------------------------------- 1) tabela population_runs
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

-- ------------------------------------ 2) vínculo runs.population_run_id
-- ReadingRuns disparadas por uma PopulationRun carregam
-- data.populationRunId (nulo para execuções individuais — comportamento
-- inalterado). Coluna gerada apenas expõe esse campo para indexação.
alter table runs add column if not exists population_run_id text generated always as (data->>'populationRunId') stored;
create index if not exists runs_population_run_idx on runs (population_run_id);

-- --------------------------------------------------- 3) trigger updated_at
drop trigger if exists trg_population_runs_updated_at on population_runs;
create trigger trg_population_runs_updated_at before update on population_runs for each row execute function set_updated_at();

-- ------------------------------------------------------------- 4) RLS
-- Mesmo padrão restritivo já usado nas demais tabelas: cada usuário só
-- enxerga/edita as próprias PopulationRuns (owner_id = auth.uid()).
alter table population_runs enable row level security;
drop policy if exists population_runs_select on population_runs;
drop policy if exists population_runs_insert on population_runs;
drop policy if exists population_runs_update on population_runs;
drop policy if exists population_runs_delete on population_runs;
create policy population_runs_select on population_runs for select to authenticated using (owner_id = auth.uid());
create policy population_runs_insert on population_runs for insert to authenticated with check (owner_id = auth.uid());
create policy population_runs_update on population_runs for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy population_runs_delete on population_runs for delete to authenticated using (owner_id = auth.uid());
