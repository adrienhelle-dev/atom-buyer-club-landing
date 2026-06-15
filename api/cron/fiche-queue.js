// api/cron/fiche-queue.js
// Cron horaire : envoie le prochain paquet de 50 fiches en attente (file fiche_queue).
// Le traitement réel vit dans api/send-fiche.js (processFicheQueue) pour réutiliser
// le template + la logique d'envoi. Protégé par CRON_SECRET.

const sendFiche = require('../send-fiche');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const r = await sendFiche.processFicheQueue(50);
    console.log('[cron fiche-queue]', JSON.stringify(r));
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    console.error('[cron fiche-queue] crash', e?.message || e);
    return res.status(500).json({ error: 'crash', detail: e?.message || String(e) });
  }
};
