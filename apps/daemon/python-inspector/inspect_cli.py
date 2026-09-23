"""Private process entrypoint for the replaceable PPTX inspection spike."""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

from lct_inspector.inspect import inspect_pptx


def _geometry(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    return {
        "x": value["x"],
        "y": value["y"],
        "width": value["width"],
        "height": value["height"],
        "rotation": value["rotation"],
        "unit": value["unit"],
    }


def _placeholder_identity(value: Any, *, slide_index: int | None = None) -> dict[str, Any] | None:
    placeholder = value.get("placeholder_identity") if isinstance(value, dict) else None
    if isinstance(value, dict) and "placeholder" in value:
        placeholder = value.get("placeholder")
    if not isinstance(placeholder, dict):
        return None
    return {
        "slideIndex": slide_index,
        "idx": placeholder.get("idx"),
        "type": placeholder.get("type"),
    }


def _relationship(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    return {
        "id": value["id"],
        "type": value["type"],
        "target": value["target"],
        "targetPart": value["targetPart"],
        "mode": value["mode"],
    }


def _observed_element(value: dict[str, Any], *, slide_index: int | None = None) -> dict[str, Any]:
    return {
        "type": value["type"],
        "name": value["name"],
        "elementId": value["element_id"],
        "text": value["text"],
        "placeholderRole": value["placeholder_role"],
        "placeholderIdentity": _placeholder_identity(value, slide_index=slide_index),
        "rawGeometry": _geometry(value["geometry"]),
        "resolvedGeometry": None if value["geometry_resolution_unknown"] else _geometry(value["effective_geometry"] or value["geometry"]),
        "geometryProvenance": "unknown" if value["geometry_resolution_unknown"] else ("group_transformed" if value["effective_geometry"] else ("direct" if value["geometry"] else "unknown")),
        "geometryResolutionUnknown": value["geometry_resolution_unknown"],
        "style": value["style"],
        "relationship": _relationship(value["relationship"]),
        "sourcePart": value["source_part"],
        "parentId": value["parent_id"],
        "warnings": value["warnings"],
        "sourceOrder": value["source_order"],
    }


def _template_element(value: dict[str, Any]) -> dict[str, Any]:
    placeholder = value.get("placeholder")
    role = placeholder.get("type") if isinstance(placeholder, dict) else value["placeholder_role"]
    return {
        "type": value["type"],
        "name": value["name"],
        "elementId": value["element_id"],
        "text": value["text"],
        "placeholderRole": role,
        "placeholderIdentity": _placeholder_identity(value),
        "rawGeometry": _geometry(value.get("raw_geometry")),
        "resolvedGeometry": None if value.get("geometry_resolution_unknown", False) else _geometry(value.get("resolved_geometry")),
        "geometryProvenance": "unknown" if value.get("geometry_resolution_unknown", False) else value.get("geometry_provenance", "unknown"),
        "geometryResolutionUnknown": value.get("geometry_resolution_unknown", False),
        "style": value["style"],
        "relationship": _relationship(value.get("relationship")),
        "sourcePart": value["source_part"],
        "parentId": value["parent_id"],
        "warnings": value["warnings"],
        "sourceOrder": value["source_order"],
    }


def _relationship_records(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "id": value["id"],
            "type": value["type"],
            "target": value["target"],
            "targetPart": value["targetPart"],
            "mode": value["mode"],
        }
        for value in values
    ]


def _inspection_observations(value: Any) -> dict[str, Any]:
    slides = [
        {
            "index": slide.index,
            "part": slide.part,
            "layoutPart": slide.layout_part,
            "masterPart": slide.master_part,
            "elements": [_observed_element(element.as_dict(), slide_index=slide.index) for element in slide.elements],
            "designElements": [_observed_element(element.as_dict(), slide_index=slide.index) for element in slide.design_elements],
            "relationships": _relationship_records(slide.relationships),
            "background": slide.background,
            "warnings": slide.warnings,
        }
        for slide in value.slides
    ]
    library = value.template_library
    masters = [
        {
            "part": master["master_part"],
            "declaredName": master["declared_name"],
            "layoutParts": master["layout_parts"],
            "elements": [_template_element(element) for element in master["design_elements"]],
            "designElements": [_template_element(element) for element in master["design_elements"]],
            "relationships": _relationship_records(master["relationships"]),
            "background": master["background"],
            "colorMapping": master["color_mapping"],
        }
        for master in library["masters"]
    ]
    layouts = [
        {
            "part": layout["layout_part"],
            "masterPart": layout["master_part"],
            "declaredName": layout["declared_name"],
            "declaredType": layout["declared_type"],
            "matchingName": layout["matching_name"],
            "preserve": layout["preserve"],
            "placeholders": [_template_element(element) for element in layout["placeholders"]],
            "elements": [_template_element(element) for element in layout["elements"]],
            "designElements": [_template_element(element) for element in layout["design_elements"]],
            "relationships": _relationship_records(layout["relationships"]),
            "background": layout["background"],
            "colorMapping": layout["color_mapping"],
        }
        for layout in library["layouts"]
    ]
    unsupported_details = [dict(item) for item in value.unsupported]
    return {
        "schemaStatus": value.schema_status,
        "slideSize": {
            "width": value.slide_size["width"],
            "height": value.slide_size["height"],
            "unit": value.slide_size["unit"],
        },
        "slides": slides,
        "masters": masters,
        "layouts": layouts,
        "theme": value.theme,
        "notesParts": sorted(value.notes_parts),
        "mediaParts": sorted(value.media_parts),
        "unsupportedDetails": unsupported_details,
        "parserWarnings": sorted(set(value.warnings)),
    }


def main() -> int:
    if len(sys.argv) != 2 or not os.path.isabs(sys.argv[1]):
        print("expected one absolute PPTX path argument", file=sys.stderr)
        return 2
    try:
        started = time.perf_counter()
        inspection = inspect_pptx(sys.argv[1])
    except ValueError as exc:
        message = str(exc).replace("\r", " ").replace("\n", " ")[:1024]
        print("LCT_INPUT_ERROR:" + (message or "invalid PPTX input"), file=sys.stderr)
        return 2
    except OSError as exc:
        message = str(exc).replace("\r", " ").replace("\n", " ")[:1024]
        print("LCT_IO_ERROR:" + (message or "PPTX input could not be read"), file=sys.stderr)
        return 4
    except Exception:
        print("internal inspector failure", file=sys.stderr)
        return 3
    try:
        observations = _inspection_observations(inspection)
        elapsed_ms = (time.perf_counter() - started) * 1000
        envelope = {
            "protocolVersion": 1,
            "schemaStatus": "REPLACEABLE/PROVISIONAL",
            "inspectionMs": elapsed_ms,
            "inspection": observations,
        }
        json.dump(envelope, sys.stdout, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        sys.stdout.write("\n")
        return 0
    except Exception:
        print("internal inspector failure", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
