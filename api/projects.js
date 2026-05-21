const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('actif', true)
    .order('created_at', { ascending: false });

  if (error) { console.error('Projects GET:', error); return res.status(500).json({ error: 'db_error' }); }
  return res.status(200).json({ projects: data || [] });
};
