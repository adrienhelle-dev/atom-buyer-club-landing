#!/usr/bin/env node
/**
 * seed-showroom.js — Scraping des réalisations atom.living + structuration Claude
 *
 * Usage :
 *   node scripts/seed-showroom.js
 *
 * Prérequis :
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY dans .env.local
 *   npm install puppeteer-core @sparticuz/chromium @supabase/supabase-js dotenv
 *   (puppeteer-core et chromium sont déjà dans les deps du projet)
 */

require('dotenv').config({ path: '.env.local' });

const { createClient } = require('@supabase/supabase-js');

const URLS = [
  { url: 'https://atom.living/fr/properties/honore',                    slug: 'honore' },
  { url: 'https://atom.living/fr/properties/panoramas',                 slug: 'panoramas' },
  { url: 'https://atom.living/fr/properties/saint-claude',              slug: 'saint-claude' },
  { url: 'https://atom.living/fr/properties/loft-republique-design',    slug: 'loft-republique-design' },
  { url: 'https://atom.living/fr/properties/studio-saint-germain-charme', slug: 'studio-saint-germain-charme' },
  { url: 'https://atom.living/fr/properties/appartement-bastille-lumineux', slug: 'appartement-bastille-lumineux' },
  { url: 'https://atom.living/fr/properties/studio-marais-temple',      slug: 'studio-marais-temple' },
];

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service role — bypasse RLS
);

async function scrapeWithPuppeteer(url) {
  let chromium, puppeteer;
  try {
    chromium  = require('@sparticuz/chromium');
    puppeteer = require('puppeteer-core');
  } catch {
    throw new Error('puppeteer-core ou @sparticuz/chromium manquant');
  }

  const browser = await puppeteer.launch({
    args:            chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath:  await chromium.executablePath(),
    headless:        true,
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000)); // laisse le JS finir

    // Extrait texte + images
    const result = await page.evaluate(() => {
      const text = document.body.innerText;
      const imgs = [...document.querySelectorAll('img')]
        .map(i => i.src || i.dataset.src || '')
        .filter(s => s.startsWith('http') && /\.(jpg|jpeg|png|webp)/i.test(s));
      return { text: text.slice(0, 15000), images: [...new Set(imgs)].slice(0, 20) };
    });

    return result;
  } finally {
    await browser.close();
  }
}

async function structureWithClaude(text, slug) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante');

  const prompt = `Tu es un assistant spécialisé en immobilier parisien.
Voici le contenu textuel d'une page de propriété Atom Living (slug: ${slug}).
Extrais les informations et retourne UNIQUEMENT un objet JSON valide, sans backticks ni texte autour.

Structure JSON attendue :
{
  "name": "nom commercial du bien",
  "quartier": "ex: Marais, Saint-Germain, République",
  "arrondissement": "ex: 3e",
  "surface": 12.5,
  "style": "Contemporain|Loft|Haussmannien|Design|Industriel|Minimaliste",
  "description_courte": "1 phrase accrocheuse max 100 caractères",
  "description_longue": "description complète du bien",
  "equipements": ["Lit double", "Cuisine équipée", "Salle de bain"],
  "caracteristiques": ["Étage élevé", "Ascenseur", "Vue dégagée"],
  "dpe": "D",
  "loyer_mensuel": null
}

Si une valeur est absente, mettre null.
Pour le style, choisis le plus adapté parmi : Contemporain, Loft, Haussmannien, Design, Industriel, Minimaliste.

Contenu de la page :
${text}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Anthropic error: ${err.error?.message || res.status}`);
  }

  const data = await res.json();
  const raw  = data.content?.[0]?.text || '{}';
  const m    = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/) || [null, raw];
  return JSON.parse(m[1]);
}

async function seedItem({ url, slug }) {
  console.log(`\n🔍 [${slug}] Scraping...`);

  // Idempotent : skip si déjà en base
  const { data: existing } = await supabase.from('showroom_items').select('id').eq('slug', slug).maybeSingle();
  if (existing) {
    console.log(`  ⏭  Déjà en base, skip.`);
    return;
  }

  // Scraping
  let text = '', images = [];
  try {
    const scraped = await scrapeWithPuppeteer(url);
    text   = scraped.text;
    images = scraped.images;
    console.log(`  ✅ Texte extrait (${text.length} chars), ${images.length} images trouvées`);
  } catch (e) {
    console.warn(`  ⚠️  Puppeteer failed: ${e.message}. Tentative fetch simple...`);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await r.text();
      text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 15000);
      console.log(`  ⚡ Fetch simple : ${text.length} chars`);
    } catch (e2) {
      console.error(`  ❌ Fetch échoué : ${e2.message}. Création fiche vide.`);
      text = '';
    }
  }

  // Structuration Claude (ou fiche vide si pas de texte)
  let structured = { name: slug, description_courte: 'À compléter manuellement' };
  if (text && text.length > 200) {
    try {
      structured = await structureWithClaude(text, slug);
      console.log(`  🤖 Claude : "${structured.name}" — ${structured.quartier || '?'}`);
    } catch (e) {
      console.warn(`  ⚠️  Claude failed: ${e.message}`);
    }
  }

  // Insertion en base
  const item = {
    slug,
    name:               structured.name || slug,
    quartier:           structured.quartier || null,
    arrondissement:     structured.arrondissement || null,
    surface:            structured.surface || null,
    style:              structured.style || null,
    description_courte: structured.description_courte || null,
    description_longue: structured.description_longue || null,
    equipements:        structured.equipements || [],
    caracteristiques:   structured.caracteristiques || [],
    dpe:                structured.dpe || null,
    loyer_mensuel:      structured.loyer_mensuel || null,
    images_after:       images,
    image_cover:        images[0] || null,
    source_url:         url,
    scraped_at:         new Date().toISOString(),
    is_published:       false,  // brouillon par défaut — à publier depuis l'admin
    ordre:              URLS.findIndex(u => u.slug === slug),
  };

  const { error } = await supabase.from('showroom_items').insert([item]);
  if (error) {
    console.error(`  ❌ DB insert error: ${error.message}`);
  } else {
    console.log(`  💾 Inséré en base (brouillon)`);
  }
}

async function main() {
  console.log('🚀 Seed showroom — Atom Living');
  console.log(`   ${URLS.length} réalisations à traiter\n`);

  for (const entry of URLS) {
    await seedItem(entry);
  }

  console.log('\n✅ Seed terminé. Les fiches sont en brouillon dans Supabase.');
  console.log('   → Ouvre le panel admin > Showroom pour compléter et publier.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
