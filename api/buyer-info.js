// api/buyer-info.js
// Landing page acheteur : collecte les infos manquantes pour générer une offre
// d'achat ou un mandat de recherche.
//
// GET  ?token=<infos_token>  → renvoie les infos publiques du lead (prénom, nom)
//                              pour pré-remplir la page
// POST ?token=<infos_token>  → sauvegarde les données du formulaire sur le lead
// POST ?upload=1&token=…     → génère une URL signée pour uploader la PJ (≤ 5 Mo)

const { supabase } = require('../lib/supabase');
const BUCKET_PJ = 'buyer-docs';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token requis' });

  // Résoudre le lead via le token
  const { data: lead, error: findErr } = await supabase
    .from('leads')
    .select('id, prenom, nom, email, date_naissance, adresse_residence, situation_familiale, conjoint_prenom, conjoint_nom, conjoint_dob, achat_structure, nom_structure, pj_identite_url')
    .eq('infos_token', token)
    .maybeSingle();

  if (findErr || !lead) return res.status(404).json({ error: 'lien invalide ou expiré' });

  // ── GET : renvoie les infos publiques (pour pré-remplissage) ──
  if (req.method === 'GET') {
    return res.status(200).json({
      prenom: lead.prenom,
      nom: lead.nom,
      date_naissance: lead.date_naissance || null,
      adresse_residence: lead.adresse_residence || null,
      situation_familiale: lead.situation_familiale || null,
      conjoint_prenom: lead.conjoint_prenom || null,
      conjoint_nom: lead.conjoint_nom || null,
      conjoint_dob: lead.conjoint_dob || null,
      achat_structure: lead.achat_structure || null,
      nom_structure: lead.nom_structure || null,
      pj_identite_url: lead.pj_identite_url ? '(déjà fournie)' : null,
    });
  }

  // ── POST ?upload=1 : URL signée pour upload PJ ───────────────
  if (req.method === 'POST' && req.query.upload === '1') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { filename, mime_type } = b;
    if (!filename) return res.status(400).json({ error: 'filename requis' });

    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (mime_type && !ALLOWED_TYPES.includes(mime_type)) {
      return res.status(400).json({ error: 'format non accepté (jpg, png, pdf uniquement)' });
    }

    const ext = String(filename).split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${lead.id}/${Date.now()}-id.${ext}`;

    const { data, error } = await supabase.storage
      .from(BUCKET_PJ)
      .createSignedUploadUrl(path);

    if (error) return res.status(500).json({ error: 'upload_url_error', detail: error.message });

    const { data: { publicUrl } } = supabase.storage.from(BUCKET_PJ).getPublicUrl(path);

    return res.status(200).json({ signedUrl: data.signedUrl, token: data.token, path, publicUrl });
  }

  // ── POST : sauvegarde les infos ───────────────────────────────
  if (req.method === 'POST') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    const ALLOWED_SITUATIONS = ['celibataire', 'marie', 'pacse', 'divorce'];
    const ALLOWED_STRUCTURES = ['personnel', 'sci', 'sas'];

    const updates = {};

    if (b.date_naissance) updates.date_naissance = b.date_naissance;
    if (b.adresse_residence) updates.adresse_residence = String(b.adresse_residence).slice(0, 300);
    if (b.situation_familiale && ALLOWED_SITUATIONS.includes(b.situation_familiale))
      updates.situation_familiale = b.situation_familiale;
    if (b.conjoint_prenom) updates.conjoint_prenom = String(b.conjoint_prenom).slice(0, 100);
    if (b.conjoint_nom)    updates.conjoint_nom    = String(b.conjoint_nom).slice(0, 100);
    if (b.conjoint_dob)    updates.conjoint_dob    = b.conjoint_dob;
    if (b.achat_structure && ALLOWED_STRUCTURES.includes(b.achat_structure))
      updates.achat_structure = b.achat_structure;
    if (b.nom_structure)   updates.nom_structure   = String(b.nom_structure).slice(0, 200);
    if (b.pj_identite_url) updates.pj_identite_url = String(b.pj_identite_url).slice(0, 500);

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'aucune donnée valide' });

    const { error: updateErr } = await supabase
      .from('leads')
      .update(updates)
      .eq('id', lead.id);

    if (updateErr) return res.status(500).json({ error: 'db_error', detail: updateErr.message });

    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
};
