#!/usr/bin/env bash
# Setup del server AI su macOS Apple Silicon.
# Idempotente: rilanciabile quante volte serve, salta ciò che è già a posto.
set -euo pipefail

cd "$(dirname "$0")"

OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2:3b}"   # piccolo: adatto a 8GB unificati

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$1"; }

# --- Controlli preliminari ------------------------------------------------

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Questo script è per macOS. Su Linux/NVIDIA serve un setup con CUDA." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  warn "Architettura $(uname -m): non è Apple Silicon, l'accelerazione MPS non sarà disponibile."
fi

info "Strumenti da riga di comando di Xcode"
if xcode-select -p >/dev/null 2>&1; then
  ok "già installati"
else
  xcode-select --install || true
  echo "Completa l'installazione nella finestra che si è aperta, poi rilancia questo script."
  exit 0
fi

info "Homebrew"
if command -v brew >/dev/null 2>&1; then
  ok "presente ($(brew --version | head -1))"
else
  warn "Homebrew non trovato. Installalo con il comando ufficiale da https://brew.sh"
  echo "Poi rilancia questo script."
  exit 1
fi

# --- Pacchetti base -------------------------------------------------------

for pkg in python git; do
  info "$pkg"
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    ok "già installato"
  else
    brew install "$pkg"
  fi
done

PYTHON_BIN="$(brew --prefix)/bin/python3"
[[ -x "$PYTHON_BIN" ]] || PYTHON_BIN="$(command -v python3)"
ok "python: $PYTHON_BIN ($("$PYTHON_BIN" --version))"

# --- Ollama (LLM locali) --------------------------------------------------

info "Ollama"
if command -v ollama >/dev/null 2>&1; then
  ok "già installato"
else
  brew install ollama
fi

info "Modello Ollama: $OLLAMA_MODEL"
if ollama list 2>/dev/null | grep -q "^${OLLAMA_MODEL%%:*}"; then
  ok "già scaricato"
elif ollama pull "$OLLAMA_MODEL"; then
  ok "scaricato"
else
  warn "Download fallito: probabilmente il servizio non è attivo."
  warn "Avvialo con 'brew services start ollama' (o apri l'app Ollama), poi:"
  warn "  ollama pull $OLLAMA_MODEL"
fi

# --- ComfyUI (generazione immagini) ---------------------------------------

info "ComfyUI"
if [[ -d ComfyUI/.git ]]; then
  ok "già clonato"
else
  git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git ComfyUI
fi

info "Ambiente Python isolato per ComfyUI"
if [[ ! -d ComfyUI/venv ]]; then
  "$PYTHON_BIN" -m venv ComfyUI/venv
fi
# shellcheck disable=SC1091
source ComfyUI/venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet torch torchvision torchaudio      # su arm64 include il backend MPS
pip install --quiet -r ComfyUI/requirements.txt
pip install --quiet pillow                            # usato dai check in checks/
deactivate
ok "dipendenze installate"

# --- Struttura cartelle ---------------------------------------------------

info "Struttura cartelle"
mkdir -p jobs/pending jobs/done jobs/failed outputs \
         models/checkpoints models/loras
ok "pronta"

# --- Fine -----------------------------------------------------------------

cat <<EOF

$(ok "Setup completato.")

Passi rimasti (manuali):
  1. Blender: scarica la versione Apple Silicon da https://www.blender.org/download/
  2. Un checkpoint Stable Diffusion 1.5 in models/checkpoints/
     (SD 1.5, non SDXL: con 8GB unificati SDXL è troppo pesante)

Per avviare ComfyUI:
  source ComfyUI/venv/bin/activate && python ComfyUI/main.py

Per eseguire la coda di job:
  ./run-job.sh
EOF
