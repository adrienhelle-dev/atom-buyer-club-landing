-- ─────────────────────────────────────────────────────────────
-- Migration 011 — Baux (mobilité / code civil) + sociétés en mémoire
-- À exécuter dans Supabase : Dashboard → SQL Editor → New query. Idempotent.
-- ─────────────────────────────────────────────────────────────

-- Sociétés mémorisées (groupe + externes) pour préremplir bailleur/locataire
create table if not exists lease_companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  forme         text,                 -- ex. 'SAS'
  rcs_numero    text,                  -- '931 734 784'
  rcs_ville     text,                  -- 'Nanterre'
  capital       text,                  -- optionnel (non imprimé sur le bail)
  siege         text,
  representant_nom     text,
  representant_qualite text,           -- 'Directeur Général' | 'Président'
  email         text,
  is_group      boolean default false, -- true = société du groupe Atom
  created_by    text,
  created_at    timestamptz default now()
);

-- Baux générés (rattachés à une réalisation showroom)
create table if not exists leases (
  id               uuid primary key default gen_random_uuid(),
  numero           serial,
  showroom_item_id uuid references showroom_items(id) on delete set null,
  type             text not null,            -- 'mobilite' | 'code_civil'
  statut           text default 'brouillon', -- brouillon|genere|envoye|signe_locataire|contresigne|actif|expire
  -- Parties (snapshots figés au moment du bail)
  bailleur         jsonb,   -- {name, forme, rcs_numero, rcs_ville, siege, representant_nom, representant_qualite}
  locataire        jsonb,   -- {kind:'physique'|'societe', prenom, nom, nationalite, dob, adresse, piece, ... | société}
  lead_id          uuid references leads(id) on delete set null,
  bien             jsonb,   -- {adresse, designation, surface, etage, lot_copro, habitation, equipements, localisation}
  -- Montants & conditions
  loyer_base       numeric(10,2),
  complement_loyer numeric(10,2),
  charges          numeric(10,2),
  services         numeric(10,2),
  frais_menage     numeric(10,2),
  depot_garantie   numeric(10,2),
  loyer_ref_majore numeric(10,2),           -- encadrement des loyers (optionnel)
  preavis          text,
  date_debut       date,
  date_fin         date,
  duree            text,
  -- Mobilité
  motif            text,
  motif_justificatif text,
  justificatif_url text,
  -- Documents
  pdf_url               text,   -- bail généré (non signé)
  pdf_signe_locataire_url text, -- signé côté locataire
  pdf_contresigne_url   text,   -- version pleinement contresignée
  -- Rappels d'échéance
  reminder_j30     boolean default false,
  reminder_j15     boolean default false,
  created_by       text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists leases_showroom_idx on leases (showroom_item_id);
create index if not exists leases_statut_idx   on leases (statut);
create index if not exists leases_datefin_idx  on leases (date_fin);

-- RLS : service key = accès total (comme les autres tables)
alter table lease_companies enable row level security;
drop policy if exists "service_full_access" on lease_companies;
create policy "service_full_access" on lease_companies using (true) with check (true);

alter table leases enable row level security;
drop policy if exists "service_full_access" on leases;
create policy "service_full_access" on leases using (true) with check (true);
