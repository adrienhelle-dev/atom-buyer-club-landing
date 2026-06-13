// scripts/import-mandats.js
// Import du registre historique MicroSurfaces (mandats 101→159) depuis
// scripts/data/mandats-import.json.
//
// Idempotent : supprime les mandats de test (n° < 100) et les imports précédents
// (source='import_microsurfaces') avant de réinsérer. Les mandants sont créés en
// leads acquéreurs (is_acquereur=true), dédupliqués par nom+prénom.
//
// Usage :
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/import-mandats.js [--dry]
//
// Prérequis : migration 006 appliquée (colonnes mandats + leads.is_acquereur + RPC).

const fs = require('fs');
const path = require('path');
const { supabase } = require('../lib/supabase');

const DRY = process.argv.includes('--dry');

const norm = s => (s || '').toString().trim().toLowerCase();

// État (couleur) → statut du flux offre/mandat
function statutFromEtat(etat) {
  return etat === 'tombe' ? 'abandonne' : 'mandat_signe';
}

async function findOrCreateLead(m, cache) {
  const key = `${norm(m.prenom)}|${norm(m.nom)}`;
  if (cache.has(key)) return cache.get(key);

  // Cherche un lead existant par prénom+nom (réutilise s'il existe déjà)
  const { data: existing } = await supabase
    .from('leads').select('id, is_acquereur')
    .ilike('prenom', m.prenom || '').ilike('nom', m.nom || '')
    .limit(1).maybeSingle();

  if (existing?.id) { cache.set(key, existing.id); return existing.id; }

  const leadData = {
    prenom: m.prenom || null,
    nom: m.nom || null,
    is_acquereur: true,
    utm_source: 'mandat_microsurfaces',
    status: 'signe',
    adresse_residence: m.mandant_domiciliation || null,
  };
  if (m.mandant_sci) { leadData.achat_structure = 'sci'; leadData.nom_structure = m.mandant_sci; }

  if (DRY) { cache.set(key, `dry-${key}`); return `dry-${key}`; }
  const { data: created, error } = await supabase.from('leads').insert([leadData]).select('id').single();
  if (error) throw new Error(`lead ${m.prenom} ${m.nom}: ${error.message}`);
  cache.set(key, created.id);
  return created.id;
}

async function main() {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'mandats-import.json'), 'utf8'));
  console.log(`📋 ${rows.length} mandats à importer (101→159)${DRY ? '  [DRY-RUN]' : ''}`);

  // 1. Nettoyage : mandats de test (n° < 100) + imports précédents
  if (!DRY) {
    const { error: e1 } = await supabase.from('mandats').delete().lt('numero', 100);
    if (e1) throw new Error('delete tests: ' + e1.message);
    const { error: e2 } = await supabase.from('mandats').delete().eq('source', 'import_microsurfaces');
    if (e2) throw new Error('delete prev import: ' + e2.message);
    console.log('🧹 mandats de test (n°<100) + import précédent supprimés');
  }

  // 2. Import
  const leadCache = new Map();
  let created = 0;
  for (const m of rows) {
    const leadId = await findOrCreateLead(m, leadCache);
    const mandat = {
      numero: m.numero,
      registre_numero: m.numero,   // déjà déversé au registre (historique)
      lead_id: DRY ? null : leadId,
      project_id: null,
      source: 'import_microsurfaces',
      etat: m.etat,
      statut: statutFromEtat(m.etat),
      commission: m.fees_ttc || null,
      prix_offre: m.prix_hai || null,
      prix_hai: m.prix_hai || null,
      date_mandat: m.date_mandat || null,
      date_fin_mandat: m.date_fin_mandat || null,
      type_mandat: m.type_mandat || null,
      commission_partie: m.commission_partie || null,
      nature_bien: m.nature_bien || null,
      adresse_num: m.adresse_num || null,
      adresse_rue: m.adresse_rue || null,
      adresse_cp: m.adresse_cp || null,
      adresse_ville: m.adresse_ville || null,
      mandant_domiciliation: m.mandant_domiciliation || null,
      mandant_sci: m.mandant_sci || null,
      date_promesse: m.date_promesse || null,
      delai_realisation: m.delai_realisation || null,
      dossier_notaire_envoye: !!m.dossier_notaire_envoye,
      fees_paid: !!m.fees_paid,
      notaire_nom: 'Maître Nicolas Chauris',
      notaire_email: 'nicolas.chauris@notaires.fr',
    };
    if (DRY) { created++; continue; }
    const { error } = await supabase.from('mandats').insert([mandat]);
    if (error) throw new Error(`mandat n°${m.numero}: ${error.message}`);
    created++;
  }
  console.log(`✅ ${created} mandats importés · ${leadCache.size} leads acquéreurs (créés ou réutilisés)`);
  console.log('🔢 numéros de registre 101→159 attribués · prochain déversement = 160 (max+1)');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌', e.message); process.exit(1); });
