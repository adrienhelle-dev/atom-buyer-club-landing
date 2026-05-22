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
    supabase.from('leads').select('prenom, nom, email, status').eq('id', lead_id).single(),
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
  const title = project.title || project.titre || 'Nouvelle opportunité';

  // ─── Envoi email ────────────────────────────────────────────────
  let emailResult;
  try {
    emailResult = await resend.emails.send({
      from,
      to: [lead.email],
      subject: `Atom Buyers Club — ${title}`,
      html: buildFicheEmail(lead, project, message),
    });
  } catch (e) {
    console.error('send-fiche throw:', e?.message || e);
    return res.status(500).json({ error: 'email_error', detail: e?.message });
  }

  // Resend SDK v4 retourne { data, error } sans throw
  if (emailResult?.error) {
    console.error('send-fiche resend error:', emailResult.error);
    return res.status(500).json({ error: 'email_error', detail: emailResult.error?.message || String(emailResult.error) });
  }

  console.log('Fiche envoyée id:', emailResult?.data?.id || 'ok', '→', lead.email, '· projet:', title);

  // ─── Mise à jour lead : responsable + statut minimum "contacté" ──
  const leadUpdates = { assigned_to: payload.email };
  if (!lead.status || lead.status === 'nouveau') {
    leadUpdates.status = 'contacte';
  }
  await supabase.from('leads').update(leadUpdates).eq('id', lead_id)
    .catch(e => console.error('Lead update after fiche:', e));

  // ─── Timeline ──────────────────────────────────────────────────
  await supabase.from('lead_events').insert([{
    lead_id,
    type: 'fiche_envoyee',
    content: JSON.stringify({ title, project_id }),
    author: payload.email,
  }]).catch(e => console.error('Event log fiche:', e));

  // Si statut changé, log timeline statut aussi
  if (leadUpdates.status) {
    await supabase.from('lead_events').insert([{
      lead_id,
      type: 'status_change',
      content: JSON.stringify({ status: leadUpdates.status }),
      author: payload.email,
    }]).catch(() => {});
  }

  return res.status(200).json({ ok: true, assigned_to: payload.email, status: leadUpdates.status || lead.status });
};

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtPrice(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return '';
  return n.toLocaleString('fr-FR') + ' €';
}

function buildFicheEmail(lead, project, message) {
  const title   = project.title   || project.titre   || 'Nouvelle opportunité';
  const address = project.address || project.adresse || '';
  const price   = project.price_fai ? fmtPrice(project.price_fai) : '';
  const slug    = project.slug;
  const ficheUrl = slug ? `https://join.atombuyerclub.fr/projet/${slug}` : '';

  const surface   = project.surface_carrez ? `${project.surface_carrez} m²` : '';
  const arr       = project.arrondissement || '';
  const loyer     = project.loyer_atom ? `${fmtPrice(project.loyer_atom)}/mois` : '';
  const rendement = project.rendement_brut ? `${project.rendement_brut}%` : '';

  const msg  = message ? `<p style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.7;font-style:italic;padding:14px 16px;background:#f8f8f8;border-radius:6px;border-left:3px solid #B8975A">${esc(message).replace(/\n/g,'<br>')}</p>` : '';
  const adr  = address ? `<p style="margin:6px 0 0;font-size:13px;color:#B8975A">📍 ${esc(address)}</p>` : '';
  const prx  = price ? `<p style="margin:6px 0 0;font-size:15px;font-weight:500;color:#F5F2ED">${esc(price)} FAI</p>` : '';
  const desc = project.description ? `<p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.7">${esc(project.description)}</p>` : '';

  const stats = [
    surface   ? `<span style="background:#1e1d1a;padding:5px 10px;border-radius:4px;font-size:12px;color:#F5F2ED">${esc(surface)}</span>` : '',
    arr       ? `<span style="background:#1e1d1a;padding:5px 10px;border-radius:4px;font-size:12px;color:#F5F2ED">${esc(arr)}</span>` : '',
    loyer     ? `<span style="background:#1e1d1a;padding:5px 10px;border-radius:4px;font-size:12px;color:#4caf7d">Loyer : ${esc(loyer)}</span>` : '',
    rendement ? `<span style="background:rgba(184,151,90,.2);padding:5px 10px;border-radius:4px;font-size:12px;color:#B8975A">Rendement : ${esc(rendement)}</span>` : '',
  ].filter(Boolean).join(' ');

  const ctaBlock = ficheUrl
    ? `<div style="margin-top:24px"><a href="${esc(ficheUrl)}" style="display:inline-block;padding:13px 26px;background:#B8975A;color:#0f0e0c;text-decoration:none;border-radius:7px;font-size:14px;font-weight:600;letter-spacing:.02em">Voir la fiche complète →</a></div>`
    : '';

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:system-ui,-apple-system,sans-serif">
  <div style="max-width:580px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;box-shadow:0 2px 12px rgba(0,0,0,.07)">
    <div style="background:#0f0e0c;padding:24px 28px">
      <p style="margin:0 0 12px;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8975A;font-weight:500">Atom Buyers Club</p>
      <h1 style="margin:0;font-size:22px;font-weight:300;color:#F5F2ED;line-height:1.3">${esc(title)}</h1>
      ${adr}${prx}
      ${stats ? `<div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:6px">${stats}</div>` : ''}
    </div>
    <div style="padding:28px">
      <p style="margin:0 0 20px;font-size:16px;color:#111;font-weight:400">Bonjour ${esc(lead.prenom)},</p>
      ${msg}
      <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.7">Nous avons sélectionné pour vous une opportunité immobilière qui correspond à votre projet.</p>
      ${desc}
      ${ctaBlock}
    </div>
    <div style="padding:16px 28px 24px;border-top:1px solid #f0f0f0;font-size:12px;color:#aaa">
      Atom Buyers Club · Paris · <a href="https://join.atombuyerclub.fr" style="color:#B8975A;text-decoration:none">join.atombuyerclub.fr</a>
    </div>
  </div></body></html>`;
}
