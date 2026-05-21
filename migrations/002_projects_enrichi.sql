-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 002 — Enrichissement table projects + alignement events
-- À exécuter dans Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Enrichir la table projects ─────────────────────────────
-- Renommer les colonnes existantes pour aligner avec le nouveau schéma
ALTER TABLE projects RENAME COLUMN titre   TO title;
ALTER TABLE projects RENAME COLUMN adresse TO address;
ALTER TABLE projects RENAME COLUMN prix    TO price_fai_text;  -- l'ancien était text, on garde temporairement

-- Ajouter toutes les nouvelles colonnes
ALTER TABLE projects ADD COLUMN IF NOT EXISTS arrondissement   text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS surface_carrez   numeric(6,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS floor            integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS has_elevator     boolean DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS price_fai        integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS fees_atom        integer DEFAULT 8900;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS fees_notaire     integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_travaux   integer DEFAULT 35000;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_meuble    integer DEFAULT 3000;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS total_all_in     integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS loyer_atom       integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS mensualite       integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS rendement_brut   numeric(5,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status           text DEFAULT 'disponible';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dpe_avant        text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dpe_apres        text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS images           text[] DEFAULT '{}'::text[];
ALTER TABLE projects ADD COLUMN IF NOT EXISTS images_3d        text[] DEFAULT '{}'::text[];
ALTER TABLE projects ADD COLUMN IF NOT EXISTS plan_2d_url      text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS metro_distance   integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS metro_name       text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS published_at     timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sent_count       integer DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS slug             text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS public_visible   boolean DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ameublement_desc text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ameublement      jsonb DEFAULT '{}'::jsonb;

-- Index pour les filtres fréquents
CREATE INDEX IF NOT EXISTS projects_status_idx         ON projects (status);
CREATE INDEX IF NOT EXISTS projects_arrondissement_idx ON projects (arrondissement);
CREATE INDEX IF NOT EXISTS projects_slug_idx           ON projects (slug);

-- Drop l'ancien champ `actif` qui devient redondant avec `status`
-- (on garde temporairement pour rétro-compat)
-- ALTER TABLE projects DROP COLUMN IF EXISTS actif;


-- ─── 2. Aligner lead_events avec le nouveau vocabulaire ────────
-- Les anciens types restent valides, on ajoute simplement les nouveaux.
-- Mapping rétro-compatible côté frontend :
--   inscription     → form_submitted
--   resoumission    → form_submitted (avec metadata.update=true)
--   status_change   → status_changed
--   fiche_envoyee   → fiche_sent
--   note            → note (inchangé)
--   rdv             → meeting_scheduled

-- Ajouter une colonne metadata jsonb pour stocker les infos structurées
ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- Renommer pour cohérence avec le MD (lead_events → lead_activities)
-- On garde le nom lead_events pour éviter de casser les API existantes,
-- mais on documente l'alias mental "activities = events".


-- ─── 3. Vérification ───────────────────────────────────────────
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'projects' ORDER BY ordinal_position;
