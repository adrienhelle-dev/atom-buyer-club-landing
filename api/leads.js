const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const page     = Math.max(1, parseInt(req.query.page)     || 1);
  const pageSize = Math.min(100, parseInt(req.query.pageSize) || 50);
  const source   = req.query.source   || null;
  const search   = req.query.search   || null;
  const from     = (page - 1) * pageSize;

  let q = supabase.from('leads').select('*', { count: 'exact' }).order('created_at', { ascending: false });

  if (source) q = q.eq('utm_source', source);
  if (search) q = q.or(`email.ilike.%${search}%,nom.ilike.%${search}%,prenom.ilike.%${search}%`);

  q = q.range(from, from + pageSize - 1);

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: 'db_error' });

  return res.status(200).json({ leads: data, total: count, page, pageSize });
};
