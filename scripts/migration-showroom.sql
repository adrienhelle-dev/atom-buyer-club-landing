-- ─── Migration showroom_items ─────────────────────────────────────────────────
-- À exécuter dans : Supabase Dashboard → SQL Editor
-- Idempotent : peut être relancé sans erreur

-- 1. Création de la table
CREATE TABLE IF NOT EXISTS showroom_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz DEFAULT now(),

  -- Identité
  slug                text UNIQUE NOT NULL,
  name                text NOT NULL,
  quartier            text,
  arrondissement      text,
  surface             numeric,
  style               text,          -- Contemporain / Loft / Haussmannien / Design / Industriel / Minimaliste
  description_courte  text,          -- tagline max 100 chars
  description_longue  text,
  equipements         text[],
  caracteristiques    text[],
  dpe                 text,

  -- Visuels
  images_before       text[],        -- URLs avant travaux
  images_after        text[],        -- URLs après travaux
  image_cover         text,          -- photo de couverture
  video_url           text,

  -- Financials (saisis manuellement)
  prix_acquisition    integer,
  budget_travaux      integer,
  total_all_in        integer,       -- calculé = prix_acquisition + budget_travaux
  loyer_mensuel       integer,
  rendement_brut      numeric,       -- calculé = loyer * 12 / total_all_in * 100
  mensualite_type     integer,       -- 10% apport, 25 ans, 3.6%
  statut_location     text DEFAULT 'Loué',
  locataire_type      text,

  -- Matching projet disponible (UUID sans contrainte FK — évite les erreurs si projects n'existe pas)
  projet_similaire_id uuid,

  -- Display
  ordre               integer DEFAULT 0,
  is_published        boolean DEFAULT false,
  is_featured         boolean DEFAULT false,

  -- Metadata scraping
  source_url          text,
  scraped_at          timestamptz
);

-- 2. FK vers projects (ajoutée séparément pour ne pas bloquer si la table n'existe pas encore)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_showroom_projet_similaire'
      AND table_name = 'showroom_items'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'projects'
    ) THEN
      ALTER TABLE showroom_items
        ADD CONSTRAINT fk_showroom_projet_similaire
        FOREIGN KEY (projet_similaire_id) REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
  END IF;
EXCEPTION WHEN others THEN
  NULL; -- non-fatal
END $$;

-- 3. Index pour les requêtes publiques
CREATE INDEX IF NOT EXISTS idx_showroom_published ON showroom_items(is_published, ordre);
CREATE INDEX IF NOT EXISTS idx_showroom_slug      ON showroom_items(slug);

-- 4. RLS : lecture publique des items publiés, écriture via service_role (bypass RLS)
ALTER TABLE showroom_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read published showroom" ON showroom_items;
CREATE POLICY "Public read published showroom" ON showroom_items
  FOR SELECT USING (is_published = true);

-- Note : l'API utilise la clé service_role qui bypass RLS automatiquement.
-- Aucune autre policy n'est nécessaire.
