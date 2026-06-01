// lib/scoring.js
// Scoring lead — logique partagée serveur (notifications, cron).
// ⚠️ Doit rester synchronisé avec computeScore() dans admin.html (côté client).

function computeScore(lead) {
  let s = 0;
  s += ({ asap: 4, '3mois': 3, '6mois': 2, reflexion: 1 }[lead.timing] || 0);
  if (lead.financement === 'comptant') {
    s += 6;
  } else {
    if      (lead.accord === 'oui')      s += 4;
    else if (lead.accord === 'courtier') s += 2;
    else if (lead.accord === 'non')      s += 2;
    s += ({ 'plus-1m': 2, '600k-1m': 2, '400-600k': 2, '250-400k': 1, '150-250k': 1, 'moins-150k': 0 }[lead.capacite] || 0);
  }
  const raw = Math.min(10, s);
  if (lead.timing === 'asap') return Math.max(8, raw);  // plancher 8
  return Math.min(7, raw);                               // plafond 7
}

const HOT_THRESHOLD = 8;
const isHot = (lead) => computeScore(lead) >= HOT_THRESHOLD;

module.exports = { computeScore, isHot, HOT_THRESHOLD };
