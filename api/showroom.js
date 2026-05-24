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

    // Les méthodes suivantes requièrent l'auth admin
    const payload = verifyToken(tokenFromReq(req));
    if (!payload) return res.status(401).json({ error: 'Non autorisé' });

    // ─── POST — création ou action (scrape) ────────────────────────
    if (req.method === 'POST') {
      let b = {};
      try { b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
      catch (e) { return res.status(400).json({ error: 'invalid_json' }); }

      // ── Action seed_initial : insère les 7 premières réalisations (one-shot) ──
      if (b.action === 'seed_initial') {
        const SEED_TOKEN = 'atom-seed-2026-init';
        if (b.token !== SEED_TOKEN) return res.status(403).json({ error: 'invalid_seed_token' });

        const SEED_ITEMS = [
          { slug:'honore',                      name:'Honoré',                        quartier:'Faubourg Saint-Honoré',   arrondissement:'8e',  style:'Haussmannien', description_courte:'Élégance parisienne au cœur du 8e',          ordre:1 },
          { slug:'panoramas',                   name:'Panoramas',                     quartier:'Grands Boulevards',       arrondissement:'2e',  style:'Design',       description_courte:"Vue panoramique, adresse d'exception",        ordre:2 },
          { slug:'saint-claude',                name:'Saint-Claude',                  quartier:'Marais',                  arrondissement:'3e',  style:'Contemporain', description_courte:'Calme et caractère en plein Marais',          ordre:3 },
          { slug:'loft-republique-design',      name:'Loft République Design',        quartier:'République',              arrondissement:'11e', style:'Loft',         description_courte:'Loft design à deux pas de République',        ordre:4 },
          { slug:'studio-saint-germain-charme', name:'Studio Saint-Germain Charme',   quartier:'Saint-Germain-des-Prés',  arrondissement:'6e',  style:'Haussmannien', description_courte:'Charme absolu en plein Saint-Germain',         ordre:5 },
          { slug:'appartement-bastille-lumineux',name:'Appartement Bastille Lumineux',quartier:'Bastille',                arrondissement:'11e', style:'Contemporain', description_courte:'Luminosité et volumes autour de Bastille',     ordre:6 },
          { slug:'studio-marais-temple',        name:'Studio Marais Temple',          quartier:'Marais',                  arrondissement:'3e',  style:'Design',       description_courte:'Studio repensé de A à Z dans le Marais',       ordre:7 },
        ].map(item => ({
          ...item,
          statut_location: 'Loué',
          is_published: false,
          is_featured: false,
          source_url: `https://atom.living/fr/properties/${item.slug}`,
          scraped_at: new Date().toISOString(),
          equipements: [],
          caracteristiques: [],
        }));

        const results = [];
        for (const item of SEED_ITEMS) {
          const { data, error } = await supabase
            .from('showroom_items')
            .upsert([item], { onConflict: 'slug' })
            .select('id, slug, name')
            .single();
          results.push(error ? { slug: item.slug, error: error.message } : { slug: data.slug, id: data.id, ok: true });
        }
        return res.status(200).json({ ok: true, results });
      }

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
