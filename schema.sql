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
  referrer        text,
  ip              text
);

-- Index for faster queries
create index if not exists leads_created_at_idx on leads (created_at desc);
create index if not exists leads_utm_source_idx on leads (utm_source);
create index if not exists leads_email_idx      on leads (email);

-- Disable Row Level Security (API uses service key = bypasses RLS anyway)
alter table leads disable row level security;
