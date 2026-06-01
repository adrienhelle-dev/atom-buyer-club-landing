const { supabase } = require('../lib/supabase');
const { getFounder } = require('../lib/founders');
const { notifyInterest } = require('../lib/notify');

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

function deriveWaContact(responsible_admin) {
  if (!responsible_admin) return null;
  const founder = getFounder(responsible_admin);
  const phone   = founder.phone ? founder.phone.replace(/[\s\-]/g, '') : null;
  if (!phone) return null;
  return { name: founder.name, phone };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (req.method === 'OPTIONS') return res.status(200).end();

    // ── POST /api/public-project?action=interest ─────────────────
    if (req.method === 'POST') {
      const { action } = req.query;
      if (action !== 'interest') return res.status(405).json({ error: 'method_not_allowed' });

      const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { lead_id, project_id, project_title } = b;
      if (!lead_id || !project_id) return res.status(400).json({ error: 'lead_id_and_project_id_required' });

      // Upsert interest
      await supabase.from('project_interests').upsert(
        [{ lead_id, project_id, source: 'projets_page' }],
        { onConflict: 'lead_id,project_id', ignoreDuplicates: true }
      );
      // Log event
      await supabase.from('lead_events').insert([{
        lead_id,
        type:    'interet_projet',
        content: JSON.stringify({ project_id, project_title: project_title || null }),
        author:  null,
      }]);

      // Notif Telegram — fail-safe (charge le lead pour avoir nom + tél)
      try {
        const { data: lead } = await supabase
          .from('leads').select('prenom, nom, tel').eq('id', lead_id).maybeSingle();
        if (lead) await notifyInterest(lead, `Projet — ${project_title || 'projet'}`);
      } catch (e) { console.error('Telegram intérêt (projets_page) erreur:', e?.message || e); }

      return res.status(200).json({ ok: true });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    const { id, slug, list } = req.query;

    // ── GET ?list=1 : retourne tous les projets publics ──────────
    if (list === '1') {
      const { data, error } = await supabase
        .from('projects')
        .select(PUBLIC_FIELDS)
        .eq('public_visible', true)
        .eq('status', 'disponible')
        .order('published_at', { ascending: false, nullsFirst: false });

      if (error) return res.status(500).json({ error: 'db_error', detail: error.message });

      const projects = (data || []).map(p => {
        const { responsible_admin, ...pub } = p;
        return { ...pub, wa_contact: deriveWaContact(responsible_admin) };
      });

      return res.status(200).json({ projects });
    }

    // ── GET ?id=... ou ?slug=... : projet unique ─────────────────
    // Pas de filtre public_visible ici : la page projet.html gère l'affichage
    // et indique si le projet n'est pas encore disponible publiquement.
    if (!id && !slug) return res.status(400).json({ error: 'id_or_slug_required' });

    let q = supabase.from('projects').select(PUBLIC_FIELDS);
    if (id)   q = q.eq('id', id);
    if (slug) q = q.eq('slug', slug);

    const { data, error } = await q.maybeSingle();
    if (error) return res.status(500).json({ error: 'db_error', detail: error.message });
    if (!data) return res.status(404).json({ error: 'not_found' });

    const { responsible_admin, ...projectPublic } = data;
    return res.status(200).json({ project: { ...projectPublic, wa_contact: deriveWaContact(responsible_admin) } });

  } catch (e) {
    console.error('Public-project crash:', e);
    return res.status(500).json({ error: 'handler_crash', detail: e?.message });
  }
};
