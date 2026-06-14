-- ─────────────────────────────────────────────────────────────
-- Migration 008 — Facture de commission
-- À exécuter dans Supabase : Dashboard → SQL Editor → New query
-- Idempotent.
-- ─────────────────────────────────────────────────────────────

alter table mandats add column if not exists facture_pdf_url text;
