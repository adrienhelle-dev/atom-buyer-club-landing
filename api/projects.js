const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

// Champs autorisés en write (POST/PUT)
const WRITE_FIELDS = [
  'title', 'address', 'arrondissement', 'surface_carrez', 'floor', 'has_elevator',
  'price_fai', 'fees_atom', 'fees_notaire', 'budget_travaux', 'budget_meuble',
  'loyer_atom', 'status', 'dpe_avant', 'dpe_apres', 'description',
  'images', 'images_3d', 'plan_2d_url', 'metro_distance', 'metro_name',
  'slug', 'public_visible', 'ameublement_desc', 'ameublement', 'published_at',
];

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return res.status(200).end();

    const payload = verifyToken(tokenFromReq(req));
    if (!payload) return res.status(401).json({ error: 'Non autorisé' });

    // ─── GET ────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { id, status, arrondissement, search } = req.query;
      if (id) {
        const { data, error } = await supabase.from('projects').select('*').eq('id', id).single();
        if (error) return res.status(404).json({ error: 'not_found', detail: error.message });
        return res.status(200).json({ project: data });
      }
      let q = supabase.from('projects').select('*').order('created_at', { ascending: false });
      if (status)         q = q.eq('status', status);
      if (arrondissement) q = q.eq('arrondissement', arrondissement);
      if (search)         q = q.ilike('title', `%${search}%`);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: 'db_error', detail: error.message });
      return res.status(200).json({ projects: data || [] });
    }

    // ─── POST (création) ────────────────────────────────────────
    if (req.method === 'POST') {
      let b = {};
      try { b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
      catch (e) { return res.status(400).json({ error: 'invalid_json', detail: e.message }); }

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

    // ─── DELETE (archivage soft) ────────────────────────────────
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id_required' });
      const { error } = await supabase.from('projects').update({ status: 'archive' }).eq('id', id);
      if (error) return res.status(500).json({ error: 'db_error', detail: error.message });
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
