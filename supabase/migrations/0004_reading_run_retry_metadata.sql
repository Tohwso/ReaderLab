-- ============ ReaderLab — Migration: retry persistente de ReadingRun ============
-- Adiciona a coluna gerada `next_retry_at` (projeção de data->>'nextRetryAt')
-- à tabela `runs` JÁ EXISTENTE, para permitir localizar rapidamente
-- ReadingRuns aguardando uma nova tentativa (status = WAITING_RETRY) sem
-- precisar carregar a tabela inteira — mesmo padrão já usado para
-- persona_id/survey_id/status/population_run_id.
--
-- NÃO apaga nem altera nenhuma ReadingRun existente: `data` continua sendo
-- a única fonte de verdade (attemptCount/lastErrorType/lastErrorMessage/
-- lastAttemptAt/nextRetryAt e o novo status "WAITING_RETRY" já cabem dentro
-- do jsonb existente, sem qualquer alteração de schema necessária para
-- funcionar) — esta coluna é apenas uma projeção derivada/indexável,
-- opcional para o funcionamento da aplicação.
--
-- Rode isto UMA VEZ, direto no SQL Editor do Supabase Dashboard (cole o
-- arquivo inteiro e clique em Run) — ou via `npx supabase@latest db push`.
--
-- Pré-requisito: já ter aplicado 0002_population_runs.sql.

alter table runs
  add column if not exists next_retry_at timestamptz generated always as ((data->>'nextRetryAt')::timestamptz) stored;

create index if not exists runs_next_retry_at_idx on runs (next_retry_at) where status = 'WAITING_RETRY';
