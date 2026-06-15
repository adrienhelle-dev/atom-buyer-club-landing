// api/offers.js
// Gestion du cycle offre → mandat pour un intérêt lead × projet.
//
// POST ?action=visit       → marque l'intérêt comme "visite effectuée"
// POST ?action=offer       → génère PDF offre + envoie email + crée enregistrement mandat
// POST ?action=mandat      → génère PDF mandat + envoie via DocuSign pour e-sign
// POST ?action=link        → génère/récupère le lien info-acheteur pour ce lead
// GET  ?interest_id=X      → statut courant de l'offre/mandat pour cet intérêt
//
// Variables d'env requises pour DocuSign (JWT Grant — server-to-server) :
//   DOCUSIGN_INTEGRATION_KEY   — client ID de l'app DocuSign
//   DOCUSIGN_USER_ID           — GUID de l'utilisateur DocuSign qui signe côté admin
//   DOCUSIGN_ACCOUNT_ID        — ID du compte DocuSign
//   DOCUSIGN_RSA_PRIVATE_KEY   — clé RSA privée PEM (avec sauts de ligne → \\n dans Vercel)
//   DOCUSIGN_BASE_URL          — ex. https://na3.docusign.net  (voir tableau de bord DS)
//   DOCUSIGN_AUTH_URL          — défaut : https://account.docusign.com (prod)

const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');
const { getFounder, allFounderEmails, associateEmails } = require('../lib/founders');
const { esc } = require('../lib/html');
const { Resend } = require('resend');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// ── Helpers ────────────────────────────────────────────────────────────────

function ordinal(n) {
  if (!n) return '';
  return n === 1 ? '1er' : `${n}ème`;
}

function fmtDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function addDays(isoDate, days) {
  const d = new Date(isoDate || Date.now());
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function todayFr() {
  return new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatPrix(n) {
  if (!n) return '—';
  return Number(n).toLocaleString('fr-FR') + ' €';
}

// ── DocuSign JWT Grant ─────────────────────────────────────────────────────

async function getDocuSignToken() {
  const integrationKey = process.env.DOCUSIGN_INTEGRATION_KEY;
  const userId         = process.env.DOCUSIGN_USER_ID;
  const authUrl        = (process.env.DOCUSIGN_AUTH_URL || 'https://account.docusign.com').replace(/\/$/, '');
  const rsaKey         = (process.env.DOCUSIGN_RSA_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!integrationKey || !userId || !rsaKey) return null;

  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: integrationKey, sub: userId, aud: authUrl.replace('https://', ''), iat: now, exp: now + 3600, scope: 'signature impersonation' },
    rsaKey,
    { algorithm: 'RS256' }
  );

  const r = await fetch(`${authUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${assertion}`,
  });
  const j = await r.json();
  return j.access_token || null;
}

async function createDocuSignEnvelope({ pdfBuffer, fileName, lead, mandatId }) {
  const token     = await getDocuSignToken();
  const accountId = process.env.DOCUSIGN_ACCOUNT_ID;
  const baseUrl   = (process.env.DOCUSIGN_BASE_URL || 'https://na3.docusign.net').replace(/\/$/, '');

  if (!token || !accountId) return null;

  const pdfB64 = Buffer.from(pdfBuffer).toString('base64');
  const envelope = {
    emailSubject: `Mandat de recherche — Atom Buyers Club`,
    emailBlurb: `Bonjour ${lead.prenom},\n\nVeuillez trouver ci-joint votre mandat de recherche à signer électroniquement.`,
    documents: [{ documentBase64: pdfB64, name: fileName, fileExtension: 'pdf', documentId: '1' }],
    recipients: {
      signers: [{
        email: lead.email,
        name: `${lead.prenom} ${lead.nom}`,
        recipientId: '1',
        routingOrder: '1',
        tabs: {
          signHereTabs: [{ documentId: '1', pageNumber: '4', xPosition: '80', yPosition: '620' }],
          dateSignedTabs: [{ documentId: '1', pageNumber: '4', xPosition: '80', yPosition: '680' }],
        },
      }],
    },
    status: 'sent',
    eventNotifications: process.env.SITE_URL ? [{
      url: `${process.env.SITE_URL}/api/docusign-webhook`,
      loggingEnabled: true,
      requireAcknowledgment: false,
      envelopeEvents: [{ envelopeEventStatusCode: 'completed' }],
      recipientEvents: [{ recipientEventStatusCode: 'Completed' }],
    }] : [],
  };

  const r = await fetch(`${baseUrl}/restapi/v2.1/accounts/${accountId}/envelopes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  const j = await r.json();
  return j.envelopeId || null;
}

// ── PDF Builders ───────────────────────────────────────────────────────────

const ATOM_LOGO_SVG = `<svg width="32" height="32" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect width="48" height="48" rx="8" fill="#B8975A"/><path transform="matrix(2.07 0 0 2 8 0.3)" d="M12.4651 19.6844C10.7251 19.6844 9.82511 18.4544 9.58511 16.5644L9.49511 15.9044C9.13511 17.7944 7.33511 19.7444 4.57513 19.7444 2.02513 19.7444 0.255127 18.0944 0.255127 15.8744 0.255127 13.8644 1.69513 12.4244 4.36513 12.1844L8.92511 11.8244 8.71511 10.2944C8.35511 7.56445 7.12511 5.76444 4.84513 5.76444 3.07513 5.76444 1.75513 6.87444 1.09513 8.46445L0.705128 8.37444C1.27513 6.24444 3.43513 3.93444 6.49511 3.93444 9.52511 3.93444 11.4451 5.91444 11.8951 9.48445L12.7651 16.1144C12.9451 17.4044 13.4551 17.7944 13.9651 17.7944 14.3851 17.7944 14.6851 17.4344 14.7751 16.9244L15.1351 16.9544C15.0751 18.2444 14.1451 19.6844 12.4651 19.6844ZM3.28513 15.2144C3.28513 16.6544 4.33513 17.9744 6.16511 17.9744 8.08511 17.9744 9.25511 16.5944 9.40511 15.2144L8.98511 12.2744 6.04511 12.5144C4.21513 12.6944 3.28513 13.7744 3.28513 15.2144Z" fill="#1A1A1A"/></svg>`;

const CONDITION_TEXTE = {
  avec: `La présente offre est formulée <strong>avec condition suspensive d'obtention de prêt</strong>, conformément aux dispositions des articles L. 313-40 et suivants du Code de la consommation. Elle ne constitue pas un avant-contrat et ne deviendra définitive qu'à la signature d'un compromis de vente.`,
  sans_comptant: `La présente offre est formulée <strong>sans condition suspensive d'obtention de prêt</strong>, l'acquéreur procédant à une <strong>acquisition au comptant sur fonds propres</strong>. Elle ne constitue pas un avant-contrat et ne deviendra définitive qu'à la signature d'un compromis de vente.`,
  sans_renonciation: `La présente offre est formulée <strong>sans condition suspensive d'obtention de prêt</strong>, l'acquéreur renonçant expressément au bénéfice de la condition suspensive prévue aux articles L. 313-40 et suivants du Code de la consommation. Elle ne constitue pas un avant-contrat et ne deviendra définitive qu'à la signature d'un compromis de vente.`,
};

function buildOfferHtml({ lead, project, prix, notaire, dateToday, conditionPret }) {
  const signataires = [];
  const civil = lead.prenom?.toLowerCase().startsWith('m') ? 'M.' : 'M.'; // défaut M.
  signataires.push(`<li><strong>${esc(civil)} ${esc(lead.nom?.toUpperCase())} ${esc(lead.prenom)}</strong>, né(e) le ${esc(fmtDate(lead.date_naissance))}, demeurant au ${esc(lead.adresse_residence)}</li>`);
  if (lead.situation_familiale === 'marie' || lead.situation_familiale === 'pacse') {
    if (lead.conjoint_prenom && lead.conjoint_nom) {
      signataires.push(`<li><strong>Mme/M. ${esc(lead.conjoint_nom?.toUpperCase())} ${esc(lead.conjoint_prenom)}</strong>${lead.conjoint_dob ? ', né(e) le ' + esc(fmtDate(lead.conjoint_dob)) : ''}, demeurant à la même adresse</li>`);
    }
  }

  const valableJusquau = addDays(dateToday, 15);
  const surface = project.surface_carrez ? `${project.surface_carrez}m²` : '—';
  const etage   = project.floor ? ordinal(project.floor) + ' étage' : '—';
  const conditionHtml = CONDITION_TEXTE[conditionPret] || CONDITION_TEXTE.avec;

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Times New Roman', Georgia, serif; font-size: 12pt; color: #1a1a1a; background: #fff; padding: 50px 70px 60px; line-height: 1.7; }
  .pdf-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 48px; padding-bottom: 20px; border-bottom: 1px solid #ddd; }
  .pdf-logo { display: flex; align-items: center; gap: 10px; }
  .pdf-brand { font-family: Georgia, 'Times New Roman', serif; font-size: 13pt; font-weight: normal; letter-spacing: .03em; color: #1a1a1a; }
  .pdf-header-date { font-size: 10.5pt; color: #555; }
  p { margin-bottom: 14px; }
  ul { margin: 10px 0 14px 20px; }
  li { margin-bottom: 6px; }
  .bold { font-weight: bold; }
  .notaire { margin: 8px 0; }
  .footer { margin-top: 50px; }
  .sig-block { display: flex; justify-content: space-between; margin-top: 30px; }
  .sig-col { width: 45%; }
  .sig-label { font-size: 10pt; color: #444; margin-bottom: 60px; }
</style></head><body>

<div class="pdf-header">
  <div class="pdf-logo">
    ${ATOM_LOGO_SVG}
    <span class="pdf-brand">Atom Buyers Club</span>
  </div>
  <div class="pdf-header-date">Paris, le ${esc(dateToday)}</div>
</div>

<p>Madame, Monsieur,</p>

<p>Je/nous soussigné(e)(s) :</p>
<ul>
  ${signataires.join('\n  ')}
</ul>

<p>Faisant suite à la visite du bien situé au <strong>${esc(project.address || project.title)}</strong>, je/nous souhaite(ons) vous présenter une offre d'achat au prix de <strong>${formatPrix(prix)} FAI</strong> pour le studio de <strong>${esc(surface)} Carrez</strong>, situé au <strong>${esc(etage)}</strong> de l'immeuble, valable jusqu'au <strong>${esc(valableJusquau)}</strong>.</p>

<p>${conditionHtml}</p>

<p>Vous trouverez ci-dessous les coordonnées de notre notaire :</p>

<p class="bold notaire">${esc(notaire.nom)}</p>
<p class="notaire">${esc(notaire.email)}<br/>${esc(notaire.adresse)}<br/>${esc(notaire.tel)}</p>

<div class="footer">
  <p>Dans l'attente de votre retour concernant cette proposition, nous vous prions d'agréer, Madame, Monsieur, l'expression de nos salutations distinguées.</p>
  <p class="bold">Fait à Paris, le ${esc(dateToday)}</p>

  <div class="sig-block">
    <div class="sig-col">
      <div class="sig-label">Signature(s) du/des acheteur(s)</div>
    </div>
    <div class="sig-col">
      <div class="sig-label">Pour Atom Buyers Club</div>
    </div>
  </div>
</div>

</body></html>`;
}

function buildMandatHtml({ lead, project, commission, numero, dateToday }) {
  const adresseProject = project.address || project.title || '—';
  const surface        = project.surface_carrez ? `${project.surface_carrez} m²` : '—';
  const etage          = project.floor ? ordinal(project.floor) : '—';
  const budget         = project.price_fai ? formatPrix(project.price_fai) + ' HAI (honoraires d\'agence inclus)' : '—';

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Times New Roman', Georgia, serif; font-size: 11pt; color: #1a1a1a; background: #fff; padding: 50px 60px; line-height: 1.65; }
  h1 { font-size: 13pt; text-transform: uppercase; text-align: center; margin-bottom: 4px; letter-spacing: .05em; }
  h2 { font-size: 10pt; text-transform: uppercase; text-align: center; color: #555; margin-bottom: 20px; letter-spacing: .04em; }
  .numero { text-align: center; font-size: 10pt; color: #444; margin-bottom: 24px; }
  .loi { text-align: center; font-size: 9pt; color: #666; margin-bottom: 28px; }
  .parties { display: flex; gap: 40px; margin-bottom: 24px; }
  .partie { flex: 1; }
  .partie-label { font-size: 9pt; text-transform: uppercase; letter-spacing: .06em; color: #888; margin-bottom: 6px; }
  .partie-val { font-size: 11pt; }
  section { margin-bottom: 20px; }
  .section-title { font-size: 10pt; text-transform: uppercase; letter-spacing: .06em; font-weight: bold; color: #222; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-bottom: 10px; }
  p { margin-bottom: 10px; }
  ul { margin: 8px 0 10px 20px; }
  li { margin-bottom: 5px; }
  .sig-block { margin-top: 40px; display: flex; justify-content: space-between; }
  .sig-col { width: 46%; }
  .sig-label { font-size: 9.5pt; font-style: italic; margin-bottom: 50px; }
  .sig-name { font-size: 10pt; font-weight: bold; }
  .art { font-size: 9.5pt; color: #555; font-style: italic; border: 1px solid #ddd; padding: 8px 12px; margin-bottom: 10px; }
  @page { size: A4; margin: 0; }
</style></head><body>

<h1>Mandat de Recherche de Biens</h1>
<h2>Signé hors établissement ou à distance</h2>
<div class="numero">Inscrit au Registre des Mandats sous le numéro : <strong>${esc(String(numero))}</strong></div>
<div class="loi">Prévu par la loi 70-9 du 2 Janvier 1970 et par le décret n°72-678 du 20 juillet 1972</div>

<div class="parties">
  <div class="partie">
    <div class="partie-label">Ci-après dénommé "Le Mandant"</div>
    <div class="partie-val">
      <strong>${esc(lead.prenom)} ${esc(lead.nom?.toUpperCase())}</strong><br/>
      ${esc(lead.adresse_residence || '—')}<br/>
      ${lead.date_naissance ? 'Né(e) le ' + esc(fmtDate(lead.date_naissance)) : ''}
    </div>
  </div>
  <div class="partie">
    <div class="partie-label">Ci-après dénommé "Le Mandataire"</div>
    <div class="partie-val">
      <strong>SAS Microsurfaces</strong><br/>
      97 rue de Turenne, 75003 Paris<br/>
      Immatriculée au RCS de Paris sous le n° 937 663 052<br/>
      Carte professionnelle N° CPI 7501 2025 000 000 458 – CCI Paris Île-de-France<br/>
      Garantie Axa France IARD S.A — 150 000 €
    </div>
  </div>
</div>

<section>
  <div class="section-title">Il a été convenu ce qui suit</div>
  <p>Par ces présentes, le Mandant confère au Mandataire qui l'accepte un <strong>MANDAT EXCLUSIF DE RECHERCHER D'UN BIEN</strong> correspondant à la description ci-dessous :</p>
</section>

<section>
  <div class="section-title">Désignation</div>
  <p><strong>Type de bien :</strong> investissement immobilier locatif</p>
  <p><strong>Budget maximum :</strong> ${esc(budget)}</p>
  <p>Un studio situé au <strong>${esc(adresseProject)}</strong> — ${esc(surface)} Carrez — ${esc(etage)} étage</p>
  <p>Et étant précisé qu'à la signature de l'acte authentique, les biens vendus seront libres de toute occupation, location ou réquisition.</p>
</section>

<section>
  <div class="section-title">Durée</div>
  <p>Le présent mandat est consenti pour une durée ferme et irrévocable de trois (3) mois, au terme desquels il se poursuivra par tacite reconduction et expirera irrévocablement à l'issue de douze (12) mois à compter de sa signature.</p>
</section>

<section>
  <div class="section-title">Étendue de la mission</div>
  <p>Le mandat ne se limite pas à une simple recherche. Il encadre l'ensemble de l'intervention du Mandataire sur l'opération :</p>
  <ul>
    <li>le sourcing ciblé d'actif, la négociation du prix avec le vendeur,</li>
    <li>l'analyse du dossier et l'accompagnement jusqu'à la signature chez le notaire,</li>
    <li>la conception d'un projet sur-mesure et la modélisation architecturale (plans, 3D, projections),</li>
    <li>la consultation d'entreprises partenaires &amp; le suivi de chantier,</li>
    <li>la livraison clé en main du bien rénové.</li>
  </ul>
</section>

<section>
  <div class="section-title">Révocation en cours de tacite reconduction</div>
  <p>Passée la période ferme et irrévocable de trois mois, le mandat pourra être dénoncé à tout moment par chacune des parties, à charge pour celle qui entend y mettre fin d'en aviser l'autre partie quinze jours à l'avance par lettre recommandée avec avis de réception.</p>
  <div class="art">Art. 78 du décret du 20 juillet 1972 — « Passé un délai de trois mois à compter de sa signature, le mandat contenant une telle clause peut être dénoncé à tout moment par chacune des parties, à charge pour celle qui entend y mettre fin d'en aviser l'autre partie quinze jours au moins à l'avance par lettre recommandée avec demande d'avis de réception. »</div>
</section>

<section>
  <div class="section-title">Obligations du Mandant et clause pénale</div>
  <p>Le Mandant s'engage :</p>
  <ul>
    <li>à ne pas révoquer le mandat pendant la première période irrévocable,</li>
    <li>à ne pas conclure l'affaire pendant la durée du mandat, directement avec le vendeur propriétaire du bien présenté par le mandataire,</li>
    <li>à ne pas négocier directement ou par l'intermédiaire d'une autre agence pendant la durée du mandat,</li>
    <li>à ne pas conclure l'affaire, même après l'expiration du mandat et ce pendant une durée d'un an, avec le propriétaire du bien présenté par le Mandataire,</li>
    <li>à ratifier l'acquisition du bien présenté par le mandataire au prix, charges et conditions du présent mandat si le bien est parfaitement identifié et individualisé dans les présentes.</li>
  </ul>
  <p>À défaut de respecter une seule des obligations énoncées ci-dessus, le Mandant devra au Mandataire une indemnité forfaitaire de dommages et intérêts d'un montant égal à celui des honoraires prévus au mandat.</p>
</section>

<section>
  <div class="section-title">Obligations du Mandataire</div>
  <p>Le Mandataire s'engage à mettre en œuvre tous les moyens humains et commerciaux dont il dispose pour parvenir à la vente, à rendre compte de l'exécution de sa mission chaque fois que le Mandant le souhaitera et, en tout état de cause, dans les huit jours suivant son accomplissement.</p>
</section>

<section>
  <div class="section-title">Rémunération</div>
  <p>Dans le cas où le Mandant viendrait à se porter acquéreur d'un des biens recherchés et proposés par le Mandataire, ce dernier aura droit à une rémunération fixée à <strong>${esc(formatPrix(commission))} TTC (${esc(commissionEnLettres(commission))} Toutes Taxes Comprises)</strong> à la charge du mandant.</p>
  <p>Cette rémunération sera exigible le jour où l'opération sera effectivement conclue et constatée dans un acte écrit.</p>
  <p>Dans le cas où le Mandant ne se porterait pas acquéreur d'un des biens proposés par le Mandataire au prix et conditions du mandat, aucune rémunération ne lui serait due.</p>
</section>

<section>
  <p>Fait en deux originaux dont l'un a été remis au Mandant qui le reconnaît et dont l'autre est conservé par le Mandataire, par dérogation aux dispositions de l'article 2004 du Code Civil.</p>
</section>

<div class="sig-block">
  <div class="sig-col">
    <div class="sig-name">Le Mandant</div>
    <div class="sig-label">« lu et approuvé, bon pour mandat »</div>
    <p>À Paris, le ${esc(dateToday)}</p>
  </div>
  <div class="sig-col">
    <div class="sig-name">Le Mandataire — SAS Microsurfaces</div>
    <div class="sig-label">« lu et approuvé, mandat accepté »</div>
    <p>À Paris, le ${esc(dateToday)}</p>
  </div>
</div>

</body></html>`;
}

function commissionEnLettres(n) {
  const map = { 8900: 'Huit mille neuf cent euros', 9000: 'Neuf mille euros', 7500: 'Sept mille cinq cents euros' };
  return map[n] || `${Number(n).toLocaleString('fr-FR')} euros`;
}

// ── PDF rendering (Puppeteer) ──────────────────────────────────────────────

async function renderPdf(html) {
  const { default: puppeteer } = await import('puppeteer-core');
  const { default: chromium }  = await import('@sparticuz/chromium');
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 794, height: 1123 },
    executablePath: await chromium.executablePath(),
    headless: true,
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
  const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  await browser.close();
  return pdf;
}

// ── Upload PDF to Supabase storage ─────────────────────────────────────────

async function uploadPdf(pdfBuffer, path) {
  const { data, error } = await supabase.storage.from('offer-docs').upload(path, pdfBuffer, {
    contentType: 'application/pdf', upsert: true,
  });
  if (error) throw new Error('storage upload: ' + error.message);
  const { data: { publicUrl } } = supabase.storage.from('offer-docs').getPublicUrl(path);
  return publicUrl;
}

// ── Handler ────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  // ── GET ?registry=mandats|acquereurs : onglet Assets ─────────────────
  if (req.method === 'GET' && req.query.registry) {
    return handleRegistry(req, res);
  }

  // ── GET : statut courant ─────────────────────────────────────────────
  if (req.method === 'GET') {
    const { interest_id } = req.query;
    if (!interest_id) return res.status(400).json({ error: 'interest_id requis' });
    const { data: ev } = await supabase.from('lead_events').select('id, content, lead_id').eq('id', interest_id).maybeSingle();
    if (!ev) return res.status(404).json({ error: 'not_found' });
    let content = {};
    try { content = ev.content ? (typeof ev.content === 'string' ? JSON.parse(ev.content) : ev.content) : {}; } catch {}
    const { data: mandat } = await supabase.from('mandats').select('*').eq('interest_event_id', interest_id).maybeSingle();
    return res.status(200).json({ ok: true, content, mandat: mandat || null });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { action, interest_id } = b;

  // ── action: notaire_recap ── envoi du dossier de vente au clerc de notaire ──
  // Prend mandat_id (pas interest_id) → traité avant le contrôle ci-dessous.
  if (action === 'notaire_recap')     return handleNotaireRecap(req, res, b, payload);
  if (action === 'mandat_update')     return handleMandatUpdate(req, res, b, payload);
  if (action === 'deverser_registre') return handleDeverserRegistre(req, res, b, payload);
  if (action === 'mandat_doc')        return handleMandatDoc(req, res, b, payload);
  if (action === 'mandat_doc_url')    return handleMandatDocUrl(req, res, b, payload);
  if (action === 'mandat_doc_set')    return handleMandatDocSet(req, res, b, payload);
  if (action === 'mandat_doc_delete') return handleMandatDocDelete(req, res, b, payload);

  if (!action || !interest_id) return res.status(400).json({ error: 'action et interest_id requis' });

  // Charger l'événement
  const { data: ev, error: evErr } = await supabase
    .from('lead_events').select('id, content, lead_id, type').eq('id', interest_id).maybeSingle();
  if (evErr || !ev) return res.status(404).json({ error: 'intérêt introuvable' });

  let content = {};
  try { content = ev.content ? (typeof ev.content === 'string' ? JSON.parse(ev.content) : ev.content) : {}; } catch {}

  // Charger lead + projet
  const { data: lead } = await supabase
    .from('leads').select('id, prenom, nom, email, date_naissance, adresse_residence, situation_familiale, conjoint_prenom, conjoint_nom, conjoint_dob, achat_structure, infos_token')
    .eq('id', ev.lead_id).maybeSingle();
  if (!lead) return res.status(404).json({ error: 'lead introuvable' });

  const projectId = b.project_id || content.project_id;
  let project = null;
  if (projectId) {
    const { data: p } = await supabase.from('projects').select('*').eq('id', projectId).maybeSingle();
    project = p;
  }

  // ── action: link ──────────────────────────────────────────────────────
  if (action === 'link') {
    let token = lead.infos_token;
    if (!token) {
      token = crypto.randomBytes(16).toString('hex');
      await supabase.from('leads').update({ infos_token: token }).eq('id', lead.id);
    }
    const site = (process.env.SITE_URL || 'https://join.atombuyerclub.fr').replace(/\/$/, '');
    return res.status(200).json({ ok: true, url: `${site}/info-acheteur?token=${token}` });
  }

  // ── action: wa_contact ── relance WhatsApp → "en attente de visite" ───
  // L'admin qui relance devient responsable du lead.
  if (action === 'wa_contact') {
    const newContent = {
      ...content,
      wa_contacted_at: new Date().toISOString(),
      wa_contacted_by: payload.email,
    };
    await supabase.from('lead_events').update({ content: newContent }).eq('id', interest_id);
    await supabase.from('leads').update({ assigned_to: payload.email }).eq('id', ev.lead_id);
    return res.status(200).json({ ok: true, content: newContent, assigned_to: payload.email });
  }

  // ── action: visit ─────────────────────────────────────────────────────
  if (action === 'visit') {
    let newContent;
    if (b.remove) {
      const { visited, visited_at, visited_by, visit_conclusive, sans_suite, treated, wa_contacted_at, wa_contacted_by, ...rest } = content;
      newContent = rest;
    } else if (b.sans_suite) {
      const { visited, visited_at, visited_by, visit_conclusive, ...rest } = content;
      newContent = { ...rest, sans_suite: true, treated: true };
    } else {
      const { sans_suite, ...rest } = content;
      newContent = {
        ...rest,
        visited: true,
        visit_conclusive: b.visit_conclusive !== undefined ? !!b.visit_conclusive : true,
        visited_at: new Date().toISOString(),
        visited_by: payload.email,
      };
    }
    await supabase.from('lead_events').update({ content: newContent }).eq('id', interest_id);
    return res.status(200).json({ ok: true, content: newContent });
  }

  // ── action: offer ─────────────────────────────────────────────────────
  if (action === 'offer') {
    // Backstop : les infos acheteur sont désormais saisies par l'admin dans le modal
    if (!lead.date_naissance || !lead.adresse_residence) {
      return res.status(422).json({ ok: false, error: 'infos_manquantes' });
    }
    if (!project) return res.status(400).json({ error: 'project_id requis pour générer une offre' });

    const notaire = {
      nom:     b.notaire_nom     || 'Maître Nicolas Chauris',
      email:   b.notaire_email   || 'nicolas.chauris@notaires.fr',
      adresse: b.notaire_adresse || '40 Avenue des Chartreux, 13004 Marseille',
      tel:     b.notaire_tel     || '04 91 78 94 34',
    };
    const prix         = b.prix || project.price_fai || 0;
    const dateToday    = todayFr();
    const conditionPret = b.condition_pret || 'avec';

    const html = buildOfferHtml({ lead, project, prix, notaire, dateToday, conditionPret });
    const pdf  = await renderPdf(html);

    const pdfPath = `${lead.id}/offre-${Date.now()}.pdf`;
    const pdfUrl  = await uploadPdf(pdf, pdfPath);

    // Créer ou mettre à jour le mandat
    const existing = await supabase.from('mandats').select('id').eq('interest_event_id', interest_id).maybeSingle();
    let mandatId;
    if (existing.data?.id) {
      mandatId = existing.data.id;
      await supabase.from('mandats').update({ offre_pdf_url: pdfUrl, prix_offre: prix, statut: 'offre_envoyee', notaire_nom: notaire.nom, notaire_email: notaire.email, notaire_adresse: notaire.adresse, notaire_tel: notaire.tel, created_by: payload.email }).eq('id', mandatId);
    } else {
      const { data: m } = await supabase.from('mandats').insert([{ lead_id: lead.id, project_id: projectId, interest_event_id: interest_id, commission: 8900, prix_offre: prix, notaire_nom: notaire.nom, notaire_email: notaire.email, notaire_adresse: notaire.adresse, notaire_tel: notaire.tel, offre_pdf_url: pdfUrl, statut: 'offre_envoyee', created_by: payload.email }]).select('id').single();
      mandatId = m?.id;
    }
    await upsertGeneratedDoc(mandatId, 'offre', pdfUrl, "Offre d'achat (générée).pdf");

    const delivery = b.delivery || 'email';
    let offerEmailed = false;
    if (delivery !== 'download' && lead.email && process.env.RESEND_API_KEY) {
      const resend  = new Resend(process.env.RESEND_API_KEY);
      const from    = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
      const founder = getFounder(payload.email);
      const subject = `Offre d'achat — ${project.address || project.title}`;
      await resend.emails.send({
        from,
        replyTo: associateEmails(),
        to: [lead.email],
        cc: [payload.email],
        subject,
        html: `<p>Bonjour ${esc(lead.prenom)},</p>
<p>Veuillez trouver ci-joint votre offre d'achat pour le bien situé au <strong>${esc(project.address || project.title)}</strong>.</p>
<p>Après avoir pris connaissance de ce document, merci de nous le retourner signé.</p>
<p>Bien à vous,<br/><strong>${esc(founder.name)}</strong><br/>Atom Buyers Club</p>`,
        attachments: [{ filename: `Offre-achat-${(project.address || project.title || '').replace(/[^a-z0-9]/gi, '-').slice(0, 40)}.pdf`, content: Buffer.from(pdf).toString('base64') }],
      });
      offerEmailed = true;
    }

    // Mettre à jour le content de l'événement (emailed_at seulement si un mail est parti)
    const newContent = {
      ...content,
      offer_sent_at: new Date().toISOString(),
      offer_sent_by: payload.email,
      mandat_id: mandatId,
      ...(offerEmailed ? { offer_emailed_at: new Date().toISOString() } : {}),
    };
    await supabase.from('lead_events').update({ content: newContent }).eq('id', interest_id);

    return res.status(200).json({ ok: true, mandat_id: mandatId, pdf_url: pdfUrl, emailed: offerEmailed });
  }

  // ── action: offer_resend ──────────────────────────────────────────────
  if (action === 'offer_resend') {
    const { data: m } = await supabase.from('mandats').select('offre_pdf_url').eq('interest_event_id', interest_id).maybeSingle();
    if (!m?.offre_pdf_url) return res.status(404).json({ error: 'offre_non_generee' });
    if (lead.email && process.env.RESEND_API_KEY) {
      const pdfBuf = await fetch(m.offre_pdf_url).then(r => r.arrayBuffer()).then(ab => Buffer.from(ab));
      const resend  = new Resend(process.env.RESEND_API_KEY);
      const from    = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
      const founder = getFounder(payload.email);
      await resend.emails.send({
        from, replyTo: associateEmails(), to: [lead.email], cc: [payload.email],
        subject: `Offre d'achat — ${project?.address || project?.title || ''}`,
        html: `<p>Bonjour ${esc(lead.prenom)},</p><p>Veuillez trouver ci-joint votre offre d'achat.</p><p>Bien à vous,<br/><strong>${esc(founder.name)}</strong><br/>Atom Buyers Club</p>`,
        attachments: [{ filename: 'Offre-achat.pdf', content: pdfBuf.toString('base64') }],
      });
      const newContent = { ...content, offer_emailed_at: new Date().toISOString() };
      await supabase.from('lead_events').update({ content: newContent }).eq('id', interest_id);
      return res.status(200).json({ ok: true, content: newContent });
    }
    return res.status(200).json({ ok: true });
  }

  // ── action: mandat_resend ─────────────────────────────────────────────
  if (action === 'mandat_resend') {
    const { data: m } = await supabase.from('mandats').select('mandat_pdf_url').eq('interest_event_id', interest_id).maybeSingle();
    if (!m?.mandat_pdf_url) return res.status(404).json({ error: 'mandat_non_genere' });
    if (lead.email && process.env.RESEND_API_KEY) {
      const pdfBuf = await fetch(m.mandat_pdf_url).then(r => r.arrayBuffer()).then(ab => Buffer.from(ab));
      const resend  = new Resend(process.env.RESEND_API_KEY);
      const from    = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
      const founder = getFounder(payload.email);
      await resend.emails.send({
        from, replyTo: associateEmails(), to: [lead.email], cc: [payload.email],
        subject: 'Mandat de recherche — Atom Buyers Club',
        html: `<p>Bonjour ${esc(lead.prenom)},</p><p>Veuillez trouver ci-joint votre mandat de recherche à signer.</p><p>Bien à vous,<br/><strong>${esc(founder.name)}</strong><br/>Atom Buyers Club</p>`,
        attachments: [{ filename: 'Mandat-recherche.pdf', content: pdfBuf.toString('base64') }],
      });
      const newContent = { ...content, mandat_emailed_at: new Date().toISOString() };
      await supabase.from('lead_events').update({ content: newContent }).eq('id', interest_id);
      return res.status(200).json({ ok: true, content: newContent });
    }
    return res.status(200).json({ ok: true });
  }

  // ── action: mandat ────────────────────────────────────────────────────
  if (action === 'mandat') {
    try {
      // Backstop : les infos acheteur sont désormais saisies par l'admin dans le modal
      if (!lead.date_naissance || !lead.adresse_residence) {
        return res.status(422).json({ ok: false, error: 'infos_manquantes' });
      }

      // Récupérer ou créer le mandat (doit exister après l'étape offre)
      let mandatRow;
      const { data: existing, error: existErr } = await supabase.from('mandats').select('*').eq('interest_event_id', interest_id).maybeSingle();
      if (existErr) { console.error('mandat lookup:', existErr); return res.status(500).json({ ok: false, error: existErr.message }); }

      if (existing) {
        mandatRow = existing;
      } else {
        // project_id fallback : content → b.project_id (déjà dans projectId)
        const mandatProjectId = projectId || null;
        if (!mandatProjectId) return res.status(400).json({ ok: false, error: 'project_id requis pour générer un mandat' });

        const { data: m, error: insertErr } = await supabase.from('mandats')
          .insert([{ lead_id: lead.id, project_id: mandatProjectId, interest_event_id: interest_id, commission: b.commission || 8900, created_by: payload.email }])
          .select('*').single();
        if (insertErr || !m) {
          console.error('mandat insert:', insertErr);
          return res.status(500).json({ ok: false, error: insertErr?.message || 'Impossible de créer le mandat' });
        }
        mandatRow = m;
      }

      // Résoudre le projet depuis le mandat existant si besoin
      let proj = project;
      if (!proj && mandatRow.project_id) {
        const { data: p } = await supabase.from('projects').select('*').eq('id', mandatRow.project_id).maybeSingle();
        proj = p;
      }
      if (!proj) return res.status(400).json({ ok: false, error: 'Projet introuvable pour ce mandat' });

      const commission = b.commission || mandatRow?.commission || 8900;
      const dateToday  = todayFr();

      // Génération du mandat = entrée au registre : on attribue le n° de registre
      // (suite de la numérotation, plancher 160) s'il n'en a pas déjà un. Ce numéro
      // est celui imprimé sur le PDF — pas l'id série interne.
      let registreNumero = mandatRow?.registre_numero;
      if (!registreNumero) {
        const { data: top } = await supabase.from('mandats').select('registre_numero')
          .not('registre_numero', 'is', null).order('registre_numero', { ascending: false }).limit(1).maybeSingle();
        registreNumero = Math.max(160, (top?.registre_numero || 159) + 1);
      }

      const html = buildMandatHtml({ lead, project: proj, commission, numero: registreNumero, dateToday });
      const pdf  = await renderPdf(html);

      const pdfPath = `${lead.id}/mandat-${Date.now()}.pdf`;
      const pdfUrl  = await uploadPdf(pdf, pdfPath);

      await supabase.from('mandats').update({
        mandat_pdf_url: pdfUrl, commission, statut: 'mandat_envoye',
        registre_numero: registreNumero, registre_at: mandatRow?.registre_at || new Date().toISOString(),
      }).eq('id', mandatRow.id);
      await upsertGeneratedDoc(mandatRow.id, 'mandat', pdfUrl, `Mandat n°${registreNumero} (généré).pdf`);

      const mandatDelivery = b.delivery || 'email';
      const fileName = `Mandat-${(proj.address || proj.title || '').replace(/[^a-z0-9]/gi, '-').slice(0, 40)}.pdf`;

      let envelopeId = null;
      if (mandatDelivery !== 'download') {
        envelopeId = await createDocuSignEnvelope({ pdfBuffer: pdf, fileName, lead, mandatId: mandatRow.id });
        if (envelopeId) {
          await supabase.from('mandats').update({ docusign_envelope_id: envelopeId }).eq('id', mandatRow.id);
        } else if (lead.email && process.env.RESEND_API_KEY) {
          const resend  = new Resend(process.env.RESEND_API_KEY);
          const from    = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
          const founder = getFounder(payload.email);
          await resend.emails.send({
            from, replyTo: associateEmails(), to: [lead.email], cc: [payload.email],
            subject: `Mandat de recherche — Atom Buyers Club`,
            html: `<p>Bonjour ${esc(lead.prenom)},</p>
<p>Veuillez trouver ci-joint votre mandat de recherche à signer et nous retourner.</p>
<p>Bien à vous,<br/><strong>${esc(founder.name)}</strong><br/>Atom Buyers Club</p>`,
            attachments: [{ filename: fileName, content: Buffer.from(pdf).toString('base64') }],
          });
        }
      }

      const newContent = {
        ...content,
        mandat_sent_at: new Date().toISOString(),
        mandat_sent_by: payload.email,
        registre_numero: registreNumero,
        ...(mandatDelivery !== 'download' ? { mandat_emailed_at: new Date().toISOString() } : {}),
      };
      await supabase.from('lead_events').update({ content: newContent }).eq('id', interest_id);

      return res.status(200).json({ ok: true, mandat_id: mandatRow.id, pdf_url: pdfUrl, registre_numero: registreNumero, docusign: !!envelopeId, emailed: mandatDelivery !== 'download' });
    } catch (err) {
      console.error('mandat action error:', err);
      return res.status(500).json({ ok: false, error: err.message || 'Erreur serveur mandat' });
    }
  }

  return res.status(400).json({ error: 'action inconnue' });
};

// ── Onglet Assets : registres (mandats / acquéreurs) ────────────────────────
async function handleRegistry(req, res) {
  const which = req.query.registry;

  const FULL = 'id, numero, registre_numero, registre_at, statut, etat, source, commission, prix_offre, prix_hai, offre_pdf_url, mandat_pdf_url, promesse_pdf_url, acte_pdf_url, facture_pdf_url, docusign_envelope_id, date_mandat, date_fin_mandat, type_mandat, commission_partie, nature_bien, adresse_num, adresse_rue, adresse_cp, adresse_ville, mandant_domiciliation, mandant_sci, date_promesse, delai_realisation, fees_paid, dossier_notaire_envoye, notaire_nom, notaire_email, notaire_adresse, notaire_tel, created_by, created_at, lead:leads(id, prenom, nom, email, tel, date_naissance, adresse_residence, situation_familiale, conjoint_prenom, conjoint_nom, conjoint_dob, achat_structure, nom_structure, pj_identite_url), project:projects(id, title, address, arrondissement, surface_carrez, floor)';

  if (which === 'mandats') {
    // Registre = mandats déversés (registre_numero NOT NULL), triés par n° décroissant.
    const { data, error } = await supabase
      .from('mandats').select(FULL)
      .not('registre_numero', 'is', null)
      .order('registre_numero', { ascending: false })
      .limit(3000);
    if (error) { console.error('[registry mandats]', error); return res.status(500).json({ error: 'db_error' }); }
    await attachDocs(data);
    return res.status(200).json({ ok: true, mandats: data || [] });
  }

  if (which === 'acquereurs') {
    // Acquéreurs = tous les dossiers rattachés à un lead (déversés ou non).
    const { data, error } = await supabase
      .from('mandats').select(FULL)
      .not('lead_id', 'is', null)
      .order('registre_numero', { ascending: false, nullsFirst: true })
      .order('created_at', { ascending: false })
      .limit(3000);
    if (error) { console.error('[registry acquereurs]', error); return res.status(500).json({ error: 'db_error' }); }
    await attachDocs(data);
    return res.status(200).json({ ok: true, acquereurs: data || [] });
  }

  return res.status(400).json({ error: 'registry inconnu' });
}

// Enregistre le document généré (offre/mandat) comme fichier listé, remplaçable
// à chaque régénération (pas de doublon). uploaded_by='system:generated' = marqueur.
async function upsertGeneratedDoc(mandatId, kind, url, filename) {
  if (!mandatId || !url) return;
  await supabase.from('mandat_documents').delete().eq('mandat_id', mandatId).eq('kind', kind).eq('uploaded_by', 'system:generated');
  await supabase.from('mandat_documents').insert([{ mandat_id: mandatId, kind, url, filename, uploaded_by: 'system:generated' }]);
}

// Attache la liste des documents uploadés (table mandat_documents) à chaque mandat.
async function attachDocs(rows) {
  if (!rows || !rows.length) return;
  const ids = rows.map(r => r.id);
  const { data: docs } = await supabase
    .from('mandat_documents').select('id, mandat_id, kind, url, filename, size_bytes, created_at')
    .in('mandat_id', ids).order('created_at', { ascending: true });
  const byMandat = {};
  for (const d of (docs || [])) (byMandat[d.mandat_id] = byMandat[d.mandat_id] || []).push(d);
  for (const r of rows) r.documents = byMandat[r.id] || [];
}

// ── Envoi du dossier de vente au clerc de notaire (Linda) ───────────────────
const NOTAIRE_CLERC_EMAIL = process.env.NOTAIRE_CLERC_EMAIL || 'linda.rebib.13190@notaires.fr';

async function handleNotaireRecap(req, res, b, payload) {
  if (!b.mandat_id) return res.status(400).json({ error: 'mandat_id requis' });
  if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'email_non_configure' });

  const { data: m, error } = await supabase
    .from('mandats')
    .select('*, lead:leads(id, prenom, nom, email, tel, date_naissance, adresse_residence, situation_familiale, conjoint_prenom, conjoint_nom, conjoint_dob, achat_structure, nom_structure, pj_identite_url), project:projects(id, title, address, arrondissement, surface_carrez, floor)')
    .eq('id', b.mandat_id).maybeSingle();
  if (error || !m) return res.status(404).json({ error: 'mandat_introuvable' });

  const lead = m.lead || {};
  const proj = m.project || {};

  if (!m.offre_pdf_url || !m.mandat_pdf_url) {
    return res.status(422).json({ error: 'documents_manquants', detail: 'offre et mandat requis avant envoi notaire' });
  }

  // ── Pièces jointes : offre + mandat + copie ID (si dispo) ──
  const attachments = [];
  const grab = async (url, filename) => {
    try {
      const buf = await fetch(url).then(r => r.arrayBuffer()).then(ab => Buffer.from(ab));
      attachments.push({ filename, content: buf.toString('base64') });
      return true;
    } catch (e) { console.error('[notaire_recap] fetch PJ échec', filename, e?.message || e); return false; }
  };
  const safeName = (proj.address || proj.title || `${lead.prenom}-${lead.nom}` || 'dossier').replace(/[^a-z0-9]/gi, '-').slice(0, 40);
  await grab(m.offre_pdf_url,  `Offre-achat-${safeName}.pdf`);
  await grab(m.mandat_pdf_url, `Mandat-recherche-${safeName}.pdf`);
  let idJoined = false;
  if (lead.pj_identite_url) {
    const ext = (lead.pj_identite_url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [, 'jpg'])[1].toLowerCase();
    idJoined = await grab(lead.pj_identite_url, `Piece-identite-${safeName}.${ext}`);
  }

  const founder = getFounder(payload.email);
  // CC = associés fondateurs, hors Melina (staff) et hors le destinataire
  const NOTAIRE_CC_EXCLUDE = ['melina.cabral@atom-capital.fr'];
  const ccList  = allFounderEmails().filter(e => e !== NOTAIRE_CLERC_EMAIL && !NOTAIRE_CC_EXCLUDE.includes(e.toLowerCase()));
  const from    = process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
  const subject = `Nouveau dossier de vente — ${esc(lead.prenom || '')} ${esc((lead.nom || '').toUpperCase())} · ${esc(proj.address || proj.title || '')}`;

  const r = (label, val) => val ? `<tr><td style="padding:6px 16px 6px 0;color:#888;font-size:13px;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:6px 0;font-size:14px;color:#111">${val}</td></tr>` : '';
  const structureLabel = { personnel: 'En nom propre', sci: `SCI${lead.nom_structure ? ' ' + esc(lead.nom_structure) : ''}`, sas: `SAS${lead.nom_structure ? ' ' + esc(lead.nom_structure) : ''}` }[lead.achat_structure] || '—';
  const conjoint = (lead.situation_familiale === 'marie' || lead.situation_familiale === 'pacse') && lead.conjoint_prenom
    ? `${esc(lead.conjoint_prenom)} ${esc((lead.conjoint_nom || '').toUpperCase())}${lead.conjoint_dob ? ' (né·e le ' + fmtDate(lead.conjoint_dob) + ')' : ''}` : '';

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:system-ui,sans-serif">
  <div style="max-width:600px;margin:24px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e5">
    <div style="background:#0f0e0c;padding:24px 28px">
      <p style="margin:0 0 8px;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#B8975A">Atom Buyers Club · Dossier de vente</p>
      <h1 style="margin:0;font-size:20px;font-weight:400;color:#F5F2ED">${esc(lead.prenom || '')} ${esc((lead.nom || '').toUpperCase())}</h1>
      <p style="margin:6px 0 0;font-size:13px;color:#B8975A">Mandat n° ${esc(String(m.registre_numero ?? m.numero ?? '—'))}</p>
    </div>
    <div style="padding:22px 28px">
      <p style="margin:0 0 16px;font-size:14px;color:#333;line-height:1.6">Bonjour Linda,<br/>Veuillez trouver ci-joint le dossier de vente complet pour l'acquéreur ci-dessous. Les pièces (offre d'achat, mandat de recherche${idJoined ? ', copie pièce d\'identité' : ''}) sont jointes à ce message.</p>

      <p style="margin:18px 0 6px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#B8975A">Acquéreur</p>
      <table style="width:100%;border-collapse:collapse">
        ${r('Nom', `<strong>${esc(lead.prenom || '')} ${esc((lead.nom || '').toUpperCase())}</strong>`)}
        ${r('Né·e le', lead.date_naissance ? fmtDate(lead.date_naissance) : '')}
        ${r('Adresse', esc(lead.adresse_residence || ''))}
        ${r('Email', lead.email ? `<a href="mailto:${esc(lead.email)}" style="color:#B8975A">${esc(lead.email)}</a>` : '')}
        ${r('Téléphone', esc(lead.tel || ''))}
        ${r('Acquisition', structureLabel)}
        ${r('Co-acquéreur', conjoint)}
      </table>

      <p style="margin:18px 0 6px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#B8975A">Bien</p>
      <table style="width:100%;border-collapse:collapse">
        ${r('Adresse', esc(proj.address || proj.title || ''))}
        ${r('Surface', proj.surface_carrez ? proj.surface_carrez + ' m² Carrez' : '')}
        ${r('Étage', proj.floor ? ordinal(proj.floor) + ' étage' : '')}
        ${r('Prix d\'offre', formatPrix(m.prix_offre))}
        ${r('Honoraires Atom', formatPrix(m.commission))}
      </table>

      <p style="margin:18px 0 6px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#B8975A">Notaire confrère (acquéreur)</p>
      <table style="width:100%;border-collapse:collapse">
        ${r('Étude', esc(m.notaire_nom || ''))}
        ${r('Email', m.notaire_email ? `<a href="mailto:${esc(m.notaire_email)}" style="color:#B8975A">${esc(m.notaire_email)}</a>` : '')}
        ${r('Adresse', esc(m.notaire_adresse || ''))}
        ${r('Téléphone', esc(m.notaire_tel || ''))}
      </table>

      <p style="margin:18px 0 6px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#B8975A">Agence mandataire</p>
      <table style="width:100%;border-collapse:collapse">
        ${r('Raison sociale', 'SAS Microsurfaces (Atom Buyers Club)')}
        ${r('Siège', '97 rue de Turenne, 75003 Paris')}
        ${r('RCS', 'Paris 937 663 052')}
        ${r('Carte pro.', 'CPI 7501 2025 000 000 458 — CCI Paris Île-de-France')}
        ${r('Contact', `${esc(founder.name || payload.email)}${founder.phone ? ' · ' + esc(founder.phone) : ''}`)}
      </table>

      <p style="margin:22px 0 0;font-size:13px;color:#555;line-height:1.6">Bien cordialement,<br/><strong style="color:#111">${esc(founder.name || 'Atom Buyers Club')}</strong><br/>Atom Buyers Club</p>
    </div>
  </div></body></html>`;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({ from, replyTo: payload.email, to: [NOTAIRE_CLERC_EMAIL], cc: ccList, subject, html, attachments });
  } catch (e) {
    console.error('[notaire_recap] envoi échec', e?.message || e);
    return res.status(500).json({ error: 'envoi_echoue', detail: e?.message || String(e) });
  }

  // Envoi réussi → coche automatiquement "Dossier envoyé au notaire"
  await supabase.from('mandats').update({ dossier_notaire_envoye: true }).eq('id', b.mandat_id);

  // Trace dans la timeline du lead
  if (lead.id) {
    await supabase.from('lead_events').insert([{
      lead_id: lead.id, type: 'note',
      content: `Dossier de vente envoyé au notaire (${NOTAIRE_CLERC_EMAIL}) — mandat n°${m.registre_numero ?? m.numero ?? '—'}, ${attachments.length} PJ`,
      author: payload.email,
    }]);
  }

  return res.status(200).json({ ok: true, sent_to: NOTAIRE_CLERC_EMAIL, cc: ccList, attachments: attachments.length, id_joined: idJoined, dossier_notaire_envoye: true });
}

// ── action: mandat_update ── édition d'un mandat + infos mandant ────────────
const MANDAT_FIELDS = ['etat','statut','fees_paid','dossier_notaire_envoye','prix_hai','prix_offre','commission','nature_bien','adresse_num','adresse_rue','adresse_cp','adresse_ville','type_mandat','commission_partie','delai_realisation','mandant_domiciliation','mandant_sci','notaire_nom','notaire_email','notaire_adresse','notaire_tel'];
const MANDAT_DATE_FIELDS = ['date_mandat','date_fin_mandat','date_promesse'];
const LEAD_FIELDS = ['prenom','nom','email','tel','adresse_residence','date_naissance','situation_familiale','conjoint_prenom','conjoint_nom','conjoint_dob','achat_structure','nom_structure'];

async function handleMandatUpdate(req, res, b, payload) {
  if (!b.mandat_id) return res.status(400).json({ error: 'mandat_id requis' });
  const { data: m } = await supabase.from('mandats').select('id, lead_id').eq('id', b.mandat_id).maybeSingle();
  if (!m) return res.status(404).json({ error: 'mandat_introuvable' });

  const patch = {};
  for (const k of MANDAT_FIELDS)      if (k in b) patch[k] = b[k] === '' ? null : b[k];
  for (const k of MANDAT_DATE_FIELDS) if (k in b) patch[k] = b[k] || null;
  if (Object.keys(patch).length) {
    const { error } = await supabase.from('mandats').update(patch).eq('id', b.mandat_id);
    if (error) return res.status(500).json({ error: 'db_error', detail: error.message });
  }

  // Édition des coordonnées du mandant (lead lié)
  if (b.lead && m.lead_id) {
    const lp = {};
    for (const k of LEAD_FIELDS) if (k in b.lead) lp[k] = b.lead[k] === '' ? null : b.lead[k];
    if (Object.keys(lp).length) await supabase.from('leads').update(lp).eq('id', m.lead_id);
  }
  return res.status(200).json({ ok: true });
}

// ── action: deverser_registre ── attribue le numéro de registre (CTA) ───────
async function handleDeverserRegistre(req, res, b, payload) {
  if (!b.mandat_id) return res.status(400).json({ error: 'mandat_id requis' });
  const { data: m } = await supabase.from('mandats').select('id, registre_numero, interest_event_id').eq('id', b.mandat_id).maybeSingle();
  if (!m) return res.status(404).json({ error: 'mandat_introuvable' });
  if (m.registre_numero) return res.status(200).json({ ok: true, registre_numero: m.registre_numero, already: true });

  // Prochain numéro = max(registre_numero)+1, plancher 160
  const { data: top } = await supabase.from('mandats').select('registre_numero')
    .not('registre_numero', 'is', null).order('registre_numero', { ascending: false }).limit(1).maybeSingle();
  const next = Math.max(160, (top?.registre_numero || 159) + 1);

  const { error } = await supabase.from('mandats')
    .update({ registre_numero: next, registre_at: new Date().toISOString() }).eq('id', b.mandat_id);
  if (error) return res.status(500).json({ error: 'db_error', detail: error.message });

  // Persiste le n° dans l'événement d'intérêt lié (pour l'affichage onglet Intérêts)
  if (m.interest_event_id) {
    const { data: ev } = await supabase.from('lead_events').select('content').eq('id', m.interest_event_id).maybeSingle();
    if (ev) {
      let c = {}; try { c = ev.content ? (typeof ev.content === 'string' ? JSON.parse(ev.content) : ev.content) : {}; } catch {}
      await supabase.from('lead_events').update({ content: { ...c, registre_numero: next } }).eq('id', m.interest_event_id);
    }
  }
  return res.status(200).json({ ok: true, registre_numero: next });
}

// ── action: mandat_doc ── upload de tout document du dossier ─────────────────
// kinds mandats : offre | mandat | promesse | acte  → bucket offer-docs
// kind lead     : identite                          → bucket buyer-docs (leads.pj_identite_url)
const DOC_COL = { offre: 'offre_pdf_url', mandat: 'mandat_pdf_url', promesse: 'promesse_pdf_url', acte: 'acte_pdf_url', facture: 'facture_pdf_url' };
async function handleMandatDoc(req, res, b, payload) {
  if (!b.mandat_id || !b.kind || !b.content) return res.status(400).json({ error: 'mandat_id, kind, content requis' });
  if (b.kind !== 'identite' && !DOC_COL[b.kind]) return res.status(400).json({ error: 'kind invalide' });
  const { data: m } = await supabase.from('mandats').select('id, lead_id').eq('id', b.mandat_id).maybeSingle();
  if (!m) return res.status(404).json({ error: 'mandat_introuvable' });

  try {
    const buf = Buffer.from(String(b.content).replace(/^data:[^,]+,/, ''), 'base64');
    const ext = (String(b.filename || '').match(/\.([a-z0-9]{2,5})$/i) || [, 'pdf'])[1].toLowerCase();
    const owner = m.lead_id || m.id;

    if (b.kind === 'identite') {
      if (!m.lead_id) return res.status(400).json({ error: 'lead_absent' });
      const path = `${owner}/identite-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('buyer-docs').upload(path, buf, { contentType: b.mime || 'application/octet-stream', upsert: true });
      if (upErr) throw new Error('storage: ' + upErr.message);
      const { data: { publicUrl } } = supabase.storage.from('buyer-docs').getPublicUrl(path);
      await supabase.from('leads').update({ pj_identite_url: publicUrl }).eq('id', m.lead_id);
      return res.status(200).json({ ok: true, url: publicUrl, kind: 'identite' });
    }

    const path = `${owner}/${b.kind}-${Date.now()}.${ext}`;
    const url = await uploadPdf(buf, path);
    await supabase.from('mandats').update({ [DOC_COL[b.kind]]: url }).eq('id', b.mandat_id);
    return res.status(200).json({ ok: true, url, kind: b.kind });
  } catch (e) {
    console.error('[mandat_doc]', e?.message || e);
    return res.status(500).json({ error: 'upload_echoue', detail: e?.message || String(e) });
  }
}

// ── action: mandat_doc_url ── URL signée pour upload direct (gros fichiers) ──
// Évite la limite de corps de requête Vercel (~4,5 Mo) : le navigateur uploade
// directement vers Supabase Storage. kinds : offre|mandat|promesse|acte|facture|identite.
async function handleMandatDocUrl(req, res, b, payload) {
  if (!b.mandat_id || !b.kind) return res.status(400).json({ error: 'mandat_id, kind requis' });
  if (b.kind !== 'identite' && !DOC_COL[b.kind]) return res.status(400).json({ error: 'kind invalide' });
  const { data: m } = await supabase.from('mandats').select('id, lead_id').eq('id', b.mandat_id).maybeSingle();
  if (!m) return res.status(404).json({ error: 'mandat_introuvable' });

  const bucket = b.kind === 'identite' ? 'buyer-docs' : 'offer-docs';
  if (b.kind === 'identite' && !m.lead_id) return res.status(400).json({ error: 'lead_absent' });
  const owner = m.lead_id || m.id;
  const ext = (String(b.ext || 'pdf').match(/[a-z0-9]{2,5}/i) || ['pdf'])[0].toLowerCase();
  const path = `${owner}/${b.kind}-${Date.now()}.${ext}`;

  const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: 'signed_url_error', detail: error.message });
  const { data: { publicUrl } } = supabase.storage.from(bucket).getPublicUrl(path);
  return res.status(200).json({ ok: true, signedUrl: data.signedUrl, publicUrl, kind: b.kind });
}

// ── action: mandat_doc_set ── enregistre l'URL après upload direct ──────────
// Insère une ligne mandat_documents (historique multi-fichiers) + met à jour la
// colonne "primaire" (dernier fichier) pour la compat (mail notaire, pastilles).
async function handleMandatDocSet(req, res, b, payload) {
  if (!b.mandat_id || !b.kind || !b.url) return res.status(400).json({ error: 'mandat_id, kind, url requis' });
  if (b.kind !== 'identite' && !DOC_COL[b.kind]) return res.status(400).json({ error: 'kind invalide' });
  const { data: m } = await supabase.from('mandats').select('id, lead_id').eq('id', b.mandat_id).maybeSingle();
  if (!m) return res.status(404).json({ error: 'mandat_introuvable' });

  const { data: doc, error: insErr } = await supabase.from('mandat_documents').insert([{
    mandat_id: b.mandat_id, kind: b.kind, url: b.url,
    filename: b.filename || null, size_bytes: b.size || null, uploaded_by: payload.email,
  }]).select('id, kind, url, filename, size_bytes, created_at').single();
  if (insErr) return res.status(500).json({ error: 'db_error', detail: insErr.message });

  // Colonne primaire = dernier fichier (compat email notaire / pastilles)
  if (b.kind === 'identite') {
    if (m.lead_id) await supabase.from('leads').update({ pj_identite_url: b.url }).eq('id', m.lead_id);
  } else {
    await supabase.from('mandats').update({ [DOC_COL[b.kind]]: b.url }).eq('id', b.mandat_id);
  }
  return res.status(200).json({ ok: true, document: doc });
}

// ── action: mandat_doc_delete ── supprime un document ───────────────────────
async function handleMandatDocDelete(req, res, b, payload) {
  if (!b.mandat_id) return res.status(400).json({ error: 'mandat_id requis' });
  const { data: m } = await supabase.from('mandats').select('id, lead_id').eq('id', b.mandat_id).maybeSingle();
  if (!m) return res.status(404).json({ error: 'mandat_introuvable' });

  let url = b.url, kind = b.kind;
  // Doc en table : on le retrouve, on le supprime
  if (b.doc_id) {
    const { data: d } = await supabase.from('mandat_documents').select('url, kind').eq('id', b.doc_id).maybeSingle();
    if (d) { url = d.url; kind = d.kind; }
    await supabase.from('mandat_documents').delete().eq('id', b.doc_id);
  }
  if (!kind) return res.status(400).json({ error: 'kind requis' });

  // Repointe la colonne primaire si elle pointait sur ce fichier
  const { data: rest } = await supabase.from('mandat_documents')
    .select('url').eq('mandat_id', b.mandat_id).eq('kind', kind).order('created_at', { ascending: false }).limit(1);
  const fallback = rest && rest[0] ? rest[0].url : null;
  if (kind === 'identite') {
    if (m.lead_id) { const { data: l } = await supabase.from('leads').select('pj_identite_url').eq('id', m.lead_id).maybeSingle();
      if (!url || l?.pj_identite_url === url) await supabase.from('leads').update({ pj_identite_url: fallback }).eq('id', m.lead_id); }
  } else if (DOC_COL[kind]) {
    const { data: mm } = await supabase.from('mandats').select(DOC_COL[kind]).eq('id', b.mandat_id).maybeSingle();
    if (!url || (mm && mm[DOC_COL[kind]] === url)) await supabase.from('mandats').update({ [DOC_COL[kind]]: fallback }).eq('id', b.mandat_id);
  }
  return res.status(200).json({ ok: true });
}
