// lib/notify.js
// Notifications Telegram → téléphones des fondateurs.
//
// Configuration (variables d'env Vercel) :
//   TELEGRAM_BOT_TOKEN  : token du bot créé via @BotFather
//   TELEGRAM_CHAT_IDS   : ids de chat séparés par virgule (groupe d'alertes OU
//                         ids individuels des fondateurs)
//   SITE_URL            : base du panel admin (def. https://join.atombuyerclub.fr)
//
// Tout est "fail-safe" : si la config manque ou que l'API Telegram échoue,
// on log et on n'interrompt jamais le flux principal (création de lead, etc.).

const { getFounder, getFounderTgId } = require('./founders');

const TIMING = { asap: 'Dès que possible', '3mois': 'Dans 3 mois', '6mois': 'Dans 6 mois', reflexion: 'En réflexion' };
const FIN    = { comptant: 'Comptant', emprunt: 'Emprunt bancaire' };
const BUDGET = { 'moins-150k': '< 150 k€', '150-250k': '150–250 k€', '250-400k': '250–400 k€', '400-600k': '400–600 k€', '600k-1m': '600 k€–1 M€', 'plus-1m': '> 1 M€' };
const SOURCE = { google: 'Google Ads', instagram: 'Instagram Ads', facebook: 'Facebook Ads', meta: 'Meta Ads', tiktok: 'TikTok Ads', linkedin: 'LinkedIn Ads', bing: 'Bing Ads', email: 'Email', organic: 'Landing', landing: 'Landing', showroom: 'Showroom', projet: 'Page projet', fiche_projet: 'Page projet', projets: 'Page projets' };

// Libellé lisible de l'origine d'un lead : "Google Ads · campagne xyz"
function sourceLabel(lead) {
  const raw = (lead.utm_source || '').toLowerCase();
  let src = SOURCE[raw] || lead.utm_source || 'Inconnue';
  if (raw.startsWith('seloger')) {
    const rest = raw.replace(/^seloger[-_]?/, '').replace(/[-_]+/g, ' ').trim();
    src = rest ? `SeLoger · ${rest.replace(/\b\w/g, c => c.toUpperCase())}` : 'SeLoger';
  }
  return lead.utm_campaign ? `${src} · ${lead.utm_campaign}` : src;
}

// Lead issu d'une campagne payante : UTM payant connu, medium cpc/paid, ou click-id présent.
const ADS_SOURCES = new Set(['google', 'instagram', 'facebook', 'meta', 'tiktok', 'linkedin', 'bing']);
function isAdsLead(lead) {
  if (ADS_SOURCES.has((lead.utm_source || '').toLowerCase())) return true;
  if (/^(cpc|ppc|paid|paid[-_].+)$/i.test(lead.utm_medium || '')) return true;
  return !!(lead.gclid || lead.fbclid || lead.ttclid || lead.li_fat_id || lead.msclkid);
}

const { esc } = require('./html');

function adminUrl() {
  return (process.env.SITE_URL || 'https://join.atombuyerclub.fr').replace(/\/$/, '') + '/admin';
}

// Envoi ciblé — DM à un chat_id précis (perso ou groupe).
async function sendTelegramTo(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return { ok: false, skipped: true };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    return { ok: true };
  } catch (e) {
    console.error(`[notify] DM ${chatId} erreur:`, e?.message || e);
    return { ok: false };
  }
}

// Envoi bas niveau — boucle sur tous les chat_ids configurés.
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token || !chatIds.length) {
    console.log('[notify] Telegram non configuré (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_IDS) — notification ignorée.');
    return { ok: false, skipped: true };
  }
  const results = await Promise.allSettled(chatIds.map(chat_id =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    }).then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`); return r.json(); })
  ));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[notify] Telegram échec chat ${chatIds[i]} :`, r.reason?.message || r.reason);
  });
  return { ok: results.some(r => r.status === 'fulfilled') };
}

// ── Messages formatés ──────────────────────────────────────────────

function notifyHotLead(lead, score) {
  const lines = [
    `🔥 <b>Nouveau lead chaud</b> (score ${score}/10)`,
    `<b>${esc(lead.prenom)} ${esc(lead.nom)}</b>`,
    `🎯 ${esc(sourceLabel(lead))}`,
    lead.tel ? `📞 ${esc(lead.tel)}` : null,
    lead.arrondissements ? `📍 ${esc(lead.arrondissements)}` : null,
    `⏱ ${esc(TIMING[lead.timing] || lead.timing || '—')}`,
    `💶 ${esc(FIN[lead.financement] || lead.financement || '—')}${lead.capacite ? ` · ${esc(BUDGET[lead.capacite] || lead.capacite)}` : ''}`,
    `\n👉 <a href="${adminUrl()}">Ouvrir le panel</a>`,
  ].filter(Boolean);
  return sendTelegram(lines.join('\n'));
}

async function notifyInterest(lead, label, score, responsibleEmail) {
  const lines = [
    `👀 <b>Nouvel intérêt</b> — ${esc(label)}`,
    `<b>${esc(lead.prenom)} ${esc(lead.nom)}</b>${score != null ? ` · score ${score}/10` : ''}`,
    lead.tel ? `📞 ${esc(lead.tel)}` : null,
    `📣 ${esc(sourceLabel(lead))}`,
    `\n👉 <a href="${adminUrl()}">Ouvrir le panel</a>`,
  ].filter(Boolean);
  const text = lines.join('\n');
  // DM au responsable du projet (en plus du groupe)
  const tgId = getFounderTgId(responsibleEmail);
  const tasks = [sendTelegram(text)];
  if (tgId) tasks.push(sendTelegramTo(tgId, text));
  const results = await Promise.allSettled(tasks);
  return { ok: results.some(r => r.status === 'fulfilled' && r.value?.ok) };
}

// Nouveau lead issu d'une campagne ads — toujours notifié, avec score + origine.
function notifyAdsLead(lead, score) {
  const lines = [
    `📣 <b>Nouveau lead Ads</b> (score ${score}/10)`,
    `<b>${esc(lead.prenom)} ${esc(lead.nom)}</b>`,
    `🎯 ${esc(sourceLabel(lead))}`,
    lead.tel ? `📞 ${esc(lead.tel)}` : null,
    lead.arrondissements ? `📍 ${esc(lead.arrondissements)}` : null,
    `⏱ ${esc(TIMING[lead.timing] || lead.timing || '—')}`,
    `💶 ${esc(FIN[lead.financement] || lead.financement || '—')}${lead.capacite ? ` · ${esc(BUDGET[lead.capacite] || lead.capacite)}` : ''}`,
    `\n👉 <a href="${adminUrl()}">Ouvrir le panel</a>`,
  ].filter(Boolean);
  return sendTelegram(lines.join('\n'));
}

// Digest quotidien des leads chauds négligés (cron).
// Envoie un DM personnalisé à chaque responsable avec ses leads uniquement.
// Les leads non assignés (ou responsable sans TG) partent sur le groupe.
async function notifyStaleDigest(leads, days) {
  if (!leads.length) return { ok: true, skipped: true };

  // Groupe par responsable
  const byResponsible = {};
  for (const l of leads) {
    const key = l.assigned_to || '_none';
    if (!byResponsible[key]) byResponsible[key] = [];
    byResponsible[key].push(l);
  }

  const tasks = [];

  for (const [email, group] of Object.entries(byResponsible)) {
    const tgId   = email !== '_none' ? getFounderTgId(email) : null;
    const name   = email !== '_none' ? getFounder(email).name || email : null;
    const rows   = group.slice(0, 30).map(l => {
      const tel = l.tel ? ` · ${esc(l.tel)}` : '';
      return `• <b>${esc(l.prenom)} ${esc(l.nom)}</b>${tel}`;
    });
    const extra  = group.length > 30 ? `\n…et ${group.length - 30} de plus.` : '';
    const header = tgId && name
      ? `⏰ <b>${name}, ${group.length} lead${group.length > 1 ? 's' : ''} à rappeler (inactif${group.length > 1 ? 's' : ''} +${days} j)</b>`
      : `⏰ <b>${group.length} lead${group.length > 1 ? 's' : ''} sans responsable — inactif${group.length > 1 ? 's' : ''} +${days} j</b>`;
    const text = [header, '', rows.join('\n') + extra, `\n👉 <a href="${adminUrl()}">Ouvrir le panel</a>`].join('\n');

    if (tgId) {
      // DM perso au responsable
      tasks.push(sendTelegramTo(tgId, text));
    } else {
      // Pas de TG ID → groupe
      tasks.push(sendTelegram(text));
    }
  }

  const results = await Promise.allSettled(tasks);
  return { ok: results.some(r => r.status === 'fulfilled' && r.value?.ok) };
}

module.exports = { sendTelegram, sendTelegramTo, notifyHotLead, notifyInterest, notifyAdsLead, notifyStaleDigest, isAdsLead, sourceLabel };
