const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { buildFicheHtml } = require('../lib/pdf-template');

module.exports = async function handler(req, res) {
  let browser = null;
  try {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    // Auth admin uniquement
    const payload = verifyToken(tokenFromReq(req));
    if (!payload) return res.status(401).json({ error: 'Non autorisé' });

    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id_required' });

    // Récupère le projet
    const { data: project, error } = await supabase
      .from('projects').select('*').eq('id', id).single();
    if (error || !project) return res.status(404).json({ error: 'not_found' });

    // Génère le HTML
    const html = buildFicheHtml(project);

    // Lance Puppeteer + Chromium
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 794, height: 1123 }, // A4 @ 96dpi
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    await browser.close();
    browser = null;

    const fileName = `Atom-${slugify(project.title)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(pdf);

  } catch (e) {
    if (browser) try { await browser.close(); } catch {}
    console.error('PDF generation error:', e);
    return res.status(500).json({ error: 'pdf_error', detail: e?.message || String(e) });
  }
};

/* ─── Helper : nom de fichier ─── */
function slugify(s) {
  return String(s || 'projet').toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
