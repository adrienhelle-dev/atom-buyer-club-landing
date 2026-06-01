-- Run this in Supabase SQL editor (Dashboard → SQL Editor → New query)

create table if not exists leads (
  id              uuid default gen_random_uuid() primary key,
  created_at      timestamptz default now() not null,
  prenom          text not null,
  nom             text not null,
  email           text not null,
  tel             text not null,
  arrondissements text,
  timing          text,
  accord          text,
  financement     text,
  capacite        text,
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  utm_content     text,
  utm_term        text,
  gclid           text,
  fbclid          text,
  ttclid          text,                 -- TikTok Ads
  li_fat_id       text,                 -- LinkedIn Ads
  msclkid         text,                 -- Microsoft / Bing Ads
  referrer        text,
  landing_page    text,                 -- 1ère page d'atterrissage (first-touch)
  last_utm_source   text,               -- dernier canal vu avant conversion (last-touch)
  last_utm_medium   text,
  last_utm_campaign text,
  ip              text
);

-- Index for faster queries
create index if not exists leads_created_at_idx     on leads (created_at desc);
create index if not exists leads_utm_source_idx     on leads (utm_source);
create index if not exists leads_email_idx          on leads (email);
create index if not exists leads_utm_campaign_idx    on leads (utm_campaign);
create index if not exists leads_last_utm_source_idx on leads (last_utm_source);

-- Disable Row Level Security (API uses service key = bypasses RLS anyway)
alter table leads disable row level security;
