const { supabase } = require('../lib/supabase');
const { getFounder } = require('../lib/founders');

// Champs exposés publiquement (jamais d'infos internes)
// responsible_admin est chargé côté serveur uniquement pour dériver wa_contact
const PUBLIC_FIELDS = [
  'id', 'title', 'address', 'arrondissement', 'surface_carrez', 'floor',
  'has_elevator', 'price_fai', 'fees_atom', 'fees_notaire',
  'budget_travaux', 'budget_meuble', 'total_all_in', 'loyer_atom',
  'mensualite', 'rendement_brut', 'dpe_avant', 'dpe_apres',
  'description', 'images', 'images_3d', 'plan_2d_url',
  'metro_distance', 'metro_name', 'pdf_url', 'slug',
  'ameublement_desc', 'ameublement', 'published_at',
  'responsible_admin',
].join(',');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    const { id, slug } = req.query;
    if (!id && !slug) return res.status(400).json({ error: 'id_or_slug_required' });

    let q = supabase.from('projects').select(PUBLIC_FIELDS).eq('public_visible', true);
    if (id)   q = q.eq('id', id);
    if (slug) q = q.eq('slug', slug);

    const { data, error } = await q.maybeSingle();
    if (error) return res.status(500).json({ error: 'db_error', detail: error.message });
    if (!data) return res.status(404).json({ error: 'not_found' });

    // Dérive wa_contact depuis responsible_admin sans exposer l'email brut
    const { responsible_admin, ...projectPublic } = data;
    let wa_contact = null;
    if (responsible_admin) {
      const founder = getFounder(responsible_admin);
      const phone   = founder.phone ? founder.phone.replace(/[\s\-]/g, '') : null;
      if (phone) wa_contact = { name: founder.name, phone };
    }

    return res.status(200).json({ project: { ...projectPublic, wa_contact } });

  } catch (e) {
    console.error('Public-project crash:', e);
    return res.status(500).json({ error: 'handler_crash', detail: e?.message });
  }
};
