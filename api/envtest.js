// TEMPORARY — will be removed immediately after use
const SECRET = 'atom-env-read-2026-tmp';
module.exports = (req, res) => {
  if (req.headers['x-tmp-secret'] !== SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
    JWT_SECRET: process.env.JWT_SECRET || '',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
    ADMIN_EMAILS: process.env.ADMIN_EMAILS || '',
    RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  });
};
