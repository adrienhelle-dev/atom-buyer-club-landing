#!/usr/bin/env bash
# Smoke-test post-déploiement — read-only.
# Vérifie que chaque fonction serverless ET chaque page clé répond (≠ 404 / 5xx).
# But : détecter en 10 s le bug "fonction non buildée par Vercel" (cf. incident OG).
#
# Usage :  bash scripts/smoke.sh                 # cible la prod
#          BASE=https://xxx.vercel.app bash scripts/smoke.sh   # cible un déploiement
set -u
BASE="${BASE:-https://join.atombuyerclub.fr}"
fail=0   # 404 / pas de réponse = fonction NON déployée → échec dur (le bug qu'on traque)
warn=0   # 5xx = fonction déployée mais en erreur → alerte (autre problème)

check() { # $1=chemin  $2=règle (built|200)
  local code; code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$BASE/$1")
  case "$2" in
    200)
      if [ "$code" = "200" ]; then printf "  ✅ %-34s %s\n" "$1" "$code";
      elif case "$code" in 5??) true;; *) false;; esac; then printf "  ⚠️  %-34s %s (erreur serveur)\n" "$1" "$code"; warn=1;
      else printf "  ❌ %-34s %s\n" "$1" "$code"; fail=1; fi ;;
    built)  # le bug "non buildé" = 404 ; 401/405/200 = sain ; 5xx = déployé mais plante
      case "$code" in
        404|000) printf "  ❌ %-34s %s (NON déployé !)\n" "$1" "$code"; fail=1 ;;
        5??)     printf "  ⚠️  %-34s %s (déployé mais erreur)\n" "$1" "$code"; warn=1 ;;
        *)       printf "  ✅ %-34s %s\n" "$1" "$code" ;;
      esac ;;
  esac
}

echo "── Fonctions API (doivent répondre, jamais 404) ── $BASE"
for ep in "api/public-project?list=1" "api/showroom?list=1" "api/projects?list=1" \
          "api/leads" "api/events" "api/auth" "api/submit" "api/send-fiche" \
          "api/upload-image" "api/generate-pdf" "api/cron/stale-hot-leads"; do
  check "$ep" built
done

echo "── Pages publiques (doivent être 200) ──"
for pg in "" "projets" "showroom" "relance-danton" "projet/studio-danton-vlev"; do
  check "$pg" 200
done

# Une réalisation réelle (slug dynamique) pour valider l'OG showroom
slug=$(curl -s --max-time 20 "$BASE/api/showroom?list=1" | grep -oE '"slug":"[^"]+"' | head -1 | cut -d'"' -f4)
[ -n "$slug" ] && check "realisation/$slug" 200

echo "──────────────────────────────────────────"
if [ "$fail" != 0 ]; then echo "❌ ÉCHEC — une fonction/page est NON déployée (404). C'est le bug à corriger d'urgence.";
elif [ "$warn" != 0 ]; then echo "✅ Déploiement OK (tout est routé) — ⚠️ mais un endpoint renvoie une erreur 5xx (à investiguer séparément).";
else echo "✅ SMOKE TEST OK — tout répond."; fi
exit $fail
