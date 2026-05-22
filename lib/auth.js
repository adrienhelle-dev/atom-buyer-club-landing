const jwt = require('jsonwebtoken');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Emails en mode "viewer" : voient uniquement les leads chauds (score ≥ 7) par défaut
const VIEWER_EMAILS = (process.env.VIEWER_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const JWT_SECRET     = process.env.JWT_SECRET || 'fallback-secret-change-me';

function signToken(email) {
  return jwt.sign({ email, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function tokenFromReq(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

module.exports = { ADMIN_EMAILS, VIEWER_EMAILS, ADMIN_PASSWORD, signToken, verifyToken, tokenFromReq };
