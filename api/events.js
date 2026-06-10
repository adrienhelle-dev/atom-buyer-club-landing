const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  // GET — liste des événements d'un lead  OU  récents  OU  tous intérêts
  if (req.method === 'GET') {
    const { lead_id, recent, interests } = req.query;

    // ── Mode "recent" : centre de notifications admin (widget FAB) ──
    if (recent === '1') {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const NOTIF_TYPES = ['interet_projet', 'showroom_interest', 'showroom_cta'];

      const { data: events, error } = await supabase
        .from('lead_events')
        .select('id, type, content, created_at, lead_id')
        .in('type', NOTIF_TYPES)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) { console.error('Events recent GET:', error); return res.status(500).json({ error: 'db_error', detail: error.message }); }
      if (!events || !events.length) return res.status(200).json({ events: [] });

      const leadIds = [...new Set(events.map(e => e.lead_id).filter(Boolean))];
      const { data: leads } = await supabase
        .from('leads')
        .select('id, prenom, nom, email')
        .in('id', leadIds);
      const leadMap = Object.fromEntries((leads || []).map(l => [l.id, l]));
      // content parsé en objet (comme le mode interests=1) : le badge "Intérêts"
      // lit content.treated — sur la chaîne brute, tout comptait comme non traité.
      const enriched = events.map(e => {
        let content = {};
        try { content = e.content ? (typeof e.content === 'string' ? JSON.parse(e.content) : e.content) : {}; } catch {}
        return { ...e, content, lead: leadMap[e.lead_id] || null };
      });

      return res.status(200).json({ events: enriched });
    }

    // ── Mode "interests" : vue Tour de contrôle (tout l'historique) ──
    if (interests === '1') {
      const INTEREST_TYPES = ['interet_projet', 'showroom_interest', 'showroom_cta'];

      const { data: events, error } = await supabase
        .from('lead_events')
        .select('id, type, content, created_at, lead_id')
        .in('type', INTEREST_TYPES)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) { console.error('Events interests GET:', error); return res.status(500).json({ error: 'db_error', detail: error.message }); }
      if (!events || !events.length) return res.status(200).json({ events: [] });

      const leadIds = [...new Set(events.map(e => e.lead_id).filter(Boolean))];
      const { data: leads } = await supabase
        .from('leads')
        .select('id, prenom, nom, email, tel, assigned_to, timing, financement, accord, capacite, arrondissements, status, utm_source')
        .in('id', leadIds);
      const leadMap = Object.fromEntries((leads || []).map(l => [l.id, l]));

      const enriched = events.map(e => {
        let content = {};
        try { content = e.content ? (typeof e.content === 'string' ? JSON.parse(e.content) : e.content) : {}; } catch {}
        return { ...e, content, lead: leadMap[e.lead_id] || null };
      });

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

  // PATCH — marquer un intérêt comme traité / non traité
  if (req.method === 'PATCH') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { id, treated } = b;
    if (!id) return res.status(400).json({ error: 'id requis' });

    // Récupérer le content actuel
    const { data: current, error: fetchErr } = await supabase
      .from('lead_events')
      .select('content')
      .eq('id', id)
      .single();
    if (fetchErr) return res.status(500).json({ error: 'db_error', detail: fetchErr.message });

    let content = {};
    try { content = current?.content ? (typeof current.content === 'string' ? JSON.parse(current.content) : current.content) : {}; } catch {}

    const newContent = {
      ...content,
      treated:    !!treated,
      treated_by: treated ? payload.email : null,
      treated_at: treated ? new Date().toISOString() : null,
    };

    const { error: updateErr } = await supabase
      .from('lead_events')
      .update({ content: newContent })
      .eq('id', id);
    if (updateErr) return res.status(500).json({ error: 'db_error', detail: updateErr.message });

    return res.status(200).json({ ok: true });
  }

  // DELETE — supprimer un événement intérêt
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requis' });

    // Récupérer l'event d'abord pour nettoyer project_interests si nécessaire
    const { data: ev } = await supabase
      .from('lead_events')
      .select('lead_id, type, content')
      .eq('id', id)
      .maybeSingle();

    const { error } = await supabase.from('lead_events').delete().eq('id', id);
    if (error) { console.error('Event DELETE:', error); return res.status(500).json({ error: 'db_error' }); }

    // Nettoyer project_interests si c'était un interet_projet
    if (ev?.type === 'interet_projet' && ev.lead_id) {
      try {
        let projectId = null;
        const c = ev.content ? (typeof ev.content === 'string' ? JSON.parse(ev.content) : ev.content) : {};
        projectId = c.project_id || null;
        if (projectId) {
          await supabase.from('project_interests').delete()
            .eq('lead_id', ev.lead_id)
            .eq('project_id', projectId);
        }
      } catch {}
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
};
