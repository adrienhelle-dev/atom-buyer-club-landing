/**
 * seed-showroom.js
 * Insère les 7 premières réalisations Atom Living dans showroom_items (stubs à compléter)
 *
 * Usage : npx vercel env run -- node scripts/seed-showroom.js
 *
 * Idempotent : upsert sur le slug — peut être relancé sans doublon.
 * Les items sont créés en brouillon (is_published: false).
 * Complète les détails (financials, surface, photos) depuis Admin → Showroom.
 */

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌  SUPABASE_URL ou SUPABASE_SERVICE_KEY manquants');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ITEMS = [
  {
    slug:               'honore',
    name:               'Honoré',
    quartier:           'Faubourg Saint-Honoré',
    arrondissement:     '8e',
    surface:            null,
    style:              'Haussmannien',
    description_courte: 'Élégance parisienne au cœur du 8e',
    description_longue: null,
    equipements:        [],
    caracteristiques:   [],
    dpe:                null,
    statut_location:    'Loué',
    locataire_type:     null,
    ordre:              1,
    is_published:       false,
    is_featured:        false,
    source_url:         'https://atom.living/fr/properties/honore',
    scraped_at:         new Date().toISOString(),
  },
  {
    slug:               'panoramas',
    name:               'Panoramas',
    quartier:           'Grands Boulevards',
    arrondissement:     '2e',
    surface:            null,
    style:              'Design',
    description_courte: 'Vue panoramique, adresse d\'exception',
    description_longue: null,
    equipements:        [],
    caracteristiques:   [],
    dpe:                null,
    statut_location:    'Loué',
    locataire_type:     null,
    ordre:              2,
    is_published:       false,
    is_featured:        false,
    source_url:         'https://atom.living/fr/properties/panoramas',
    scraped_at:         new Date().toISOString(),
  },
  {
    slug:               'saint-claude',
    name:               'Saint-Claude',
    quartier:           'Marais',
    arrondissement:     '3e',
    surface:            null,
    style:              'Contemporain',
    description_courte: 'Calme et caractère en plein Marais',
    description_longue: null,
    equipements:        [],
    caracteristiques:   [],
    dpe:                null,
    statut_location:    'Loué',
    locataire_type:     null,
    ordre:              3,
    is_published:       false,
    is_featured:        false,
    source_url:         'https://atom.living/fr/properties/saint-claude',
    scraped_at:         new Date().toISOString(),
  },
  {
    slug:               'loft-republique-design',
    name:               'Loft République Design',
    quartier:           'République',
    arrondissement:     '11e',
    surface:            null,
    style:              'Loft',
    description_courte: 'Loft design à deux pas de République',
    description_longue: null,
    equipements:        [],
    caracteristiques:   [],
    dpe:                null,
    statut_location:    'Loué',
    locataire_type:     null,
    ordre:              4,
    is_published:       false,
    is_featured:        false,
    source_url:         'https://atom.living/fr/properties/loft-republique-design',
    scraped_at:         new Date().toISOString(),
  },
  {
    slug:               'studio-saint-germain-charme',
    name:               'Studio Saint-Germain Charme',
    quartier:           'Saint-Germain-des-Prés',
    arrondissement:     '6e',
    surface:            null,
    style:              'Haussmannien',
    description_courte: 'Charme absolu en plein Saint-Germain',
    description_longue: null,
    equipements:        [],
    caracteristiques:   [],
    dpe:                null,
    statut_location:    'Loué',
    locataire_type:     null,
    ordre:              5,
    is_published:       false,
    is_featured:        false,
    source_url:         'https://atom.living/fr/properties/studio-saint-germain-charme',
    scraped_at:         new Date().toISOString(),
  },
  {
    slug:               'appartement-bastille-lumineux',
    name:               'Appartement Bastille Lumineux',
    quartier:           'Bastille',
    arrondissement:     '11e',
    surface:            null,
    style:              'Contemporain',
    description_courte: 'Luminosité et volumes autour de Bastille',
    description_longue: null,
    equipements:        [],
    caracteristiques:   [],
    dpe:                null,
    statut_location:    'Loué',
    locataire_type:     null,
    ordre:              6,
    is_published:       false,
    is_featured:        false,
    source_url:         'https://atom.living/fr/properties/appartement-bastille-lumineux',
    scraped_at:         new Date().toISOString(),
  },
  {
    slug:               'studio-marais-temple',
    name:               'Studio Marais Temple',
    quartier:           'Marais',
    arrondissement:     '3e',
    surface:            null,
    style:              'Design',
    description_courte: 'Studio repensé de A à Z dans le Marais',
    description_longue: null,
    equipements:        [],
    caracteristiques:   [],
    dpe:                null,
    statut_location:    'Loué',
    locataire_type:     null,
    ordre:              7,
    is_published:       false,
    is_featured:        false,
    source_url:         'https://atom.living/fr/properties/studio-marais-temple',
    scraped_at:         new Date().toISOString(),
  },
];

async function seed() {
  console.log(`\n🌱  Insertion de ${ITEMS.length} showroom items (stubs)…\n`);

  for (const item of ITEMS) {
    const { data, error } = await supabase
      .from('showroom_items')
      .upsert([item], { onConflict: 'slug' })
      .select('id, slug, name')
      .single();

    if (error) {
      console.error(`  ✗  ${item.slug.padEnd(35)} — ${error.message}`);
    } else {
      console.log(`  ✓  ${data.slug.padEnd(35)} → ${data.id}`);
    }
  }

  console.log('\n✅  Seed terminé.');
  console.log('   → Admin → Showroom pour compléter les détails et publier.\n');
}

seed().catch(e => { console.error('Fatal:', e); process.exit(1); });
