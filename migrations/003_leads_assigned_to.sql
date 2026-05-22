-- Migration 003 : Ajout colonne assigned_to sur leads
-- À exécuter dans Supabase → SQL Editor

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS assigned_to text;

-- Vérification
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'leads' AND column_name = 'assigned_to';
