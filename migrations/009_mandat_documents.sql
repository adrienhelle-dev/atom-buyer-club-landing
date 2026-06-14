-- ─────────────────────────────────────────────────────────────
-- Migration 009 — Documents multiples par mandat
-- À exécuter dans Supabase : Dashboard → SQL Editor → New query
--
-- Permet d'uploader plusieurs fichiers par catégorie (offre, mandat, pièce ID,
-- promesse, acte, facture) avec métadonnées (nom, taille). Les colonnes
-- *_pdf_url existantes restent le doc "primaire" (généré/importé) ; cette table
-- stocke l'historique complet des fichiers. L'affichage fusionne les deux.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────

create table if not exists mandat_documents (
  id          uuid primary key default gen_random_uuid(),
  mandat_id   uuid references mandats(id) on delete cascade,
  kind        text not null,             -- offre|mandat|identite|promesse|acte|facture
  url         text not null,
  filename    text,
  size_bytes  bigint,
  uploaded_by text,
  created_at  timestamptz default now()
);
create index if not exists mandat_documents_mandat_idx on mandat_documents (mandat_id);

-- Postgres ne supporte pas CREATE POLICY IF NOT EXISTS → drop puis create (idempotent)
alter table mandat_documents enable row level security;
drop policy if exists "service_full_access" on mandat_documents;
create policy "service_full_access" on mandat_documents using (true) with check (true);
