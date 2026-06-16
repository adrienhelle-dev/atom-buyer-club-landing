-- ─────────────────────────────────────────────────────────────
-- Migration 012 — Clause de sous-location optionnelle sur les baux
-- À exécuter dans Supabase : Dashboard → SQL Editor → New query. Idempotent.
-- ─────────────────────────────────────────────────────────────

-- true (défaut) = clause d'interdiction de sous-location incluse dans le bail.
-- false = clause exclue du PDF généré.
alter table leases add column if not exists clause_sous_location boolean default true;
