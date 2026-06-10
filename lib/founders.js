// lib/founders.js
// Signature des emails : nom + téléphone par email d'admin
// Renseignez FOUNDER_PHONES dans les env Vercel (JSON) :
// {"adrien.helle@atom-capital.fr":"+33 6 86 47 56 56","alexandre.kiman@atom-capital.fr":"+33 6 22 05 73 64","thierry.vignal@atom-capital.fr":"+33 6 37 12 47 96"}

// Noms canoniques des fondateurs (avec accents)
const FOUNDER_NAMES = {
  'adrien.helle@atom-capital.fr':    'Adrien Helle',
  'alexandre.kiman@atom-capital.fr': 'Alexandre Kiman',
  'thierry.vignal@atom-capital.fr':  'Thierry Vignal',
  'melina.cabral@atom-capital.fr':   'Melina Cabral',
};

function getFounder(email) {
  if (!email) return { name: '', phone: '' };

  const key = email.toLowerCase();

  // Téléphone depuis variable d'env FOUNDER_PHONES (JSON)
  let phone = '';
  try {
    const map = JSON.parse(process.env.FOUNDER_PHONES || '{}');
    phone = map[key] || '';
  } catch {}

  // Nom : hardcodé si connu (préserve les accents), sinon dérivé de l'email
  const name = FOUNDER_NAMES[key]
    || email.split('@')[0].split(/[.\-_]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');

  return { name, phone };
}

module.exports = { getFounder };
