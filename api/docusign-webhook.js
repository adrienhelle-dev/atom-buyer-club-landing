// api/docusign-webhook.js
// Reçoit les notifications DocuSign (Connect) quand une enveloppe est signée.
//
// DocuSign envoie un POST avec le status de l'enveloppe.
// Quand status = "completed" (tous les signataires ont signé) :
//   → mandats.statut = 'mandat_signe'
//   → si un projet est lié, son statut passe à 'vendu' (vendu par Atom)
//   → notification Telegram
//
// Configuration DocuSign Connect :
//   URL : https://join.atombuyerclub.fr/api/docusign-webhook
//   Événements à cocher : "Envelope Completed"
//   HMAC Key (optionnel mais recommandé) → stocker dans DOCUSIGN_HMAC_KEY

const { supabase }     = require('../lib/supabase');
const { sendTelegram } = require('../lib/notify');
const crypto           = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Vérification HMAC optionnelle (recommandée en prod)
  const hmacKey = process.env.DOCUSIGN_HMAC_KEY;
  if (hmacKey) {
    const sig       = req.headers['x-docusign-signature-1'] || '';
    const body      = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const expected  = crypto.createHmac('sha256', hmacKey).update(body).digest('base64');
    if (sig !== expected) {
      console.warn('[docusign-webhook] HMAC invalide');
      return res.status(401).json({ error: 'invalid_signature' });
    }
  }

  let update = {};
  try { update = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}

  // DocuSign envoie soit du JSON soit du XML (Connect) selon la config.
  // On supporte ici JSON (format recommandé dans la config Connect).
  const status     = update?.event || update?.status || '';
  const envelopeId = update?.data?.envelopeId || update?.envelopeId || '';

  console.log('[docusign-webhook] event:', status, '| envelope:', envelopeId);

  // On ne traite que l'événement "completed"
  if (status !== 'envelope-completed' && status !== 'completed') {
    return res.status(200).json({ ok: true, ignored: true });
  }
  if (!envelopeId) return res.status(200).json({ ok: true, ignored: true });

  // Trouver le mandat correspondant
  const { data: mandat } = await supabase
    .from('mandats')
    .select('id, lead_id, project_id, commission, statut')
    .eq('docusign_envelope_id', envelopeId)
    .maybeSingle();

  if (!mandat) {
    console.warn('[docusign-webhook] envelope inconnue :', envelopeId);
    return res.status(200).json({ ok: true, ignored: true });
  }

  // Marquer mandat signé
  await supabase.from('mandats').update({ statut: 'mandat_signe' }).eq('id', mandat.id);

  // Charger lead + projet pour la notification
  const [{ data: lead }, { data: project }] = await Promise.all([
    supabase.from('leads').select('prenom, nom, email').eq('id', mandat.lead_id).maybeSingle(),
    mandat.project_id ? supabase.from('projects').select('title, address, statut').eq('id', mandat.project_id).maybeSingle() : { data: null },
  ]);

  // Passer le projet en "vendu" si c'est un projet Atom
  if (project && project.statut !== 'vendu') {
    await supabase.from('projects').update({
      statut: 'vendu',
      commission_ht: mandat.commission,
    }).eq('id', mandat.project_id);
  }

  // Notification Telegram
  const leadName    = lead ? `${lead.prenom} ${lead.nom}` : 'Lead inconnu';
  const projectName = project ? (project.address || project.title) : 'Projet inconnu';
  await sendTelegram(
    `✅ <b>Mandat signé !</b>\n\n👤 ${leadName}\n🏠 ${projectName}\n💶 Commission : ${Number(mandat.commission).toLocaleString('fr-FR')} €\n\n<a href="${(process.env.SITE_URL || 'https://join.atombuyerclub.fr').replace(/\/$/, '')}/admin">Ouvrir le panel</a>`
  );

  return res.status(200).json({ ok: true });
};
