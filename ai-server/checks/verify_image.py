#!/usr/bin/env python3
"""Guardrail: verifica che un'immagine generata sia valida prima di darla per buona.

Deterministico di proposito: a controllare è uno script, non un altro modello AI.
Uscita 0 = passato, 1 = fallito (con il motivo su stderr).

    python3 checks/verify_image.py outputs/panchina.png --min-width 512 --min-height 512
"""

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageStat
except ImportError:
    sys.exit("Pillow non installato: pip install pillow")


def fail(msg: str) -> None:
    print(f"FALLITO: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(description="Verifica un'immagine generata")
    ap.add_argument("path", type=Path)
    ap.add_argument("--min-width", type=int, default=0)
    ap.add_argument("--min-height", type=int, default=0)
    ap.add_argument("--min-bytes", type=int, default=1024)
    ap.add_argument(
        "--min-stddev",
        type=float,
        default=3.0,
        help="deviazione standard minima dei pixel: sotto questa soglia l'immagine "
             "è praticamente uniforme (nera, bianca, o una generazione fallita)",
    )
    args = ap.parse_args()

    if not args.path.is_file():
        fail(f"file inesistente: {args.path}")

    size = args.path.stat().st_size
    if size < args.min_bytes:
        fail(f"file troppo piccolo ({size} byte, minimo {args.min_bytes})")

    try:
        with Image.open(args.path) as img:
            img.verify()                     # struttura del file integra
        with Image.open(args.path) as img:   # verify() consuma il file, riapriamo
            width, height = img.size
            stats = ImageStat.Stat(img.convert("L"))
    except Exception as exc:                 # file corrotto o formato non leggibile
        fail(f"immagine non leggibile: {exc}")

    if width < args.min_width or height < args.min_height:
        fail(f"risoluzione {width}x{height}, attesa almeno "
             f"{args.min_width}x{args.min_height}")

    stddev = stats.stddev[0]
    if stddev < args.min_stddev:
        fail(f"immagine praticamente uniforme (stddev {stddev:.2f} < {args.min_stddev}): "
             "probabile generazione fallita")

    print(f"OK: {args.path} — {width}x{height}, {size} byte, stddev {stddev:.1f}")


if __name__ == "__main__":
    main()
