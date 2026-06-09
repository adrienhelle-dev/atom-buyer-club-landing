// lib/html.js — échappement HTML partagé (factorisé depuis generate-pdf, send-fiche, notify, og-render)
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
module.exports = { esc };
