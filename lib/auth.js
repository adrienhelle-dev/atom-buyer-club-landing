const jwt = require('jsonwebtoken');

// ── Comptes internes ───────────────────────────────────────────────────────────
// role: 'admin' | 'projects'
// Le mot de passe est lu depuis une variable d'environnement Vercel (passwordEnv),
// jamais en clair dans le code.
const INTERNAL_ACCOUNTS = [
  // Agathe — accès complet au dashboard (Leads, Projets, Showroom, Intérêts)
  { email: 'contact@atom-capital.fr', passwordEnv: 'CONTACT_PASSWORD', role: 'admin' },
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
// Pas de fallback : si JWT_SECRET n'est pas défini, signToken/verifyToken
// échouent (fail closed) plutôt que d'exposer une clé publique connue.
const JWT_SECRET     = process.env.JWT_SECRET;
if (!JWT_SECRET) console.error('[auth] JWT_SECRET manquant — auth désactivée tant que la variable n\'est pas posée.');

// Mot de passe par email — comptes internes (via env) en priorité, puis ADMIN_PASSWORDS JSON, puis fallback ADMIN_PASSWORD
function getPasswordForEmail(email) {
  const internal = INTERNAL_ACCOUNTS.find(a => a.email === email.toLowerCase());
  if (internal) return process.env[internal.passwordEnv] || null;
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
