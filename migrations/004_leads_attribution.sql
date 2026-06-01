-- ─────────────────────────────────────────────────────────────
-- Migration 004 — Attribution ads (first-touch + last-touch)
-- À exécuter dans Supabase : Dashboard → SQL Editor → New query
--
-- Ajoute les colonnes nécessaires au tracking robuste mis en place
-- dans /track.js + api/submit.js :
--   - click ids supplémentaires (TikTok / LinkedIn / Bing)
--   - landing_page : 1ère page d'atterrissage (first-touch)
--   - last_utm_*    : dernier canal vu avant conversion (last-touch)
--
-- Idempotent : peut être relancée sans risque.
-- ⚠️ À PASSER AVANT de déployer le nouveau submit.js (sinon les
--    inserts échoueront sur les colonnes inconnues).
-- ─────────────────────────────────────────────────────────────

alter table leads add column if not exists ttclid            text;  -- TikTok Ads
alter table leads add column if not exists li_fat_id         text;  -- LinkedIn Ads
alter table leads add column if not exists msclkid           text;  -- Microsoft / Bing Ads
alter table leads add column if not exists landing_page      text;  -- 1ère page (first-touch)
alter table leads add column if not exists last_utm_source   text;  -- dernier canal
alter table leads add column if not exists last_utm_medium   text;
alter table leads add column if not exists last_utm_campaign text;

-- Index pour le reporting par campagne (first + last touch)
create index if not exists leads_utm_campaign_idx      on leads (utm_campaign);
create index if not exists leads_last_utm_source_idx   on leads (last_utm_source);
