#!/usr/bin/env bash
# Smoke-test post-déploiement — read-only.
# Vérifie que chaque fonction serverless ET chaque page clé répond (≠ 404 / 5xx).
# But : détecter en 10 s le bug "fonction non buildée par Vercel" (cf. incident OG).
#
# Usage :  bash scripts/smoke.sh                 # cible la prod
#          BASE=https://xxx.vercel.app bash scripts/smoke.sh   # cible un déploiement
set -u
BASE="${BASE:-https://join.atombuyerclub.fr}"
fail=0

check() { # $1=chemin  $2=règle (notfound|200)  $3=libellé
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/$1")
  local ok=1
  case "$2" in
    200)      [ "$code" = "200" ] || ok=0 ;;
    notfound) case "$code" in 404|000|5??) ok=0 ;; esac ;;
  esac
  if [ "$ok" = 1 ]; then printf "  ✅ %-34s %s\n" "$1" "$code"
  else printf "  ❌ %-34s %s\n" "$1" "$code"; fail=1; fi
}

echo "── Fonctions API (doivent répondre, jamais 404) ── $BASE"
for ep in "api/public-project?list=1" "api/showroom?list=1" "api/projects?list=1" \
          "api/leads" "api/events" "api/auth" "api/submit" "api/send-fiche" \
          "api/upload-image" "api/generate-pdf" "api/cron/stale-hot-leads"; do
  check "$ep" notfound
done

echo "── Pages publiques (doivent être 200) ──"
for pg in "" "projets" "showroom" "relance-danton" "projet/studio-danton-vlev"; do
  check "$pg" 200
done

# Une réalisation réelle (slug dynamique) pour valider l'OG showroom
slug=$(curl -s --max-time 20 "$BASE/api/showroom?list=1" | grep -oE '"slug":"[^"]+"' | head -1 | cut -d'"' -f4)
[ -n "$slug" ] && check "realisation/$slug" 200

echo "──────────────────────────────────────────"
if [ "$fail" = 0 ]; then echo "✅ SMOKE TEST OK — tout répond."; else echo "❌ ÉCHEC — un endpoint/page ne répond pas (voir ❌ ci-dessus)."; fi
exit $fail
