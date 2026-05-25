const jwt = require('jsonwebtoken');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Emails en mode "viewer" : voient uniquement les leads chauds (score ≥ 7) par défaut
const VIEWER_EMAILS = (process.env.VIEWER_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Emails restreints à l'onglet Projets uniquement
const PROJECTS_ONLY_EMAILS = (process.env.PROJECTS_ONLY_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Emails qui voient les leads chauds par défaut (natif — sans passer par env var)
const HOT_DEFAULT_EMAILS = [
  'adrien.helle@atom-capital.fr',
];

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const JWT_SECRET     = process.env.JWT_SECRET || 'fallback-secret-change-me';

// Mot de passe par email — env var ADMIN_PASSWORDS (JSON) avec fallback ADMIN_PASSWORD
// Exemple : {"contact@atom-capital.fr":"NPMN5l6t1TpfhziV"}
function getPasswordForEmail(email) {
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
