const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

const PATCH_ALLOWED = [
  'status', 'notes',
  // Champs modifiables manuellement depuis l'admin (après un appel, pour corriger le profil)
  'timing', 'accord', 'financement', 'capacite', 'arrondissements', 'assigned_to',
  // Issue du deal (rempli quand status='signe') : 'managed' (géré par Atom → asset)
  // ou 'commission' (vente Microsurfaces). + montant de commission + date de signature.
  'deal_outcome', 'commission_amount', 'deal_closed_at',
];

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  // ─── DELETE — suppression d'un lead ────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'ID requis' });
    const { error } = await supabase.from('leads').delete().eq('id', id);
    if (error) { console.error('Delete lead error:', error); return res.status(500).json({ error: 'db_error' }); }
    return res.status(200).json({ ok: true });
  }

  // ─── PATCH — mise à jour partielle (status, notes) ─────────────
  if (req.method === 'PATCH') {
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'ID requis' });

      let b = {};
      try { b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
      catch (e) { return res.status(400).json({ error: 'invalid_json', detail: e.message }); }

      const updates = {};
      PATCH_ALLOWED.forEach(k => { if (k in b) updates[k] = b[k]; });

      // Auto-assign : quand le statut change OU force_assign=true
      // Mais si assigned_to est fourni explicitement, il prend la priorité
      if (('status' in updates || b.force_assign) && !('assigned_to' in b)) {
        updates.assigned_to = payload.email;
      }

      // Issue du deal : si on renseigne l'issue sans date, on date la signature à maintenant.
      // Toute signature rapporte une commission (managed OU commission), donc on
      // ne nettoie jamais le montant : un deal "géré par Atom" a aussi sa commission.
      if ('deal_outcome' in updates && !('deal_closed_at' in updates)) {
        updates.deal_closed_at = new Date().toISOString();
      }

      if (!Object.keys(updates).length) return res.status(400).json({ error: 'Aucun champ valide' });

      const { error } = await supabase.from('leads').update(updates).eq('id', id);
      if (error) {
        console.error('Patch lead DB error:', error);
        return res.status(500).json({ error: 'db_error', detail: error.message, code: error.code, hint: error.hint });
      }

      // Log timeline si statut changé (fire & forget)
      if ('status' in updates) {
        supabase.from('lead_events').insert([{
          lead_id: id,
          type:    'status_change',
          content: JSON.stringify({ status: updates.status }),
          author:  payload.email,
        }]);
      }

      // Log timeline pour l'issue du deal (fire & forget)
      if ('deal_outcome' in updates) {
        supabase.from('lead_events').insert([{
          lead_id: id,
          type:    'deal_outcome',
          content: JSON.stringify({
            outcome: updates.deal_outcome,
            commission_amount: updates.commission_amount ?? null,
          }),
          author:  payload.email,
        }]);
      }

      return res.status(200).json({ ok: true, assigned_to: updates.assigned_to || null });

    } catch (e) {
      console.error('Patch handler crash:', e);
      return res.status(500).json({ error: 'handler_crash', detail: e?.message || String(e) });
    }
  }

  // ─── GET — liste paginée avec filtres  OU  lead unique par id ──
  if (req.method === 'GET') {
    // ── Stats conversions par campagne ───────────────────────────
    // Agrège côté serveur (toute la base, pas limité par la pagination) :
    // par utm_campaign → total leads, commissions (+ €), assets gérés.
    if (req.query.stats === 'campaigns') {
      const { data, error } = await supabase
        .from('leads')
        .select('utm_campaign, deal_outcome, commission_amount');
      if (error) return res.status(500).json({ error: 'db_error' });

      const map = {};
      (data || []).forEach(l => {
        const key = (l.utm_campaign && String(l.utm_campaign).trim()) || '(sans campagne)';
        if (!map[key]) map[key] = { campaign: key, leads: 0, commission_only: 0, managed: 0, commission_amount: 0 };
        const m = map[key];
        m.leads++;
        // Toute signature (managed OU commission) rapporte une commission → on somme le €.
        if (l.deal_outcome === 'commission' || l.deal_outcome === 'managed') {
          m.commission_amount += Number(l.commission_amount) || 0;
          if (l.deal_outcome === 'managed') m.managed++;
          else m.commission_only++;
        }
      });
      // Tri : campagnes avec signatures d'abord, puis par volume de leads.
      const rows = Object.values(map).sort((a, b) =>
        (b.commission_only + b.managed) - (a.commission_only + a.managed) || b.leads - a.leads);
      return res.status(200).json({ campaigns: rows });
    }

    // ── Lead unique ──────────────────────────────────────────────
    if (req.query.id && !req.query.page) {
      const { data, error } = await supabase.from('leads').select('*').eq('id', req.query.id).maybeSingle();
      if (error) return res.status(500).json({ error: 'db_error' });
      if (!data)  return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ lead: data });
    }
    const page     = Math.max(1, parseInt(req.query.page)     || 1);
    // Plafond relevé à 1000 : l'admin charge tout d'un coup (tri/score côté client).
    // Au-delà, il faudra une vraie pagination + tri serveur.
    const pageSize = Math.min(1000, parseInt(req.query.pageSize) || 50);
    const source   = req.query.source   || null;
    const search   = req.query.search   || null;
    const status   = req.query.status   || null;
    const from     = (page - 1) * pageSize;

    let q = supabase.from('leads').select('*', { count: 'exact' }).order('created_at', { ascending: false });

    // "organic" = source organique pure uniquement
    // "fiche_projet" = leads venus d'une page projet sans UTM payant
    if (source === 'organic')      q = q.eq('utm_source', 'organic');
    else if (source === 'fiche_projet') q = q.in('utm_source', ['fiche_projet', 'projet']);
    else if (source)               q = q.eq('utm_source', source);
    if (status) q = q.eq('status', status);
    if (search) q = q.or(`email.ilike.%${search}%,nom.ilike.%${search}%,prenom.ilike.%${search}%`);

    q = q.range(from, from + pageSize - 1);

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: 'db_error' });

    return res.status(200).json({ leads: data, total: count, page, pageSize });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
};
