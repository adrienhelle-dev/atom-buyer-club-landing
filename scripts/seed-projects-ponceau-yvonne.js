/**
 * seed-projects-ponceau-yvonne.js
 * Crée les projets "Ponceau" et "Yvonne-le-Tac" en brouillon avec leurs photos extraites des PDF.
 *
 * Usage : npx vercel env run -- node scripts/seed-projects-ponceau-yvonne.js
 *
 * Idempotent sur le slug (upsert) — peut être relancé sans doublon.
 */

const { createClient } = require('@supabase/supabase-js');
const fs   = require('fs');
const path = require('path');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌  SUPABASE_URL ou SUPABASE_SERVICE_KEY manquants');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BUCKET = 'project-images';

// ── Helpers ────────────────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function num(v) { return Number(v) || 0; }

function computeFinancials({ price_fai, fees_atom, fees_notaire, budget_travaux, budget_meuble, loyer_atom }) {
  const prix = num(price_fai), fa = num(fees_atom), fn = num(fees_notaire);
  const bt   = num(budget_travaux), bm = num(budget_meuble), loyer = num(loyer_atom);
  const total = prix + fa + fn + bt + bm;
  if (!total) return { total_all_in: null, mensualite: null, rendement_brut: null };
  const apport    = Math.round(total * 0.10);
  const principal = total - apport;
  const taux_m    = 3.6 / 100 / 12;
  const n         = 25 * 12;
  const mensualite = principal > 0
    ? Math.round(principal * taux_m * Math.pow(1 + taux_m, n) / (Math.pow(1 + taux_m, n) - 1))
    : null;
  const rendement_brut = total > 0 && loyer > 0
    ? Math.round(((loyer * 12) / total) * 1000) / 10
    : null;
  return { total_all_in: total, mensualite, rendement_brut };
}

async function uploadImage(filePath, folder) {
  const content  = fs.readFileSync(filePath);
  const ext      = path.extname(filePath).slice(1).toLowerCase() || 'jpg';
  const basename = path.basename(filePath, path.extname(filePath)).slice(0, 40);
  const storagePath = `${folder}/${Date.now()}-${basename}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, content, {
      contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      upsert: false,
    });

  if (error) {
    console.error(`    ✗ upload ${path.basename(filePath)}: ${error.message}`);
    return null;
  }

  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  console.log(`    ✓ ${path.basename(filePath)} → ${publicUrl.slice(0, 70)}...`);
  return publicUrl;
}

// ── Images extraites par PyMuPDF ────────────────────────────────────────────
// Ponceau — État actuel page 2 (photos réelles) + page 4 (3D ameublement)
const PONCEAU_PHOTOS = [
  '/tmp/pdf-imgs/ponceau_photos_p2_73.jpeg',  // panoramique principale
  '/tmp/pdf-imgs/ponceau_photos_p2_57.jpeg',  // portrait 1
  '/tmp/pdf-imgs/ponceau_photos_p2_59.jpeg',  // portrait 2
  '/tmp/pdf-imgs/ponceau_photos_p2_63.jpeg',  // cuisine fenêtre
  '/tmp/pdf-imgs/ponceau_photos_p2_67.jpeg',  // dressing
].filter(f => fs.existsSync(f));

const PONCEAU_3D = [
  '/tmp/pdf-imgs/ponceau_images_3d_p4_140.jpeg', // grande 3D ameublée
  '/tmp/pdf-imgs/ponceau_images_3d_p4_138.jpeg', // 3D ameublée 2
].filter(f => fs.existsSync(f));

// Yvonne-le-Tac — État actuel page 2 + 3D pages 4 et 6
const YVONNE_PHOTOS = [
  '/tmp/pdf-imgs/yvonne_photos_p2_77.jpeg',   // panoramique principale
  '/tmp/pdf-imgs/yvonne_photos_p2_67.jpeg',   // portrait 1
  '/tmp/pdf-imgs/yvonne_photos_p2_65.jpeg',   // portrait 2
  '/tmp/pdf-imgs/yvonne_photos_p2_71.jpeg',   // salle de bain
  '/tmp/pdf-imgs/yvonne_photos_p2_75.jpeg',   // cuisine
].filter(f => fs.existsSync(f));

const YVONNE_3D = [
  '/tmp/pdf-imgs/yvonne_images_3d_p6_171.jpeg', // 3D grande
  '/tmp/pdf-imgs/yvonne_images_3d_p6_175.jpeg', // 3D grande 2
  '/tmp/pdf-imgs/yvonne_images_3d_p4_151.jpeg', // 3D portrait chambre
  '/tmp/pdf-imgs/yvonne_images_3d_p4_153.jpeg', // 3D portrait bureau
  '/tmp/pdf-imgs/yvonne_images_3d_p4_155.jpeg', // 3D sdb
].filter(f => fs.existsSync(f));

// ── Données projet ──────────────────────────────────────────────────────────
const PROJECTS = [
  {
    slug:            'ponceau',
    title:           'Ponceau',
    address:         '11 rue du Ponceau 75002',
    arrondissement:  '2e',
    surface_carrez:  10.5,
    floor:           '4ème étage',
    has_elevator:    false,
    price_fai:       123000,
    fees_atom:       8900,
    fees_notaire:    10455,
    budget_travaux:  5000,
    budget_meuble:   3000,
    loyer_atom:      770,
    metro_name:      'Arts et Métiers',
    metro_distance:  4,   // ~350m ≈ 4 min à pied
    description:     'Studio 10,5 m² au 4ème étage sans ascenseur, dans le quartier Arts et Métiers. ' +
                     'Prix FAI 123 000 €. Cuisine ouverte avec évier, plaques, frigo et rangements. ' +
                     'Lit deux places, salle de bain avec douche et toilettes.',
    ameublement:     true,
    ameublement_desc:'Table à manger, cuisine ouverte (évier, plaques, frigo, rangements), lit deux places, salle de bain avec douche et toilettes. Budget meubles + électroménager : 3 000 €.',
    status:          'brouillon',
    public_visible:  false,
    photo_files:     PONCEAU_PHOTOS,
    img3d_files:     PONCEAU_3D,
  },
  {
    slug:            'yvonne-le-tac',
    title:           'Yvonne-le-Tac',
    address:         '26 Rue Yvonne le Tac 75018',
    arrondissement:  '18e',
    surface_carrez:  11.55,
    floor:           'RDC',
    has_elevator:    false,
    price_fai:       130000,
    fees_atom:       8900,
    fees_notaire:    11050,
    budget_travaux:  15000,
    budget_meuble:   3000,
    loyer_atom:      850,
    metro_name:      'Abbesses',
    metro_distance:  1,   // 40m ≈ 1 min à pied
    description:     'Studio 11,55 m² au rez-de-chaussée, à 40 m du métro Abbesses (18e, Montmartre). ' +
                     'Prix FAI 130 000 €, travaux de rénovation complète prévus (15 000 €). ' +
                     'Projections 3D disponibles.',
    ameublement:     true,
    ameublement_desc:'Table à manger, cuisine ouverte (évier, plaques, frigo, rangements), lit deux places, salle de bain avec douche et toilettes. Budget meubles + électroménager : 3 000 €.',
    status:          'brouillon',
    public_visible:  false,
    photo_files:     YVONNE_PHOTOS,
    img3d_files:     YVONNE_3D,
  },
];

// ── Main ────────────────────────────────────────────────────────────────────
async function seed() {
  for (const proj of PROJECTS) {
    console.log(`\n📦  Projet "${proj.title}"…`);

    const { photo_files, img3d_files, ...data } = proj;
    const financials = computeFinancials(data);

    // ── Upsert projet (sans images d'abord pour obtenir l'ID) ──
    const { data: existing } = await supabase
      .from('projects')
      .select('id')
      .eq('slug', data.slug)
      .maybeSingle();

    let projectId;

    if (existing) {
      projectId = existing.id;
      console.log(`  ↩  Projet existant (${projectId}), mise à jour…`);
    } else {
      const insertData = {
        ...data,
        ...financials,
        images:    [],
        images_3d: [],
      };
      delete insertData.photo_files;
      delete insertData.img3d_files;

      const { data: created, error } = await supabase
        .from('projects')
        .insert([insertData])
        .select('id')
        .single();

      if (error) {
        console.error(`  ✗ Insertion "${proj.title}": ${error.message}`);
        continue;
      }
      projectId = created.id;
      console.log(`  ✓ Créé → ${projectId}`);
    }

    // ── Upload photos état actuel ──
    console.log(`  📷  Upload ${photo_files.length} photo(s) état actuel…`);
    const imageUrls = [];
    for (const f of photo_files) {
      const url = await uploadImage(f, projectId);
      if (url) imageUrls.push(url);
    }

    // ── Upload 3D ──
    console.log(`  🏗   Upload ${img3d_files.length} projection(s) 3D…`);
    const img3dUrls = [];
    for (const f of img3d_files) {
      const url = await uploadImage(f, projectId);
      if (url) img3dUrls.push(url);
    }

    // ── Update projet avec URLs images + financiers ──
    const { error: updErr } = await supabase
      .from('projects')
      .update({
        ...data,
        ...financials,
        images:    imageUrls,
        images_3d: img3dUrls,
      })
      .eq('id', projectId);

    if (updErr) {
      console.error(`  ✗ Update "${proj.title}": ${updErr.message}`);
    } else {
      console.log(`  ✓ Financiers: total=${financials.total_all_in}€ | loyer=${data.loyer_atom}€ | rendement=${financials.rendement_brut}% | mensualité=${financials.mensualite}€`);
      console.log(`  ✓ ${imageUrls.length} photos + ${img3dUrls.length} 3D enregistrées`);
    }
  }

  console.log('\n✅  Seed terminé. → Admin → Projets → onglet "Brouillons" pour compléter et publier.\n');
}

seed().catch(e => { console.error('Fatal:', e); process.exit(1); });
