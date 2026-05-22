const { ADMIN_EMAILS, VIEWER_EMAILS, ADMIN_PASSWORD, signToken } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const email    = (b.email    || '').trim().toLowerCase();
  const password = (b.password || '').trim();

  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  if (!ADMIN_EMAILS.includes(email)) return res.status(401).json({ error: 'Accès non autorisé' });
  if (password !== ADMIN_PASSWORD)   return res.status(401).json({ error: 'Mot de passe incorrect' });

  const isViewer = VIEWER_EMAILS.includes(email);
  return res.status(200).json({ token: signToken(email), email, isViewer });
};
