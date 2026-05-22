const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

const BUCKET = 'project-images';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  // ─── POST : génère une URL de upload signée ──────────────────
  if (req.method === 'POST') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { filename, project_id, mime_type } = b;

    if (!filename) return res.status(400).json({ error: 'filename requis' });

    // Sanitise le nom de fichier (garde extension)
    const ext = String(filename).split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const safeBase = String(filename).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const folder = project_id ? String(project_id).replace(/[^a-zA-Z0-9-]/g, '') : 'tmp';
    const path   = `${folder}/${Date.now()}-${safeBase}.${ext}`;

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);

    if (error) {
      console.error('createSignedUploadUrl:', error);
      return res.status(500).json({ error: 'upload_url_error', detail: error.message });
    }

    const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path);

    return res.status(200).json({
      signedUrl: data.signedUrl,
      token:     data.token,
      path,
      publicUrl,
    });
  }

  // ─── DELETE : supprime un fichier ────────────────────────────
  if (req.method === 'DELETE') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { path } = b;
    if (!path) return res.status(400).json({ error: 'path requis' });

    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) {
      console.error('storage remove:', error);
      return res.status(500).json({ error: 'delete_error', detail: error.message });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
};
