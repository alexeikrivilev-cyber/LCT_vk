# Adapted from EdYaRdx/LCT_2026_hack, commit b065024ac349b04aceac8211cc166274a1978d48.
# Internal, replaceable inspection code; observations are not a product contract.

"""Small replaceable inspection records.

These records intentionally describe observations, not a product contract.
They preserve source part names and source units so a later IR can be chosen
without losing evidence from the package.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


SCHEMA_STATUS = "REPLACEABLE/PROVISIONAL"


@dataclass
class Geometry:
    x: int
    y: int
    width: int
    height: int
    rotation: float = 0.0
    unit: str = "EMU"

    def as_dict(self) -> dict[str, Any]:
        return {
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "rotation": self.rotation,
            "unit": self.unit,
        }


@dataclass
class ElementRecord:
    type: str
    name: str
    element_id: str | None
    geometry: Geometry | None
    text: str = ""
    placeholder_role: str | None = None
    style: dict[str, Any] = field(default_factory=dict)
    relationship: dict[str, Any] | None = None
    source_part: str = ""
    parent_id: str | None = None
    warnings: list[str] = field(default_factory=list)
    effective_geometry: Geometry | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "name": self.name,
            "element_id": self.element_id,
            "geometry": self.geometry.as_dict() if self.geometry else None,
            "effective_geometry": self.effective_geometry.as_dict() if self.effective_geometry else None,
            "text": self.text,
            "placeholder_role": self.placeholder_role,
            "style": self.style,
            "relationship": self.relationship,
            "source_part": self.source_part,
            "parent_id": self.parent_id,
            "warnings": self.warnings,
        }


@dataclass
class SlideRecord:
    index: int
    part: str
    layout_part: str | None
    master_part: str | None
    elements: list[ElementRecord] = field(default_factory=list)
    design_elements: list[ElementRecord] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "part": self.part,
            "layout_part": self.layout_part,
            "master_part": self.master_part,
            "elements": [element.as_dict() for element in self.elements],
            "design_elements": [element.as_dict() for element in self.design_elements],
            "warnings": self.warnings,
        }


@dataclass
class Inspection:
    schema_status: str
    source: str
    slide_size: dict[str, Any]
    slide_count: int
    slides: list[SlideRecord]
    theme: dict[str, Any]
    unsupported: list[dict[str, Any]]
    warnings: list[str] = field(default_factory=list)
    notes_parts: list[str] = field(default_factory=list)
    # The template library is intentionally a raw, replaceable observation
    # surface.  It inventories every slideLayout/slideMaster part, including
    # parts that no current slide references; it is not a renderer contract.
    template_library: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_status": self.schema_status,
            "source": self.source,
            "slide_size": self.slide_size,
            "slide_count": self.slide_count,
            "slides": [slide.as_dict() for slide in self.slides],
            "theme": self.theme,
            "unsupported": self.unsupported,
            "warnings": self.warnings,
            "notes_parts": self.notes_parts,
            "template_library": self.template_library,
        }
