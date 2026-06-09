# 📌 Reprise — Audit Atom & Roadmap (à reprendre au réveil)

> Note de continuité écrite le soir du 2026-05-28. Fichier local, NON commité (à ne pas pousser).

## ✅ Décisions prises hier soir
- Audit complet réalisé sur les 2 outils : CRM `admin.html` (join.atombuyerclub.fr/admin) + app Assets Next.js (atom-buyer-club.vercel.app/admin/assets).
- Les **4 chantiers sont validés** (à faire dans cet ordre) :
  1. **Phase 1 — Tracking ads** (P0, AVANT la pub)
  2. **Phase 2 — Quick wins sécurité/stabilité**
  3. **Phase 3 — Login unique + pont lead→projet→asset**
  4. **Phase 4 — Refactor `admin.html`** (en dernier, ne bloque rien)
- Niveau tracking choisi : **« Robuste mais simple »** (first-touch + last-touch, pas de multi-touch complet).

## ❓ À me redemander au réveil (2 questions restées en suspens)
1. **Mode Phase 1** : (a) je code tout d'un coup puis tu testes, (b) SQL d'abord, ou (c) montre le track.js d'abord ?
2. **Canaux ads au lancement** : Meta (fbclid) ? Google (gclid) ? Autres (TikTok/LinkedIn) ? Liens manuels/influenceurs ? → pour cibler la capture.

---

## 🎯 PHASE 1 — Plan détaillé (tracking robuste mais simple)

**Problème identifié (l'attribution est cassée AVANT même la navigation) :**
- `projets.html` (l.894, 939) & `showroom.html` (l.711, 756) **n'lisent aucun UTM**, `utm_source` est écrit EN DUR.
- `projet.html` (l.505) essaie de lire les UTM mais le **rewrite Vercel** (`vercel.json:5`) vide `location.search` → fallback `'fiche_projet'`.
- Seule `index.html` (l.914-921) capture, et en `sessionStorage` (perdu à la fermeture). `projet.html` lit ce storage mais ne l'écrit jamais.
- `submit.js` (l.61-66) **fige le first-touch** → un faux `source=projets` devient définitif.
- Manque en base : `landing_page`, `first_touch`/`last_touch`, `project_id` direct.

**Implémentation prévue :**
1. Script commun `track.js` chargé sur les 4 pages (index, projets, projet, showroom) :
   - Capture tous les `utm_*` + `gclid`/`fbclid` sur CHAQUE page.
   - **first-touch** → `localStorage['atom_attribution']` + cookie 90j (survit fermeture onglet + retour différé).
   - **last-touch** mis à jour à chaque visite.
   - Stocke `landing_page` + `referrer`.
2. Fin du hardcoding : projets/showroom/projet lisent le storage ; nom de page = fallback uniquement.
3. Fix `projet.html` : parser les UTM malgré le rewrite (avant écrasement + fallback storage).
4. Propagation : repose sur le storage (la soumission reste attribuée même URL nue).
5. `submit.js` : corriger un faux first-touch si une vraie campagne arrive ; ajouter le last-touch.
6. **Migration SQL** sur table `leads` : `landing_page`, `last_utm_source`, `last_utm_medium`, `last_utm_campaign` (à coller dans Supabase).

**Fichiers concernés :** `index.html`, `projets.html`, `projet.html`, `showroom.html`, `api/submit.js`, `schema.sql` (+ migration Supabase), `vercel.json` (vérifier le rewrite).

---

## 📋 Rappel — constats de l'audit (pour mémoire)

### 🔴 P1 — Sécurité/stabilité (avant dépense ads)
- **Mot de passe `contact@atom-capital.fr` en clair** dans les 2 repos (versionné git) + `JWT_SECRET` fallback `'fallback-secret-change-me'` → à sortir en env + changer le mot de passe (présent dans l'historique git).
- **Autorisation rôle non appliquée côté API** (CRM) : rôle `projects` masqué seulement côté client → un token peut requêter `/api/leads`.
- **Gestion erreur/loading absente** sur la plupart des vues (CRM bloque sur « Chargement… » ; Assets `?? []` = page vide silencieuse).
- **Pagination trompeuse** : client demande 500 leads, API plafonne à 100 → leads anciens invisibles sans indicateur (grave avec afflux ads).
- Aucun timeout/AbortController ; token en localStorage + beaucoup d'innerHTML (XSS).
- **Schéma SQL désynchronisé** : `status`, `notes`, `assigned_to` utilisés mais absents de `schema.sql`.

### 🟠 P2 — UX/UI
- CRM : 13 `alert()` bloquants à remplacer par toasts ; `maximum-scale=1` bloque le zoom iPhone (à retirer) ; drawer lead = template géant fragile aux apostrophes ; pas d'Échap/focus, z-index anarchiques.
- Assets : viewer ne voit AUCUNE métrique calculée (P&L masqué) ; pas de validation saisie (`nights_booked > available` accepté) ; auto-save sans verrou (écriture concurrente Diamoni/admin) ; `manual_bookings` + `revenue_breakdown` codés mais sans UI.

### 🟠 P3 — Responsive
- CRM : responsive par `nth-child` codé en dur (fragile) ; vue Intérêts mobile = mur de `!important` ; zone tablette 640-1024px non testée.
- Assets : détail asset grille fixe `1fr 320px` SANS media query → P&L écrase le formulaire sur tablette ; barre de contrôles du chart se tasse sur mobile.
- Couleurs Atom (`#B8975A`...) re-hardcodées des dizaines de fois (pas de design system partagé).

### 🟡 P4 — Interconnexion
- 2 repos / 2 auth / 2 logins, mais probablement même Supabase.
- Login unique possible (même JWT_SECRET, cookie déjà presque commun, rôle `projects` des 2 côtés).
- Pont de données manquant : asset livré jamais relié à son projet CRM ni au lead acheteur → pas de vue « lead → projet → asset en exploitation ».
- Navigation croisée absente entre les 2 admins.

### ⚡ Quick wins (<1h chacun)
1. Retirer `maximum-scale=1` (zoom mobile).
2. Corriger pagination 500/100.
3. Loading + erreur sur les 4 vues CRM.
4. Media query détail asset (`1fr 320px` → 1 colonne tablette).
5. Sortir mot de passe du code + changer secret JWT.

---

## 🗂️ État des modifs récentes (déjà déployées)
- Cards onglet Intérêts refondues (hover Fiche, source visible, delete ghost + confirm-nom, toggle circulaire). Commits : `f81cf98`, `0118997`, `ac5deb0`.
- PDF guide fiche projet généré pour Agathe (sur le Bureau).
