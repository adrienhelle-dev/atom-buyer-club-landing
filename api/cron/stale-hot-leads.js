const { supabase } = require('../../lib/supabase');
const { isHot } = require('../../lib/scoring');
const { notifyStaleDigest } = require('../../lib/notify');

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

  const days = parseInt(process.env.STALE_DAYS, 10) || 5;
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
    return res.status(200).json({ ok: true, days, stale: stale.length, sent: !!result.ok && !result.skipped });
  } catch (e) {
    console.error('[cron] crash:', e?.message || e);
    return res.status(500).json({ error: 'handler_crash', detail: e?.message || String(e) });
  }
};
