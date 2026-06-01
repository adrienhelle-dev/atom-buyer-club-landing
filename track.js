/* ─────────────────────────────────────────────────────────────
   Atom — Attribution tracking (first-touch + last-touch)
   Robuste mais simple. Chargé sur index / projets / projet / showroom.

   Objectif : qu'un clic ads soit attribué correctement même si le
   lead navigue ensuite sur le site ou revient plus tard.

   - Capture TOUS les params connus sur CHAQUE page (pas seulement la 1ère).
   - first-touch : figé une fois dans localStorage + cookie 90j.
   - last-touch  : rafraîchi à chaque nouveau hit campagne.
   - Expose window.AtomTrack { first(), last(), payload(opts), propagate() }.
   ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Tous les paramètres d'attribution qu'on sait capter.
  var PARAM_KEYS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'gclid',      // Google Ads
    'fbclid',     // Meta (Insta / FB)
    'ttclid',     // TikTok
    'li_fat_id',  // LinkedIn
    'msclkid',    // Microsoft / Bing
  ];

  var FIRST_KEY = 'atom_attr_first';
  var LAST_KEY  = 'atom_attr_last';
  var COOKIE    = 'atom_attr';
  var MAXAGE    = 60 * 60 * 24 * 90; // 90 jours

  function readStore(key) {
    try { var s = localStorage.getItem(key); return s ? JSON.parse(s) : null; }
    catch (e) { return null; }
  }
  function writeStore(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }
  function readCookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : null;
  }
  function writeCookie(name, value) {
    try {
      var secure = window.location.protocol === 'https:' ? ';secure' : '';
      document.cookie = name + '=' + encodeURIComponent(value) +
        ';path=/;max-age=' + MAXAGE + ';samesite=lax' + secure;
    } catch (e) {}
  }

  // Récupère les params présents dans l'URL courante.
  function collectFromUrl() {
    var out = {}, has = false;
    try {
      var p = new URLSearchParams(window.location.search);
      PARAM_KEYS.forEach(function (k) {
        var v = p.get(k);
        if (v) { out[k] = v; has = true; }
      });
    } catch (e) {}
    return has ? out : null;
  }

  var urlData = collectFromUrl();
  var now = new Date().toISOString();

  // ── FIRST touch ─────────────────────────────────────────────
  var first = readStore(FIRST_KEY);

  // Fallback cookie si le localStorage a été vidé / autre onglet.
  if (!first) {
    var ck = readCookie(COOKIE);
    if (ck) { try { first = JSON.parse(ck); writeStore(FIRST_KEY, first); } catch (e) {} }
  }

  if (!first && urlData) {
    // Tout premier contact, avec attribution.
    first = Object.assign({}, urlData, {
      landing_page: window.location.href,
      referrer: document.referrer || null,
      ts: now,
    });
    writeStore(FIRST_KEY, first);
    writeCookie(COOKIE, JSON.stringify(first));
  } else if (!first) {
    // Premier contact organique (aucun param) — on garde au moins la landing.
    first = {
      landing_page: window.location.href,
      referrer: document.referrer || null,
      ts: now,
      organic: true,
    };
    writeStore(FIRST_KEY, first);
    writeCookie(COOKIE, JSON.stringify(first));
  } else if (urlData && first.organic) {
    // On n'avait qu'un first-touch organique : on le promeut vers la 1ère
    // attribution réelle rencontrée (reste le plus ancien touch attribué connu).
    first = Object.assign({}, urlData, {
      landing_page: first.landing_page || window.location.href,
      referrer: first.referrer || document.referrer || null,
      ts: now,
      upgraded_from_organic: true,
    });
    writeStore(FIRST_KEY, first);
    writeCookie(COOKIE, JSON.stringify(first));
  }

  // ── LAST touch ──────────────────────────────────────────────
  var last = readStore(LAST_KEY);
  if (urlData) {
    last = Object.assign({}, urlData, { landing_page: window.location.href, ts: now });
    writeStore(LAST_KEY, last);
  }

  // ── Rétro-compat : maintient sessionStorage utm_* pour l'ancien code ──
  try {
    PARAM_KEYS.forEach(function (k) {
      var v = (urlData && urlData[k]) || (first && first[k]);
      if (v) sessionStorage.setItem('utm_' + k, v);
    });
  } catch (e) {}

  // Objet plat prêt à fusionner dans le body de /api/submit.
  function flat() {
    var f = first || {};
    var l = last || {};
    return {
      utm_source:   f.utm_source   || null,
      utm_medium:   f.utm_medium   || null,
      utm_campaign: f.utm_campaign || null,
      utm_content:  f.utm_content  || null,
      utm_term:     f.utm_term     || null,
      gclid:        f.gclid        || null,
      fbclid:       f.fbclid       || null,
      ttclid:       f.ttclid       || null,
      li_fat_id:    f.li_fat_id    || null,
      msclkid:      f.msclkid      || null,
      referrer:     f.referrer     || (document.referrer || null),
      landing_page: f.landing_page || window.location.href,
      first_touch_at: f.ts || null,
      // last-touch (dernier canal vu)
      last_utm_source:   l.utm_source   || null,
      last_utm_medium:   l.utm_medium   || null,
      last_utm_campaign: l.utm_campaign || null,
    };
  }

  // Propage les UTM first-touch dans les liens internes pour que l'URL
  // les conserve à la navigation (filet de sécurité en plus du storage).
  function propagate() {
    var f = first;
    if (!f || f.organic) return;
    var qs = [];
    PARAM_KEYS.forEach(function (k) {
      if (f[k]) qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(f[k]));
    });
    if (!qs.length) return;
    var add = qs.join('&');
    var origin = window.location.origin;
    var anchors = document.querySelectorAll('a[href]');
    Array.prototype.forEach.call(anchors, function (a) {
      try {
        var href = a.getAttribute('href');
        if (!href || href.charAt(0) === '#') return;
        var u = new URL(href, origin);
        if (u.origin !== origin) return;                  // liens internes seulement
        if (u.searchParams.has('utm_source')) return;     // déjà taggé
        u.search = (u.search ? u.search + '&' : '?') + add;
        a.setAttribute('href', u.pathname + u.search + u.hash);
      } catch (e) {}
    });
  }

  window.AtomTrack = {
    first: function () { return first; },
    last: function () { return last; },
    payload: function (opts) {
      var base = flat();
      opts = opts || {};
      // fallback éventuel : nom de page si aucune source réelle (rarement utilisé,
      // le fallback est plutôt appliqué côté serveur via le champ `page`).
      if (!base.utm_source && opts.fallbackSource) base.utm_source = opts.fallbackSource;
      return base;
    },
    propagate: propagate,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', propagate);
  } else {
    propagate();
  }
})();
