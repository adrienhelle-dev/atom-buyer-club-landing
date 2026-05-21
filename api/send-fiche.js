const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');
const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { lead_id, project_id, message } = b;
  if (!lead_id || !project_id) return res.status(400).json({ error: 'Paramètres manquants' });

  const [{ data: lead, error: le }, { data: project, error: pe }] = await Promise.all([
    supabase.from('leads').select('prenom, nom, email').eq('id', lead_id).single(),
    supabase.from('projects').select('*').eq('id', project_id).single(),
  ]);
  if (le || !lead) return res.status(404).json({ error: 'Lead non trouvé' });
  if (pe || !project) return res.status(404).json({ error: 'Projet non trouvé' });

  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY manquant');
    return res.status(500).json({ error: 'email_config_missing' });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';

  try {
    await resend.emails.send({
      from,
      to: [lead.email],
      subject: `Atom Buyers Club — ${project.titre}`,
      html: buildFicheEmail(lead, project, message),
    });
  } catch (e) {
    console.error('send-fiche email:', e?.message || e);
    return res.status(500).json({ error: 'email_error' });
  }

  // Log de l'envoi dans la timeline
  await supabase.from('lead_events').insert([{
    lead_id,
    type: 'fiche_envoyee',
    content: JSON.stringify({ titre: project.titre, project_id }),
    author: payload.email,
  }]).catch(e => console.error('Event log fiche:', e));

  return res.status(200).json({ ok: true });
};

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildFicheEmail(lead, project, message) {
  const msg  = message ? `<p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.7;font-style:italic;padding:14px 16px;background:#f8f8f8;border-radius:6px;border-left:3px solid #B8975A">${esc(message).replace(/\n/g,'<br>')}</p>` : '';
  const adr  = project.adresse ? `<p style="margin:6px 0 0;font-size:13px;color:#B8975A">📍 ${esc(project.adresse)}</p>` : '';
  const prix = project.prix ? `<p style="margin:6px 0 0;font-size:14px;font-weight:500;color:#F5F2ED">${esc(project.prix)}</p>` : '';
  const desc = project.description ? `<p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.7">${esc(project.description)}</p>` : '';
  const pdf  = project.pdf_url ? `<a href="${esc(project.pdf_url)}" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#0f0e0c;color:#F5F2ED;text-decoration:none;border-radius:6px;font-size:13px;font-weight:500">Voir la fiche complète →</a>` : '';

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:system-ui,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5">
    <div style="background:#0f0e0c;padding:22px 28px">
      <p style="margin:0 0 10px;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8975A">Atom Buyers Club</p>
      <h1 style="margin:0;font-size:21px;font-weight:400;color:#F5F2ED">${esc(project.titre)}</h1>
      ${adr}${prix}
    </div>
    <div style="padding:28px">
      <p style="margin:0 0 20px;font-size:15px;color:#111">Bonjour ${esc(lead.prenom)},</p>
      ${msg}
      <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.7">Nous avons sélectionné pour vous une opportunité immobilière qui correspond à votre projet.</p>
      ${desc}${pdf}
    </div>
    <div style="padding:16px 28px 24px;border-top:1px solid #f0f0f0;font-size:12px;color:#aaa">
      Atom Buyers Club · Paris · <a href="https://join.atombuyerclub.fr" style="color:#B8975A;text-decoration:none">join.atombuyerclub.fr</a>
    </div>
  </div></body></html>`;
}
