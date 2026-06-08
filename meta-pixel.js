/* ─────────────────────────────────────────────────────────────────────────
   Atom — Meta Pixel (centralisé pour toutes les pages publiques)

   👉 POUR ACTIVER : coller l'ID du Pixel entre les quotes ci-dessous.
      (Meta Business → Gestionnaire d'événements → votre source Web → ID du pixel,
       un nombre d'environ 15-16 chiffres.)

   Tant que ATOM_META_PIXEL_ID est vide, le pixel reste TOTALEMENT INACTIF
   (aucun script chargé, aucun cookie, aucune requête) — déployable sans risque.

   Expose window.atomTrackLead() : à appeler à chaque formulaire envoyé pour
   compter une conversion "Lead" côté Meta.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  var ATOM_META_PIXEL_ID = ''; // ← ex : '1234567890123456'

  // No-op sûr par défaut : si le pixel n'est pas configuré, l'appel ne fait rien.
  window.atomTrackLead = function () {};

  if (!ATOM_META_PIXEL_ID) return;

  // Snippet officiel Meta (fbevents)
  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0';
    n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
    s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  fbq('init', ATOM_META_PIXEL_ID);
  fbq('track', 'PageView');

  // Conversion "Lead" — câblée sur chaque envoi de formulaire du site.
  window.atomTrackLead = function (params) {
    try { fbq('track', 'Lead', params || {}); } catch (e) {}
  };
})();
