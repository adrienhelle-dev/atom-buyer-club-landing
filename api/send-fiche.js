const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');
const { getFounder, associateEmails } = require('../lib/founders');
const { esc } = require('../lib/html');
const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  // ─── Envoi en masse : fiche à tous les leads compatibles d'un projet ──
  if (Array.isArray(b.lead_ids) && b.lead_ids.length) return handleBulkFiche(req, res, b, payload);

  const { lead_id, project_id, message, force, subject, body: emailBody } = b;
  if (!lead_id) return res.status(400).json({ error: 'Paramètres manquants' });

  // ─── Mode email libre (depuis drawer lead) ──────────────────────
  if (subject && emailBody) {
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
        from, replyTo: associateEmails(), to: [lead.email], subject,
        cc: [payload.email], // responsable du lead (= l'expéditeur) en copie
        html: buildSimpleEmail(lead, subject, emailBody, founder, payload.email),
      });
    } catch (e) {
      return res.status(500).json({ error: 'email_error', detail: e?.message });
    }
    if (emailResult?.error) return res.status(500).json({ error: 'email_error', detail: emailResult.error?.message || String(emailResult.error) });

    console.log('Email libre id:', emailResult?.data?.id || 'ok', '→', lead.email);

    const leadUpdates = { assigned_to: payload.email };
    if (!lead.status || lead.status === 'nouveau') leadUpdates.status = 'contacte';
    const events = [{ lead_id, type: 'email_manuel', content: JSON.stringify({ subject }), author: payload.email }];
    if (leadUpdates.status) events.push({ lead_id, type: 'status_change', content: JSON.stringify({ status: leadUpdates.status }), author: payload.email });
    await Promise.allSettled([
      supabase.from('leads').update(leadUpdates).eq('id', lead_id),
      supabase.from('lead_events').insert(events),
    ]);
    return res.status(200).json({ ok: true, assigned_to: payload.email, status: leadUpdates.status || lead.status });
  }

  // ─── Mode fiche projet ──────────────────────────────────────────
  if (!project_id) return res.status(400).json({ error: 'Paramètres manquants' });

  // ─── Chargement lead + projet en parallèle ─────────────────────
  const [{ data: lead, error: le }, { data: project, error: pe }] = await Promise.all([
    supabase.from('leads').select('id, prenom, nom, email, status').eq('id', lead_id).single(),
    supabase.from('projects').select('*').eq('id', project_id).single(),
  ]);
  if (le || !lead)    return res.status(404).json({ error: 'Lead non trouvé' });
  if (pe || !project) return res.status(404).json({ error: 'Projet non trouvé' });

  // ─── Anti-spam : vérif envoi < 24h pour ce projet + ce lead ────
  if (!force) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentSends } = await supabase
      .from('lead_events')
      .select('created_at, content')
      .eq('lead_id', lead_id)
      .eq('type', 'fiche_envoyee')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(10);

    const alreadySent = (recentSends || []).find(e => {
      try { return JSON.parse(e.content).project_id === project_id; }
      catch { return false; }
    });

    if (alreadySent) {
      const hoursAgo = (Date.now() - new Date(alreadySent.created_at).getTime()) / 3600000;
      return res.status(409).json({
        warn: 'already_sent',
        last_sent: alreadySent.created_at,
        hours_ago: Math.round(hoursAgo * 10) / 10,
      });
    }
  }

  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY manquant');
    return res.status(500).json({ error: 'email_config_missing' });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const from   = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
  const title  = project.title || project.titre || 'Nouvelle opportunité';

  // ─── Envoi email ────────────────────────────────────────────────
  let emailResult;
  try {
    emailResult = await resend.emails.send({
      from,
      replyTo: associateEmails(),
      to: [lead.email],
      cc: [payload.email], // responsable du lead (= l'expéditeur) en copie
      subject: `Atom Buyers Club — ${title}`,
      html: buildFicheEmail(lead, project, message, getFounder(payload.email), payload.email),
    });
  } catch (e) {
    console.error('send-fiche throw:', e?.message || e);
    return res.status(500).json({ error: 'email_error', detail: e?.message });
  }

  // Resend SDK v4 retourne { data, error } sans throw
  if (emailResult?.error) {
    console.error('send-fiche resend error:', JSON.stringify(emailResult.error));
    return res.status(500).json({
      error: 'email_error',
      detail: emailResult.error?.message || String(emailResult.error),
    });
  }

  console.log('Fiche envoyée id:', emailResult?.data?.id || 'ok', '→', lead.email, '· projet:', title);

  // ─── DB : lead update + events en parallèle ─────────────────────
  const leadUpdates = { assigned_to: payload.email };
  if (!lead.status || lead.status === 'nouveau') leadUpdates.status = 'contacte';

  const events = [
    { lead_id, type: 'fiche_envoyee', content: JSON.stringify({ title, project_id }), author: payload.email },
  ];
  if (leadUpdates.status) {
    events.push({ lead_id, type: 'status_change', content: JSON.stringify({ status: leadUpdates.status }), author: payload.email });
  }

  await Promise.allSettled([
    supabase.from('leads').update(leadUpdates).eq('id', lead_id),
    supabase.from('lead_events').insert(events),
  ]);

  return res.status(200).json({
    ok: true,
    assigned_to: payload.email,
    status: leadUpdates.status || lead.status,
  });
};

// ─── Envoi en masse de la fiche projet aux leads compatibles ──────────────
// Envoi groupé via Resend batch (≤100/appel), reply-to = 3 associés, SANS cc
// (évite 177 copies à l'expéditeur). Anti-doublon : ignore les leads ayant déjà
// reçu la fiche de CE projet (sauf force=true).
async function handleBulkFiche(req, res, b, payload) {
  const { project_id, lead_ids, message, force } = b;
  if (!project_id) return res.status(400).json({ error: 'project_id requis' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'email_config_missing' });

  const { data: project } = await supabase.from('projects').select('*').eq('id', project_id).single();
  if (!project) return res.status(404).json({ error: 'Projet non trouvé' });

  const { data: leads } = await supabase.from('leads').select('id, prenom, nom, email, status').in('id', lead_ids);
  let targets = (leads || []).filter(l => l.email);

  // Anti-doublon : leads ayant déjà reçu la fiche de ce projet
  const { data: prior } = await supabase.from('lead_events').select('lead_id, content').eq('type', 'fiche_envoyee').limit(10000);
  const doneSet = new Set();
  for (const e of (prior || [])) { try { if (JSON.parse(e.content).project_id === project_id) doneSet.add(e.lead_id); } catch {} }
  const skipped = force ? 0 : targets.filter(l => doneSet.has(l.id)).length;
  if (!force) targets = targets.filter(l => !doneSet.has(l.id));

  if (!targets.length) return res.status(200).json({ ok: true, sent: 0, skipped, total: (leads || []).length, all_done: skipped > 0 });

  const resend  = new Resend(process.env.RESEND_API_KEY);
  const from    = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
  const replyTo = associateEmails();
  const title   = project.title || project.titre || 'Nouvelle opportunité';
  const founder = getFounder(payload.email);
  const subject = `Atom Buyers Club — ${title}`;

  let sent = 0, failed = 0;
  const sentLeads = [];
  for (let i = 0; i < targets.length; i += 100) {
    const chunkLeads = targets.slice(i, i + 100);
    const chunk = chunkLeads.map(l => ({ from, replyTo, to: [l.email], subject, html: buildFicheEmail(l, project, message, founder, payload.email) }));
    try {
      const r = await resend.batch.send(chunk);
      if (r?.error) { failed += chunkLeads.length; console.error('[bulk fiche] batch error', JSON.stringify(r.error)); }
      else { sent += chunkLeads.length; sentLeads.push(...chunkLeads); }
    } catch (e) { failed += chunkLeads.length; console.error('[bulk fiche] throw', e?.message || e); }
  }

  if (sentLeads.length) {
    const events = sentLeads.map(l => ({ lead_id: l.id, type: 'fiche_envoyee', content: JSON.stringify({ title, project_id, bulk: true }), author: payload.email }));
    const toContacte = sentLeads.filter(l => !l.status || l.status === 'nouveau').map(l => l.id);
    await supabase.from('lead_events').insert(events);
    if (toContacte.length) await supabase.from('leads').update({ status: 'contacte' }).in('id', toContacte);
  }

  return res.status(200).json({ ok: true, sent, skipped, failed, total: (leads || []).length });
}

// ─── Helpers ────────────────────────────────────────────────────

function fmtPrice(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '' : n.toLocaleString('fr-FR') + ' €';
}

function buildSimpleEmail(lead, subject, body, founder = {}, senderEmail = '') {
  // Supprime le "Bonjour X," en tête de corps s'il est présent (protection anti-doublon)
  const cleanBody = body.replace(/^bonjour\s+\S+\s*,?\s*/i, '').trim();
  const bodyHtml  = esc(cleanBody).replace(/\n/g, '<br>');
  const greeting  = `<p style="margin:0 0 16px;font-size:14px;color:#444">Bonjour ${esc(lead.prenom)},</p>`;
  const sigName   = founder.name  ? `<strong style="color:#555">${esc(founder.name)}</strong><br>` : '';
  const sigPhone  = founder.phone ? `${esc(founder.phone)} · ` : '';
  const sigEmail  = senderEmail   ? `<a href="mailto:${esc(senderEmail)}" style="color:#B8975A;text-decoration:none">${esc(senderEmail)}</a><br>` : '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:system-ui,-apple-system,sans-serif">
  <div style="max-width:580px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;box-shadow:0 2px 12px rgba(0,0,0,.07)">
    <div style="background:#0f0e0c;padding:22px 28px">
      <p style="margin:0;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8975A;font-weight:500">Atom Buyers Club</p>
    </div>
    <div style="padding:28px">
      ${greeting}
      <p style="margin:0 0 24px;font-size:14px;color:#444;line-height:1.8">${bodyHtml}</p>
    </div>
    <div style="padding:16px 28px 24px;border-top:1px solid #f0f0f0;font-size:12px;color:#888;line-height:1.7">
      ${sigName}${sigPhone}${sigEmail}Atom Buyers Club · Paris · <a href="https://join.atombuyerclub.fr" style="color:#B8975A;text-decoration:none">join.atombuyerclub.fr</a>
    </div>
  </div></body></html>`;
}

function buildFicheEmail(lead, project, message, founder = {}, senderEmail = '') {
  const title   = project.title   || project.titre   || 'Nouvelle opportunité';
  const address = project.address || project.adresse || '';
  const price   = project.price_fai ? fmtPrice(project.price_fai) + ' FAI' : '';
  const slug    = project.slug;
  const ficheUrl = slug ? `https://join.atombuyerclub.fr/projet/${slug}?lead_id=${lead.id}` : '';

  const surface   = project.surface_carrez ? `${project.surface_carrez} m²` : '';
  const arr       = project.arrondissement || '';
  const loyer     = project.loyer_atom ? `Loyer ${fmtPrice(project.loyer_atom)}/mois` : '';
  const rendement = project.rendement_brut ? `Rendement ${project.rendement_brut}%` : '';

  const msgHtml  = message
    ? `<p style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.7;font-style:italic;padding:14px 16px;background:#f8f8f8;border-radius:6px;border-left:3px solid #B8975A">${esc(message).replace(/\n/g,'<br>')}</p>`
    : '';
  const adrHtml  = address ? `<p style="margin:6px 0 0;font-size:13px;color:#B8975A">📍 ${esc(address)}</p>` : '';
  const prxHtml  = price   ? `<p style="margin:8px 0 0;font-size:16px;font-weight:600;color:#F5F2ED">${esc(price)}</p>` : '';
  const descHtml = project.description
    ? `<p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.7">${esc(project.description)}</p>`
    : '';

  const chips = [surface, arr, loyer, rendement].filter(Boolean)
    .map(t => `<span style="display:inline-block;background:#1e1d1a;padding:5px 10px;border-radius:4px;font-size:12px;color:#F5F2ED;margin:3px 3px 0 0">${esc(t)}</span>`)
    .join('');

  const ctaHtml = ficheUrl
    ? `<div style="margin-top:28px"><a href="${esc(ficheUrl)}" style="display:inline-block;padding:13px 26px;background:#B8975A;color:#0f0e0c;text-decoration:none;border-radius:7px;font-size:14px;font-weight:600;letter-spacing:.02em">Voir la fiche complète →</a></div>`
    : '';

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:system-ui,-apple-system,sans-serif">
  <div style="max-width:580px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5;box-shadow:0 2px 12px rgba(0,0,0,.07)">
    <div style="background:#0f0e0c;padding:26px 28px">
      <p style="margin:0 0 12px;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8975A;font-weight:500">Atom Buyers Club</p>
      <h1 style="margin:0;font-size:22px;font-weight:300;color:#F5F2ED;line-height:1.3">${esc(title)}</h1>
      ${adrHtml}${prxHtml}
      ${chips ? `<div style="margin-top:14px">${chips}</div>` : ''}
    </div>
    <div style="padding:28px">
      <p style="margin:0 0 20px;font-size:16px;color:#111">Bonjour ${esc(lead.prenom)},</p>
      ${msgHtml}
      <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.7">Nous avons sélectionné pour vous une opportunité immobilière qui correspond à votre projet.</p>
      ${descHtml}${ctaHtml}
    </div>
    <div style="padding:16px 28px 24px;border-top:1px solid #f0f0f0;font-size:12px;color:#888;line-height:1.7">
      ${founder.name ? `<strong style="color:#555">${esc(founder.name)}</strong><br>` : ''}${founder.phone ? `${esc(founder.phone)} · ` : ''}${senderEmail ? `<a href="mailto:${esc(senderEmail)}" style="color:#B8975A;text-decoration:none">${esc(senderEmail)}</a><br>` : ''}
      Atom Buyers Club · Paris · <a href="https://join.atombuyerclub.fr" style="color:#B8975A;text-decoration:none">join.atombuyerclub.fr</a>
    </div>
  </div></body></html>`;
}
