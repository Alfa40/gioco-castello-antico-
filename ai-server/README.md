# AI Server — setup portabile

Server AI locale per la generazione di asset del gioco (immagini/texture, LLM locali,
elaborazione animazioni). Progettato per essere **riproducibile**: la macchina non è
un'installazione artigianale irripetibile, ma il risultato di uno script versionato.

Questa è la ragione per cui il server si sposta su hardware nuovo senza perdere nulla.

---

## Il principio di portabilità

Le cose si dividono in due categorie:

| Categoria | Esempi | Come si sposta |
|---|---|---|
| **Difficile da ricreare** | file LoRA allenati, dataset, config dei job, script di verifica, asset generati | Versionato in git (o copiato a mano se pesante) — è il vero valore |
| **Banale da reinstallare** | Python, ComfyUI, Ollama, PyTorch, Blender | Si rilancia `setup-*.sh` sulla macchina nuova |

Il file `.gitignore` di questa cartella applica esattamente questa divisione: tutto ciò
che pesa GB ed è riscaricabile resta fuori da git, tutto ciò che è tuo ci entra.

**Conseguenza pratica:** quando cambi macchina non "migri il server", lo **ricostruisci
in mezz'ora** e ci riporti dentro i tuoi file. Niente si perde perché niente di
importante vive solo dentro l'installazione.

---

## Installazione (Mac Apple Silicon — la macchina attuale)

```bash
cd ai-server
./setup-macos.sh
```

Lo script è **idempotente**: puoi rilanciarlo quante volte vuoi, salta ciò che è già
installato.

Cosa installa:
- Python + Git (via Homebrew)
- **Ollama** + un modello piccolo adatto a 8GB di memoria unificata
- **ComfyUI** con PyTorch in accelerazione Metal (MPS)
- La struttura di cartelle per i job

Da installare a mano (sono app, non pacchetti da terminale):
- **Blender** — da [blender.org](https://www.blender.org/download/), versione Apple Silicon

### Limiti noti su M1 con 8GB

- Usare checkpoint **Stable Diffusion 1.5**, non SDXL (troppo pesante per 8GB condivisi)
- Modelli Ollama fino a ~3B parametri per un uso fluido
- **Il training dei LoRA non gira qui**: richiede CUDA. Si affitta una GPU cloud per
  quella fase una tantum, e si riporta il file `.safetensors` risultante in `models/loras/`

---

## Migrazione su hardware nuovo

Quando compri la macchina più potente (verosimilmente PC + GPU NVIDIA):

1. Clona il repo sulla macchina nuova
2. Lancia lo script di setup per quella piattaforma (`setup-linux.sh`, da scrivere quando
   servirà — cambia solo il backend: CUDA invece di MPS)
3. Copia le cartelle escluse da git: `models/` e `outputs/` (chiavetta, disco esterno, o
   riscaricando i checkpoint pubblici)
4. Fine

**Cosa si trasferisce senza modifiche:** file LoRA, checkpoint, dataset, definizioni dei
job, script di verifica, progetti Blender, asset generati, progetto Godot. Sono tutti
formati indipendenti dalla piattaforma.

**Cosa va reinstallato (non riportato):** l'ambiente Python e PyTorch, perché la build
cambia tra Apple Silicon (MPS) e NVIDIA (CUDA). Per questo l'installazione è uno script
e non una procedura manuale: reinstallare costa un comando.

> Nota Docker: se in futuro containerizzi gli strumenti, il `Dockerfile` è portabile ma
> le immagini già costruite no — vanno ricostruite passando da arm64 (Mac) a x86 (PC).

---

## Struttura

```
ai-server/
├── setup-macos.sh      # installazione riproducibile
├── run-job.sh          # esecuzione job in coda, uno alla volta
├── checks/             # guardrail: verifiche automatiche dei risultati
├── jobs/
│   ├── pending/        # job da eseguire
│   ├── done/           # completati e verificati
│   └── failed/         # falliti la verifica
├── models/             # [non in git] checkpoint, LoRA — pesanti
└── outputs/            # [non in git] risultati generati
```

---

## Come funziona la coda di job

Un lavoro pesante alla volta (su 8GB non ha senso il contrario). Ogni job è un file JSON
in `jobs/pending/`:

```json
{
  "cmd": "python scripts/genera_immagine.py --prompt 'top-down pixel art park bench' --out outputs/panchina.png",
  "output": "outputs/panchina.png",
  "check": { "min_width": 512, "min_height": 512 }
}
```

- `cmd` — il comando da eseguire (deliberatamente generico: ci metti una chiamata a
  ComfyUI, uno script Blender headless, una conversione `ffmpeg`… quello che serve)
- `output` — il file che il comando deve produrre
- `check` — i vincoli che l'output deve rispettare

Poi:

```bash
./run-job.sh
```

Il runner prende i job uno alla volta, li esegue, **verifica il risultato** con lo script
in `checks/`, e sposta il file in `done/` o `failed/` a seconda dell'esito. Un job che
fallisce la verifica non viene mai dato per buono in silenzio.

Il perché di questa forma: il comando è uno **script deterministico** scritto da te, non
una decisione presa al volo da un modello. Meno latitudine lasci al modello, meno errori
può fare — è il principio che regge tutti i guardrail.
