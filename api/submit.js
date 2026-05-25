const { supabase } = require('../lib/supabase');
const { ADMIN_EMAILS } = require('../lib/auth');
const { getFounder } = require('../lib/founders');
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

  const emailNorm = b.email.trim().toLowerCase();
  const ip        = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
  const projectId = b.project_id || null;

  const leadData = {
    prenom: b.prenom.trim(), nom: b.nom.trim(),
    email: emailNorm, tel: b.tel.trim(),
    arrondissements: b.arrondissements || null,
    timing:      b.timing      || null,
    accord:      b.accord      || null,
    financement: b.financement || null,
    capacite:    b.capacite    || null,
    utm_source:  b.utm_source  || null,
    utm_medium:  b.utm_medium  || null,
    utm_campaign:b.utm_campaign|| null,
    utm_content: b.utm_content || null,
    utm_term:    b.utm_term    || null,
    gclid:       b.gclid       || null,
    fbclid:      b.fbclid      || null,
    referrer:    b.referrer    || null,
    ip,
  };

  // ── Cherche un lead existant par email ─────────────────────────
  const { data: existing } = await supabase
    .from('leads')
    .select('id, email')
    .eq('email', emailNorm)
    .maybeSingle();

  let leadId   = null;
  let isUpdate = false;

  const isShowroomCta = b.utm_source === 'showroom';

  if (existing) {
    // Pour un lead existant :
    // 1. On ne touche jamais aux UTMs/source d'acquisition originaux
    // 2. On n'écrase jamais un champ renseigné avec une valeur null
    //    (évite de perdre le profiling quand le formulaire ne contient pas tous les champs)
    const UTM_FIELDS = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid','referrer'];
    const safeUpdate = { updated_at: new Date().toISOString() };
    Object.entries(leadData).forEach(([k, v]) => {
      if (UTM_FIELDS.includes(k)) return;   // jamais écraser l'acquisition originale
      if (v != null)              safeUpdate[k] = v; // seulement si valeur non-null
    });

    const { error } = await supabase
      .from('leads')
      .update(safeUpdate)
      .eq('id', existing.id);
    if (error) { console.error('DB update:', error); return res.status(500).json({ error: 'db_error' }); }
    leadId   = existing.id;
    isUpdate = true;
  } else {
    const { data: newLead, error } = await supabase
      .from('leads')
      .insert([leadData])
      .select('id')
      .single();
    if (error) { console.error('DB insert:', error); return res.status(500).json({ error: 'db_error' }); }
    leadId = newLead.id;
    // Log inscription dans la timeline (fire & forget)
    supabase.from('lead_events').insert([{ lead_id: leadId, type: 'inscription', content: null, author: null }]);
  }

  // ── Log showroom CTA dans la timeline du lead ──────────────────
  if (isShowroomCta && leadId) {
    await supabase.from('lead_events').insert([{
      lead_id: leadId,
      type:    'showroom_cta',
      content: JSON.stringify({ showroom_slug: b.utm_content || null, item_name: b.showroom_item_name || null }),
      author:  null,
    }]);
  }

  // ── Intérêt projet ─────────────────────────────────────────────
  if (projectId && leadId) {
    // Upsert (ignore si doublon UNIQUE lead_id + project_id)
    await supabase.from('project_interests').upsert(
      [{ lead_id: leadId, project_id: projectId, source: 'project_page' }],
      { onConflict: 'lead_id,project_id', ignoreDuplicates: true }
    );

    // Charge le projet en premier pour avoir le titre dans l'event + l'email
    const { data: proj } = await supabase
      .from('projects')
      .select('title, responsible_admin')
      .eq('id', projectId)
      .single();

    // Log dans la timeline — awaited (fire & forget n'est pas fiable en serverless)
    await supabase.from('lead_events').insert([{
      lead_id: leadId,
      type:    'interet_projet',
      content: JSON.stringify({ project_id: projectId, project_title: proj?.title || null }),
      author:  null,
    }]);

    if (process.env.RESEND_API_KEY) {
      const resend    = new Resend(process.env.RESEND_API_KEY);
      const fromAddr  = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
      const projTitle = proj?.title || 'Projet';
      const responsible = proj?.responsible_admin ? getFounder(proj.responsible_admin).name : null;

      // ── Routing : email vers le responsable du projet uniquement.
      // Fallback sur tous les admins si aucun responsable défini.
      let notifyList = [];
      if (proj?.responsible_admin) {
        notifyList = [proj.responsible_admin];
      } else {
        notifyList = ADMIN_EMAILS.length
          ? ADMIN_EMAILS
          : (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
      }

      if (notifyList.length) {
        try {
          await resend.emails.send({
            from: fromAddr,
            to:   notifyList,
            subject: `Intérêt projet — ${leadData.prenom} ${leadData.nom} · ${projTitle}`,
            html: buildInterestEmail(leadData, projTitle, responsible),
          });
          console.log('Notif intérêt envoyée → ', notifyList.join(', '));
        } catch (e) {
          console.error('Email intérêt erreur:', e?.message || e);
        }
      }
    }
  }

  // ── Email hot lead (nouveau lead comptant + asap) ──────────────
  const isHotLead = !isUpdate
    && leadData.financement === 'comptant'
    && leadData.timing      === 'asap';

  if (isHotLead && !projectId) {
    // Ne double-notifie pas si on a déjà envoyé la notif projet ci-dessus
    const notifyEmails = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
    if (notifyEmails.length && process.env.RESEND_API_KEY) {
      const resend   = new Resend(process.env.RESEND_API_KEY);
      const fromAddr = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
      try {
        await resend.emails.send({
          from: fromAddr,
          to:   notifyEmails,
          subject: `🔥 Lead chaud — ${leadData.prenom} ${leadData.nom} · Comptant · Dès que possible`,
          html: buildHotLeadEmail(leadData),
        });
        console.log('Hot lead email envoyé → ', notifyEmails.join(', '));
      } catch (e) {
        console.error('Hot lead email erreur:', e?.message || e);
      }
    }
  }

  return res.status(200).json({ ok: true, updated: isUpdate, lead_id: leadId });
};

// ─── Templates email ────────────────────────────────────────────
function row(label, value) {
  return `<tr><td style="padding:9px 20px 9px 0;color:#888;font-size:13px;white-space:nowrap">${label}</td><td style="padding:9px 0;font-size:14px;color:#111">${value || '—'}</td></tr>`;
}

function buildInterestEmail(l, projTitle, responsible) {
  const src = l.utm_source ? (SOURCE[l.utm_source.toLowerCase()] || l.utm_source) : '—';
  const respLine = responsible ? `<p style="margin:0 0 6px;font-size:13px;color:#888">Responsable projet : <strong style="color:#111">${responsible}</strong></p>` : '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:system-ui,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5">
    <div style="background:#0f0e0c;padding:22px 28px">
      <p style="margin:0 0 8px;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8975A">Atom Buyers Club</p>
      <h1 style="margin:0;font-size:19px;font-weight:400;color:#F5F2ED">${l.prenom} ${l.nom}</h1>
      <p style="margin:6px 0 0;font-size:13px;color:#B8975A">Intérêt déclaré — ${projTitle}</p>
    </div>
    <div style="padding:24px 28px">
      ${respLine}
      <table style="width:100%;border-collapse:collapse">
        ${row('Email',     `<a href="mailto:${l.email}" style="color:#B8975A">${l.email}</a>`)}
        ${row('Téléphone', l.tel)}
        ${row('Source',    src)}
        ${row('Campagne',  l.utm_campaign)}
      </table>
    </div>
    <div style="padding:16px 28px 24px;border-top:1px solid #f0f0f0">
      <a href="${process.env.SITE_URL || 'https://join.atombuyerclub.fr'}/admin" style="display:inline-block;padding:10px 18px;background:#0f0e0c;color:#F5F2ED;text-decoration:none;border-radius:6px;font-size:13px">Voir dans le panel admin →</a>
    </div>
  </div></body></html>`;
}

function buildHotLeadEmail(l) {
  const src = l.utm_source ? (SOURCE[l.utm_source.toLowerCase()] || l.utm_source) : '—';
  const badge = `<span style="display:inline-block;padding:3px 10px;background:#d95e5e22;color:#d95e5e;border-radius:20px;font-size:11px;font-weight:600">🔥 Comptant · Dès que possible</span>`;
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:system-ui,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5">
    <div style="background:#0f0e0c;padding:22px 28px">
      <p style="margin:0 0 8px;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8975A">Atom Buyers Club</p>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <h1 style="margin:0;font-size:19px;font-weight:400;color:#F5F2ED">${l.prenom} ${l.nom}</h1>
        ${badge}
      </div>
    </div>
    <div style="padding:24px 28px">
      <table style="width:100%;border-collapse:collapse">
        ${row('Email', `<a href="mailto:${l.email}" style="color:#B8975A">${l.email}</a>`)}
        ${row('Téléphone', l.tel)}
        ${row('Arrondissements', l.arrondissements)}
        ${row('Horizon', TIMING[l.timing] || l.timing)}
        ${row('Financement bancaire', l.accord === 'oui' ? '✅ Étude validée' : l.accord === 'courtier' ? '🤝 Courtier souhaité' : l.accord === 'non' ? 'Pas encore fait de demande' : null)}
        ${row('Financement', FIN[l.financement] || l.financement)}
        ${row('Budget emprunt', BUDGET[l.capacite] || l.capacite)}
        ${row('Source', src)}
        ${row('Campagne', l.utm_campaign)}
      </table>
    </div>
    <div style="padding:16px 28px 24px;border-top:1px solid #f0f0f0">
      <a href="${process.env.SITE_URL || 'https://join.atombuyerclub.fr'}/admin" style="display:inline-block;padding:10px 18px;background:#0f0e0c;color:#F5F2ED;text-decoration:none;border-radius:6px;font-size:13px">Voir dans le panel admin →</a>
    </div>
  </div></body></html>`;
}
