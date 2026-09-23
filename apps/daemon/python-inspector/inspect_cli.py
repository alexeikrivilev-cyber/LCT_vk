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


def _element(value: dict[str, Any], *, template: bool = False) -> dict[str, Any]:
    placeholder = value.get("placeholder") if template else None
    return {
        "type": value["type"],
        "name": value["name"],
        "elementId": value["element_id"],
        "text": value["text"],
        "placeholderRole": (
            placeholder.get("type") if isinstance(placeholder, dict) else value["placeholder_role"]
        ),
        # Template geometry comes only from the element's raw source coordinates.
        "geometry": _geometry(value.get("raw_geometry") if template else value.get("geometry")),
        "sourcePart": value["source_part"],
    }


def _inspection_observations(value: Any) -> dict[str, Any]:
    slides = [
        {
            "index": slide.index,
            "part": slide.part,
            "layoutPart": slide.layout_part,
            "masterPart": slide.master_part,
            "elements": [_element(element.as_dict()) for element in slide.elements],
        }
        for slide in value.slides
    ]
    library = value.template_library
    masters = [
        {
            "part": master["master_part"],
            "layoutParts": master["layout_parts"],
            "elements": [_element(element, template=True) for element in master["design_elements"]],
        }
        for master in library["masters"]
    ]
    layouts = [
        {
            "part": layout["layout_part"],
            "masterPart": layout["master_part"],
            "elements": [
                _element(element, template=True)
                for element in [*layout["placeholders"], *layout["design_elements"]]
            ],
        }
        for layout in library["layouts"]
    ]
    unsupported_parts = sorted(
        {
            item["part"]
            for item in value.unsupported
            if isinstance(item.get("part"), str)
        }
    )
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
        "unsupportedParts": unsupported_parts,
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