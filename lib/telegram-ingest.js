// lib/telegram-ingest.js
// Webhook Telegram (DM privé) : reçoit un screenshot d'un prospect, le lit via
// l'IA vision (Anthropic), demande confirmation, puis crée la fiche dans le CRM.
//
// Branché depuis api/submit.js (?tg=1) pour ne pas créer de fonction serverless
// supplémentaire (limite Vercel = 12).
//
// Variables d'env requises :
//   TELEGRAM_BOT_TOKEN        (déjà posé)
//   TELEGRAM_WEBHOOK_SECRET   (chaîne aléatoire, = secret_token du setWebhook)
//   TELEGRAM_ALLOWED_IDS      (ids Telegram des fondateurs autorisés, séparés par virgule)
//   ANTHROPIC_API_KEY         (clé API vision)
//   ATOM_VISION_MODEL         (optionnel, def. claude-3-5-haiku-latest)

const { supabase } = require('./supabase');
const { getFounder } = require('./founders');

// Mapping id Telegram → email fondateur (pour assigner le lead au demandeur).
// Surchargeable via TELEGRAM_USER_EMAILS (JSON), sinon défauts ci-dessous.
const USER_EMAILS = (() => { try { return JSON.parse(process.env.TELEGRAM_USER_EMAILS || '{}'); } catch { return {}; } })();
const DEFAULT_EMAILS = {
  '2099914269': 'adrien.helle@atom-capital.fr',
  '6370822526': 'thierry.vignal@atom-capital.fr',
  '8410007459': 'alexandre.kiman@atom-capital.fr',
  '8768992002': 'melina.cabral@atom-capital.fr',
};
function founderEmail(id) { id = String(id || ''); return USER_EMAILS[id] || DEFAULT_EMAILS[id] || null; }

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED        = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const VISION_KEY     = process.env.ANTHROPIC_API_KEY || '';
const VISION_MODEL   = process.env.ATOM_VISION_MODEL || 'claude-3-5-sonnet-latest'; // doit supporter la vision (images)
const SITE           = (process.env.SITE_URL || 'https://join.atombuyerclub.fr').replace(/\/$/, '');

async function tg(method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) { console.error('[tg]', method, e?.message || e); return null; }
}

async function downloadPhotoB64(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  const path = f?.result?.file_path;
  if (!path) throw new Error('getFile a échoué');
  const buf = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${path}`)).arrayBuffer());
  return buf.toString('base64');
}

const PROMPT = `Tu analyses la capture d'écran d'un échange (souvent WhatsApp) avec un PROSPECT en investissement immobilier (studios à Paris, Atom Buyers Club).
Extrais les infos du PROSPECT (jamais de l'équipe Atom) au format JSON STRICT, sans aucun texte autour :
{"prenom": string|null, "nom": string|null, "tel": string|null, "email": string|null, "context": string|null}
- tel au format international si possible (+33…).
- context : une phrase courte résumant sa demande / la réalisation ou le projet mentionné.
- null si l'info est absente. Réponds UNIQUEMENT le JSON.`;

async function visionExtract(b64, caption) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': VISION_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL, max_tokens: 500,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: PROMPT + (caption ? `\n\nNote de l'utilisateur : ${caption}` : '') },
      ] }],
    }),
  });
  const j = await r.json();
  if (j && j.error) throw new Error('API vision : ' + String(j.error.message || JSON.stringify(j.error)).slice(0, 160));
  const txt = j?.content?.[0]?.text || '';
  if (!txt) throw new Error('réponse vision vide (modèle ' + VISION_MODEL + ')');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('réponse vision illisible : ' + txt.slice(0, 120));
  return JSON.parse(m[0]);
}

function fmtSummary(d) {
  const lines = [
    `👤 ${[d.prenom, d.nom].filter(Boolean).join(' ') || '—'}`,
    `📞 ${d.tel || '—'}`,
  ];
  if (d.email) lines.push(`✉️ ${d.email}`);
  lines.push(`📝 ${d.context || '—'}`);
  if (d._assigned) lines.push(`👔 Responsable : ${getFounder(d._assigned).name || d._assigned}`);
  return lines.join('\n');
}

async function createLead(d) {
  if (d.tel) {
    const { data: existing } = await supabase.from('leads').select('id').eq('tel', d.tel).maybeSingle();
    if (existing) return { id: existing.id, dup: true };
  }
  const { data, error } = await supabase.from('leads')
    .insert([{ prenom: d.prenom || null, nom: d.nom || null, tel: d.tel || null,
               email: d.email || null, utm_source: 'manuel', status: 'contacte',
               assigned_to: d._assigned || null }])
    .select('id').single();
  if (error) throw new Error('insert lead : ' + error.message);
  if (d.context) {
    await supabase.from('lead_events').insert([{ lead_id: data.id, type: 'note',
      content: 'Lead manuel (Telegram) — ' + d.context, author: null }]);
  }
  return { id: data.id, dup: false };
}

async function handleCallback(cb) {
  const chatId = String(cb.message?.chat?.id);
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  const [action, id] = String(cb.data || '').split(':');
  const { data: pending } = await supabase.from('telegram_pending_leads').select('*').eq('id', id).maybeSingle();
  if (!pending) { await tg('sendMessage', { chat_id: chatId, text: '⏱️ Demande expirée — renvoie le screenshot.' }); return; }
  if (action === 'cancel') {
    await supabase.from('telegram_pending_leads').delete().eq('id', id);
    await tg('sendMessage', { chat_id: chatId, text: '✖️ Annulé. Aucune fiche créée.' });
    return;
  }
  try {
    const r = await createLead(pending.data);
    await supabase.from('telegram_pending_leads').delete().eq('id', id);
    const d = pending.data;
    await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true,
      text: r.dup
        ? `ℹ️ Ce contact existe déjà (tél. connu) — pas de doublon créé.\n<a href="${SITE}/admin">Ouvrir le CRM</a>`
        : `✅ <b>Lead créé</b> : ${[d.prenom, d.nom].filter(Boolean).join(' ') || '—'}\n📞 ${d.tel || '—'}\n📝 ${d.context || '—'}${d._assigned ? `\n👔 ${getFounder(d._assigned).name || d._assigned}` : ''}\n\n<a href="${SITE}/admin">Ouvrir dans le CRM</a>` });
  } catch (e) {
    await tg('sendMessage', { chat_id: chatId, text: '⚠️ Erreur création : ' + (e.message || e) });
  }
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const fromId = String(msg.from?.id || '');
  // /id : répond l'identifiant du chat (utile pour configurer TELEGRAM_CHAT_IDS)
  // — seule commande qui fonctionne aussi dans un groupe.
  if (msg.text && msg.text.trim().split('@')[0] === '/id') {
    await tg('sendMessage', { chat_id: chatId, text: `ID de ce chat : ${chatId}` });
    return;
  }
  if (msg.chat.type !== 'private') return; // uniquement en discussion privée
  if (ALLOWED.length && !ALLOWED.includes(fromId) && !ALLOWED.includes(chatId)) {
    // Affiche l'ID pour faciliter l'ajout d'un nouveau membre (à transmettre à l'admin)
    await tg('sendMessage', { chat_id: chatId,
      text: `⛔ Accès non autorisé.\n\nTon ID Telegram : ${fromId}\nTransmets-le à l'équipe pour être ajouté.` });
    return;
  }
  if (msg.text && msg.text.trim() === '/start') {
    await tg('sendMessage', { chat_id: chatId,
      text: "👋 Envoie-moi un screenshot d'un échange avec un prospect. Je lis les infos, tu valides, et je crée la fiche dans le CRM." });
    return;
  }
  // /models : liste les modèles vision disponibles sur le compte Anthropic (debug)
  if (msg.text && msg.text.trim() === '/models') {
    if (!VISION_KEY) { await tg('sendMessage', { chat_id: chatId, text: '⚠️ Clé API manquante.' }); return; }
    try {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: { 'x-api-key': VISION_KEY, 'anthropic-version': '2023-06-01' } });
      const j = await r.json();
      if (j && j.error) { await tg('sendMessage', { chat_id: chatId, text: 'API: ' + (j.error.message || JSON.stringify(j.error)) }); return; }
      const ids = (j.data || []).map(m => m.id).join('\n');
      await tg('sendMessage', { chat_id: chatId, text: `Modèles dispo (mets-en un dans ATOM_VISION_MODEL) :\n\n${ids || '(liste vide)'}` });
    } catch (e) { await tg('sendMessage', { chat_id: chatId, text: 'Erreur: ' + (e.message || e) }); }
    return;
  }
  if (msg.photo && msg.photo.length) {
    if (!VISION_KEY) { await tg('sendMessage', { chat_id: chatId, text: "⚠️ Lecture d'image non configurée (clé API manquante)." }); return; }
    await tg('sendMessage', { chat_id: chatId, text: '🔎 Je lis le screenshot…' });
    try {
      const b64 = await downloadPhotoB64(msg.photo[msg.photo.length - 1].file_id);
      const d = await visionExtract(b64, msg.caption || '');
      d._assigned = founderEmail(msg.from?.id); // responsable = celui qui envoie
      const { data: pending } = await supabase.from('telegram_pending_leads')
        .insert([{ chat_id: chatId, data: d }]).select('id').single();
      await tg('sendMessage', { chat_id: chatId,
        text: `J'ai lu :\n\n${fmtSummary(d)}\n\nJe crée la fiche dans le CRM ?`,
        reply_markup: { inline_keyboard: [[
          { text: '✅ Créer le lead', callback_data: `create:${pending.id}` },
          { text: '✖️ Annuler',      callback_data: `cancel:${pending.id}` },
        ]] } });
    } catch (e) {
      await tg('sendMessage', { chat_id: chatId, text: '⚠️ Lecture impossible : ' + (e.message || e) });
    }
    return;
  }
  await tg('sendMessage', { chat_id: chatId, text: '📸 Envoie-moi un screenshot du prospect (WhatsApp, etc.) et je crée la fiche après ta validation.' });
}

async function handleTelegramUpdate(req, res) {
  if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    return res.status(401).end();
  }
  let update = {};
  try { update = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}
  try {
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message)   await handleMessage(update.message);
  } catch (e) { console.error('[tg] update', e?.message || e); }
  return res.status(200).json({ ok: true }); // toujours 200 → pas de retry-storm Telegram
}

module.exports = { handleTelegramUpdate };
