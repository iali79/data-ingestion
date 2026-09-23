"""docstage command line.

    python -m docstage tables --models DIR [--native selected.pdf] [--image p25.png ...] --out tables.json

Runs fully offline: HF_HUB_OFFLINE is forced on, so a missing model fails instead of downloading.
"""

from __future__ import annotations

import argparse
import os
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="docstage")
    commands = parser.add_subparsers(dest="command", required=True)
    tables = commands.add_parser("tables", help="extract page texts and table grids")
    tables.add_argument("--models", required=True, help="directory holding the verified Docling models")
    tables.add_argument("--native", help="PDF of native (text-layer) pages")
    tables.add_argument("--image", action="append", default=[], help="image of one scanned page (repeatable)")
    tables.add_argument("--tesseract", default="tesseract", help="tesseract executable for scanned pages")
    tables.add_argument("--threads", type=int, default=os.cpu_count() or 1)
    tables.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ.setdefault("OMP_NUM_THREADS", str(args.threads))
    if not args.native and not args.image:
        parser.error("nothing to do: give --native and/or --image")

    from .tables import extract_tables, write

    result = extract_tables(args.native, args.image, args.models, args.tesseract, args.threads)
    write(result, args.out)
    print(f"docstage: native pages={len(result['native'])} images={len(result['images'])} seconds={result['seconds']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
