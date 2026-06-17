-- ─────────────────────────────────────────────────────────────
-- Migration 013 — Verrouillage RLS sur toutes les tables publiques
-- Corrige l'alerte Supabase « rls_disabled_in_public ».
--
-- Contexte : l'application accède à Supabase UNIQUEMENT côté serveur via la clé
-- service (SUPABASE_SERVICE_KEY), qui contourne la RLS. Aucun accès anon/public
-- direct (pas de client Supabase dans le navigateur, pas de clé anon dans le code).
-- On peut donc :
--   1) activer la RLS sur toutes les tables de l'app,
--   2) supprimer toute policy existante (y compris permissive créée via l'UI),
--   3) ne (re)créer qu'une policy réservée au rôle service_role.
-- Résultat : l'app continue de fonctionner (clé service), tout accès public
-- direct via l'API REST Supabase est bloqué.
--
-- À exécuter dans Supabase : Dashboard → SQL Editor → New query. Idempotent.
-- ─────────────────────────────────────────────────────────────

do $$
declare
  t text;
  pol record;
  tables text[] := array[
    'asset_monthly_performance',
    'manual_bookings',
    'assets',
    'fiche_queue',
    'lead_events',
    'leads',
    'lease_companies',
    'leases',
    'mandat_documents',
    'mandats',
    'project_interests',
    'project_showroom_links',
    'projects',
    'showroom_items',
    'telegram_pending_leads'
  ];
begin
  foreach t in array tables loop
    -- la table peut ne pas exister selon l'historique → on ignore le cas échéant
    if to_regclass('public.' || t) is not null then
      -- 1) activer la RLS
      execute format('alter table public.%I enable row level security;', t);
      -- 2) supprimer toutes les policies existantes (repart d'une base propre)
      for pol in
        select policyname from pg_policies where schemaname = 'public' and tablename = t
      loop
        execute format('drop policy %I on public.%I;', pol.policyname, t);
      end loop;
      -- 3) une seule policy : accès total réservé au service_role
      execute format('create policy "service_full_access" on public.%I to service_role using (true) with check (true);', t);
    end if;
  end loop;
end $$;
