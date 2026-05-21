const { supabase } = require('../lib/supabase');
const { Resend } = require('resend');

const TIMING = { asap: 'Dès que possible', '3mois': 'Dans 3 mois', '6mois': 'Dans 6 mois', reflexion: 'En réflexion' };
const FIN    = { comptant: 'Comptant', emprunt: 'Emprunt bancaire' };
const BUDGET = { 'moins-150k': '< 150 k€', '150-250k': '150–250 k€', '250-400k': '250–400 k€', '400-600k': '400–600 k€', '600k-1m': '600 k€–1 M€', 'plus-1m': '> 1 M€' };
const SOURCE = { google: 'Google Ads', instagram: 'Instagram Ads', facebook: 'Facebook Ads', meta: 'Meta Ads', email: 'Email', organic: 'Organique' };

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  if (!b.email || !b.prenom || !b.nom || !b.tel) {
    return res.status(400).json({ error: 'Champs requis manquants' });
  }

  const lead = {
    prenom: b.prenom, nom: b.nom, email: b.email, tel: b.tel,
    arrondissements: b.arrondissements || null,
    timing: b.timing || null,
    accord: b.accord || null,
    financement: b.financement || null,
    capacite: b.capacite || null,
    utm_source: b.utm_source || null,
    utm_medium: b.utm_medium || null,
    utm_campaign: b.utm_campaign || null,
    utm_content: b.utm_content || null,
    utm_term: b.utm_term || null,
    gclid: b.gclid || null,
    fbclid: b.fbclid || null,
    referrer: b.referrer || null,
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
  };

  const { error: dbErr } = await supabase.from('leads').insert([lead]);
  if (dbErr) { console.error('DB:', dbErr); return res.status(500).json({ error: 'db_error' }); }

  const notifyEmails = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (notifyEmails.length && process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    try {
      await resend.emails.send({
        from: 'Atom Buyers Club <leads@atombuyerclub.fr>',
        to: notifyEmails,
        subject: `Nouveau lead — ${lead.prenom} ${lead.nom}`,
        html: buildEmail(lead),
      });
    } catch (e) { console.error('Email:', e); }
  }

  return res.status(200).json({ ok: true });
};

function row(label, value) {
  return `<tr><td style="padding:9px 20px 9px 0;color:#888;font-size:13px;white-space:nowrap">${label}</td><td style="padding:9px 0;font-size:14px;color:#111">${value || '—'}</td></tr>`;
}

function buildEmail(l) {
  const src = l.utm_source ? (SOURCE[l.utm_source.toLowerCase()] || l.utm_source) : '—';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:system-ui,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5">
    <div style="background:#0f0e0c;padding:22px 28px">
      <p style="margin:0;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8975A">Atom Buyers Club · Lead qualifié</p>
      <h1 style="margin:8px 0 0;font-size:19px;font-weight:400;color:#F5F2ED">${l.prenom} ${l.nom}</h1>
    </div>
    <div style="padding:24px 28px">
      <table style="width:100%;border-collapse:collapse">
        ${row('Email', `<a href="mailto:${l.email}" style="color:#B8975A">${l.email}</a>`)}
        ${row('Téléphone', l.tel)}
        ${row('Arrondissements', l.arrondissements)}
        ${row('Horizon', TIMING[l.timing] || l.timing)}
        ${row('Accord bancaire', l.accord === 'oui' ? '✓ Oui' : l.accord === 'non' ? 'Non' : null)}
        ${row('Financement', FIN[l.financement] || l.financement)}
        ${row('Budget emprunt', BUDGET[l.capacite] || l.capacite)}
        ${row('Source campagne', src)}
        ${row('Campagne', l.utm_campaign)}
        ${row('Medium', l.utm_medium)}
        ${l.gclid ? row('GCLID', l.gclid) : ''}
        ${l.fbclid ? row('FBCLID', l.fbclid) : ''}
      </table>
    </div>
    <div style="padding:16px 28px 24px;border-top:1px solid #f0f0f0">
      <a href="${process.env.SITE_URL || 'https://join.atombuyerclub.fr'}/admin" style="display:inline-block;padding:10px 18px;background:#0f0e0c;color:#F5F2ED;text-decoration:none;border-radius:6px;font-size:13px">Voir dans le panel admin →</a>
    </div>
  </div></body></html>`;
}
