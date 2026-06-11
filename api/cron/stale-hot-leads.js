const { supabase } = require('../../lib/supabase');
const { isHot } = require('../../lib/scoring');
const { notifyStaleDigest, sendTelegram } = require('../../lib/notify');

// ── Cron quotidien : leads chauds (score ≥ 8) sans interaction depuis +N jours ──
// Déclenché par Vercel Cron (voir vercel.json). Protégé par CRON_SECRET :
// Vercel envoie `Authorization: Bearer <CRON_SECRET>` quand la variable est posée.
//
// "Interaction" = tout événement dans lead_events (appel, whatsapp, note,
// changement de statut, fiche envoyée…) OU une mise à jour de la fiche
// (updated_at) dans la fenêtre. Les leads encore récents (créés il y a moins
// de N jours) ne sont pas signalés — ils sont gérés par la notif instantanée.

module.exports = async function handler(req, res) {
  // Auth cron
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  }

  const days = parseInt(process.env.STALE_DAYS, 10) || 15;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    // 1. Tous les leads actifs (hors signé / non retenu)
    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, prenom, nom, tel, timing, financement, accord, capacite, status, assigned_to, created_at, updated_at')
      .not('status', 'in', '(signe,perdu)')
      .limit(5000);
    if (error) { console.error('[cron] leads error:', error); return res.status(500).json({ error: 'db_error' }); }

    // 2. Leads "touchés" récemment (un événement dans la fenêtre)
    const { data: recentEvents } = await supabase
      .from('lead_events')
      .select('lead_id')
      .gte('created_at', cutoff)
      .limit(10000);
    const touched = new Set((recentEvents || []).map(e => e.lead_id));

    // 3. Filtre : chaud + ancien + non touché
    const stale = (leads || []).filter(l =>
      isHot(l) &&
      l.created_at < cutoff &&
      (!l.updated_at || l.updated_at < cutoff) &&
      !touched.has(l.id)
    );

    const result = await notifyStaleDigest(stale, days);
    console.log(`[cron] stale hot leads : ${stale.length} signalé(s)`, result);

    // ── Intérêts relancés WhatsApp sans visite après N jours → sans suite ──
    // (greffé ici pour ne pas créer de fonction serverless — limite 12)
    const waExpiry = await expireWaInterests();
    console.log(`[cron] wa-expiry : ${waExpiry.expired} intérêt(s) passé(s) en sans suite`);

    // ── Health-check quotidien : alerte Telegram UNIQUEMENT si panne ──
    // (greffé ici pour ne pas créer de fonction serverless — limite 12)
    const health = await runHealthCheck();
    if (health.failures.length) {
      const lines = health.failures.map(f => `• <code>${f.path}</code> → ${f.label}`);
      await sendTelegram(`🚨 <b>Panne détectée sur join.atombuyerclub.fr</b>\n\n${lines.join('\n')}\n\nVérifier le dernier déploiement Vercel.`);
    }
    console.log(`[cron] health-check : ${health.checked} testés, ${health.failures.length} en panne`);

    return res.status(200).json({ ok: true, days, stale: stale.length, sent: !!result.ok && !result.skipped, wa_expired: waExpiry.expired, health });
  } catch (e) {
    console.error('[cron] crash:', e?.message || e);
    return res.status(500).json({ error: 'handler_crash', detail: e?.message || String(e) });
  }
};

// ── Expiration des relances WhatsApp ──────────────────────────────────────────
// Un intérêt projet relancé par WhatsApp (wa_contacted_at) sans visite, offre ni
// sans suite au bout de WA_FOLLOWUP_DAYS jours passe automatiquement en "sans
// suite" et le groupe Telegram est prévenu.
async function expireWaInterests() {
  const followupDays = parseInt(process.env.WA_FOLLOWUP_DAYS, 10) || 10;
  const waCutoff = Date.now() - followupDays * 24 * 60 * 60 * 1000;

  // content est une colonne TEXT (JSON sérialisé) : impossible de filtrer côté
  // PostgREST, on parse côté serveur sur une fenêtre bornée.
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: events, error } = await supabase
    .from('lead_events')
    .select('id, content, lead_id, created_at')
    .eq('type', 'interet_projet')
    .gte('created_at', since)
    .limit(2000);
  if (error) { console.error('[cron] wa-expiry events error:', error); return { expired: 0 }; }

  const toExpire = [];
  for (const ev of events || []) {
    let c = {};
    try { c = ev.content ? (typeof ev.content === 'string' ? JSON.parse(ev.content) : ev.content) : {}; } catch {}
    if (!c.wa_contacted_at) continue;
    if (c.visited || c.sans_suite || c.offer_sent_at || c.mandat_sent_at) continue;
    if (new Date(c.wa_contacted_at).getTime() > waCutoff) continue;
    toExpire.push({ ev, content: c });
  }
  if (!toExpire.length) return { expired: 0 };

  // Noms des leads pour le message Telegram
  const leadIds = [...new Set(toExpire.map(t => t.ev.lead_id).filter(Boolean))];
  const { data: leads } = await supabase.from('leads').select('id, prenom, nom').in('id', leadIds);
  const leadMap = Object.fromEntries((leads || []).map(l => [l.id, l]));

  const lines = [];
  for (const { ev, content } of toExpire) {
    const newContent = {
      ...content,
      sans_suite: true,
      sans_suite_auto: true,
      sans_suite_at: new Date().toISOString(),
      treated: true,
    };
    const { error: upErr } = await supabase.from('lead_events').update({ content: newContent }).eq('id', ev.id);
    if (upErr) { console.error('[cron] wa-expiry update error:', ev.id, upErr.message); continue; }
    const lead = leadMap[ev.lead_id];
    const name = lead ? `${lead.prenom || ''} ${lead.nom || ''}`.trim() : 'Lead inconnu';
    const proj = content.project_title || content.project_name || 'Projet';
    const dateRelance = new Date(content.wa_contacted_at).toLocaleDateString('fr-FR');
    lines.push(`• <b>${name}</b> — ${proj} (relancé le ${dateRelance})`);
  }

  if (lines.length) {
    await sendTelegram(
      `⏳ <b>Intérêts passés en « sans suite » automatiquement</b>\n` +
      `${followupDays} jours sans visite après la relance WhatsApp :\n\n` +
      lines.join('\n')
    );
  }
  return { expired: lines.length };
}

// ── Health-check : mêmes règles que scripts/smoke.sh ──────────────────────────
// Endpoints API : 404 = fonction NON déployée (le bug OG), 5xx = déployée mais en erreur.
// Pages publiques : tout sauf 200 = problème.
async function runHealthCheck() {
  const base = (process.env.SITE_URL || 'https://join.atombuyerclub.fr').replace(/\/$/, '');
  const API_PATHS = [
    'api/public-project?list=1', 'api/showroom?list=1', 'api/projects?list=1',
    'api/leads', 'api/events', 'api/auth', 'api/submit', 'api/send-fiche',
    'api/upload-image', 'api/generate-pdf',
  ];
  const PAGE_PATHS = ['', 'projets', 'showroom'];

  async function probe(path) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(`${base}/${path}`, { signal: ctrl.signal, redirect: 'manual' });
      clearTimeout(t);
      return r.status;
    } catch { return 0; } // timeout / réseau
  }

  const failures = [];
  const results = await Promise.all([...API_PATHS, ...PAGE_PATHS].map(async path => {
    const status = await probe(path);
    const isApi = path.startsWith('api/');
    if (isApi) {
      if (status === 404 || status === 0) failures.push({ path: '/' + path, label: `${status || 'timeout'} — fonction NON déployée` });
      else if (status >= 500)             failures.push({ path: '/' + path, label: `${status} — erreur serveur` });
    } else if (status !== 200) {
      failures.push({ path: '/' + (path || ''), label: `${status || 'timeout'} — page indisponible` });
    }
    return status;
  }));

  return { checked: results.length, failures };
}
