const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

const ALLOWED = ['status', 'notes'];

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH') return res.status(405).end();

  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'ID requis' });

  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const updates = {};
  ALLOWED.forEach(k => { if (k in b) updates[k] = b[k]; });

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Aucun champ valide' });

  // Si le statut change, on assigne automatiquement le lead au founder connecté
  if ('status' in updates) {
    updates.assigned_to = payload.email;
  }

  const { error } = await supabase.from('leads').update(updates).eq('id', id);
  if (error) {
    console.error('Patch error:', error);
    // On retourne le détail de l'erreur Supabase pour faciliter le debug
    return res.status(500).json({
      error: 'db_error',
      detail: error.message || error.code || 'unknown',
      hint: error.hint || null,
    });
  }

  // Auto-log dans la timeline si le statut a changé
  if ('status' in updates) {
    supabase.from('lead_events').insert([{
      lead_id: id,
      type: 'status_change',
      content: JSON.stringify({ status: updates.status }),
      author: payload.email,
    }]).catch(e => console.error('Event log status:', e));
  }

  return res.status(200).json({ ok: true, assigned_to: updates.assigned_to || null });
};
