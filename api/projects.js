const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

// Champs autorisés en write (POST/PUT)
const WRITE_FIELDS = [
  'title', 'address', 'arrondissement', 'surface_carrez', 'floor', 'has_elevator',
  'price_fai', 'fees_atom', 'fees_notaire', 'budget_travaux', 'budget_meuble',
  'loyer_atom', 'status', 'dpe_avant', 'dpe_apres', 'description',
  'images', 'images_3d', 'plan_2d_url', 'metro_distance', 'metro_name',
  'slug', 'public_visible', 'ameublement_desc', 'ameublement', 'published_at',
  'responsible_admin',
];

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return res.status(200).end();


    const payload = verifyToken(tokenFromReq(req));
    if (!payload) return res.status(401).json({ error: 'Non autorisé' });

    // ─── GET ────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { id, status, arrondissement, search, interests } = req.query;

      if (id) {
        const { data, error } = await supabase.from('projects').select('*').eq('id', id).single();
        if (error) return res.status(404).json({ error: 'not_found', detail: error.message });

        // ?interests=1 → renvoie aussi la liste des leads intéressés
        if (interests === '1') {
          const { data: intRows } = await supabase
            .from('project_interests')
            .select('lead_id, source, created_at, leads(id, prenom, nom, email, tel, status)')
            .eq('project_id', id)
            .order('created_at', { ascending: false });
          return res.status(200).json({ project: data, interested_leads: intRows || [] });
        }

        return res.status(200).json({ project: data });
      }

      let q = supabase.from('projects').select('*').order('created_at', { ascending: false });
      if (status)         q = q.eq('status', status);
      if (arrondissement) q = q.eq('arrondissement', arrondissement);
      if (search)         q = q.ilike('title', `%${search}%`);

      const [{ data, error }, { data: intData }] = await Promise.all([
        q,
        supabase.from('project_interests').select('project_id'),
      ]);

      if (error) return res.status(500).json({ error: 'db_error', detail: error.message });

      // Calcule le nombre d'intéressés par projet
      const interestCounts = {};
      (intData || []).forEach(r => {
        interestCounts[r.project_id] = (interestCounts[r.project_id] || 0) + 1;
      });

      const projects = (data || []).map(p => ({
        ...p,
        interest_count: interestCounts[p.id] || 0,
      }));

      return res.status(200).json({ projects });
    }

    // ─── POST (création ou parse-pdf) ──────────────────────────
    if (req.method === 'POST') {
      let b = {};
      try { b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
      catch (e) { return res.status(400).json({ error: 'invalid_json', detail: e.message }); }

      // ── Action one-shot : seed Ponceau + Yvonne-le-Tac ──────────
      if (b.action === 'seed_ponceau_yvonne') {
        if (b.secret !== 'atom_seed_2026') return res.status(403).json({ error: 'forbidden' });

        const BUCKET = 'project-images';

        async function uploadB64(b64, folder, idx) {
          const buf  = Buffer.from(b64, 'base64');
          const path = `${folder}/${Date.now()}-img${idx}.jpg`;
          const { error } = await supabase.storage.from(BUCKET)
            .upload(path, buf, { contentType: 'image/jpeg', upsert: false });
          if (error) { console.error('upload error', error.message); return null; }
          const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path);
          return publicUrl;
        }

        const PROJECTS_DATA = [
          {
            slug: 'ponceau', title: 'Ponceau',
            address: '11 rue du Ponceau 75002', arrondissement: '2e',
            surface_carrez: 10.5, floor: '4ème étage', has_elevator: false,
            price_fai: 123000, fees_atom: 8900, fees_notaire: 10455,
            budget_travaux: 5000, budget_meuble: 3000, loyer_atom: 770,
            metro_name: 'Arts et Métiers', metro_distance: 4,
            description: 'Studio 10,5 m² au 4ème étage sans ascenseur, quartier Arts et Métiers (2e). Prix FAI 123 000 €. Cuisine ouverte, lit deux places, salle de bain avec douche et toilettes.',
            ameublement: true,
            ameublement_desc: 'Table à manger, cuisine ouverte (évier, plaques, frigo, rangements), lit deux places, salle de bain avec douche et toilettes. Budget meubles + électroménager : 3 000 €.',
            status: 'brouillon', public_visible: false,
            photo_key: 'ponceau_photos', img3d_key: 'ponceau_3d',
          },
          {
            slug: 'yvonne-le-tac', title: 'Yvonne-le-Tac',
            address: '26 Rue Yvonne le Tac 75018', arrondissement: '18e',
            surface_carrez: 11.55, floor: 'RDC', has_elevator: false,
            price_fai: 130000, fees_atom: 8900, fees_notaire: 11050,
            budget_travaux: 15000, budget_meuble: 3000, loyer_atom: 850,
            metro_name: 'Abbesses', metro_distance: 1,
            description: 'Studio 11,55 m² au rez-de-chaussée, à 40 m du métro Abbesses (18e, Montmartre). Prix FAI 130 000 €. Rénovation complète prévue avec projections 3D.',
            ameublement: true,
            ameublement_desc: 'Table à manger, cuisine ouverte (évier, plaques, frigo, rangements), lit deux places, salle de bain avec douche et toilettes. Budget meubles + électroménager : 3 000 €.',
            status: 'brouillon', public_visible: false,
            photo_key: 'yvonne_photos', img3d_key: 'yvonne_3d',
          },
        ];

        const results = [];
        for (const proj of PROJECTS_DATA) {
          const { photo_key, img3d_key, ...data } = proj;
          const financials = computeFinancials(data);

          // Upsert (skip if slug exists)
          const { data: existing } = await supabase.from('projects').select('id').eq('slug', data.slug).maybeSingle();
          if (existing) { results.push({ slug: data.slug, status: 'already_exists', id: existing.id }); continue; }

          // Upload images
          const photoB64s = (b[photo_key] || []);
          const img3dB64s = (b[img3d_key] || []);
          const imageUrls  = (await Promise.all(photoB64s.map((b64, i) => uploadB64(b64, data.slug, i)))).filter(Boolean);
          const img3dUrls  = (await Promise.all(img3dB64s.map((b64, i) => uploadB64(b64, data.slug + '-3d', i)))).filter(Boolean);

          const { data: created, error } = await supabase.from('projects')
            .insert([{ ...data, ...financials, images: imageUrls, images_3d: img3dUrls }])
            .select('id').single();

          if (error) { results.push({ slug: data.slug, status: 'error', detail: error.message }); }
          else        { results.push({ slug: data.slug, status: 'created', id: created.id, photos: imageUrls.length, img3d: img3dUrls.length, ...financials }); }
        }
        return res.status(200).json({ ok: true, results });
      }
      // ── fin seed_ponceau_yvonne ──────────────────────────────────


      if (!b.title || !b.title.trim()) return res.status(400).json({ error: 'title_required' });

      const insert = {};
      WRITE_FIELDS.forEach(k => { if (k in b) insert[k] = b[k]; });

      // Calculs serveur (sécurité — on recalcule, on ne fait pas confiance au client)
      const calc = computeFinancials(insert);
      insert.total_all_in   = calc.total_all_in;
      insert.mensualite     = calc.mensualite;
      insert.rendement_brut = calc.rendement_brut;

      // Slug auto si absent
      if (!insert.slug && insert.title) {
        insert.slug = slugify(insert.title) + '-' + Date.now().toString(36).slice(-4);
      }

      const { data, error } = await supabase.from('projects').insert([insert]).select().single();
      if (error) return res.status(500).json({ error: 'db_error', detail: error.message, code: error.code });
      return res.status(200).json({ ok: true, project: data });
    }

    // ─── PUT (mise à jour) ──────────────────────────────────────
    if (req.method === 'PUT') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id_required' });

      let b = {};
      try { b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
      catch (e) { return res.status(400).json({ error: 'invalid_json', detail: e.message }); }

      const updates = {};
      WRITE_FIELDS.forEach(k => { if (k in b) updates[k] = b[k]; });
      const calc = computeFinancials(updates);
      if (calc.total_all_in   != null) updates.total_all_in   = calc.total_all_in;
      if (calc.mensualite     != null) updates.mensualite     = calc.mensualite;
      if (calc.rendement_brut != null) updates.rendement_brut = calc.rendement_brut;

      const { data, error } = await supabase.from('projects').update(updates).eq('id', id).select().single();
      if (error) return res.status(500).json({ error: 'db_error', detail: error.message, code: error.code });
      return res.status(200).json({ ok: true, project: data });
    }

    // ─── DELETE (archivage soft, ou suppression définitive si ?permanent=true) ──
    if (req.method === 'DELETE') {
      const { id, permanent } = req.query;
      if (!id) return res.status(400).json({ error: 'id_required' });

      if (permanent === 'true') {
        // Suppression définitive — uniquement si déjà archivé
        const { data: proj } = await supabase.from('projects').select('status').eq('id', id).single();
        if (!proj) return res.status(404).json({ error: 'not_found' });
        if (proj.status !== 'archive') return res.status(400).json({ error: 'must_be_archived_first' });
        const { error } = await supabase.from('projects').delete().eq('id', id);
        if (error) return res.status(500).json({ error: 'db_error', detail: error.message });
      } else {
        // Archivage soft
        const { error } = await supabase.from('projects').update({ status: 'archive' }).eq('id', id);
        if (error) return res.status(500).json({ error: 'db_error', detail: error.message });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });

  } catch (e) {
    console.error('Projects handler crash:', e);
    return res.status(500).json({ error: 'handler_crash', detail: e?.message || String(e) });
  }
};

// ─── Helpers ──────────────────────────────────────────────────
function computeFinancials(p) {
  const prix = num(p.price_fai), fa = num(p.fees_atom), fn = num(p.fees_notaire);
  const bt = num(p.budget_travaux), bm = num(p.budget_meuble), loyer = num(p.loyer_atom);
  const hasAny = [prix, fa, fn, bt, bm].some(v => v > 0);
  if (!hasAny) return { total_all_in: null, mensualite: null, rendement_brut: null };

  const total = prix + fa + fn + bt + bm;
  const apport = Math.round(total * 0.10);
  const principal = Math.max(0, total - apport);
  const months = 25 * 12;
  const r = 0.036 / 12;
  const mensualite = principal > 0
    ? Math.round((principal * r) / (1 - Math.pow(1 + r, -months)))
    : 0;
  const rendement = total > 0 ? Number(((loyer * 12 / total) * 100).toFixed(2)) : 0;
  return { total_all_in: total, mensualite, rendement_brut: rendement };
}

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function slugify(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
