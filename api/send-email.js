const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');
const { getFounder } = require('../lib/founders');
const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { lead_id, subject, body } = b;
  if (!lead_id || !subject || !body) return res.status(400).json({ error: 'Paramètres manquants' });

  // Chargement du lead
  const { data: lead, error: le } = await supabase
    .from('leads').select('prenom, nom, email, status').eq('id', lead_id).single();
  if (le || !lead) return res.status(404).json({ error: 'Lead non trouvé' });

  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'email_config_missing' });

  const resend  = new Resend(process.env.RESEND_API_KEY);
  const from    = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
  const founder = getFounder(payload.email);

  let emailResult;
  try {
    emailResult = await resend.emails.send({
      from,
      to: [lead.email],
      subject,
      html: buildEmail(lead, subject, body, founder, payload.email),
    });
  } catch (e) {
    console.error('send-email throw:', e?.message || e);
    return res.status(500).json({ error: 'email_error', detail: e?.message });
  }

  if (emailResult?.error) {
    console.error('send-email resend error:', JSON.stringify(emailResult.error));
    return res.status(500).json({ error: 'email_error', detail: emailResult.error?.message || String(emailResult.error) });
  }

  console.log('Email envoyé id:', emailResult?.data?.id || 'ok', '→', lead.email);

  // ─── DB : lead update + event en parallèle ──────────────────────
  const leadUpdates = { assigned_to: payload.email };
  if (!lead.status || lead.status === 'nouveau') leadUpdates.status = 'contacte';

  const events = [
    { lead_id, type: 'email_manuel', content: JSON.stringify({ subject }), author: payload.email },
  ];
  if (leadUpdates.status) {
    events.push({ lead_id, type: 'status_change', content: JSON.stringify({ status: leadUpdates.status }), author: payload.email });
  }

  await Promise.all([
    supabase.from('leads').update(leadUpdates).eq('id', lead_id).catch(e => console.error('Lead update after email:', e)),
    supabase.from('lead_events').insert(events).catch(e => console.error('Event log email:', e)),
  ]);

  return res.status(200).json({ ok: true, assigned_to: payload.email, status: leadUpdates.status || lead.status });
};

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildEmail(lead, subject, body, founder, senderEmail) {
  const bodyHtml = esc(body).replace(/\n/g, '<br>');
  const sigName  = founder.name  ? `<strong>${esc(founder.name)}</strong><br>` : '';
  const sigPhone = founder.phone ? `${esc(founder.phone)} · ` : '';
  const sigEmail = `<a href="mailto:${esc(senderEmail)}" style="color:#B8975A;text-decoration:none">${esc(senderEmail)}</a>`;

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:system-ui,-apple-system,sans-serif">
  <div style="max-width:580px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;box-shadow:0 2px 12px rgba(0,0,0,.07)">
    <div style="background:#0f0e0c;padding:22px 28px">
      <p style="margin:0;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8975A;font-weight:500">Atom Buyers Club</p>
    </div>
    <div style="padding:28px">
      <p style="margin:0 0 20px;font-size:16px;color:#111">Bonjour ${esc(lead.prenom)},</p>
      <p style="margin:0 0 24px;font-size:14px;color:#444;line-height:1.8">${bodyHtml}</p>
    </div>
    <div style="padding:16px 28px 24px;border-top:1px solid #f0f0f0;font-size:12px;color:#888;line-height:1.7">
      ${sigName}${sigPhone}${sigEmail}<br>
      Atom Buyers Club · Paris · <a href="https://join.atombuyerclub.fr" style="color:#B8975A;text-decoration:none">join.atombuyerclub.fr</a>
    </div>
  </div></body></html>`;
}
