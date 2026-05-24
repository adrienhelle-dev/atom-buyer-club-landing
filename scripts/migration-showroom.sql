-- ─── Table showroom_items ─────────────────────────────────────────────────────

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
  images_after        text[],        -- URLs après travaux (principal)
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

  -- Matching projet disponible
  projet_similaire_id uuid REFERENCES projects(id) ON DELETE SET NULL,

  -- Display
  ordre               integer DEFAULT 0,
  is_published        boolean DEFAULT false,
  is_featured         boolean DEFAULT false,

  -- Metadata scraping
  source_url          text,
  scraped_at          timestamptz
);

-- Index pour les requêtes publiques
CREATE INDEX IF NOT EXISTS idx_showroom_published ON showroom_items(is_published, ordre);
CREATE INDEX IF NOT EXISTS idx_showroom_slug ON showroom_items(slug);

-- RLS : lecture publique des items publiés, écriture admin seulement via service role
ALTER TABLE showroom_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read published showroom" ON showroom_items
  FOR SELECT USING (is_published = true);

CREATE POLICY "Service role full access showroom" ON showroom_items
  USING (true) WITH CHECK (true);
