-- Leads en attente de confirmation (flux : screenshot Telegram → vision → confirmation → CRM)
-- À exécuter une fois dans Supabase (SQL Editor). Non destructif.

create table if not exists telegram_pending_leads (
  id          uuid primary key default gen_random_uuid(),
  chat_id     text not null,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

-- (optionnel) purge auto possible plus tard ; pour l'instant on supprime à la création/annulation.
