// api/leases.js
// Génération & gestion des baux (mobilité / code civil) rattachés à une réalisation.
// PDF bilingue FR | EN sur 2 colonnes (sans logo), généré via Puppeteer.
// Sociétés mémorisées (bailleur/locataire) dans lease_companies.
//
// GET  ?showroom_item_id=X    → baux de la réalisation
// GET  ?companies=1           → sociétés en mémoire
// POST {action:'save'}        → crée/maj un bail (brouillon)
// POST {action:'generate'}    → génère le PDF du bail
// POST {action:'doc_upload'}  → upload version signée (locataire / contresignée)
// POST {action:'send'}        → email le bail (signature / partage contresigné)
// POST {action:'company_save'}/{action:'company_delete'}
// DELETE ?id=X

const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');
const { getFounder, associateEmails } = require('../lib/founders');
const { esc } = require('../lib/html');
const { Resend } = require('resend');

const NOTAIRE_FROM = () => process.env.RESEND_FROM || 'Atom Buyers Club <onboarding@resend.dev>';
const fmtEur = n => (n != null && n !== '' && !isNaN(n)) ? Number(n).toLocaleString('fr-FR') + ' €' : '—';
const fmtDateFr = d => d ? new Date(d).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' }) : '—';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  if (req.method === 'GET') {
    if (req.query.companies) {
      const { data } = await supabase.from('lease_companies').select('*').order('is_group', { ascending: false }).order('name');
      return res.status(200).json({ ok: true, companies: data || [] });
    }
    const sid = req.query.showroom_item_id;
    if (!sid) return res.status(400).json({ error: 'showroom_item_id requis' });
    const { data } = await supabase.from('leases').select('*').eq('showroom_item_id', sid).order('created_at', { ascending: false });
    return res.status(200).json({ ok: true, leases: data || [] });
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requis' });
    await supabase.from('leases').delete().eq('id', id);
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') return res.status(405).end();
  const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const action = b.action;

  // ── Sociétés ──────────────────────────────────────────────────────────────
  if (action === 'company_save') {
    const c = b.company || {};
    if (!c.name) return res.status(400).json({ error: 'name requis' });
    const row = {
      name: c.name, forme: c.forme || null, rcs_numero: c.rcs_numero || null, rcs_ville: c.rcs_ville || null,
      capital: c.capital || null, siege: c.siege || null,
      representant_nom: c.representant_nom || null, representant_qualite: c.representant_qualite || null,
      email: c.email || null, is_group: !!c.is_group,
    };
    let saved;
    if (c.id) { const { data } = await supabase.from('lease_companies').update(row).eq('id', c.id).select('*').single(); saved = data; }
    else { row.created_by = payload.email; const { data } = await supabase.from('lease_companies').insert([row]).select('*').single(); saved = data; }
    return res.status(200).json({ ok: true, company: saved });
  }
  if (action === 'company_delete') {
    if (!b.id) return res.status(400).json({ error: 'id requis' });
    await supabase.from('lease_companies').delete().eq('id', b.id);
    return res.status(200).json({ ok: true });
  }

  // ── Baux : save (brouillon) ────────────────────────────────────────────────
  if (action === 'save') {
    const L = b.lease || {};
    if (!L.showroom_item_id) return res.status(400).json({ error: 'showroom_item_id requis' });
    if (!['mobilite', 'code_civil'].includes(L.type)) return res.status(400).json({ error: 'type invalide' });
    const num = v => (v === '' || v == null || isNaN(v)) ? null : Number(v);
    const row = {
      showroom_item_id: L.showroom_item_id, type: L.type,
      bailleur: L.bailleur || null, locataire: L.locataire || null, lead_id: L.lead_id || null, bien: L.bien || null,
      loyer_base: num(L.loyer_base), complement_loyer: num(L.complement_loyer), charges: num(L.charges),
      services: num(L.services), frais_menage: num(L.frais_menage), depot_garantie: num(L.depot_garantie),
      loyer_ref_majore: num(L.loyer_ref_majore), preavis: L.preavis || null,
      date_debut: L.date_debut || null, date_fin: L.date_fin || null, duree: L.duree || null,
      motif: L.motif || null, motif_justificatif: L.motif_justificatif || null,
      updated_at: new Date().toISOString(),
    };
    let saved;
    if (L.id) { const { data, error } = await supabase.from('leases').update(row).eq('id', L.id).select('id, numero, statut').single(); if (error) return res.status(500).json({ error: error.message }); saved = data; }
    else { row.statut = 'brouillon'; row.created_by = payload.email; const { data, error } = await supabase.from('leases').insert([row]).select('id, numero, statut').single(); if (error) return res.status(500).json({ error: error.message }); saved = data; }
    return res.status(200).json({ ok: true, lease: saved });
  }

  // ── Baux : génération PDF ───────────────────────────────────────────────────
  if (action === 'generate') {
    if (!b.id) return res.status(400).json({ error: 'id requis' });
    const { data: lease } = await supabase.from('leases').select('*').eq('id', b.id).maybeSingle();
    if (!lease) return res.status(404).json({ error: 'bail introuvable' });
    try {
      const html = buildLeaseHtml(lease);
      const pdf = await renderPdf(html);
      const path = `${lease.showroom_item_id || 'lease'}/bail-${lease.type}-${lease.numero}-${Date.now()}.pdf`;
      const url = await uploadLeasePdf(pdf, path);
      const newStatut = ['brouillon', 'genere'].includes(lease.statut) ? 'genere' : lease.statut;
      await supabase.from('leases').update({ pdf_url: url, statut: newStatut, updated_at: new Date().toISOString() }).eq('id', b.id);
      return res.status(200).json({ ok: true, pdf_url: url });
    } catch (e) {
      console.error('[leases generate]', e?.message || e);
      return res.status(500).json({ error: 'pdf_echoue', detail: e?.message || String(e) });
    }
  }

  // ── Baux : upload version signée ────────────────────────────────────────────
  if (action === 'doc_upload') {
    if (!b.id || !b.kind || !b.content) return res.status(400).json({ error: 'id, kind, content requis' });
    if (!['signe_locataire', 'contresigne'].includes(b.kind)) return res.status(400).json({ error: 'kind invalide' });
    const { data: lease } = await supabase.from('leases').select('id, showroom_item_id, numero').eq('id', b.id).maybeSingle();
    if (!lease) return res.status(404).json({ error: 'bail introuvable' });
    try {
      const buf = Buffer.from(String(b.content).replace(/^data:[^,]+,/, ''), 'base64');
      const path = `${lease.showroom_item_id || 'lease'}/bail-${lease.numero}-${b.kind}-${Date.now()}.pdf`;
      const url = await uploadLeasePdf(buf, path);
      const col = b.kind === 'signe_locataire' ? 'pdf_signe_locataire_url' : 'pdf_contresigne_url';
      const statut = b.kind === 'contresigne' ? 'contresigne' : 'signe_locataire';
      await supabase.from('leases').update({ [col]: url, statut, updated_at: new Date().toISOString() }).eq('id', b.id);
      return res.status(200).json({ ok: true, url, statut });
    } catch (e) {
      return res.status(500).json({ error: 'upload_echoue', detail: e?.message || String(e) });
    }
  }

  // ── Baux : envoi email (signature / partage contresigné) ────────────────────
  if (action === 'send') {
    if (!b.id) return res.status(400).json({ error: 'id requis' });
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'email_non_configure' });
    const { data: lease } = await supabase.from('leases').select('*').eq('id', b.id).maybeSingle();
    if (!lease) return res.status(404).json({ error: 'bail introuvable' });

    const mode = b.mode === 'partage' ? 'partage' : 'signature';
    const pdfUrl = mode === 'partage' ? (lease.pdf_contresigne_url || lease.pdf_url) : (lease.pdf_url);
    if (!pdfUrl) return res.status(422).json({ error: 'pdf_absent', detail: 'génère le bail d\'abord' });

    const loc = lease.locataire || {};
    const ba = lease.bailleur || {};
    // Destinataires : signature → locataire seul ; partage → locataire + bailleur.
    const recipients = mode === 'partage'
      ? [...new Set([b.to || loc.email, ba.email].filter(Boolean))]
      : [b.to || loc.email].filter(Boolean);
    if (!recipients.length) return res.status(422).json({ error: 'email_locataire_absent', detail: 'Renseigne l\'email du locataire (et du bailleur pour le partage).' });

    let pdfBuf;
    try { pdfBuf = await fetch(pdfUrl).then(r => r.arrayBuffer()).then(ab => Buffer.from(ab)); }
    catch (e) { return res.status(500).json({ error: 'pdf_fetch_echoue' }); }

    const founder = getFounder(payload.email);
    const cc = associateEmails().filter(e => !recipients.includes(e));
    const bienAdr = lease.bien?.adresse || '';
    const subject = mode === 'partage'
      ? `Bail signé — ${bienAdr}`
      : `Bail à signer — ${bienAdr}`;
    const intro = mode === 'partage'
      ? `<p>Bonjour,</p><p>Veuillez trouver ci-joint le bail <strong>signé par toutes les parties</strong> pour le logement situé au <strong>${esc(bienAdr)}</strong>.</p>`
      : `<p>Bonjour ${esc(loc.prenom || '')},</p><p>Veuillez trouver ci-joint votre bail pour le logement situé au <strong>${esc(bienAdr)}</strong>.</p><p>Merci de le retourner signé (ou de nous confirmer votre accord pour une signature électronique).</p>`;
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: NOTAIRE_FROM(), replyTo: associateEmails(),
        to: recipients, cc,
        subject,
        html: `${intro}<p>Bien à vous,<br/><strong>${esc(founder.name || 'Atom')}</strong><br/>Atom</p>`,
        attachments: [{ filename: `Bail-${(bienAdr || 'logement').replace(/[^a-z0-9]/gi, '-').slice(0, 40)}.pdf`, content: pdfBuf.toString('base64') }],
      });
    } catch (e) {
      return res.status(500).json({ error: 'envoi_echoue', detail: e?.message || String(e) });
    }
    if (mode === 'signature' && lease.statut === 'genere') {
      await supabase.from('leases').update({ statut: 'envoye', updated_at: new Date().toISOString() }).eq('id', b.id);
    }
    return res.status(200).json({ ok: true, sent_to: recipients, cc });
  }

  return res.status(400).json({ error: 'action inconnue' });
};

// ── Rendu PDF (Puppeteer) ─────────────────────────────────────────────────────
async function renderPdf(html) {
  const { default: puppeteer } = await import('puppeteer-core');
  const { default: chromium } = await import('@sparticuz/chromium');
  const browser = await puppeteer.launch({ args: chromium.args, defaultViewport: { width: 794, height: 1123 }, executablePath: await chromium.executablePath(), headless: true });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
  const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' } });
  await browser.close();
  return pdf;
}
async function uploadLeasePdf(buf, path) {
  const { error } = await supabase.storage.from('lease-docs').upload(path, buf, { contentType: 'application/pdf', upsert: true });
  if (error) throw new Error('storage: ' + error.message);
  const { data: { publicUrl } } = supabase.storage.from('lease-docs').getPublicUrl(path);
  return publicUrl;
}

// ── Construction du HTML bilingue (2 colonnes FR | EN) ────────────────────────
function clause(fr, en) {
  return `<tr><td class="fr">${fr}</td><td class="en">${en}</td></tr>`;
}
function head(fr, en) {
  return `<tr><td class="h" colspan="1">${fr}</td><td class="h">${en}</td></tr>`;
}
function leaseShell(titleFr, titleEn, subFr, subEn, rows) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Times New Roman', Georgia, serif; font-size: 9.5pt; color: #1a1a1a; line-height: 1.5; }
  .doc-title { text-align: center; font-size: 14pt; font-weight: bold; text-transform: uppercase; letter-spacing: .03em; margin-bottom: 2px; }
  .doc-sub { text-align: center; font-size: 9pt; color: #555; margin-bottom: 4px; }
  .doc-note { text-align: center; font-size: 8pt; color: #888; font-style: italic; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; padding: 6px 10px; width: 50%; border: 1px solid #e2e2e2; }
  td.fr { border-right: 2px solid #B8975A; }
  td.en { color: #444; font-style: italic; }
  td.h { background: #0f0e0c; color: #F5F2ED; font-weight: bold; font-size: 9pt; text-transform: uppercase; letter-spacing: .04em; font-style: normal; padding: 5px 10px; }
  .sig { margin-top: 22px; display: flex; justify-content: space-between; gap: 30px; }
  .sig-col { width: 46%; font-size: 9pt; }
  .sig-lbl { font-weight: bold; margin-bottom: 4px; }
  .sig-line { margin-top: 44px; border-top: 1px solid #999; padding-top: 3px; font-size: 8pt; color: #666; }
  strong { font-weight: bold; }
  </style></head><body>
  <div class="doc-title">${titleFr}</div>
  <div class="doc-title" style="font-size:11pt;color:#555">${titleEn}</div>
  <div class="doc-sub">${subFr}</div>
  <div class="doc-note">Version bilingue — seule la version française fait foi. / Bilingual version — only the French version is binding.</div>
  <table>${rows}</table>
  </body></html>`;
}

function partiesRows(lease) {
  const ba = lease.bailleur || {}, lo = lease.locataire || {};
  let baFr, baEn;
  if (ba.kind === 'physique') {
    const baName = ba.name || `${ba.prenom || ''} ${ba.nom || ''}`.trim();
    const idFr = [ba.nationalite ? `de nationalité ${esc(ba.nationalite)}` : '', ba.dob ? `né(e) le ${fmtDateFr(ba.dob)}` : '', ba.adresse ? `demeurant ${esc(ba.adresse)}` : '', ba.piece ? esc(ba.piece) : ''].filter(Boolean).join(', ');
    const idEn = [ba.nationalite ? `of ${esc(ba.nationalite)} nationality` : '', ba.dob ? `born on ${fmtDateFr(ba.dob)}` : '', ba.adresse ? `residing at ${esc(ba.adresse)}` : '', ba.piece ? esc(ba.piece) : ''].filter(Boolean).join(', ');
    baFr = `<strong>${esc(baName)}</strong>${idFr ? ', ' + idFr : ''}.`;
    baEn = `<strong>${esc(baName)}</strong>${idEn ? ', ' + idEn : ''}.`;
  } else {
    baFr = `<strong>${esc(ba.name || '')}</strong>, ${esc(ba.forme || 'SAS')}, RCS ${esc(ba.rcs_ville || '')} n° ${esc(ba.rcs_numero || '')}, siège ${esc(ba.siege || '')}${ba.representant_nom ? `, représentée par ${esc(ba.representant_nom)}${ba.representant_qualite ? ', ' + esc(ba.representant_qualite) : ''}` : ''}.`;
    baEn = `<strong>${esc(ba.name || '')}</strong>, ${esc(ba.forme || 'SAS')}, registered with the ${esc(ba.rcs_ville || '')} Trade Register under n° ${esc(ba.rcs_numero || '')}, registered office ${esc(ba.siege || '')}${ba.representant_nom ? `, represented by ${esc(ba.representant_nom)}${ba.representant_qualite ? ', ' + esc(ba.representant_qualite) : ''}` : ''}.`;
  }
  let locFr, locEn;
  if (lo.kind === 'societe') {
    locFr = `<strong>${esc(lo.name || '')}</strong>, ${esc(lo.forme || 'société')}, RCS ${esc(lo.rcs_ville || '')} n° ${esc(lo.rcs_numero || '')}, siège ${esc(lo.siege || '')}${lo.representant_nom ? `, représentée par ${esc(lo.representant_nom)}` : ''}.`;
    locEn = `<strong>${esc(lo.name || '')}</strong>, ${esc(lo.forme || 'company')}, registered ${esc(lo.rcs_ville || '')} n° ${esc(lo.rcs_numero || '')}, registered office ${esc(lo.siege || '')}${lo.representant_nom ? `, represented by ${esc(lo.representant_nom)}` : ''}.`;
  } else {
    const id = [lo.nationalite ? `de nationalité ${esc(lo.nationalite)}` : '', lo.dob ? `né(e) le ${fmtDateFr(lo.dob)}` : '', lo.adresse ? `demeurant ${esc(lo.adresse)}` : '', lo.piece ? esc(lo.piece) : ''].filter(Boolean).join(', ');
    locFr = `<strong>${esc((lo.prenom || '') + ' ' + (lo.nom || ''))}</strong>${id ? ', ' + id : ''}.`;
    locEn = `<strong>${esc((lo.prenom || '') + ' ' + (lo.nom || ''))}</strong>${id ? ', ' + id : ''}.`;
  }
  return head('Désignation des parties', 'Parties')
    + clause(`<u>Le Bailleur</u> : ${baFr}`, `<u>The Landlord</u>: ${baEn}`)
    + clause(`<u>Le Locataire</u> : ${locFr}`, `<u>The Tenant</u>: ${locEn}`);
}

function bienRows(lease) {
  const bn = lease.bien || {};
  const fr = [bn.adresse ? `Adresse : ${esc(bn.adresse)}.` : '', bn.localisation ? `Localisation : ${esc(bn.localisation)}.` : (bn.etage ? `Étage : ${esc(bn.etage)}.` : ''), bn.surface ? `Type : studio meublé, surface habitable ${esc(bn.surface)} m².` : 'Type : studio meublé.', bn.lot_copro ? `Lot de copropriété : ${esc(bn.lot_copro)}.` : '', bn.equipements ? `Équipements : ${esc(bn.equipements)}.` : ''].filter(Boolean).join('<br/>');
  const en = [bn.adresse ? `Address: ${esc(bn.adresse)}.` : '', bn.localisation ? `Location: ${esc(bn.localisation)}.` : (bn.etage ? `Floor: ${esc(bn.etage)}.` : ''), bn.surface ? `Type: furnished studio, habitable surface ${esc(bn.surface)} sq.m.` : 'Type: furnished studio.', bn.lot_copro ? `Co-ownership lot: ${esc(bn.lot_copro)}.` : '', bn.equipements ? `Equipment: ${esc(bn.equipements)}.` : ''].filter(Boolean).join('<br/>');
  return head('Désignation des locaux loués', 'Leased Premises') + clause(fr, en);
}

function loyerRows(lease) {
  const total = ['loyer_base', 'complement_loyer', 'charges', 'services'].reduce((s, k) => s + (Number(lease[k]) || 0), 0);
  const lignes = [];
  if (lease.loyer_base != null) lignes.push(['Loyer de base', 'Base rent', lease.loyer_base]);
  if (lease.complement_loyer) lignes.push(['Complément de loyer', 'Rent supplement', lease.complement_loyer]);
  if (lease.charges != null) lignes.push(['Charges (forfait)', 'Charges (flat-rate)', lease.charges]);
  if (lease.services) lignes.push(['Services', 'Services', lease.services]);
  const detailFr = lignes.map(l => `${l[0]} : ${fmtEur(l[2])}`).join(' · ');
  const detailEn = lignes.map(l => `${l[1]}: ${fmtEur(l[2])}`).join(' · ');
  const encadr = lease.loyer_ref_majore ? `<br/>Loyer de référence majoré applicable : ${fmtEur(lease.loyer_ref_majore)} (encadrement des loyers respecté).` : '';
  const encadrEn = lease.loyer_ref_majore ? `<br/>Applicable reference rent (cap): ${fmtEur(lease.loyer_ref_majore)} (rent control complied with).` : '';
  const menageFr = lease.frais_menage ? `<br/>Forfait ménage (prélevé en fin de bail) : ${fmtEur(lease.frais_menage)}.` : '';
  const menageEn = lease.frais_menage ? `<br/>Cleaning fee (deducted at end of lease): ${fmtEur(lease.frais_menage)}.` : '';
  const depotFr = lease.type === 'mobilite' ? `Dépôt de garantie : Aucun (art. 25-14 de la loi du 6 juillet 1989).` : `Dépôt de garantie : ${fmtEur(lease.depot_garantie)}.`;
  const depotEn = lease.type === 'mobilite' ? `Security deposit: None (article 25-14 of the Law of 6 July 1989).` : `Security deposit: ${fmtEur(lease.depot_garantie)}.`;
  return head('Loyer et charges', 'Rent and Charges')
    + clause(`Loyer mensuel toutes charges comprises : <strong>${fmtEur(total)}</strong>.<br/>${detailFr}${encadr}${menageFr}`, `Monthly rent inclusive of charges: <strong>${fmtEur(total)}</strong>.<br/>${detailEn}${encadrEn}${menageEn}`)
    + clause(depotFr, depotEn)
    + clause(`Loyer payable mensuellement et d'avance par virement bancaire.`, `Rent payable monthly in advance by bank transfer.`);
}

function dureeRows(lease) {
  if (lease.type === 'mobilite') {
    return head('Durée et prise d\'effet', 'Term and Effective Date')
      + clause(`Bail à durée déterminée : <strong>${esc(lease.duree || '')}</strong> (maximum 10 mois). Date d'effet : <strong>${fmtDateFr(lease.date_debut)}</strong>. Date de fin : <strong>${fmtDateFr(lease.date_fin)}</strong>. Non renouvelable ni reconductible ; prolongation unique possible par avenant sans dépasser 10 mois au total.`,
                `Fixed-term lease: <strong>${esc(lease.duree || '')}</strong> (maximum 10 months). Effective date: <strong>${fmtDateFr(lease.date_debut)}</strong>. End date: <strong>${fmtDateFr(lease.date_fin)}</strong>. Neither renewable nor extendable; a single extension by amendment is possible without exceeding 10 months total.`);
  }
  return head('Durée', 'Term')
    + clause(`Bail conclu pour une durée ferme de <strong>${esc(lease.duree || '')}</strong>, à compter du <strong>${fmtDateFr(lease.date_debut)}</strong>, sans tacite reconduction. Échéance : <strong>${fmtDateFr(lease.date_fin)}</strong>.`,
              `Lease for a firm term of <strong>${esc(lease.duree || '')}</strong>, from <strong>${fmtDateFr(lease.date_debut)}</strong>, without tacit renewal. Expiry: <strong>${fmtDateFr(lease.date_fin)}</strong>.`);
}

function buildLeaseHtml(lease) {
  const rows = [];
  if (lease.type === 'mobilite') {
    // Motif (obligatoire en bail mobilité)
    rows.push(head('Motif du bail mobilité', 'Grounds for the Mobility Lease'));
    rows.push(clause(
      `Le Locataire déclare se trouver, à la date de prise d'effet, dans la situation suivante justifiant le bénéfice d'un bail mobilité : <strong>${esc(lease.motif || '')}</strong>${lease.motif_justificatif ? ' — ' + esc(lease.motif_justificatif) : ''}. Il s'engage à fournir un justificatif écrit lors de la signature.`,
      `The Tenant declares being, on the effective date, in the following situation justifying a mobility lease: <strong>${esc(lease.motif || '')}</strong>${lease.motif_justificatif ? ' — ' + esc(lease.motif_justificatif) : ''}. The Tenant undertakes to provide written evidence upon signature.`));
  }
  rows.push(partiesRows(lease));
  rows.push(bienRows(lease));
  rows.push(dureeRows(lease));
  rows.push(loyerRows(lease));

  // Résiliation / préavis
  const preavis = lease.preavis || (lease.type === 'mobilite' ? '1 mois' : '');
  rows.push(head('Résiliation et préavis', 'Termination and Notice'));
  if (lease.type === 'mobilite') {
    rows.push(clause(`Le Locataire peut résilier à tout moment moyennant un préavis de <strong>${esc(preavis)}</strong> (LRAR, acte de commissaire de justice ou remise en main propre). Le Bailleur ne peut donner congé avant le terme.`,
      `The Tenant may terminate at any time with <strong>${esc(preavis)}</strong> notice (registered letter, bailiff's act or hand delivery). The Landlord may not give notice before the term.`));
  } else {
    rows.push(clause(`Le Preneur peut mettre fin au bail à tout moment, par écrit (email ou WhatsApp), avec un préavis de <strong>${esc(preavis || 'aucun')}</strong>. Le loyer reste dû jusqu'à restitution des clés.`,
      `The Tenant may terminate at any time, in writing (email or WhatsApp), with <strong>${esc(preavis || 'no')}</strong> notice. Rent remains due until keys are returned.`));
  }

  // Clauses standard
  rows.push(head('État des lieux & entretien', 'Inventory & Maintenance'));
  rows.push(clause(`Un état des lieux d'entrée et de sortie et un inventaire du mobilier sont établis et annexés. Le Locataire maintient les lieux, le mobilier et les équipements en bon état (hors usure normale) et signale sans délai tout sinistre.`,
    `An entry/exit inventory and a furniture inventory are established and annexed. The Tenant keeps the premises, furniture and equipment in good condition (excluding normal wear) and reports any damage without delay.`));
  rows.push(head('Assurance', 'Insurance'));
  rows.push(clause(lease.locataire?.kind === 'societe' ? `Le Preneur souscrit une assurance RC professionnelle.` : `Le Locataire souscrit une assurance multirisque habitation pour toute la durée du bail et en remet l'attestation avant la remise des clés.`,
    lease.locataire?.kind === 'societe' ? `The Tenant subscribes to professional liability insurance.` : `The Tenant subscribes to multi-risk home insurance for the full term and provides the certificate before key handover.`));
  rows.push(head('Sous-location · Destination', 'Subletting · Use'));
  rows.push(clause(`Sous-location et cession interdites (notamment toute annonce de location touristique). Les lieux sont à usage de résidence ${lease.type === 'mobilite' ? 'temporaire' : 'secondaire'} et ne constituent pas la résidence principale.`,
    `Subletting and assignment prohibited (including any tourist rental listing). The premises are for ${lease.type === 'mobilite' ? 'temporary' : 'secondary'} residential use and do not constitute the principal residence.`));
  rows.push(head('Droit applicable', 'Governing Law'));
  rows.push(clause(`Droit français${lease.type === 'mobilite' ? ' — loi n° 89-462 du 6 juillet 1989 (titre Ier ter)' : ' — Code civil'}. Seule la version française fait foi. Tribunaux du lieu de situation des locaux compétents.`,
    `French law${lease.type === 'mobilite' ? ' — Law No. 89-462 of 6 July 1989 (Title I ter)' : ' — Civil Code'}. Only the French version is authoritative. Courts of the premises\' location have jurisdiction.`));

  const titleFr = lease.type === 'mobilite' ? "Bail d'habitation meublée — Bail mobilité" : "Bail société — Location meublée (Code civil)";
  const titleEn = lease.type === 'mobilite' ? 'Furnished residential lease — Mobility lease' : 'Corporate lease — Furnished (Civil Code)';
  const subFr = lease.type === 'mobilite' ? "Régi par l'article 25-12 de la loi du 6 juillet 1989 / Governed by article 25-12 of the Law of 6 July 1989" : "Bail de droit commun soumis au Code civil / Common-law lease under the Civil Code";

  const ba = lease.bailleur || {}, lo = lease.locataire || {};
  const sig = `<div class="sig">
    <div class="sig-col"><div class="sig-lbl">Pour le Bailleur / For the Landlord</div>${esc(ba.name || '')}${ba.representant_nom ? `<br/>Représentée par / Represented by : ${esc(ba.representant_nom)}${ba.representant_qualite ? '<br/>' + esc(ba.representant_qualite) : ''}` : ''}<div class="sig-line">« Lu et approuvé » — Signature</div></div>
    <div class="sig-col"><div class="sig-lbl">Pour le Locataire / For the Tenant</div>${esc(lo.kind === 'societe' ? (lo.name || '') : ((lo.prenom || '') + ' ' + (lo.nom || '')))}<div class="sig-line">« Lu et approuvé » — Signature</div></div>
  </div>`;

  return leaseShell(titleFr, titleEn, subFr, '', rows.join('')).replace('</table>', '</table>' + sig);
}

module.exports.buildLeaseHtml = buildLeaseHtml; // exposé pour tests/usage interne
