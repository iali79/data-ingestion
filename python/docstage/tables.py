"""Stage 4 -- table extraction with Docling, on the selected pages only.

Two inputs, because the two kinds of page need opposite treatment:

- native pages arrive as one PDF (the selected pages cut out of the filing). Docling reads the PDF's
  own text cells -- exact characters, no OCR -- and its layout model and TableFormer recover the
  table grid.
- scanned pages arrive as images rendered from the filing. A scanned page often carries a partial
  text layer on top (a page number, a caption or two); given the PDF, the converter trusts that
  overlay and loses the table. Given only the pixels, it OCRs the whole page.

The output is deliberately generic -- page texts and table cells with positions, nothing about
finance -- so this stage can be reused and tested on its own. It never reaches the network: models
are read from a local directory that the caller has verified.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

# Layout labels kept as page texts: titles, headings and prose carry the statement name, the
# period ("For the year ended ...") and the unit ("Rupees in '000"). Pictures (charts, logos,
# signatures) are dropped here.
TEXT_LABELS = {"title", "section_header", "text", "caption", "page_header", "list_item", "footnote"}


def _converters(models: str, tesseract: str, threads: int, want_pdf: bool, want_images: bool):
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode, TesseractCliOcrOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

    def options(ocr: bool) -> PdfPipelineOptions:
        opts = PdfPipelineOptions(artifacts_path=models, do_ocr=ocr, do_table_structure=True, document_timeout=600)
        opts.table_structure_options.mode = TableFormerMode.ACCURATE
        opts.table_structure_options.do_cell_matching = True
        opts.accelerator_options.num_threads = threads
        if ocr:
            opts.ocr_options = TesseractCliOcrOptions(lang=["eng"], force_full_page_ocr=True, tesseract_cmd=tesseract)
        return opts

    pdf = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options(False))}) if want_pdf else None
    image = DocumentConverter(format_options={InputFormat.IMAGE: ImageFormatOption(pipeline_options=options(True))}) if want_images else None
    return pdf, image


def _box(bbox: Any, page_height: float) -> list[float]:
    top_left = bbox.to_top_left_origin(page_height=page_height)
    return [round(top_left.l, 1), round(top_left.t, 1), round(top_left.r, 1), round(top_left.b, 1)]


def _pages(document: Any) -> dict[int, dict[str, Any]]:
    """Every page's texts and tables, keyed by the converter's page number (1-based)."""
    pages: dict[int, dict[str, Any]] = {}
    for number, page in document.pages.items():
        pages[number] = {"width": round(page.size.width, 1), "height": round(page.size.height, 1), "texts": [], "tables": []}
    for item, _level in document.iterate_items():
        provenance = item.prov[0] if getattr(item, "prov", None) else None
        if provenance is None or provenance.page_no not in pages:
            continue
        page = pages[provenance.page_no]
        label = str(item.label)
        if label == "table":
            data = item.data
            page["tables"].append(
                {
                    "bbox": _box(provenance.bbox, page["height"]),
                    "rows": data.num_rows,
                    "cols": data.num_cols,
                    "cells": [
                        {
                            "row": cell.start_row_offset_idx,
                            "col": cell.start_col_offset_idx,
                            "rowSpan": cell.row_span,
                            "colSpan": cell.col_span,
                            "text": cell.text,
                            "columnHeader": bool(cell.column_header),
                            "rowHeader": bool(cell.row_header),
                            "rowSection": bool(cell.row_section),
                        }
                        for cell in data.table_cells
                    ],
                }
            )
        elif label in TEXT_LABELS:
            text = getattr(item, "text", "")
            if text:
                page["texts"].append({"label": label, "text": text, "bbox": _box(provenance.bbox, page["height"])})
    return pages


def extract_tables(native_pdf: str | None, images: list[str], models: str, tesseract: str, threads: int) -> dict[str, Any]:
    started = time.monotonic()
    pdf, image = _converters(models, tesseract, threads, native_pdf is not None, len(images) > 0)
    out: dict[str, Any] = {"schemaVersion": SCHEMA_VERSION, "native": [], "images": [], "seconds": {}}
    if pdf is not None and native_pdf is not None:
        tick = time.monotonic()
        document = pdf.convert(native_pdf).document
        out["native"] = [{"index": number, **page} for number, page in sorted(_pages(document).items())]
        out["seconds"]["native"] = round(time.monotonic() - tick, 1)
    if image is not None:
        tick = time.monotonic()
        for path in images:
            document = image.convert(path).document
            pages = _pages(document)
            first = pages[min(pages)] if pages else {"width": 0, "height": 0, "texts": [], "tables": []}
            out["images"].append({"file": Path(path).name, **first})
        out["seconds"]["images"] = round(time.monotonic() - tick, 1)
    out["seconds"]["total"] = round(time.monotonic() - started, 1)
    return out


def write(result: dict[str, Any], path: str) -> None:
    Path(path).write_text(json.dumps(result, ensure_ascii=False))
