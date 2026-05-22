// lib/founders.js
// Signature des emails : nom + téléphone par email d'admin
// Renseignez FOUNDER_PHONES dans les env Vercel (JSON) :
// {"adrien.helle@atom-capital.fr":"+33 6 XX XX XX XX","alexandre.kiman@atom-capital.fr":"+33 6 XX XX XX XX"}

function getFounder(email) {
  if (!email) return { name: '', phone: '' };

  // Téléphone depuis variable d'env FOUNDER_PHONES (JSON)
  let phone = '';
  try {
    const map = JSON.parse(process.env.FOUNDER_PHONES || '{}');
    phone = map[email.toLowerCase()] || '';
  } catch {}

  // Nom dérivé de l'email (ex: adrien.helle@ → Adrien Hellé)
  const parts = email.split('@')[0].split(/[.\-_]/);
  const name  = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');

  return { name, phone };
}

module.exports = { getFounder };
