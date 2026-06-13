-- ─────────────────────────────────────────────────────────────
-- Migration 006 — Registre des mandats (historique MicroSurfaces) + suivi acquéreur
-- À exécuter dans Supabase : Dashboard → SQL Editor → New query
--
-- 1. Colonnes registre/suivi sur la table mandats (mandats historiques 101→159
--    importés depuis le fichier Excel, sans projet sur le site)
-- 2. Marqueur is_acquereur sur leads (acquéreurs importés, masqués de l'onglet Leads)
-- 3. Fonction RPC pour réaligner la séquence des numéros après import
--
-- Idempotent : peut être relancée sans risque.
-- ─────────────────────────────────────────────────────────────

-- ── 1. mandats : champs registre + suivi acquéreur ───────────
alter table mandats add column if not exists etat                   text default 'actif';  -- 'actif' | 'tombe' | 'inactif'
alter table mandats add column if not exists source                 text default 'systeme'; -- 'systeme' | 'import_microsurfaces'
alter table mandats add column if not exists date_mandat            date;
alter table mandats add column if not exists date_fin_mandat        date;
alter table mandats add column if not exists prix_hai               numeric(12,2);
alter table mandats add column if not exists type_mandat            text;
alter table mandats add column if not exists commission_partie      text;   -- 'Acheteur' | 'Vendeur'
alter table mandats add column if not exists nature_bien            text;
alter table mandats add column if not exists adresse_num            text;
alter table mandats add column if not exists adresse_rue            text;
alter table mandats add column if not exists adresse_cp             text;
alter table mandats add column if not exists adresse_ville          text;
alter table mandats add column if not exists mandant_domiciliation  text;
alter table mandats add column if not exists mandant_sci            text;
alter table mandats add column if not exists date_promesse          date;
alter table mandats add column if not exists delai_realisation      text;
alter table mandats add column if not exists promesse_pdf_url        text;
alter table mandats add column if not exists acte_pdf_url            text;
alter table mandats add column if not exists fees_paid              boolean default false;
alter table mandats add column if not exists dossier_notaire_envoye boolean default false;

create index if not exists mandats_etat_idx   on mandats (etat);
create index if not exists mandats_source_idx on mandats (source);

-- ── 2. leads : marqueur acquéreur importé ────────────────────
-- Ces leads (mandants historiques) sont créés sans tel/mail ; ils ne doivent PAS
-- apparaître dans l'onglet Leads ni le scoring — uniquement dans Suivi acquéreurs.
alter table leads add column if not exists is_acquereur boolean default false;
create index if not exists leads_is_acquereur_idx on leads (is_acquereur);

-- ── 3. Réalignement de la séquence des numéros de mandat ──────
-- Après import des numéros explicites 101→159, le prochain mandat auto-généré
-- doit prendre 160. Appelée par le script d'import via supabase.rpc().
create or replace function reset_mandats_numero_seq(next_val bigint)
returns bigint language sql security definer as $$
  select setval(pg_get_serial_sequence('mandats', 'numero'), next_val, false);
$$;
