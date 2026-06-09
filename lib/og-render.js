// lib/og-render.js
// Rendu Open Graph dynamique (aperçu de lien riche pour /projet/:slug et
// /realisation/:slug). On le place dans lib/ — et NON dans un fichier api/ —
// car le build distant de Vercel classe toute fonction api/*.js contenant du
// HTML/OG comme « page statique » et ne la compile pas en fonction serverless
// (→ 404). Les fichiers lib/ sont de simples dépendances bundlées : leur
// contenu HTML est sans effet sur la détection des fonctions.
const { supabase } = require('./supabase');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildOgTags({ title, desc, img, url }) {
  return [
    `<meta property="og:type" content="website"/>`,
    `<meta property="og:site_name" content="Atom Buyers Club"/>`,
    `<meta property="og:title" content="${esc(title)}"/>`,
    `<meta property="og:description" content="${esc(desc)}"/>`,
    `<meta property="og:image" content="${esc(img)}"/>`,
    `<meta property="og:url" content="${esc(url)}"/>`,
    `<meta name="twitter:card" content="summary_large_image"/>`,
    `<meta name="twitter:title" content="${esc(title)}"/>`,
    `<meta name="twitter:description" content="${esc(desc)}"/>`,
    `<meta name="twitter:image" content="${esc(img)}"/>`,
  ].join('\n  ');
}

function injectOg(html, title, ogTags) {
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`)
    .replace('</head>', `  ${ogTags}\n</head>`);
}

// Cache mémoire du template (par type de page) — réinitialisé à chaque cold start.
const TPL = {};
async function getTemplate(base, path) {
  if (TPL[path]) return TPL[path];
  TPL[path] = await (await fetch(`${base}${path}`)).text();
  return TPL[path];
}

function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'join.atombuyerclub.fr';
  return `https://${host}`;
}

// ── Page projet : /projet/:slug ──────────────────────────────────
async function renderProjectOG(req, res, slug) {
  const base = baseUrl(req);
  try {
    let html = await getTemplate(base, '/projet');
    const { data: project } = await supabase
      .from('projects')
      .select('title, description, images, images_3d, slug')
      .eq('slug', slug)
      .maybeSingle();

    const title = project ? `${project.title || 'Projet'} — Atom Buyers Club` : 'Projet — Atom Buyers Club';
    const desc = (project && project.description)
      ? String(project.description).replace(/\s+/g, ' ').trim().slice(0, 200)
      : 'Studio rénové, clé en main, à Paris — investissement locatif avec Atom Buyers Club.';
    const img = (project && project.images_3d && project.images_3d[0])
      || (project && project.images && project.images[0])
      || `${base}/og-default.jpg`;
    const url = `${base}/projet/${(project && project.slug) || slug || ''}`;

    html = injectOg(html, title, buildOgTags({ title, desc, img, url }));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
    return res.status(200).send(html);
  } catch (e) {
    console.error('renderProjectOG error:', e?.message || e);
    res.setHeader('Location', `/projet?slug=${encodeURIComponent(slug || '')}`);
    return res.status(302).end();
  }
}

// ── Page réalisation : /realisation/:slug ────────────────────────
async function renderShowroomOG(req, res, slug) {
  const base = baseUrl(req);
  try {
    let html = await getTemplate(base, '/showroom');
    const { data: item } = await supabase
      .from('showroom_items')
      .select('name, description_courte, image_cover, images_after, quartier, arrondissement, slug')
      .eq('slug', slug)
      .maybeSingle();

    const title = item ? `${item.name || 'Réalisation'} — Atom Buyers Club` : 'Nos réalisations — Atom Buyers Club';
    const desc = (item && item.description_courte)
      ? String(item.description_courte).replace(/\s+/g, ' ').trim().slice(0, 200)
      : 'Découvrez nos réalisations : studios parisiens rénovés, clé en main, par Atom Buyers Club.';
    const img = (item && item.image_cover)
      || (item && item.images_after && item.images_after[0])
      || `${base}/og-default.jpg`;
    const url = `${base}/realisation/${(item && item.slug) || slug || ''}`;

    html = injectOg(html, title, buildOgTags({ title, desc, img, url }));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
    return res.status(200).send(html);
  } catch (e) {
    console.error('renderShowroomOG error:', e?.message || e);
    res.setHeader('Location', `/showroom`);
    return res.status(302).end();
  }
}

module.exports = { renderProjectOG, renderShowroomOG };
