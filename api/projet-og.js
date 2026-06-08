const { supabase } = require('../lib/supabase');

// Sert la page projet (/projet/<slug>) avec des métadonnées Open Graph dynamiques :
// titre + description + IMAGE = 1er visuel 3D du projet. Permet un bel aperçu de
// lien (Telegram, WhatsApp, Meta, iMessage…). La page reste la même SPA pour
// l'utilisateur ; on n'injecte que les balises <head> que lisent les robots.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Template mis en cache entre invocations "chaudes" de la fonction.
let TPL = null;
async function getTemplate(base) {
  if (TPL) return TPL;
  const r = await fetch(`${base}/projet`);
  TPL = await r.text();
  return TPL;
}

module.exports = async function handler(req, res) {
  const slug = req.query.slug || null;
  const id   = req.query.id || null;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'join.atombuyerclub.fr';
  const base = `https://${host}`;

  try {
    let html = await getTemplate(base);

    let project = null;
    if (slug || id) {
      let q = supabase.from('projects')
        .select('title, description, images, images_3d, slug, arrondissement')
        .limit(1);
      q = slug ? q.eq('slug', slug) : q.eq('id', id);
      const { data } = await q.maybeSingle();
      project = data || null;
    }

    const title = project
      ? `${project.title || 'Projet'} — Atom Buyers Club`
      : 'Projet — Atom Buyers Club';
    const desc = (project && project.description)
      ? String(project.description).replace(/\s+/g, ' ').trim().slice(0, 200)
      : 'Studio rénové, clé en main, à Paris — investissement locatif avec Atom Buyers Club.';
    const img = (project && project.images_3d && project.images_3d[0])
      || (project && project.images && project.images[0])
      || `${base}/og-default.jpg`;
    const url = `${base}/projet/${(project && project.slug) || slug || ''}`;

    const og = [
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

    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
    html = html.replace('</head>', `  ${og}\n</head>`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
    return res.status(200).send(html);
  } catch (e) {
    console.error('projet-og error:', e?.message || e);
    // Repli : on sert la page statique normale (sans OG dynamique).
    res.setHeader('Location', `/projet?slug=${encodeURIComponent(slug || '')}`);
    return res.status(302).end();
  }
};
