const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const { id, status, arrondissement, search } = req.query;

  // ─── GET détail d'un projet ─────────────────────────────────
  if (id) {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .single();
    if (error) { console.error('Project detail:', error); return res.status(404).json({ error: 'not_found' }); }
    return res.status(200).json({ project: data });
  }

  // ─── GET liste avec filtres ─────────────────────────────────
  let q = supabase.from('projects').select('*').order('created_at', { ascending: false });

  if (status)         q = q.eq('status', status);
  if (arrondissement) q = q.eq('arrondissement', arrondissement);
  if (search)         q = q.ilike('title', `%${search}%`);

  const { data, error } = await q;
  if (error) { console.error('Projects list:', error); return res.status(500).json({ error: 'db_error' }); }
  return res.status(200).json({ projects: data || [] });
};
