const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

const ALLOWED = ['status', 'notes'];

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'PATCH') return res.status(405).json({ error: 'method_not_allowed' });

    const payload = verifyToken(tokenFromReq(req));
    if (!payload) return res.status(401).json({ error: 'Non autorisé' });

    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'ID requis' });

    let b = {};
    try {
      b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (e) {
      return res.status(400).json({ error: 'invalid_json', detail: e.message });
    }

    const updates = {};
    ALLOWED.forEach(k => { if (k in b) updates[k] = b[k]; });

    // Auto-assign : quand le statut change OU quand force_assign=true (ex: clic CTA)
    if ('status' in updates || b.force_assign) {
      updates.assigned_to = payload.email;
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Aucun champ valide' });

    const { error } = await supabase.from('leads').update(updates).eq('id', id);
    if (error) {
      console.error('Patch DB error:', error);
      return res.status(500).json({
        error: 'db_error',
        detail: error.message || error.code || 'unknown',
        code:   error.code   || null,
        hint:   error.hint   || null,
      });
    }

    // Auto-log dans la timeline si le statut a changé (fire & forget)
    if ('status' in updates) {
      supabase.from('lead_events').insert([{
        lead_id: id,
        type: 'status_change',
        content: JSON.stringify({ status: updates.status }),
        author: payload.email,
      }]).then(() => {}).catch(e => console.error('Event log status:', e));
    }

    return res.status(200).json({ ok: true, assigned_to: updates.assigned_to || null });

  } catch (e) {
    // Filet de sécurité : on garantit toujours une réponse JSON
    console.error('Patch handler crash:', e);
    return res.status(500).json({ error: 'handler_crash', detail: e?.message || String(e) });
  }
};
