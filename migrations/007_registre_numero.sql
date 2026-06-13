-- ─────────────────────────────────────────────────────────────
-- Migration 007 — Déversement dans le registre
-- À exécuter dans Supabase : Dashboard → SQL Editor → New query
--
-- Un mandat généré (offre→mandat) n'apparaît dans le Registre qu'après un CTA
-- explicite « Déverser dans le registre », qui lui attribue son numéro à ce
-- moment-là (registre_numero). Les mandats importés (101→159) sont déjà déversés.
--
-- "Dans le registre" ⇔ registre_numero IS NOT NULL.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────

alter table mandats add column if not exists registre_numero int;
alter table mandats add column if not exists registre_at timestamptz;

-- Unicité du numéro de registre (hors NULL)
create unique index if not exists mandats_registre_numero_uniq
  on mandats (registre_numero) where registre_numero is not null;
