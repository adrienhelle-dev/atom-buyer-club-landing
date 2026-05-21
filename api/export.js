const { supabase } = require('../lib/supabase');
const { verifyToken, tokenFromReq } = require('../lib/auth');

const COLS = [
  'created_at','prenom','nom','email','tel',
  'arrondissements','timing','accord','financement','capacite',
  'utm_source','utm_medium','utm_campaign','utm_content','utm_term',
  'gclid','fbclid','referrer','ip',
];

const HEADERS_FR = [
  'Date','Prénom','Nom','Email','Téléphone',
  'Arrondissements','Horizon','Accord bancaire','Financement','Budget emprunt',
  'Source','Medium','Campagne','Contenu','Terme',
  'GCLID','FBCLID','Référent','IP',
];

function csv(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const payload = verifyToken(tokenFromReq(req));
  if (!payload) return res.status(401).json({ error: 'Non autorisé' });

  const { data, error } = await supabase.from('leads').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'db_error' });

  const lines = [
    HEADERS_FR.join(','),
    ...data.map(l => COLS.map(c => csv(l[c])).join(',')),
  ];

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads_abc_${date}.csv"`);
  return res.status(200).send('﻿' + lines.join('\n')); // BOM → Excel friendly
};
