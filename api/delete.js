const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).end();

  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'ID requis' });

  const { error } = await supabase.from('leads').delete().eq('id', id);
  if (error) { console.error('Delete error:', error); return res.status(500).json({ error: 'db_error' }); }

  return res.status(200).json({ ok: true });
};
