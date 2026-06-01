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

const { getFounder } = require('./founders');

const TIMING = { asap: 'Dès que possible', '3mois': 'Dans 3 mois', '6mois': 'Dans 6 mois', reflexion: 'En réflexion' };
const FIN    = { comptant: 'Comptant', emprunt: 'Emprunt bancaire' };
const BUDGET = { 'moins-150k': '< 150 k€', '150-250k': '150–250 k€', '250-400k': '250–400 k€', '400-600k': '400–600 k€', '600k-1m': '600 k€–1 M€', 'plus-1m': '> 1 M€' };

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function adminUrl() {
  return (process.env.SITE_URL || 'https://join.atombuyerclub.fr').replace(/\/$/, '') + '/admin';
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
    lead.tel ? `📞 ${esc(lead.tel)}` : null,
    lead.arrondissements ? `📍 ${esc(lead.arrondissements)}` : null,
    `⏱ ${esc(TIMING[lead.timing] || lead.timing || '—')}`,
    `💶 ${esc(FIN[lead.financement] || lead.financement || '—')}${lead.capacite ? ` · ${esc(BUDGET[lead.capacite] || lead.capacite)}` : ''}`,
    `\n👉 <a href="${adminUrl()}">Ouvrir le panel</a>`,
  ].filter(Boolean);
  return sendTelegram(lines.join('\n'));
}

function notifyInterest(lead, label) {
  const lines = [
    `👀 <b>Nouvel intérêt</b> — ${esc(label)}`,
    `<b>${esc(lead.prenom)} ${esc(lead.nom)}</b>`,
    lead.tel ? `📞 ${esc(lead.tel)}` : null,
    `\n👉 <a href="${adminUrl()}">Ouvrir le panel</a>`,
  ].filter(Boolean);
  return sendTelegram(lines.join('\n'));
}

// Digest quotidien des leads chauds négligés (cron).
function notifyStaleDigest(leads, days) {
  if (!leads.length) return { ok: true, skipped: true };
  const rows = leads.slice(0, 30).map(l => {
    const resp = l.assigned_to ? getFounder(l.assigned_to).name || l.assigned_to : 'non assigné';
    const tel = l.tel ? ` · ${esc(l.tel)}` : '';
    return `• <b>${esc(l.prenom)} ${esc(l.nom)}</b>${tel} — ${esc(resp)}`;
  });
  const extra = leads.length > 30 ? `\n…et ${leads.length - 30} de plus.` : '';
  const text = [
    `⏰ <b>${leads.length} lead${leads.length > 1 ? 's' : ''} chaud${leads.length > 1 ? 's' : ''} sans interaction depuis +${days} j</b>`,
    '',
    rows.join('\n') + extra,
    `\n👉 <a href="${adminUrl()}">Relancer depuis le panel</a>`,
  ].join('\n');
  return sendTelegram(text);
}

module.exports = { sendTelegram, notifyHotLead, notifyInterest, notifyStaleDigest };
