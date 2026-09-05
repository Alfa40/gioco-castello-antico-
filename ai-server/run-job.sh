#!/usr/bin/env bash
# Esegue i job in coda, UNO ALLA VOLTA (su 8GB unificati non ha senso il contrario).
#
# Ogni job è un file JSON in jobs/pending/. Il runner lo esegue, ne verifica il
# risultato con uno script di checks/, e lo sposta in jobs/done/ o jobs/failed/.
# Un job che non passa la verifica non viene mai dato per buono in silenzio.
set -euo pipefail
shopt -s nullglob

cd "$(dirname "$0")"

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$1"; }
ko()   { printf '\033[1;31m[ko]\033[0m %s\n' "$1"; }

# Gli script in checks/ richiedono Pillow, che setup-macos.sh installa nel venv di
# ComfyUI: usiamo quello se c'è, altrimenti il python di sistema.
PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  if [[ -x ComfyUI/venv/bin/python ]]; then
    PYTHON="ComfyUI/venv/bin/python"
  else
    PYTHON="python3"
  fi
fi

# Legge un campo dal job JSON (notazione a punti, stringa vuota se assente).
field() {
  "$PYTHON" - "$1" "$2" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for key in sys.argv[2].split("."):
    if not isinstance(data, dict) or key not in data:
        print(""); raise SystemExit
    data = data[key]
print("" if data is None else data)
PY
}

jobs=(jobs/pending/*.json)
if [[ ${#jobs[@]} -eq 0 ]]; then
  echo "Nessun job in jobs/pending/"
  exit 0
fi

echo "${#jobs[@]} job in coda."
failed=0

for job in "${jobs[@]}"; do
  name="$(basename "$job" .json)"
  info "Job: $name"

  cmd="$(field "$job" cmd)"
  if [[ -z "$cmd" ]]; then
    ko "campo 'cmd' mancante"
    mv "$job" jobs/failed/
    failed=$((failed + 1))
    continue
  fi

  # --- Esecuzione -----------------------------------------------------------
  if ! bash -c "$cmd"; then
    ko "comando fallito"
    mv "$job" jobs/failed/
    failed=$((failed + 1))
    continue
  fi

  # --- Guardrail: verifica del risultato ------------------------------------
  output="$(field "$job" output)"
  if [[ -n "$output" ]]; then
    check_args=()
    for k in min_width min_height; do
      v="$(field "$job" "check.$k")"
      [[ -n "$v" ]] && check_args+=("--${k//_/-}" "$v")
    done

    # ${arr[@]+...}: espansione sicura anche con array vuoto sotto 'set -u'
    # (il bash 3.2 di default su macOS altrimenti aborta).
    if ! "$PYTHON" checks/verify_image.py "$output" ${check_args[@]+"${check_args[@]}"}; then
      ko "verifica fallita: l'output non è valido"
      mv "$job" jobs/failed/
      failed=$((failed + 1))
      continue
    fi
  fi

  ok "completato e verificato"
  mv "$job" jobs/done/
done

echo
if [[ $failed -gt 0 ]]; then
  ko "$failed job falliti — vedi jobs/failed/"
  exit 1
fi
ok "Tutti i job completati."
