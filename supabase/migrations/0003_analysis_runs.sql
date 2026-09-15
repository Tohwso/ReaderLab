-- ============ ReaderLab — Migration: AnalysisRun (Research Analyst) ============
-- Adiciona o conceito de AnalysisRun (uma interpretação, por IA, dos
-- resultados já produzidos por uma PopulationRun — ver
-- js/analysisEngine.js) a um projeto ReaderLab JÁ EXISTENTE. Não apaga nem
-- altera nenhum dado de personas/runs/results/population_runs existentes.
--
-- Rode isto UMA VEZ, direto no SQL Editor do Supabase Dashboard (cole o
-- arquivo inteiro e clique em Run) — ou via `npx supabase@latest db push`.
--
-- Pré-requisito: já ter aplicado 0002_population_runs.sql.

-- ---------------------------------------------------- 1) tabela analysis_runs
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

-- --------------------------------------------------- 2) trigger updated_at
drop trigger if exists trg_analysis_runs_updated_at on analysis_runs;
create trigger trg_analysis_runs_updated_at before update on analysis_runs for each row execute function set_updated_at();

-- ------------------------------------------------------------- 3) RLS
-- Mesmo padrão restritivo já usado nas demais tabelas: cada usuário só
-- enxerga/edita as próprias AnalysisRuns (owner_id = auth.uid()).
alter table analysis_runs enable row level security;
drop policy if exists analysis_runs_select on analysis_runs;
drop policy if exists analysis_runs_insert on analysis_runs;
drop policy if exists analysis_runs_update on analysis_runs;
drop policy if exists analysis_runs_delete on analysis_runs;
create policy analysis_runs_select on analysis_runs for select to authenticated using (owner_id = auth.uid());
create policy analysis_runs_insert on analysis_runs for insert to authenticated with check (owner_id = auth.uid());
create policy analysis_runs_update on analysis_runs for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy analysis_runs_delete on analysis_runs for delete to authenticated using (owner_id = auth.uid());
