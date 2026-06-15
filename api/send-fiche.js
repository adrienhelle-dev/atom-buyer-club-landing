const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');
const { getFounder, associateEmails } = require('../lib/founders');
const { esc } = require('../lib/html');
const { sendTelegram } = require('../lib/notify');
const { Resend } = require('resend');
const crypto = require('crypto');

module.exports = handler;
module.exports.processFicheQueue = processFicheQueue;

async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  // ─── GET : statut du mailing groupé d'un projet (bandeau anti-doublon) ──
  if (req.method === 'GET') return handleBlastStatus(req, res);
  if (req.method !== 'POST') return res.status(405).end();

  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  // ─── Relance "compléter le profil" (leads sans info de financement) ──
  if (b.relance_profil && Array.isArray(b.lead_ids) && b.lead_ids.length) return handleRelanceProfil(req, res, b, payload);

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

// ─── Statut du mailing groupé d'un projet (pour le bandeau anti-doublon) ──────
async function handleBlastStatus(req, res) {
  const project_id = req.query.project_id;
  if (!project_id) return res.status(400).json({ error: 'project_id requis' });
  const { data: rows } = await supabase.from('fiche_queue')
    .select('status, requested_by, created_at, sent_at').eq('project_id', project_id);
  const q = rows || [];
  if (!q.length) return res.status(200).json({ ok: true, ever: false });

  const sent = q.filter(r => r.status === 'sent').length;
  const pending = q.filter(r => r.status === 'pending').length;
  const failed = q.filter(r => r.status === 'failed').length;
  // Dernier blast = requested_by du plus récent created_at
  const latest = q.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  const lastSentAt = q.filter(r => r.sent_at).map(r => r.sent_at).sort().pop() || null;
  return res.status(200).json({
    ok: true, ever: true, sent, pending, failed, total: q.length,
    last_by: latest?.requested_by || null,
    last_at: latest?.created_at || null,
    last_sent_at: lastSentAt,
  });
}

const FICHE_BATCH_SIZE = 50; // envois par passage (immédiat + chaque heure via cron)

// ─── Envoi en masse : mise en file + envoi des 50 premiers tout de suite ──────
// Le reste part automatiquement par paquets de 50/heure (cron api/cron/fiche-queue).
// Anti-doublon : ignore les leads déjà destinataires (fiche reçue OU déjà en file),
// sauf force=true.
async function handleBulkFiche(req, res, b, payload) {
  const { project_id, lead_ids, message, force } = b;
  if (!project_id) return res.status(400).json({ error: 'project_id requis' });

  const { data: project } = await supabase.from('projects').select('id').eq('id', project_id).single();
  if (!project) return res.status(404).json({ error: 'Projet non trouvé' });

  const { data: leads } = await supabase.from('leads').select('id, email').in('id', lead_ids);
  let targets = (leads || []).filter(l => l.email);

  // Déjà destinataires : fiche déjà reçue, ou déjà en file (pending) pour ce projet
  const exclude = new Set();
  if (!force) {
    const { data: prior } = await supabase.from('lead_events').select('lead_id, content').eq('type', 'fiche_envoyee').limit(10000);
    for (const e of (prior || [])) { try { if (JSON.parse(e.content).project_id === project_id) exclude.add(e.lead_id); } catch {} }
  }
  const { data: queued } = await supabase.from('fiche_queue').select('lead_id').eq('project_id', project_id).eq('status', 'pending');
  for (const q of (queued || [])) exclude.add(q.lead_id); // jamais de double-file
  const skipped = targets.filter(l => exclude.has(l.id)).length;
  targets = targets.filter(l => !exclude.has(l.id));

  if (!targets.length) return res.status(200).json({ ok: true, queued: 0, sent: 0, skipped, total: (leads || []).length, all_done: skipped > 0 });

  // Mise en file
  const rows = targets.map(l => ({ project_id, lead_id: l.id, message: message || null, requested_by: payload.email, status: 'pending' }));
  const { error: qErr } = await supabase.from('fiche_queue').insert(rows);
  if (qErr) return res.status(500).json({ error: 'db_error', detail: qErr.message });

  // Traite tout de suite le premier paquet de 50
  const first = await processFicheQueue(FICHE_BATCH_SIZE);
  const remaining = Math.max(0, targets.length - (first.sent || 0));
  return res.status(200).json({ ok: true, queued: targets.length, sent: first.sent || 0, skipped, remaining, total: (leads || []).length });
}

// Traite jusqu'à `limit` éléments en attente de la file (utilisé par l'envoi initial
// ET par le cron horaire). Envoi groupé Resend, reply-to = 3 associés, sans cc.
async function processFicheQueue(limit = FICHE_BATCH_SIZE) {
  if (!process.env.RESEND_API_KEY) return { sent: 0, failed: 0, remaining: 0, skipped: 'no_key' };

  const { data: items } = await supabase.from('fiche_queue')
    .select('id, project_id, lead_id, message, requested_by')
    .eq('status', 'pending').order('created_at', { ascending: true }).limit(limit);
  if (!items || !items.length) return { sent: 0, failed: 0, remaining: 0 };

  const projIds = [...new Set(items.map(i => i.project_id))];
  const leadIds = [...new Set(items.map(i => i.lead_id))];
  const [{ data: projects }, { data: leads }] = await Promise.all([
    supabase.from('projects').select('*').in('id', projIds),
    supabase.from('leads').select('id, prenom, nom, email, status').in('id', leadIds),
  ]);
  const pMap = Object.fromEntries((projects || []).map(p => [p.id, p]));
  const lMap = Object.fromEntries((leads || []).map(l => [l.id, l]));

  const resend  = new Resend(process.env.RESEND_API_KEY);
  const from    = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
  const replyTo = associateEmails();

  const emails = [], valid = [];
  for (const it of items) {
    const p = pMap[it.project_id], l = lMap[it.lead_id];
    if (!p || !l || !l.email) continue;
    const title = p.title || p.titre || 'Nouvelle opportunité';
    emails.push({ from, replyTo, to: [l.email], subject: `Atom Buyers Club — ${title}`, html: buildFicheEmail(l, p, it.message, getFounder(it.requested_by), it.requested_by) });
    valid.push({ ...it, _lead: l, _title: title });
  }

  let sent = 0, failed = 0;
  if (emails.length) {
    try {
      const r = await resend.batch.send(emails);
      if (r?.error) { failed = emails.length; console.error('[fiche-queue] batch error', JSON.stringify(r.error)); }
      else sent = emails.length;
    } catch (e) { failed = emails.length; console.error('[fiche-queue] throw', e?.message || e); }
  }

  const now = new Date().toISOString();
  if (sent) {
    const okIds = valid.map(v => v.id);
    await supabase.from('fiche_queue').update({ status: 'sent', sent_at: now }).in('id', okIds);
    await supabase.from('lead_events').insert(valid.map(v => ({
      lead_id: v.lead_id, type: 'fiche_envoyee',
      content: JSON.stringify({ title: v._title, project_id: v.project_id, bulk: true }), author: v.requested_by,
    })));
    const toContacte = valid.filter(v => !v._lead.status || v._lead.status === 'nouveau').map(v => v.lead_id);
    if (toContacte.length) await supabase.from('leads').update({ status: 'contacte' }).in('id', toContacte);
  } else if (failed) {
    await supabase.from('fiche_queue').update({ status: 'failed', error: 'batch_failed' }).in('id', valid.map(v => v.id));
  }

  // ── Notif TG de fin de mailing : pour chaque projet de ce lot dont la file
  //    de pending vient de tomber à 0, on prévient les founders ──
  if (sent) {
    const projectsInBatch = [...new Set(valid.map(v => v.project_id))];
    for (const pid of projectsInBatch) {
      const { count: stillPending } = await supabase.from('fiche_queue')
        .select('id', { count: 'exact', head: true }).eq('project_id', pid).eq('status', 'pending');
      if (stillPending) continue; // pas encore fini pour ce projet
      const [{ count: totalSent }, { count: totalFailed }] = await Promise.all([
        supabase.from('fiche_queue').select('id', { count: 'exact', head: true }).eq('project_id', pid).eq('status', 'sent'),
        supabase.from('fiche_queue').select('id', { count: 'exact', head: true }).eq('project_id', pid).eq('status', 'failed'),
      ]);
      const title = pMap[pid]?.title || pMap[pid]?.titre || 'Projet';
      try {
        await sendTelegram(`✅ <b>Mailing terminé</b> — ${title}\n${totalSent || 0} fiche${(totalSent||0)>1?'s':''} envoyée${(totalSent||0)>1?'s':''}${totalFailed ? ` · ⚠️ ${totalFailed} échec(s)` : ''}.`);
      } catch (e) { console.error('[fiche-queue] TG fin échec', e?.message || e); }
    }
  }

  const { count } = await supabase.from('fiche_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  return { sent, failed, remaining: count || 0 };
}

// ─── Relance "compléter le profil" ───────────────────────────────────────────
// Envoie aux leads sans info de financement un email invitant à compléter le
// formulaire de la landing. Batch Resend, reply-to = 3 associés, anti-doublon 7j.
async function handleRelanceProfil(req, res, b, payload) {
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'email_config_missing' });
  const { lead_ids, force } = b;

  const { data: leads } = await supabase.from('leads')
    .select('id, prenom, nom, email, tel, status, arrondissements, timing, infos_token').in('id', lead_ids);
  let targets = (leads || []).filter(l => l.email);

  // Anti-doublon : relancé il y a moins de 7 jours
  if (!force) {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: recent } = await supabase.from('lead_events')
      .select('lead_id').eq('type', 'relance_profil').gte('created_at', since).in('lead_id', targets.map(l => l.id));
    const done = new Set((recent || []).map(e => e.lead_id));
    targets = targets.filter(l => !done.has(l.id));
  }
  if (!targets.length) return res.status(200).json({ ok: true, sent: 0, skipped: (leads || []).length });

  // Token de pré-remplissage (réutilise infos_token) : généré si absent
  await Promise.all(targets.filter(l => !l.infos_token).map(async l => {
    l.infos_token = crypto.randomBytes(16).toString('hex');
    await supabase.from('leads').update({ infos_token: l.infos_token }).eq('id', l.id);
  }));

  const resend  = new Resend(process.env.RESEND_API_KEY);
  const from    = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
  const replyTo = associateEmails();
  const founder = getFounder(payload.email);

  let sent = 0, failed = 0;
  const sentLeads = [];
  for (let i = 0; i < targets.length; i += 100) {
    const chunk = targets.slice(i, i + 100);
    const emails = chunk.map(l => ({ from, replyTo, to: [l.email], subject: 'Complétez votre profil — Atom Buyers Club', html: buildRelanceEmail(l, founder, payload.email) }));
    try {
      const r = await resend.batch.send(emails);
      if (r?.error) { failed += chunk.length; console.error('[relance] batch error', JSON.stringify(r.error)); }
      else { sent += chunk.length; sentLeads.push(...chunk); }
    } catch (e) { failed += chunk.length; console.error('[relance] throw', e?.message || e); }
  }

  if (sentLeads.length) {
    await supabase.from('lead_events').insert(sentLeads.map(l => ({
      lead_id: l.id, type: 'relance_profil', content: JSON.stringify({ bulk: true }), author: payload.email,
    })));
  }
  return res.status(200).json({ ok: true, sent, failed, skipped: (leads || []).length - targets.length });
}

function buildRelanceEmail(lead, founder = {}, senderEmail = '') {
  const url = `https://join.atombuyerclub.fr/?complete=${encodeURIComponent(lead.infos_token || '1')}`;
  const known = [];
  if (lead.arrondissements) known.push(`Secteurs visés : <strong>${esc(lead.arrondissements)}</strong>`);
  const TIMING = { asap: 'Dès que possible', '3mois': 'Dans 3 mois', '6mois': 'Dans 6 mois', reflexion: 'En réflexion' };
  if (lead.timing) known.push(`Horizon : <strong>${esc(TIMING[lead.timing] || lead.timing)}</strong>`);
  const knownHtml = known.length
    ? `<p style="margin:0 0 6px;font-size:13px;color:#888">Ce que nous avons déjà :</p><ul style="margin:0 0 18px;padding-left:18px;font-size:14px;color:#444;line-height:1.7">${known.map(k => `<li>${k}</li>`).join('')}</ul>`
    : '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:system-ui,-apple-system,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5">
    <div style="background:#0f0e0c;padding:26px 28px">
      <p style="margin:0 0 8px;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8975A">Atom Buyers Club</p>
      <h1 style="margin:0;font-size:21px;font-weight:300;color:#F5F2ED">Complétez votre profil investisseur</h1>
    </div>
    <div style="padding:28px">
      <p style="margin:0 0 16px;font-size:16px;color:#111">Bonjour ${esc(lead.prenom || '')},</p>
      <p style="margin:0 0 18px;font-size:14px;color:#444;line-height:1.7">Pour vous proposer les opportunités les plus adaptées (et vous les envoyer en priorité), il nous manque quelques informations sur votre <strong>capacité de financement</strong> et votre projet.</p>
      ${knownHtml}
      <p style="margin:0 0 4px;font-size:14px;color:#444;line-height:1.7">Cela prend moins d'une minute :</p>
      <div style="margin-top:20px"><a href="${url}" style="display:inline-block;padding:13px 26px;background:#B8975A;color:#0f0e0c;text-decoration:none;border-radius:7px;font-size:14px;font-weight:600">Compléter mon profil →</a></div>
    </div>
    <div style="padding:16px 28px 24px;border-top:1px solid #f0f0f0;font-size:12px;color:#888;line-height:1.7">
      ${founder.name ? `<strong style="color:#555">${esc(founder.name)}</strong><br>` : ''}${senderEmail ? `<a href="mailto:${esc(senderEmail)}" style="color:#B8975A;text-decoration:none">${esc(senderEmail)}</a><br>` : ''}Atom Buyers Club · Paris · <a href="https://join.atombuyerclub.fr" style="color:#B8975A;text-decoration:none">join.atombuyerclub.fr</a>
    </div>
  </div></body></html>`;
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
