-- ─────────────────────────────────────────────────────────────
-- Migration 005 — Offres d'achat & Mandats de recherche
-- À exécuter dans Supabase : Dashboard → SQL Editor → New query
--
-- 1. Colonnes KYC acheteur sur leads (infos nécessaires pour
--    générer une offre ou un mandat : DOB, adresse, situation…)
-- 2. Table mandats (compteur auto, lien lead + projet, DocuSign)
-- 3. Colonnes de suivi de visite sur lead_events (content JSON)
--    → aucun changement schema, géré applicativement via content
--
-- Idempotent : peut être relancée sans risque.
-- ─────────────────────────────────────────────────────────────

-- ── 1. Infos complémentaires acheteur ────────────────────────
alter table leads add column if not exists date_naissance      date;
alter table leads add column if not exists adresse_residence   text;
alter table leads add column if not exists situation_familiale text;  -- 'celibataire' | 'marie' | 'pacse' | 'divorce'
alter table leads add column if not exists conjoint_prenom     text;
alter table leads add column if not exists conjoint_nom        text;
alter table leads add column if not exists conjoint_dob        date;
alter table leads add column if not exists achat_structure     text;  -- 'personnel' | 'sci' | 'sas'
alter table leads add column if not exists nom_structure       text;  -- si sci/sas : nom de la société
alter table leads add column if not exists pj_identite_url     text;  -- URL du fichier uploadé (Supabase Storage)
alter table leads add column if not exists infos_token         text;  -- token court pour la landing page info-acheteur

-- ── 2. Table mandats ─────────────────────────────────────────
create table if not exists mandats (
  id              uuid primary key default gen_random_uuid(),
  numero          serial not null,             -- numéro séquentiel (162, 163…)
  lead_id         uuid references leads(id) on delete set null,
  project_id      uuid references projects(id) on delete set null,
  interest_event_id uuid,                       -- id de l'événement lead_events source
  commission      numeric(10,2) default 8900,
  prix_offre      numeric(10,2),               -- prix de l'offre d'achat associée
  notaire_nom     text default 'Maître Nicolas Chauris',
  notaire_email   text default 'nicolas.chauris@notaires.fr',
  notaire_adresse text default '40 Avenue des Chartreux, 13004 Marseille',
  notaire_tel     text default '04 91 78 94 34',
  statut          text default 'offre_generee', -- 'offre_generee' | 'offre_envoyee' | 'mandat_genere' | 'mandat_envoye' | 'mandat_signe' | 'abandonne'
  offre_pdf_url   text,
  mandat_pdf_url  text,
  docusign_envelope_id text,
  created_by      text,                         -- email fondateur
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- Index utiles
create index if not exists mandats_lead_id_idx    on mandats (lead_id);
create index if not exists mandats_project_id_idx on mandats (project_id);
create index if not exists mandats_statut_idx     on mandats (statut);

-- Trigger updated_at
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists mandats_updated_at on mandats;
create trigger mandats_updated_at
  before update on mandats
  for each row execute function set_updated_at();

-- ── 3. RLS : même politique que les autres tables métier ─────
alter table mandats enable row level security;

-- Service key (backend) = accès total
create policy if not exists "service_full_access" on mandats
  using (true) with check (true);
