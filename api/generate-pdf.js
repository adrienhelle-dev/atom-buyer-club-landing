const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');
// puppeteer-core@25 et @sparticuz/chromium@148 sont des ES Modules : on NE peut
// PAS les require() depuis ce fichier CommonJS (ERR_REQUIRE_ESM → crash au chargement).
// On les charge donc en import() dynamique dans le handler (cf. plus bas).

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

    // Lance Puppeteer + Chromium (import dynamique : modules ESM)
    const { default: puppeteer } = await import('puppeteer-core');
    const { default: chromium }  = await import('@sparticuz/chromium');
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

/* ─── Helpers ──────────────────────────────────────────────── */
function fmtEuro(n) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function slugify(s) {
  return String(s || 'projet').toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* ─── Template HTML 9 pages ────────────────────────────────── */
function buildFicheHtml(p) {
  const totalAllIn = p.total_all_in || ((p.price_fai||0)+(p.fees_atom||0)+(p.fees_notaire||0)+(p.budget_travaux||0)+(p.budget_meuble||0));
  const apport = Math.round(totalAllIn * 0.10);
  const emprunt = Math.max(0, totalAllIn - apport);
  const cashflow = (p.loyer_atom || 0) - (p.mensualite || 0);
  const heroImg = p.images_3d?.[0] || p.images?.[0];

  return `<!DOCTYPE html><html lang="fr"><head>
<meta charset="UTF-8"/>
<title>Projet ${esc(p.title)} — Atom Buyers Club</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300&display=swap" rel="stylesheet"/>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'DM Sans', system-ui, sans-serif;
    background: #F5F2ED; color: #1a1815;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .serif { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 300; }
  .page {
    width: 210mm; height: 297mm;
    padding: 28mm 24mm; position: relative;
    page-break-after: always; overflow: hidden;
  }
  .page:last-child { page-break-after: auto; }
  .brand-mark {
    position: absolute; top: 22mm; left: 24mm;
    font-size: 9pt; letter-spacing: .25em; text-transform: uppercase; color: #B8975A; font-weight: 500;
  }
  .page-footer {
    position: absolute; bottom: 16mm; left: 24mm; right: 24mm;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 8pt; color: #999;
  }
  .page-footer .footer-logo {
    font-family: 'Cormorant Garamond', Georgia, serif; font-size: 13pt; color: #1a1815; font-style: italic;
  }

  /* ─── PAGE 1 - Couverture ───────────────────────── */
  .cover { display: flex; flex-direction: column; justify-content: space-between; height: 100%; padding-top: 30mm; }
  .cover-title { font-size: 48pt; line-height: 1; margin-bottom: 8mm; }
  .cover-subtitle { font-size: 13pt; color: #6b6862; letter-spacing: .05em; margin-bottom: 14mm; line-height: 1.5; }
  .cover-prices { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; margin-bottom: 14mm; }
  .cover-price-block { padding: 6mm 8mm; background: #fff; border-radius: 4px; border-left: 3px solid #B8975A; }
  .cover-price-label { font-size: 8pt; text-transform: uppercase; letter-spacing: .15em; color: #999; margin-bottom: 3mm; }
  .cover-price-value { font-size: 18pt; font-weight: 500; color: #1a1815; }
  .cover-image {
    flex: 1; background-color: #e8e3da;
    background-size: cover; background-position: center;
    border-radius: 6px; min-height: 80mm;
    display: flex; align-items: center; justify-content: center;
    color: #aaa; font-size: 60pt;
  }

  /* ─── PAGE 2 - État actuel + 3D ─────────────────── */
  .h2-page { font-size: 28pt; margin-bottom: 8mm; }
  .photo-section { margin-bottom: 12mm; }
  .photo-label { font-size: 9pt; text-transform: uppercase; letter-spacing: .2em; color: #B8975A; margin-bottom: 4mm; }
  .photo-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 3mm; }
  .photo-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; }
  .photo-tile {
    aspect-ratio: 4/3; background-color: #e8e3da; background-size: cover; background-position: center;
    border-radius: 3px;
  }
  .photo-tile.tall { aspect-ratio: 3/4; }
  .photo-hero {
    width: 100%; aspect-ratio: 16/9; background-color: #e8e3da;
    background-size: cover; background-position: center; border-radius: 4px;
  }

  /* ─── PAGE 3 - Infos ────────────────────────────── */
  .info-table { width: 100%; margin: 8mm 0; }
  .info-table tr td { padding: 3mm 0; border-bottom: 1px solid rgba(0,0,0,.08); font-size: 10pt; }
  .info-table tr td:first-child { color: #6b6862; width: 40%; }
  .info-table tr td:last-child { text-align: right; font-weight: 500; }
  .price-center {
    text-align: center; margin: 18mm 0; padding: 12mm 0;
    background: #fff; border-radius: 4px;
  }
  .price-center-label { font-size: 9pt; color: #999; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 3mm; }
  .price-center-value { font-size: 32pt; color: #B8975A; }
  .price-center-extra { font-size: 9pt; color: #6b6862; font-style: italic; margin-top: 2mm; }

  /* ─── PAGE 5 - Ameublement ──────────────────────── */
  .ameu-desc { font-size: 11pt; line-height: 1.7; color: #4a4742; margin-bottom: 8mm; }
  .ameu-items { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm 6mm; margin: 6mm 0; }
  .ameu-item { font-size: 10pt; display: flex; align-items: center; gap: 4mm; padding: 2mm 0; }
  .ameu-budget { margin-top: 10mm; padding: 6mm 8mm; background: #fff; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; }
  .ameu-budget-label { font-size: 10pt; color: #6b6862; }
  .ameu-budget-value { font-size: 16pt; font-weight: 500; color: #B8975A; }

  /* ─── PAGE 6 - Financiers ───────────────────────── */
  .fin-table { width: 100%; margin-top: 10mm; }
  .fin-table tr td { padding: 4mm 0; font-size: 11pt; }
  .fin-table tr td:first-child { color: #4a4742; }
  .fin-table tr td:last-child { text-align: right; font-weight: 500; }
  .fin-table tr.fin-sep td { border-bottom: 2px solid #1a1815; }
  .fin-table tr.fin-total td { padding-top: 5mm; font-size: 14pt; font-weight: 500; }
  .fin-table tr.fin-total td:last-child { color: #B8975A; font-family: 'Cormorant Garamond'; font-size: 22pt; }
  .fin-table tr.fin-loyer-line td { padding-top: 10mm; font-size: 12pt; font-weight: 500; }
  .fin-disclaimer { font-size: 8pt; color: #999; font-style: italic; margin-top: 14mm; }

  /* ─── PAGE 8 - FAQ ──────────────────────────────── */
  .faq-block { margin-bottom: 7mm; }
  .faq-q { font-family: 'Cormorant Garamond'; font-size: 14pt; font-style: italic; color: #B8975A; margin-bottom: 2mm; }
  .faq-a { font-size: 10pt; line-height: 1.7; color: #4a4742; }

  /* ─── PAGE 9 - Contact ──────────────────────────── */
  .contact-page { display: flex; flex-direction: column; justify-content: center; height: 100%; }
  .contact-intro { font-size: 12pt; color: #6b6862; line-height: 1.7; margin-bottom: 14mm; text-align: center; }
  .contact-list { display: flex; flex-direction: column; gap: 6mm; margin: 0 auto; max-width: 110mm; }
  .contact-card { padding: 6mm 8mm; background: #fff; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; }
  .contact-name { font-family: 'Cormorant Garamond'; font-size: 18pt; color: #1a1815; }
  .contact-phone { font-size: 11pt; color: #B8975A; font-weight: 500; }
  .contact-logo {
    margin-top: 20mm; text-align: center;
    font-family: 'Cormorant Garamond'; font-style: italic; font-size: 28pt; color: #1a1815;
  }
  .contact-tagline { font-size: 9pt; color: #999; letter-spacing: .2em; text-transform: uppercase; margin-top: 3mm; text-align: center; }
</style>
</head><body>

<!-- ═══ PAGE 1 — COUVERTURE ═══ -->
<div class="page">
  <div class="brand-mark">Atom Buyers Club</div>
  <div class="cover">
    <div>
      <h1 class="serif cover-title">${esc(p.title)}</h1>
      <p class="cover-subtitle">
        ${p.arrondissement ? 'Paris ' + esc(p.arrondissement) : ''}
        ${p.surface_carrez ? '· ' + p.surface_carrez + ' m²' : ''}
        ${p.floor != null ? '· ' + p.floor + (p.floor === 0 ? '' : 'e') + ' étage' : ''}
        ${p.has_elevator ? ' avec ascenseur' : ''}
      </p>
      <div class="cover-prices">
        <div class="cover-price-block">
          <div class="cover-price-label">Prix FAI</div>
          <div class="cover-price-value">${fmtEuro(p.price_fai)}</div>
        </div>
        <div class="cover-price-block">
          <div class="cover-price-label">Budget travaux</div>
          <div class="cover-price-value">${fmtEuro(p.budget_travaux)}</div>
        </div>
      </div>
    </div>
    <div class="cover-image" style="${heroImg ? `background-image:url('${esc(heroImg)}')` : ''}">${heroImg ? '' : '🏠'}</div>
  </div>
  <div class="page-footer">
    <span class="footer-logo">atom</span>
    <span>buyers club</span>
  </div>
</div>

<!-- ═══ PAGE 2 — ÉTAT ACTUEL + 3D ═══ -->
<div class="page">
  <div class="brand-mark">Atom Buyers Club · État actuel & projections</div>
  <h2 class="serif h2-page">Avant / Après</h2>

  ${p.images?.length ? `
  <div class="photo-section">
    <div class="photo-label">État actuel</div>
    <div class="photo-grid-3">
      ${p.images.slice(0, 3).map(src => `<div class="photo-tile" style="background-image:url('${esc(src)}')"></div>`).join('')}
    </div>
  </div>` : ''}

  ${p.images_3d?.length ? `
  <div class="photo-section">
    <div class="photo-label">Projections 3D (après travaux)</div>
    <div class="photo-hero" style="${p.images_3d[0] ? `background-image:url('${esc(p.images_3d[0])}')` : ''}"></div>
  </div>` : ''}

  <div class="page-footer">
    <span class="footer-logo">atom</span>
    <span>2 / 9</span>
  </div>
</div>

<!-- ═══ PAGE 3 — INFORMATIONS ═══ -->
<div class="page">
  <div class="brand-mark">Atom Buyers Club · Informations</div>
  <h2 class="serif h2-page">Le bien</h2>

  ${p.description ? `<p style="font-size:11pt;line-height:1.7;color:#4a4742;margin-bottom:8mm">${esc(p.description)}</p>` : ''}

  <table class="info-table">
    ${p.address          ? `<tr><td>Adresse</td><td>${esc(p.address)}</td></tr>` : ''}
    ${p.arrondissement   ? `<tr><td>Arrondissement</td><td>Paris ${esc(p.arrondissement)}</td></tr>` : ''}
    ${p.surface_carrez   ? `<tr><td>Surface Carrez</td><td>${p.surface_carrez} m²</td></tr>` : ''}
    ${p.floor != null    ? `<tr><td>Étage</td><td>${p.floor}${p.floor === 0 ? ' (rdc)' : 'e étage'} ${p.has_elevator ? '· ascenseur' : '· sans ascenseur'}</td></tr>` : ''}
    ${p.metro_name       ? `<tr><td>Métro</td><td>${esc(p.metro_name)}${p.metro_distance ? ' — ' + p.metro_distance + ' m' : ''}</td></tr>` : ''}
    ${p.dpe_avant        ? `<tr><td>DPE avant travaux</td><td>${esc(p.dpe_avant)}</td></tr>` : ''}
    ${p.dpe_apres        ? `<tr><td>DPE après travaux</td><td>${esc(p.dpe_apres)}</td></tr>` : ''}
  </table>

  <div class="price-center">
    <div class="price-center-label">Prix d'acquisition</div>
    <div class="serif price-center-value">${fmtEuro(p.price_fai)}</div>
    <div class="price-center-extra">+ frais d'accompagnement Atom</div>
  </div>

  <div class="page-footer">
    <span class="footer-logo">atom</span>
    <span>3 / 9</span>
  </div>
</div>

<!-- ═══ PAGE 4 — PROJECTIONS 3D (suite) ═══ -->
${p.images_3d?.length > 1 ? `
<div class="page">
  <div class="brand-mark">Atom Buyers Club · Projections 3D</div>
  <h2 class="serif h2-page">Projection finale</h2>
  <div class="photo-grid-2" style="margin-top:8mm">
    ${p.images_3d.slice(1, 7).map(src => `<div class="photo-tile" style="background-image:url('${esc(src)}')"></div>`).join('')}
  </div>
  <div class="page-footer">
    <span class="footer-logo">atom</span>
    <span>4 / 9</span>
  </div>
</div>` : ''}

<!-- ═══ PAGE 5 — AMEUBLEMENT ═══ -->
<div class="page">
  <div class="brand-mark">Atom Buyers Club · Ameublement</div>
  <h2 class="serif h2-page">Ameublement & équipements</h2>

  ${p.ameublement_desc ? `<p class="ameu-desc">${esc(p.ameublement_desc)}</p>` : ''}

  <div class="ameu-items">
    ${buildAmeuItems(p.ameublement || {})}
  </div>

  <div class="ameu-budget">
    <span class="ameu-budget-label">Budget mobilier & électroménager</span>
    <span class="serif ameu-budget-value">${fmtEuro(p.budget_meuble)}</span>
  </div>

  <div class="page-footer">
    <span class="footer-logo">atom</span>
    <span>5 / 9</span>
  </div>
</div>

<!-- ═══ PAGE 6 — ÉLÉMENTS FINANCIERS ═══ -->
<div class="page">
  <div class="brand-mark">Atom Buyers Club · Éléments financiers</div>
  <h2 class="serif h2-page">Éléments financiers</h2>

  <table class="fin-table">
    <tr><td>Prix FAI</td><td>${fmtEuro(p.price_fai)}</td></tr>
    <tr><td>Frais d'accompagnement Atom</td><td>${fmtEuro(p.fees_atom)}</td></tr>
    <tr><td>Frais de notaire</td><td>${fmtEuro(p.fees_notaire)}</td></tr>
    <tr><td>Travaux</td><td>${fmtEuro(p.budget_travaux)}</td></tr>
    <tr class="fin-sep"><td>Mobilier & électroménager</td><td>${fmtEuro(p.budget_meuble)}</td></tr>
    <tr class="fin-total"><td>Total</td><td>${fmtEuro(totalAllIn)}</td></tr>

    <tr class="fin-loyer-line"><td>Loyer Atom</td><td>${p.loyer_atom ? fmtEuro(p.loyer_atom) + '/mois' : '—'}</td></tr>
    <tr><td>Mensualité*</td><td>${p.mensualite ? fmtEuro(p.mensualite) + '/mois' : '—'}</td></tr>
    ${p.loyer_atom && p.mensualite ? `<tr><td>Cash-flow estimé</td><td style="color:${cashflow >= 0 ? '#4caf7d' : '#d95e5e'}">${cashflow >= 0 ? '+' : ''}${fmtEuro(cashflow)}/mois</td></tr>` : ''}
    ${p.rendement_brut ? `<tr><td>Rendement</td><td>${p.rendement_brut} %</td></tr>` : ''}
  </table>

  <p class="fin-disclaimer">* Hypothèse de simulation : apport 10 %, durée 25 ans, taux fixe 3,60 %.</p>

  <div class="page-footer">
    <span class="footer-logo">atom</span>
    <span>6 / 9</span>
  </div>
</div>

<!-- ═══ PAGE 7 — SIMULATION FINANCEMENT ═══ -->
<div class="page">
  <div class="brand-mark">Atom Buyers Club · Simulation</div>
  <h2 class="serif h2-page">Simulation de financement</h2>

  <table class="fin-table" style="margin-top:14mm">
    <tr><td>Prix du bien</td><td>${fmtEuro(p.price_fai)}</td></tr>
    <tr><td>Frais annexes</td><td>${fmtEuro((p.fees_atom||0) + (p.fees_notaire||0))}</td></tr>
    <tr class="fin-sep"><td>Travaux & mobilier</td><td>${fmtEuro((p.budget_travaux||0) + (p.budget_meuble||0))}</td></tr>
    <tr class="fin-total"><td>Budget total</td><td>${fmtEuro(totalAllIn)}</td></tr>

    <tr style="height:6mm"><td></td><td></td></tr>
    <tr><td>Montant emprunté</td><td>${fmtEuro(emprunt)}</td></tr>
    <tr><td>Apport (10 %)</td><td>${fmtEuro(apport)}</td></tr>
    <tr><td>Durée d'emprunt</td><td>25 ans</td></tr>
    <tr><td>Taux fixe</td><td>3,60 %</td></tr>
    <tr class="fin-total"><td>Mensualité</td><td>${p.mensualite ? fmtEuro(p.mensualite) + '/mois' : '—'}</td></tr>
  </table>

  <div class="page-footer">
    <span class="footer-logo">atom</span>
    <span>7 / 9</span>
  </div>
</div>

<!-- ═══ PAGE 8 — FAQ ═══ -->
<div class="page">
  <div class="brand-mark">Atom Buyers Club · Questions courantes</div>
  <h2 class="serif h2-page">Questions courantes</h2>

  <div style="margin-top:8mm">
    <div class="faq-block">
      <div class="faq-q">Comment Atom source-t-il ses opportunités ?</div>
      <div class="faq-a">Nous travaillons avec un réseau de partenaires (notaires, marchands de biens, off-market) et sélectionnons chaque mois quelques opportunités à fort potentiel dans Paris intra-muros.</div>
    </div>
    <div class="faq-block">
      <div class="faq-q">Suis-je propriétaire du bien ?</div>
      <div class="faq-a">Oui, vous êtes pleinement propriétaire. Atom intervient comme chasseur immobilier et opérateur de la rénovation. L'acte d'achat est signé à votre nom.</div>
    </div>
    <div class="faq-block">
      <div class="faq-q">La négociation du prix est-elle incluse ?</div>
      <div class="faq-a">Oui. Notre rémunération est forfaitaire (frais d'accompagnement), nous n'avons aucun intérêt à gonfler le prix. Nous négocions au maximum pour vous.</div>
    </div>
    <div class="faq-block">
      <div class="faq-q">Le budget travaux est-il garanti ?</div>
      <div class="faq-a">Le budget annoncé est issu d'un chiffrage détaillé par notre maître d'œuvre. Nous prenons en charge tout dépassement éventuel.</div>
    </div>
    <div class="faq-block">
      <div class="faq-q">Comment se passe l'exploitation locative ?</div>
      <div class="faq-a">Atom propose un mandat de gestion locative meublé optimisé. Vous percevez un loyer net mensuel défini à l'avance, sans gestion des locataires.</div>
    </div>
    <div class="faq-block">
      <div class="faq-q">Que couvrent les frais d'accompagnement ?</div>
      <div class="faq-a">Recherche, négociation, suivi notarial, pilotage des travaux, ameublement, mise en location : tout est inclus dans le forfait Atom.</div>
    </div>
  </div>

  <div class="page-footer">
    <span class="footer-logo">atom</span>
    <span>8 / 9</span>
  </div>
</div>

<!-- ═══ PAGE 9 — CONTACT ═══ -->
<div class="page">
  <div class="brand-mark">Atom Buyers Club · Contact</div>
  <div class="contact-page">
    <h2 class="serif h2-page" style="text-align:center">Parlons-en</h2>
    <p class="contact-intro">Cette opportunité vous intéresse ?<br>Contactez-nous directement pour en discuter.</p>

    <div class="contact-list">
      <div class="contact-card">
        <span class="contact-name">Thierry Vignal</span>
        <span class="contact-phone">+33 6 37 12 47 96</span>
      </div>
      <div class="contact-card">
        <span class="contact-name">Alexandre Kiman</span>
        <span class="contact-phone">+33 6 22 05 73 64</span>
      </div>
      <div class="contact-card">
        <span class="contact-name">Adrien Helle</span>
        <span class="contact-phone">+33 6 86 47 56 56</span>
      </div>
    </div>

    <div class="contact-logo">atom</div>
    <div class="contact-tagline">Buyers Club</div>
  </div>
</div>

</body></html>`;
}

const AMEU_LABELS = {
  lit_double:      '🛏 Lit double',
  cuisine_equipee: '🍳 Cuisine équipée',
  douche:          '🚿 Salle de bain avec douche',
  wc_separes:      '🚽 WC séparés',
  table:           '🍽 Table à manger',
  rangements:      '🗄 Rangements intégrés',
  internet:        '📶 Internet inclus',
};

function buildAmeuItems(ameu) {
  const items = Object.entries(AMEU_LABELS)
    .filter(([k]) => ameu[k])
    .map(([_, label]) => `<div class="ameu-item">${label}</div>`)
    .join('');
  return items || '<div style="color:#999;font-style:italic;font-size:10pt">Aucun équipement spécifié</div>';
}
