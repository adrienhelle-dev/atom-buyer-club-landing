const jwt = require('jsonwebtoken');

// ── Comptes internes hardcodés (ne nécessitent pas d'env vars Vercel) ──────────
// role: 'admin' | 'projects'
const INTERNAL_ACCOUNTS = [
  { email: 'contact@atom-capital.fr', password: 'NPMN5l6t1TpfhziV', role: 'projects' },
];

const ADMIN_EMAILS = [
  ...(process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
  ...INTERNAL_ACCOUNTS.map(a => a.email),
];

// Emails en mode "viewer" : voient uniquement les leads chauds (score ≥ 7) par défaut
const VIEWER_EMAILS = (process.env.VIEWER_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Emails restreints à l'onglet Projets uniquement
const PROJECTS_ONLY_EMAILS = [
  ...(process.env.PROJECTS_ONLY_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
  ...INTERNAL_ACCOUNTS.filter(a => a.role === 'projects').map(a => a.email),
];

// Emails qui voient les leads chauds par défaut (piloté par env var VIEWER_EMAILS uniquement)
const HOT_DEFAULT_EMAILS = [];

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const JWT_SECRET     = process.env.JWT_SECRET || 'fallback-secret-change-me';

// Mot de passe par email — comptes internes en priorité, puis ADMIN_PASSWORDS JSON, puis fallback ADMIN_PASSWORD
function getPasswordForEmail(email) {
  const internal = INTERNAL_ACCOUNTS.find(a => a.email === email.toLowerCase());
  if (internal) return internal.password;
  try {
    const map = JSON.parse(process.env.ADMIN_PASSWORDS || '{}');
    return map[email.toLowerCase()] || ADMIN_PASSWORD;
  } catch {
    return ADMIN_PASSWORD;
  }
}

// role : 'admin' | 'projects'
function signToken(email, role = 'admin') {
  return jwt.sign({ email, role }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function tokenFromReq(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

module.exports = {
  ADMIN_EMAILS, VIEWER_EMAILS, PROJECTS_ONLY_EMAILS, HOT_DEFAULT_EMAILS,
  ADMIN_PASSWORD, getPasswordForEmail, signToken, verifyToken, tokenFromReq,
};
