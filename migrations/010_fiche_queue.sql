-- ─────────────────────────────────────────────────────────────
-- Migration 010 — File d'attente d'envoi des fiches (50/heure)
-- À exécuter dans Supabase : Dashboard → SQL Editor → New query
--
-- L'envoi groupé d'une fiche met les leads en file (pending) ; les 50 premiers
-- partent tout de suite, le reste par paquets de 50/heure via le cron
-- api/cron/fiche-queue. Idempotent.
-- ─────────────────────────────────────────────────────────────

create table if not exists fiche_queue (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references projects(id) on delete cascade,
  lead_id      uuid references leads(id) on delete cascade,
  message      text,
  requested_by text,
  status       text default 'pending',   -- pending | sent | failed
  error        text,
  created_at   timestamptz default now(),
  sent_at      timestamptz
);
create index if not exists fiche_queue_status_idx on fiche_queue (status, created_at);

alter table fiche_queue enable row level security;
drop policy if exists "service_full_access" on fiche_queue;
create policy "service_full_access" on fiche_queue using (true) with check (true);
