const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  // GET — liste des événements d'un lead  OU  récents toutes sources confondues
  if (req.method === 'GET') {
    const { lead_id, recent } = req.query;

    // ── Mode "recent" : centre de notifications admin ────────────
    if (recent === '1') {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const NOTIF_TYPES = ['inscription', 'resoumission', 'interet_projet', 'showroom_interest', 'showroom_cta'];

      // Étape 1 : récupérer les événements
      const { data: events, error } = await supabase
        .from('lead_events')
        .select('id, type, content, created_at, lead_id')
        .in('type', NOTIF_TYPES)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) { console.error('Events recent GET:', error); return res.status(500).json({ error: 'db_error', detail: error.message }); }
      if (!events || !events.length) return res.status(200).json({ events: [] });

      // Étape 2 : enrichir avec les noms des leads (requête séparée, plus fiable)
      const leadIds = [...new Set(events.map(e => e.lead_id).filter(Boolean))];
      const { data: leads } = await supabase
        .from('leads')
        .select('id, prenom, nom, email')
        .in('id', leadIds);
      const leadMap = Object.fromEntries((leads || []).map(l => [l.id, l]));
      const enriched = events.map(e => ({ ...e, lead: leadMap[e.lead_id] || null }));

      return res.status(200).json({ events: enriched });
    }

    if (!lead_id) return res.status(400).json({ error: 'lead_id requis' });
    const { data, error } = await supabase
      .from('lead_events')
      .select('*')
      .eq('lead_id', lead_id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) { console.error('Events GET:', error); return res.status(500).json({ error: 'db_error' }); }
    return res.status(200).json({ events: data || [] });
  }

  // POST — ajouter un événement manuel
  if (req.method === 'POST') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { lead_id, type, content } = b;
    if (!lead_id || !type) return res.status(400).json({ error: 'lead_id et type requis' });
    const { data, error } = await supabase
      .from('lead_events')
      .insert([{ lead_id, type, content: content || null, author: payload.email }])
      .select()
      .single();
    if (error) { console.error('Events POST:', error); return res.status(500).json({ error: 'db_error' }); }
    return res.status(200).json({ ok: true, event: data });
  }

  return res.status(405).end();
};
