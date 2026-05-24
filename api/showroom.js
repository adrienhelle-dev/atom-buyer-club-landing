const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

const WRITE_FIELDS = [
  'slug', 'name', 'quartier', 'arrondissement', 'surface', 'style',
  'description_courte', 'description_longue', 'equipements', 'caracteristiques', 'dpe',
  'images_before', 'images_after', 'image_cover', 'video_url',
  'prix_acquisition', 'budget_travaux', 'loyer_mensuel', 'statut_location', 'locataire_type',
  'projet_similaire_id', 'ordre', 'is_published', 'is_featured',
  'source_url', 'scraped_at',
];

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return res.status(200).end();

    // ─── GET public — liste ou item unique (pas d'auth requise) ────
    if (req.method === 'GET') {
      const { slug, id, admin } = req.query;

      // Auth optionnelle : si token valide → tous les items, sinon publiés seulement
      const payload = verifyToken(tokenFromReq(req));
      const isAdmin = !!payload;

      if (slug || id) {
        // Item unique
        let q = supabase.from('showroom_items').select(`
          *,
          projet_similaire:projet_similaire_id (
            id, title, arrondissement, surface_carrez, total_all_in,
            loyer_atom, mensualite, rendement_brut, slug
          )
        `);
        if (!isAdmin) q = q.eq('is_published', true);
        if (slug) q = q.eq('slug', slug);
        if (id)   q = q.eq('id', id);
        const { data, error } = await q.maybeSingle();
        if (error) return res.status(500).json({ error: 'db_error', detail: error.message });
        if (!data) return res.status(404).json({ error: 'not_found' });
        return res.status(200).json({ item: data });
      }

      // Liste
      let q = supabase.from('showroom_items').select(`
        *,
        projet_similaire:projet_similaire_id (
          id, title, arrondissement, surface_carrez, total_all_in, slug
        )
      `).order('ordre', { ascending: true }).order('created_at', { ascending: false });
      if (!isAdmin) q = q.eq('is_published', true);

      const { data, error } = await q;
      if (error) return res.status(500).json({ error: 'db_error', detail: error.message });
      return res.status(200).json({ items: data || [] });
    }

    // ── Action update_all (one-shot, own token) ─────────────────────────────
    if (req.method === 'POST') {
      let _b = {};
      try { _b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}
      if (_b.action === 'update_all') {
        if (_b.token !== 'atom-update-2026') return res.status(403).json({ error: 'invalid_token' });

        const BASE = 'https://api.atom.living/uploads/properties';
        const UPDATES = [
          {
            slug: 'honore',
            name: 'Honoré', quartier: 'Louvre – Les Halles', arrondissement: '1er', surface: 12,
            style: 'Contemporain',
            description_courte: 'Studio neuf signé architecte, hyper-centre de Paris',
            description_longue: "Tombez sous le charme de ce studio de 12m² entièrement neuf, imaginé par un architecte d'intérieur pour allier style, confort et efficacité. Chaque détail a été pensé pour un séjour sans compromis : lit double 140 cm, cuisine parfaitement équipée, TV connectée, fibre ultra-rapide. Niché en hyper-centre, tout Paris s'explore à pied : 3 min de Châtelet, 10 min du Louvre, 15 min de Notre-Dame de Paris, 10 min du Centre Pompidou. Un cocon élégant, ultra central, parfait pour vivre Paris intensément.",
            equipements: ['WiFi Haut Débit','Cuisine Équipée','TV Connectée','Lit double 140 cm','Chauffage','Draps & Serviettes'],
            loyer_mensuel: 1400,
            images_after: [
              `${BASE}/019df5cd-8562-712d-84b9-5a3786461d2c/DSC-1674-at-adrien-lgm-69f94f6160f4b.jpg`,
              `${BASE}/019df5cd-8562-712d-84b9-5a3786461d2c/DSC-1676-at-adrien-lgm-69f94f61623b5.jpg`,
              `${BASE}/019df5cd-8562-712d-84b9-5a3786461d2c/DSC-1681-at-adrien-lgm-69f94f6163b62.jpg`,
              `${BASE}/019df5cd-8562-712d-84b9-5a3786461d2c/DSC-1690-at-adrien-lgm-69f94f6cc2d2b.jpg`,
              `${BASE}/019df5cd-8562-712d-84b9-5a3786461d2c/DSC-1682-at-adrien-lgm-69f94f61651ea.jpg`,
            ],
          },
          {
            slug: 'panoramas',
            name: 'Panoramas', quartier: 'Grands Boulevards', arrondissement: '2e', surface: 10,
            style: 'Design',
            description_courte: 'Passage des Panoramas, adresse d\'exception au 6e étage',
            description_longue: 'Niché au cœur du passage des Panoramas, l\'un des passages couverts les plus emblématiques de Paris, ce studio offre un cadre de vie unique entre histoire et modernité. Au 6e étage, loin de l\'agitation des rues animées, il propose un séjour au calme tout en étant à deux pas des Grands Boulevards.',
            equipements: ['WiFi Haut Débit','Chauffage','Draps & Serviettes','Cuisine Équipée'],
            loyer_mensuel: 1300,
            images_after: [
              `${BASE}/019ccef6-2a48-730d-a8f4-8604da6ae7f5/WhatsApp-Image-2026-04-15-at-15-14-00-2-69fa241942053.jpg`,
              `${BASE}/019ccef6-2a48-730d-a8f4-8604da6ae7f5/WhatsApp-Image-2026-04-15-at-15-14-00-69fa241f25569.jpg`,
              `${BASE}/019ccef6-2a48-730d-a8f4-8604da6ae7f5/WhatsApp-Image-2026-04-15-at-15-14-01-1-69fa24228c80e.jpg`,
              `${BASE}/019ccef6-2a48-730d-a8f4-8604da6ae7f5/WhatsApp-Image-2026-04-15-at-15-14-00-1-69fa242c33881.jpg`,
              `${BASE}/019ccef6-2a48-730d-a8f4-8604da6ae7f5/WhatsApp-Image-2026-04-15-at-15-14-01-3-69fa2430896da.jpg`,
            ],
          },
          {
            slug: 'saint-claude',
            name: 'Saint-Claude', quartier: 'Haut-Marais', arrondissement: '3e', surface: 9,
            style: 'Contemporain',
            description_courte: 'Studio repensé par architecte au cœur du Haut-Marais',
            description_longue: "En plein cœur du Haut-Marais, ce studio a été entièrement repensé par architecte. Prestations haut de gamme, confort moderne, finitions soignées et ambiance lumineuse : une adresse premium au sein de l'un des quartiers les plus dynamiques de Paris.",
            equipements: ['WiFi Haut Débit','Chauffage','Climatisation','Draps & Serviettes','Canapé Confortable','Bureau de Travail','Dressing','Cuisine Équipée','Lave-Vaisselle','Four','Machine à Café','Micro-ondes','Sèche-Cheveux','Machine à Laver','TV Écran Plat','Netflix'],
            loyer_mensuel: 1300,
            images_after: [
              `${BASE}/019c3de9-461c-7019-9939-e884d78c0648/DSC-1753-adrien-lgm-6988c862a5907.jpg`,
            ],
          },
          {
            slug: 'loft-republique-design',
            name: 'Ziem', quartier: 'Montmartre', arrondissement: '18e', surface: 13,
            style: 'Design',
            description_courte: 'Studio de caractère avec vue dégagée à Montmartre',
            description_longue: "À deux pas de Montmartre, ce studio de caractère est situé au dernier étage et bénéficie d'une cheminée et d'une vue dégagée. Un pied-à-terre lumineux et plein de charme, dans l'un des quartiers les plus emblématiques de Paris.",
            equipements: ['WiFi Haut Débit','Chauffage','Draps & Serviettes','Bureau de Travail','Dressing','Cuisine Équipée','Lave-Vaisselle','Four','Machine à Café','Micro-ondes','Machine à Laver','Sèche-Linge','TV Écran Plat','Netflix','Enceinte Bluetooth'],
            loyer_mensuel: 1450,
            images_after: [
              `${BASE}/019c3de9-461c-7019-9939-e884d0e4ab57/ValeriaTorres-14-6988cbaa6658f.jpg`,
              `${BASE}/019c3de9-461c-7019-9939-e884d0e4ab57/ValeriaTorres-15-6988cbaeb6095.jpg`,
              `${BASE}/019c3de9-461c-7019-9939-e884d0e4ab57/ValeriaTorres-11-6988cbbeaa01f.jpg`,
              `${BASE}/019c3de9-461c-7019-9939-e884d0e4ab57/ValeriaTorres-08-6988cbc4afb77.jpg`,
              `${BASE}/019c3de9-461c-7019-9939-e884d0e4ab57/ValeriaTorres-05-6988cbd0d5fcb.jpg`,
            ],
          },
          {
            slug: 'studio-saint-germain-charme',
            name: 'Saint-Antoine', quartier: 'Marais – Saint-Paul', arrondissement: '4e', surface: 13,
            style: 'Haussmannien',
            description_courte: 'Studio climatisé au cœur du Marais historique',
            description_longue: "Situé en plein cœur du Marais, dans le quartier recherché de Saint-Paul, ce studio climatisé se trouve au 5e étage d'un immeuble typique parisien. Emplacement central, calme et ultra-prisé, à deux pas des commerces, galeries et adresses iconiques du Marais.",
            equipements: ['WiFi Haut Débit','Chauffage','Draps & Serviettes','Cuisine Équipée','Machine à Café','Sèche-Cheveux','TV Écran Plat'],
            loyer_mensuel: 1300,
            images_after: [
              `${BASE}/019c3de9-461c-7019-9939-e884d464681f/ValeriaTorres-12-6988b1ebdc22a.jpg`,
              `${BASE}/019c3de9-461c-7019-9939-e884d464681f/ValeriaTorres-11-6988b1f1b7ace.jpg`,
              `${BASE}/019c3de9-461c-7019-9939-e884d464681f/ValeriaTorres-52-6988b1f593792.jpg`,
              `${BASE}/019c3de9-461c-7019-9939-e884d464681f/ValeriaTorres-02-6988b1fa217c2.jpg`,
              `${BASE}/019c3de9-461c-7019-9939-e884d464681f/ValeriaTorres-43-6988b1feafa9e.jpg`,
            ],
          },
          {
            slug: 'appartement-bastille-lumineux',
            name: 'Beaurepaire', quartier: 'Canal Saint-Martin', arrondissement: '10e', surface: 10,
            style: 'Contemporain',
            description_courte: 'Studio avec balcon, canal Saint-Martin en toile de fond',
            description_longue: "À proximité immédiate du canal Saint-Martin et au nord du Marais, ce studio climatisé se situe dans un immeuble avec gardien. Il dispose d'un balcon et offre un cadre de vie recherché, entre ambiance parisienne et esprit quartier.",
            equipements: ['WiFi Haut Débit','Chauffage','Climatisation','Draps & Serviettes','Canapé Confortable','Bureau de Travail','Cuisine Équipée','Lave-Vaisselle','Four','Machine à Café','Machine à Laver','TV Écran Plat','Netflix'],
            loyer_mensuel: 1300,
            images_after: [
              `${BASE}/019c3de9-461c-7019-9939-e884cc414f7e/ValeriaTorres-32-6988c107a730a.jpg`,
              `${BASE}/019c3de9-461c-7019-9939-e884cc414f7e/ValeriaTorres-34-6988c107a796e.jpg`,
              `${BASE}/019c3de9-461c-7019-9939-e884cc414f7e/ValeriaTorres-36-6988c107a7cf3.jpg`,
              `${BASE}/019c3de9-461c-7019-9939-e884cc414f7e/ValeriaTorres-37-6988c107a8024.jpg`,
              `${BASE}/019c3de9-461c-7019-9939-e884cc414f7e/ValeriaTorres-38-6988c107a835d.jpg`,
            ],
          },
          {
            slug: 'studio-marais-temple',
            name: 'Tiquetonne', quartier: 'Sentier', arrondissement: '2e', surface: 14,
            style: 'Contemporain',
            description_courte: 'Studio vivant au cœur des rues piétonnes du Sentier',
            description_longue: "Situé dans le quartier du Sentier, au cœur de rues piétonnes animées, ce studio climatisé d'environ 14 m² se trouve au 2e étage. Emplacement central, vivant et très recherché, idéal pour une immersion parisienne.",
            equipements: ['WiFi Haut Débit','Chauffage','Climatisation','Draps & Serviettes','Cuisine Équipée','Machine à Café','TV Écran Plat','Netflix'],
            loyer_mensuel: 1550,
            images_after: [
              `${BASE}/019c3de9-461c-7019-9939-e884c9c34a45/WhatsApp-Image-2026-02-08-at-15-21-19-6988ca21260cf.jpg`,
            ],
          },
        ];

        const results = [];
        for (const u of UPDATES) {
          const update = {
            name: u.name, quartier: u.quartier, arrondissement: u.arrondissement,
            surface: u.surface, style: u.style,
            description_courte: u.description_courte, description_longue: u.description_longue,
            equipements: u.equipements, loyer_mensuel: u.loyer_mensuel,
            images_after: u.images_after, image_cover: u.images_after[0] || null,
            statut_location: 'Loué',
            source_url: `https://atom.living/fr/properties/${u.slug}`,
            scraped_at: new Date().toISOString(),
          };
          const { data, error } = await supabase.from('showroom_items').update(update).eq('slug', u.slug).select('id,slug,name').single();
          results.push(error ? { slug: u.slug, error: error.message } : { slug: data.slug, name: data.name, ok: true });
        }
        return res.status(200).json({ ok: true, results });
      }
    }

    // Les méthodes suivantes requièrent l'auth admin
    const payload = verifyToken(tokenFromReq(req));
    if (!payload) return res.status(401).json({ error: 'Non autorisé' });

    // ─── POST — création ou action (scrape) ────────────────────────
    if (req.method === 'POST') {
      let b = {};
      try { b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
      catch (e) { return res.status(400).json({ error: 'invalid_json' }); }

      // ── Action scrape : récupère + structure une URL atom.living ──
      if (b.action === 'scrape') {
        const url = b.url;
        if (!url) return res.status(400).json({ error: 'url_required' });

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'anthropic_key_missing' });

        const BROWSER_HEADERS = {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        };

        let html = '';
        let text = '';
        let images = [];

        // Stratégie 1 : Nuxt 3 _payload.json (SPA avec SSR)
        try {
          const payloadUrl = url.replace(/\/$/, '') + '/_payload.json';
          const r = await fetch(payloadUrl, { headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' } });
          if (r.ok) {
            const raw = await r.text();
            if (raw && raw.length > 200) {
              text = raw.slice(0, 15000);
              console.log(`Nuxt payload OK (${text.length} chars)`);
            }
          }
        } catch {}

        // Stratégie 2 : HTML brut avec bons headers
        if (!text || text.length < 200) {
          try {
            const r = await fetch(url, { headers: BROWSER_HEADERS });
            html = await r.text();

            // Essaie d'extraire window.__NUXT__ ou __NEXT_DATA__
            const nuxtMatch = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]+?\})\s*;?\s*<\/script>/);
            const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{[\s\S]+?\})<\/script>/);
            if (nuxtMatch) {
              text = nuxtMatch[1].slice(0, 15000);
              console.log('Extracted __NUXT__ data');
            } else if (nextMatch) {
              text = nextMatch[1].slice(0, 15000);
              console.log('Extracted __NEXT_DATA__');
            } else {
              // Fallback : strip HTML
              text = html
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 15000);
            }
            // Images depuis le HTML
            const imgMatches = [...html.matchAll(/(?:src|data-src|srcset)=["']([^"']*(?:\.jpg|\.jpeg|\.png|\.webp)[^"']*)/gi)];
            images = [...new Set(imgMatches.map(m => m[1].split(' ')[0]).filter(u => u.startsWith('http')))].slice(0, 20);
          } catch (e) {
            console.error('Fetch HTML error:', e.message);
          }
        }

        // Si pas assez de contenu → stub (fiche vide à compléter manuellement)
        if (!text || text.length < 150) {
          const slug = url.split('/').pop();
          const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          return res.status(200).json({
            ok: true,
            stub: true,
            item: { name, slug, description_courte: 'À compléter manuellement' },
            images_found: [],
          });
        }

        // Extraction images depuis le HTML (srcset, src, data-src)
        if (!images.length && html) {
          const imgMatches = [...html.matchAll(/(?:src|data-src|srcset)=["']([^"']*(?:\.jpg|\.jpeg|\.png|\.webp)[^"']*)/gi)];
          images = [...new Set(imgMatches.map(m => m[1].split(' ')[0]).filter(u => u.startsWith('http')))].slice(0, 20);
        }

        const prompt = `Tu es un assistant spécialisé en immobilier parisien.
Voici le contenu textuel d'une page de propriété Atom Living.
Extrais les informations et retourne UNIQUEMENT un objet JSON valide, sans backticks ni texte autour.

Structure JSON attendue :
{
  "name": "nom commercial du bien",
  "slug": "slug-url-sans-espaces",
  "quartier": "ex: Marais, Saint-Germain, République",
  "arrondissement": "ex: 3e",
  "surface": 12.5,
  "style": "Contemporain|Loft|Haussmannien|Design|Industriel|Minimaliste",
  "description_courte": "1 phrase accrocheuse max 100 caractères",
  "description_longue": "description complète",
  "equipements": ["Lit double", "Cuisine équipée"],
  "caracteristiques": ["Étage élevé", "Vue dégagée"],
  "dpe": "D",
  "loyer_mensuel": null
}

Si une valeur est absente, mettre null.

Contenu de la page :
${text}`;

        let apiRes;
        try {
          apiRes = await fetch('https://api.anthropic.com/v1/messages', {
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
        } catch (e) {
          return res.status(500).json({ error: 'anthropic_fetch_error', detail: e.message });
        }

        if (!apiRes.ok) {
          const err = await apiRes.json().catch(() => ({}));
          return res.status(500).json({ error: 'anthropic_api_error', detail: err.error?.message });
        }

        const apiData = await apiRes.json();
        const raw = apiData.content?.[0]?.text || '{}';
        const m = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/) || [null, raw];
        let parsed;
        try { parsed = JSON.parse(m[1]); }
        catch { return res.status(500).json({ error: 'json_parse_error', raw: raw.slice(0, 300) }); }

        return res.status(200).json({ ok: true, item: parsed, images_found: images });
      }

      // ── Création d'un item showroom ──────────────────────────────
      if (!b.name || !b.slug) return res.status(400).json({ error: 'name_and_slug_required' });
      const insert = computeShowroomFinancials({});
      WRITE_FIELDS.forEach(k => { if (k in b) insert[k] = b[k]; });
      Object.assign(insert, computeShowroomFinancials(insert));

      const { data, error } = await supabase.from('showroom_items').insert([insert]).select().single();
      if (error) return res.status(500).json({ error: 'db_error', detail: error.message, code: error.code });
      return res.status(200).json({ ok: true, item: data });
    }

    // ─── PUT — mise à jour ─────────────────────────────────────────
    if (req.method === 'PUT') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id_required' });

      let b = {};
      try { b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
      catch (e) { return res.status(400).json({ error: 'invalid_json' }); }

      const updates = {};
      WRITE_FIELDS.forEach(k => { if (k in b) updates[k] = b[k]; });
      Object.assign(updates, computeShowroomFinancials(updates));

      const { data, error } = await supabase.from('showroom_items').update(updates).eq('id', id).select().single();
      if (error) return res.status(500).json({ error: 'db_error', detail: error.message });
      return res.status(200).json({ ok: true, item: data });
    }

    // ─── DELETE ────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id_required' });
      const { error } = await supabase.from('showroom_items').delete().eq('id', id);
      if (error) return res.status(500).json({ error: 'db_error', detail: error.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });

  } catch (e) {
    console.error('Showroom handler crash:', e);
    return res.status(500).json({ error: 'handler_crash', detail: e?.message || String(e) });
  }
};

// ─── Helpers ──────────────────────────────────────────────────────
function computeShowroomFinancials(p) {
  const prix = numS(p.prix_acquisition);
  const bt   = numS(p.budget_travaux);
  const loyer = numS(p.loyer_mensuel);
  const result = {};

  if (prix > 0 || bt > 0) {
    result.total_all_in = prix + bt;
    const apport    = Math.round(result.total_all_in * 0.10);
    const principal = Math.max(0, result.total_all_in - apport);
    const months = 25 * 12;
    const r = 0.036 / 12;
    result.mensualite_type = principal > 0
      ? Math.round((principal * r) / (1 - Math.pow(1 + r, -months)))
      : 0;
  }
  if (loyer > 0 && p.total_all_in > 0) {
    result.rendement_brut = Number(((loyer * 12 / p.total_all_in) * 100).toFixed(2));
  } else if (loyer > 0 && result.total_all_in > 0) {
    result.rendement_brut = Number(((loyer * 12 / result.total_all_in) * 100).toFixed(2));
  }
  return result;
}

function numS(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
