# Adapted from EdYaRdx/LCT_2026_hack, commit b065024ac349b04aceac8211cc166274a1978d48.
# Internal, replaceable inspection code; observations are not a product contract.

"""Direct OOXML/ZIP inspection for observations needed by the foundation."""

from __future__ import annotations

import posixpath
import re
import math
import zipfile
import zlib
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable
from xml.etree import ElementTree as ET

from .model import ElementRecord, Geometry, Inspection, SlideRecord, SCHEMA_STATUS


_REL_NS = {"rel": "http://schemas.openxmlformats.org/package/2006/relationships"}
_TRANSITIONAL = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
_STRICT = {
    "a": "http://purl.oclc.org/ooxml/drawingml/main",
    "c": "http://purl.oclc.org/ooxml/drawingml/chart",
    "p": "http://purl.oclc.org/ooxml/presentationml/main",
    "r": "http://purl.oclc.org/ooxml/officeDocument/relationships",
}
@dataclass(frozen=True)
class _NamespaceProfile:
    ns: dict[str, str]
    r_id: str
    r_embed: str
    r_link: str


def _make_profile(profile: dict[str, str]) -> _NamespaceProfile:
    return _NamespaceProfile(
        ns={**profile, **_REL_NS},
        r_id="{" + profile["r"] + "}id",
        r_embed="{" + profile["r"] + "}embed",
        r_link="{" + profile["r"] + "}link",
    )


_TRANSITIONAL_PROFILE = _make_profile(_TRANSITIONAL)
_STRICT_PROFILE = _make_profile(_STRICT)
_PROFILE: ContextVar[_NamespaceProfile] = ContextVar("pptx_namespace_profile", default=_TRANSITIONAL_PROFILE)
_XML_BYTES_READ: ContextVar[int] = ContextVar("pptx_xml_bytes_read", default=0)

# Provisional engineering caps based on the daemon's 64 MiB per-upload ceiling.
_MAX_SOURCE_BYTES = 64 * 1024 * 1024
_MAX_ARCHIVE_MEMBERS = 4096
_MAX_EXPANDED_BYTES = 256 * 1024 * 1024
_MAX_PART_BYTES = 64 * 1024 * 1024
_MAX_XML_READ_BYTES = 256 * 1024 * 1024
_XML_READ_CHUNK_BYTES = 64 * 1024


def _profile() -> _NamespaceProfile:
    return _PROFILE.get()


def _ns() -> dict[str, str]:
    return _profile().ns


def _configure_namespace_profile(root: ET.Element) -> _NamespaceProfile:
    return _STRICT_PROFILE if root.tag.startswith("{" + _STRICT["p"] + "}") else _TRANSITIONAL_PROFILE


Affine = tuple[float, float, float, float]


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _part_target(source: str, target: str) -> str:
    if not target or "\\" in target or "\x00" in target or "?" in target or "#" in target:
        raise ValueError(f"invalid internal relationship target: {target!r}")
    if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target):
        raise ValueError(f"internal relationship target has a URI scheme: {target!r}")
    rooted = target.startswith("/")
    resolved = posixpath.normpath(target.lstrip("/") if rooted else posixpath.join(posixpath.dirname(source), target))
    if resolved in {"", ".", ".."} or resolved.startswith("../") or resolved.startswith("/"):
        raise ValueError(f"internal relationship target escapes package root: {target!r}")
    return resolved


def _rels_path(part: str) -> str:
    path = PurePosixPath(part)
    return str(path.parent / "_rels" / f"{path.name}.rels")


def _read_xml(zf: zipfile.ZipFile, part: str) -> ET.Element:
    info = zf.getinfo(part)
    if info.file_size > _MAX_PART_BYTES:
        raise ValueError(f"XML part exceeds {_MAX_PART_BYTES} byte limit: {part}")
    bytes_before = _XML_BYTES_READ.get()
    if bytes_before + info.file_size > _MAX_XML_READ_BYTES:
        raise ValueError(f"XML reads exceed {_MAX_XML_READ_BYTES} byte limit")
    actual_limit = min(_MAX_PART_BYTES, _MAX_XML_READ_BYTES - bytes_before)
    data = bytearray()
    # ZipExtFile.read() without a size may ask zlib to produce up to its large
    # MAX_N in one call. Fixed-size reads cap each decompressor output chunk;
    # the byte counters below enforce limits on bytes actually returned.
    with zf.open(part) as source:
        while True:
            remaining = actual_limit - len(data)
            chunk = source.read(min(_XML_READ_CHUNK_BYTES, remaining + 1))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > actual_limit:
                raise ValueError(f"XML reads exceed byte limit while reading: {part}")
    _XML_BYTES_READ.set(bytes_before + len(data))
    data = bytes(data)
    # Reject DTDs before ElementTree parses them; null removal also catches UTF-16/32 markup.
    if re.search(br"<!\s*DOCTYPE\b", data.replace(b"\x00", b""), re.IGNORECASE):
        raise ValueError(f"DTD is not allowed in OOXML part: {part}")
    return ET.fromstring(data)


def _validate_archive(zf: zipfile.ZipFile, path: str) -> list[str]:
    source_size = Path(path).stat().st_size
    if source_size > _MAX_SOURCE_BYTES:
        raise ValueError(f"PPTX exceeds {_MAX_SOURCE_BYTES} byte source limit")
    infos = zf.infolist()
    if len(infos) > _MAX_ARCHIVE_MEMBERS:
        raise ValueError(f"PPTX exceeds {_MAX_ARCHIVE_MEMBERS} ZIP member limit")
    names: list[str] = []
    seen: set[str] = set()
    expanded_bytes = 0
    for info in infos:
        name = info.filename
        part_name = name[:-1] if info.is_dir() else name
        # zipfile bounds DEFLATE output while reading, but its BZIP2/LZMA
        # readers can materialize a decompressed chunk before our byte caps
        # apply. PPTX commonly uses stored/DEFLATE parts; reject other codecs.
        if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
            raise ValueError(f"unsupported ZIP compression method {info.compress_type}: {part_name}")
        if (not part_name or part_name.startswith("/") or "\\" in part_name
                or "\x00" in part_name or any(segment in {"", ".", ".."} for segment in part_name.split("/"))
                or ":" in part_name.split("/", 1)[0]):
            raise ValueError(f"unsafe ZIP member name: {name!r}")
        if part_name in seen:
            raise ValueError(f"duplicate ZIP member name: {part_name!r}")
        seen.add(part_name)
        if info.file_size > _MAX_PART_BYTES:
            raise ValueError(f"ZIP member exceeds {_MAX_PART_BYTES} byte limit: {part_name}")
        expanded_bytes += info.file_size
        if expanded_bytes > _MAX_EXPANDED_BYTES:
            raise ValueError(f"PPTX exceeds {_MAX_EXPANDED_BYTES} byte expanded-size limit")
        if not info.is_dir():
            names.append(part_name)
    return sorted(names)


def _relationships(zf: zipfile.ZipFile, part: str) -> dict[str, tuple[str, str | None, str, str, str]]:
    rels_part = _rels_path(part)
    if rels_part not in zf.namelist():
        return {}
    root = _read_xml(zf, rels_part)
    result: dict[str, tuple[str, str | None, str, str, str]] = {}
    for rel in root.findall("rel:Relationship", _ns()):
        rel_id = rel.get("Id")
        if not rel_id:
            raise ValueError(f"relationship part {rels_part} contains a relationship without Id")
        if rel_id in result:
            raise ValueError(f"relationship part {rels_part} contains duplicate relationship Id {rel_id!r}")
        target = rel.get("Target", "")
        target_mode = rel.get("TargetMode")
        if target_mode not in {None, "External"}:
            raise ValueError(f"relationship part {rels_part} contains unsupported TargetMode {target_mode!r}")
        mode = "external" if target_mode == "External" else "internal"
        # External targets are URLs and must not be normalized as package paths.
        target_part = None if mode == "external" else _part_target(part, target)
        full_type = rel.get("Type", "")
        result[rel_id] = (full_type.rsplit("/", 1)[-1], target_part, mode, full_type, target)
    return result


def _emu(value: str | None) -> int:
    if value is None:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid EMU value: {value!r}") from exc


def _geometry(sppr: ET.Element | None) -> Geometry | None:
    if sppr is None:
        return None
    xfrm = sppr if _tag(sppr) == "xfrm" else sppr.find("a:xfrm", _ns())
    if xfrm is None:
        return None
    off = xfrm.find("a:off", _ns())
    ext = xfrm.find("a:ext", _ns())
    if off is None or ext is None:
        return None
    try:
        rotation = float(xfrm.get("rot", "0")) / 60000.0
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid rotation value: {xfrm.get('rot')!r}") from exc
    if not math.isfinite(rotation):
        raise ValueError(f"invalid rotation value: {xfrm.get('rot')!r}")
    return Geometry(
        x=_emu(off.get("x")),
        y=_emu(off.get("y")),
        width=_emu(ext.get("cx")),
        height=_emu(ext.get("cy")),
        rotation=rotation,
    )


def _group_affine(element: ET.Element) -> Affine | None:
    xfrm = element.find("p:grpSpPr/a:xfrm", _ns())
    if xfrm is None:
        return None
    if xfrm.get("rot", "0") not in {"0", "0.0"} or xfrm.get("flipH", "0") in {"1", "true", "True"} or xfrm.get("flipV", "0") in {"1", "true", "True"}:
        return None
    off = xfrm.find("a:off", _ns())
    ext = xfrm.find("a:ext", _ns())
    child_off = xfrm.find("a:chOff", _ns())
    child_ext = xfrm.find("a:chExt", _ns())
    if any(node is None for node in (off, ext, child_off, child_ext)):
        return None
    child_width = _emu(child_ext.get("cx"))
    child_height = _emu(child_ext.get("cy"))
    if child_width == 0 or child_height == 0:
        return None
    scale_x = _emu(ext.get("cx")) / child_width
    scale_y = _emu(ext.get("cy")) / child_height
    return (
        scale_x,
        scale_y,
        _emu(off.get("x")) - scale_x * _emu(child_off.get("x")),
        _emu(off.get("y")) - scale_y * _emu(child_off.get("y")),
    )


def _compose_affine(parent: Affine | None, local: Affine | None) -> Affine | None:
    if parent is None:
        return local
    if local is None:
        return parent
    parent_x, parent_y, parent_tx, parent_ty = parent
    local_x, local_y, local_tx, local_ty = local
    return (
        parent_x * local_x,
        parent_y * local_y,
        parent_x * local_tx + parent_tx,
        parent_y * local_ty + parent_ty,
    )


def _apply_affine(geometry: Geometry | None, transform: Affine | None) -> Geometry | None:
    if geometry is None or transform is None:
        return geometry
    scale_x, scale_y, translate_x, translate_y = transform
    return Geometry(
        x=round(translate_x + geometry.x * scale_x),
        y=round(translate_y + geometry.y * scale_y),
        width=round(geometry.width * scale_x),
        height=round(geometry.height * scale_y),
        rotation=geometry.rotation,
    )


def _text(element: ET.Element) -> str:
    paragraphs = []
    for paragraph in element.findall(".//a:p", _ns()):
        paragraphs.append("".join(node.text or "" for node in paragraph.findall(".//a:t", _ns())))
    return "\n".join(paragraphs)


def _color(parent: ET.Element | None) -> str | None:
    if parent is None:
        return None
    color_tags = {"srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr", "hslClr"}
    for color in parent.iter():
        color_type = _tag(color)
        if color_type not in color_tags:
            continue
        attributes = dict(color.attrib)
        if color_type == "srgbClr":
            return attributes.get("val")
        if color_type == "schemeClr":
            return f"scheme:{attributes['val']}" if attributes.get("val") else None
        if color_type == "sysClr":
            name = attributes.get("val")
            fallback = attributes.get("lastClr")
            if name:
                return f"system:{name}/{fallback}" if fallback else f"system:{name}"
            return None
        if color_type == "prstClr":
            return f"preset:{attributes['val']}" if attributes.get("val") else None
        return f"{color_type}:" + ",".join(f"{key}={value}" for key, value in sorted(attributes.items()))
    return None


def _style(element: ET.Element) -> dict[str, object]:
    style: dict[str, object] = {}
    body = element.find(".//p:txBody", _ns())
    if body is not None:
        runs = body.findall(".//a:r", _ns())
        fonts: list[str] = []
        sizes: list[float] = []
        bold = False
        italic = False
        for run in runs:
            props = run.find("a:rPr", _ns())
            if props is None:
                continue
            if props.get("b") == "1":
                bold = True
            if props.get("i") == "1":
                italic = True
            if props.get("sz"):
                sizes.append(int(props.get("sz", "0")) / 100.0)
            latin = props.find("a:latin", _ns())
            if latin is not None and latin.get("typeface"):
                fonts.append(latin.get("typeface", ""))
        if fonts:
            style["fonts"] = sorted(set(fonts))
        if sizes:
            style["font_sizes_pt"] = sorted(set(sizes))
        if bold:
            style["bold"] = True
        if italic:
            style["italic"] = True
    style["fill_color"] = _color(element.find("p:spPr/a:solidFill", _ns()))
    style["line_color"] = _color(element.find("p:spPr/a:ln/a:solidFill", _ns()))
    return {key: value for key, value in style.items() if value is not None}


def _placeholder(element: ET.Element) -> str | None:
    ph = element.find("p:nvSpPr/p:nvPr/p:ph", _ns())
    if ph is None:
        return None
    return ph.get("type", "body")


def _name_id(element: ET.Element) -> tuple[str, str | None]:
    c_nv = None
    for path in ("p:nvSpPr/p:cNvPr", "p:nvPicPr/p:cNvPr", "p:nvGraphicFramePr/p:cNvPr", "p:nvGrpSpPr/p:cNvPr"):
        c_nv = element.find(path, _ns())
        if c_nv is not None:
            break
    if c_nv is None:
        return (_tag(element), None)
    return (c_nv.get("name", _tag(element)), c_nv.get("id"))


def _record_element(
    element: ET.Element,
    slide_part: str,
    rels: dict[str, tuple[str, str | None, str, str, str]],
    parent_id: str | None = None,
    inherited_geometry: Geometry | None = None,
    parent_transform: Affine | None = None,
    parent_transform_known: bool = True,
    slide_index: int | None = None,
    source_order: int = 0,
) -> Iterable[ElementRecord]:
    tag = _tag(element)
    name, element_id = _name_id(element)
    if tag == "graphicFrame":
        source_sppr = element.find("p:xfrm", _ns())
    elif tag == "grpSp":
        source_sppr = element.find("p:grpSpPr", _ns())
    else:
        source_sppr = element.find("p:spPr", _ns())
    geometry = _geometry(source_sppr)
    if geometry is None:
        geometry = inherited_geometry
    effective_geometry = _apply_affine(geometry, parent_transform) if parent_transform_known else None
    text = _text(element)
    warnings: list[str] = []
    relationship = None
    element_type = {
        "sp": "shape",
        "pic": "image",
        "graphicFrame": "graphic_frame",
        "grpSp": "group",
        "cxnSp": "connector",
        "contentPart": "content_part",
    }.get(tag, "unsupported")
    if tag == "pic":
        blip = element.find(".//a:blip", _ns())
        rel_id = None
        relation_mode = None
        if blip is not None:
            rel_id = blip.get(_profile().r_embed)
            if rel_id is None:
                rel_id = blip.get(_profile().r_link)
                relation_mode = "external"
        if rel_id and rel_id in rels:
            rel_type, target_part, mode, full_type, raw_target = rels[rel_id]
            relationship = {"id": rel_id, "type": full_type, "target": raw_target, "targetPart": target_part, "mode": mode}
            if relation_mode:
                relationship["mode"] = relation_mode
    elif tag == "graphicFrame":
        graphic_data = element.find(".//a:graphicData", _ns())
        uri = graphic_data.get("uri") if graphic_data is not None else None
        if uri and "table" in uri:
            element_type = "table"
        elif element.find(".//c:chart", _ns()) is not None:
            element_type = "chart"
            chart = element.find(".//c:chart", _ns())
            rel_id = chart.get(_profile().r_id) if chart is not None else None
            if rel_id and rel_id in rels:
                rel_type, target_part, mode, full_type, raw_target = rels[rel_id]
                relationship = {"id": rel_id, "type": full_type, "target": raw_target, "targetPart": target_part, "mode": mode}
        else:
            warnings.append("graphic frame subtype was not recognized")
    elif tag == "contentPart":
        warnings.append("content part is detected but not interpreted")
    elif element_type == "unsupported":
        warnings.append(f"unsupported slide object tag: {tag}")
    group_transform = None
    group_transform_known = parent_transform_known
    if tag == "grpSp":
        local_transform = _group_affine(element)
        if local_transform is None:
            warnings.append("group transform is incomplete or uses rotation/reflection; child resolved geometry is unknown")
            group_transform_known = False
        elif parent_transform_known:
            group_transform = _compose_affine(parent_transform, local_transform)
        else:
            group_transform_known = False

    record = ElementRecord(
        type=element_type,
        name=name,
        element_id=element_id,
        geometry=geometry,
        text=text,
        placeholder_role=_placeholder(element),
        placeholder_identity=_placeholder_observation(element, slide_index=slide_index),
        style=_style(element),
        relationship=relationship,
        source_part=slide_part,
        parent_id=parent_id,
        warnings=warnings,
        effective_geometry=effective_geometry if parent_transform is not None else None,
        geometry_resolution_unknown=not parent_transform_known,
        source_order=source_order,
    )
    yield record
    if tag == "grpSp":
        for child_order, child in enumerate(element):
            if _tag(child) in {"nvGrpSpPr", "grpSpPr", "extLst"}:
                continue
            yield from _record_element(
                child, slide_part, rels, parent_id=element_id, parent_transform=group_transform,
                parent_transform_known=group_transform_known, slide_index=slide_index, source_order=child_order,
            )


def _theme(
    zf: zipfile.ZipFile,
    parts: list[str],
    presentation_rels: dict[str, tuple[str, str | None, str, str, str]],
    master_parts: list[str],
) -> dict[str, object] | None:
    relationships = list(presentation_rels.values())
    for master_part in master_parts:
        relationships.extend(_relationships(zf, master_part).values())
    theme_links = [(target, mode) for rel_type, target, mode, _full_type, _raw_target in relationships if rel_type == "theme"]
    if any(mode != "internal" or target is None or target not in parts or not target.startswith("ppt/theme/") for target, mode in theme_links):
        return None
    themes = sorted({target for target, _mode in theme_links})
    if len(themes) != 1:
        return None
    root = _read_xml(zf, themes[0])
    clr_scheme = root.find(".//a:clrScheme", _ns())
    colors: dict[str, str] = {}
    if clr_scheme is not None:
        for child in list(clr_scheme):
            value = next(iter(child), None)
            color_value = value.get("lastClr") if value is not None and value.get("lastClr") else value.get("val") if value is not None else None
            if color_value:
                colors[_tag(child)] = color_value
    fonts: dict[str, str] = {}
    font_scheme = root.find(".//a:fontScheme", _ns())
    if font_scheme is not None:
        for branch_name, path in (("major", "a:majorFont"), ("minor", "a:minorFont")):
            latin = font_scheme.find(f"{path}/a:latin", _ns())
            if latin is not None and latin.get("typeface"):
                fonts[branch_name] = latin.get("typeface", "")
    return {"part": themes[0], "colors": colors, "fonts": fonts}


def _placeholder_key(element: ET.Element) -> tuple[str | None, str]:
    placeholder = element.find("p:nvSpPr/p:nvPr/p:ph", _ns())
    if placeholder is None:
        return None, ""
    return placeholder.get("idx"), placeholder.get("type", "body")


def _placeholder_observation(element: ET.Element, *, slide_index: int | None = None) -> dict[str, str | int | None] | None:
    """Return the stable placeholder identity used by layout inheritance."""

    idx, role = _placeholder_key(element)
    if not role:
        return None
    return {"slideIndex": slide_index, "idx": idx, "type": role}


def _relationship_observations(zf: zipfile.ZipFile, part: str) -> list[dict[str, object]]:
    return [
        {"id": rel_id, "type": full_type, "target": raw_target, "targetPart": target_part, "mode": mode}
        for rel_id, (_rel_type, target_part, mode, full_type, raw_target) in sorted(_relationships(zf, part).items())
    ]


def _internal_targets(
    relationships: dict[str, tuple[str, str | None, str, str, str]],
    kind: str,
    context: str,
) -> list[str]:
    targets: list[str] = []
    for rel_type, target_part, mode, _full_type, raw_target in relationships.values():
        if rel_type != kind:
            continue
        if mode != "internal" or target_part is None:
            raise ValueError(f"{context} has an external {kind} relationship: {raw_target!r}")
        targets.append(target_part)
    return targets


def _background_fill_observation(
    fill: ET.Element | None,
    rels: dict[str, tuple[str, str | None, str, str, str]],
) -> dict[str, object] | None:
    if fill is None:
        return None
    colors: list[dict[str, object]] = []
    color_tags = {"srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr", "hslClr"}

    def visit(element: ET.Element, position: str | None = None) -> None:
        current_position = element.get("pos") if _tag(element) == "gs" else position
        if _tag(element) in color_tags:
            colors.append({
                "type": _tag(element),
                "attributes": dict(sorted(element.attrib.items())),
                "position": current_position,
            })
        for child in list(element):
            visit(child, current_position)

    visit(fill)
    relation: dict[str, object] | None = None
    blip = fill.find(".//a:blip", _ns())
    if blip is not None:
        rel_id = blip.get(_profile().r_embed) or blip.get(_profile().r_link)
        if rel_id and rel_id in rels:
            rel_type, target_part, mode, full_type, raw_target = rels[rel_id]
            relation = {
                "id": rel_id,
                "type": full_type,
                "target": raw_target,
                "targetPart": target_part,
                "mode": mode,
            }
    return {
        "kind": _tag(fill),
        "attributes": dict(sorted(fill.attrib.items())),
        "colors": colors,
        "relationship": relation,
    }


def _background_observation(
    root: ET.Element,
    rels: dict[str, tuple[str, str | None, str, str, str]],
) -> dict[str, object] | None:
    background = root.find("p:cSld/p:bg", _ns())
    if background is None:
        return None
    ref = background.find("p:bgRef", _ns())
    if ref is not None:
        color = ref.find("a:schemeClr", _ns())
        return {
            "kind": "bgRef",
            "idx": ref.get("idx"),
            "scheme_color": color.get("val") if color is not None else None,
            "scheme_color_type": _tag(color) if color is not None else None,
            "fill": None,
        }
    properties = background.find("p:bgPr", _ns())
    fill = next(iter(properties), None) if properties is not None else None
    return {
        "kind": "explicit",
        "element": _tag(fill) if fill is not None else "unknown",
        "fill": _background_fill_observation(fill, rels),
    }


def _color_mapping_observation(root: ET.Element) -> dict[str, object] | None:
    mapping = root.find("p:clrMap", _ns())
    override = root.find("p:clrMapOvr", _ns())
    result: dict[str, object] = {}
    if mapping is not None:
        result["master_mapping"] = dict(sorted(mapping.attrib.items()))
    if override is not None:
        result["layout_override"] = [
            {"element": _tag(child), "attributes": dict(sorted(child.attrib.items()))}
            for child in list(override)
        ]
    return result or None


def _template_element_observation(
    record: ElementRecord,
    *,
    master_root: ET.Element | None = None,
) -> dict[str, object]:
    """Serialize one master/layout shape with its direct and resolved evidence."""
    direct = record.geometry
    placeholder = record.placeholder_identity
    if record.geometry_resolution_unknown:
        resolved = None
        provenance = "unknown"
    elif record.effective_geometry is not None:
        resolved = record.effective_geometry
        provenance = "group_transformed"
    elif direct is not None:
        resolved = direct
        provenance = "layout_explicit"
    elif placeholder and record.parent_id is None:
        resolved = _placeholder_geometry(master_root, (placeholder["idx"], placeholder["type"] or ""))
        provenance = "master_inherited" if resolved else "unknown"
    else:
        resolved = None
        provenance = "unknown"
    return {
        "schema_status": SCHEMA_STATUS,
        **record.as_dict(),
        "placeholder": placeholder,
        "raw_geometry": direct.as_dict() if direct else None,
        "resolved_geometry": resolved.as_dict() if resolved else None,
        "geometry_provenance": provenance,
    }


def _template_shapes(
    root: ET.Element | None,
    source_part: str,
    rels: dict[str, tuple[str, str | None, str, str, str]],
    *,
    master_root: ET.Element | None = None,
) -> list[dict[str, object]]:
    if root is None:
        return []
    tree = root.find("p:cSld/p:spTree", _ns())
    if tree is None:
        return []
    observations: list[dict[str, object]] = []
    source_order = 0
    for child in tree:
        if _tag(child) in {"nvGrpSpPr", "grpSpPr", "extLst"}:
            continue
        for record in _record_element(child, source_part, rels, source_order=source_order):
            record.source_order = len(observations)
            observations.append(_template_element_observation(record, master_root=master_root))
        source_order = len(observations)
    return observations


def _template_library(
    zf: zipfile.ZipFile,
    parts: list[str],
    presentation: ET.Element,
    presentation_rels: dict[str, tuple[str, str | None, str, str, str]],
    slide_size: dict[str, int | str],
) -> dict[str, object]:
    """Inventory all masters/layouts independently of slide instances.

    This deliberately returns plain observations.  Classification and matching
    remain in ``layout_grammar`` so this inspector cannot freeze a renderer or
    external API while the final TZ is still unknown.
    """

    listed_masters: list[str] = []
    for master_id in presentation.findall("p:sldMasterIdLst/p:sldMasterId", _ns()):
        rel_id = master_id.get(_profile().r_id)
        if rel_id and rel_id in presentation_rels:
            rel_type, target, mode, _full_type, raw_target = presentation_rels[rel_id]
            if rel_type != "slideMaster" or mode != "internal" or target is None:
                raise ValueError(f"presentation master relationship {rel_id!r} is invalid: {raw_target!r}")
            if target in parts and target not in listed_masters:
                listed_masters.append(target)
    master_parts = sorted(set(listed_masters) | {part for part in parts if part.startswith("ppt/slideMasters/") and part.endswith(".xml")})
    layout_parts = sorted(part for part in parts if part.startswith("ppt/slideLayouts/") and part.endswith(".xml"))

    master_roots: dict[str, ET.Element] = {part: _read_xml(zf, part) for part in master_parts}
    master_rels: dict[str, dict[str, tuple[str, str | None, str, str, str]]] = {part: _relationships(zf, part) for part in master_parts}
    layout_master: dict[str, str] = {}
    for layout_part in layout_parts:
        rels = _relationships(zf, layout_part)
        master_targets = _internal_targets(rels, "slideMaster", f"layout {layout_part}")
        if len(master_targets) > 1:
            raise ValueError(f"layout {layout_part} has multiple slide master relationships")
        master = master_targets[0] if master_targets else None
        if master:
            if master is None:
                raise ValueError(f"layout {layout_part} has external slide master relationship")
            if not master.startswith("ppt/slideMasters/") or master not in parts:
                raise ValueError(f"layout {layout_part} points to missing or invalid master part: {master}")
            layout_master[layout_part] = master
    for master_part, rels in master_rels.items():
        for rel_type, target, mode, _full_type, raw_target in rels.values():
            if rel_type == "slideLayout":
                if mode != "internal" or target is None or not target.startswith("ppt/slideLayouts/") or target not in layout_parts:
                    raise ValueError(f"master {master_part} points to missing or invalid layout part: {target}")
                layout_master.setdefault(target, master_part)

    masters: list[dict[str, object]] = []
    master_design: dict[str, list[dict[str, object]]] = {}
    for master_part in master_parts:
        root = master_roots[master_part]
        c_sld = root.find("p:cSld", _ns())
        declared_name = c_sld.get("name", "") if c_sld is not None else ""
        rels = master_rels[master_part]
        elements = _template_shapes(root, master_part, rels)
        master_design[master_part] = elements
        masters.append(
            {
                "schema_status": SCHEMA_STATUS,
                "master_part": master_part,
                "declared_name": declared_name,
                "layout_parts": sorted(part for part, owner in layout_master.items() if owner == master_part),
                "design_elements": elements,
                "relationships": _relationship_observations(zf, master_part),
                "background": _background_observation(root, rels),
                "color_mapping": _color_mapping_observation(root),
            }
        )

    layouts: list[dict[str, object]] = []
    for layout_part in layout_parts:
        root = _read_xml(zf, layout_part)
        rels = _relationships(zf, layout_part)
        master_part = layout_master.get(layout_part)
        master_root = master_roots.get(master_part) if master_part else None
        c_sld = root.find("p:cSld", _ns())
        declared_name = c_sld.get("name", "") if c_sld is not None else ""
        elements = _template_shapes(root, layout_part, rels, master_root=master_root)
        placeholders = [element for element in elements if element.get("placeholder")]
        direct_design = [element for element in elements if not element.get("placeholder")]
        layouts.append(
            {
                "schema_status": SCHEMA_STATUS,
                "layout_part": layout_part,
                "master_part": master_part,
                "declared_name": declared_name,
                "declared_type": root.get("type"),
                "matching_name": root.get("matchingName"),
                "preserve": root.get("preserve") in {"1", "true", "True"},
                "placeholders": placeholders,
                "elements": elements,
                "design_elements": direct_design,
                "master_design_elements": master_design.get(master_part or "", []),
                "relationships": _relationship_observations(zf, layout_part),
                "background": _background_observation(root, rels),
                "color_mapping": _color_mapping_observation(root),
            }
        )
    return {
        "schema_status": SCHEMA_STATUS,
        "slide_size": slide_size,
        "masters": masters,
        "layouts": layouts,
        "counts": {"masters": len(masters), "layouts": len(layouts)},
        "identity_rule": "layout_part + master_part; declared names are weak hints only",
        "inheritance_rule": "layout placeholder geometry -> matching master placeholder by (idx,type) -> unknown",
    }


def _placeholder_geometry(root: ET.Element | None, key: tuple[str | None, str]) -> Geometry | None:
    if root is None or not key[1]:
        return None
    wanted_idx, wanted_type = key
    candidates = root.findall(".//p:sp", _ns())
    # An explicit idx is the stable identity; otherwise match the placeholder role.
    for candidate in candidates:
        candidate_ph = candidate.find("p:nvSpPr/p:nvPr/p:ph", _ns())
        if candidate_ph is None:
            continue
        candidate_idx = candidate_ph.get("idx")
        candidate_type = candidate_ph.get("type", "body")
        if wanted_idx is not None and candidate_idx == wanted_idx and candidate_type == wanted_type:
            return _geometry(candidate.find("p:spPr", _ns()))
        if wanted_idx is None and candidate_idx is None and candidate_type == wanted_type:
            geometry = _geometry(candidate.find("p:spPr", _ns()))
            if geometry is not None:
                return geometry
    return None


def _unsupported_parts(parts: list[str]) -> list[dict[str, str]]:
    markers = {
        "/diagrams/": "SmartArt/diagram part is present but not interpreted",
        "/embeddings/": "embedded object part is present but not interpreted",
        "/oleObjects/": "OLE object part is present but not interpreted",
        "/ink/": "ink part is present but not interpreted",
    }
    result: list[dict[str, str]] = []
    for part in parts:
        if part.startswith("ppt/") and not part.endswith(".rels"):
            known = (
                "ppt/presentation.xml",
                "ppt/slides/",
                "ppt/slideLayouts/",
                "ppt/slideMasters/",
                "ppt/theme/",
                "ppt/media/",
                "ppt/charts/",
                "ppt/embeddings/",
                "ppt/diagrams/",
                "ppt/oleObjects/",
                "ppt/ink/",
                "ppt/notesSlides/",
                "ppt/notesMasters/",
                "ppt/handoutMasters/",
                "ppt/printerSettings/",
            )
            known_exact = {"ppt/presProps.xml", "ppt/viewProps.xml", "ppt/tableStyles.xml"}
            if part not in known_exact and not part.startswith(known):
                result.append({"kind": "unsupported_part", "part": part, "reason": "unrecognized ppt package part"})
                continue
        for marker, reason in markers.items():
            if marker in f"/{part}":
                result.append({"kind": "unsupported_part", "part": part, "reason": reason})
                break
    return result


def inspect_pptx(path: str) -> Inspection:
    """Inspect a PPTX package and normalize package failures to ValueError."""

    token = _XML_BYTES_READ.set(0)
    try:
        try:
            return _inspect_pptx(path)
        except (zipfile.BadZipFile, zipfile.LargeZipFile, ET.ParseError, KeyError, EOFError, zlib.error, UnicodeDecodeError) as exc:
            raise ValueError(f"invalid PPTX package: {exc}") from exc
    finally:
        _XML_BYTES_READ.reset(token)


def _inspect_pptx(path: str) -> Inspection:
    """Inspect a PPTX package without assuming a known template."""

    if Path(path).stat().st_size > _MAX_SOURCE_BYTES:
        raise ValueError(f"PPTX exceeds {_MAX_SOURCE_BYTES} byte source limit")
    with zipfile.ZipFile(path) as zf:
        parts = _validate_archive(zf, path)
        if "[Content_Types].xml" not in parts:
            raise ValueError("not a complete PPTX package: [Content_Types].xml is missing")
        if "ppt/presentation.xml" not in parts:
            raise ValueError("not a PPTX package: ppt/presentation.xml is missing")
        presentation = _read_xml(zf, "ppt/presentation.xml")
        _PROFILE.set(_configure_namespace_profile(presentation))
        size = presentation.find("p:sldSz", _ns())
        if size is None:
            raise ValueError("presentation.xml has no slide size")
        width = _emu(size.get("cx"))
        height = _emu(size.get("cy"))
        presentation_rels = _relationships(zf, "ppt/presentation.xml")
        slide_ids = presentation.findall("p:sldIdLst/p:sldId", _ns())
        slides: list[SlideRecord] = []
        for index, slide_id in enumerate(slide_ids, start=1):
            rel_id = slide_id.get(_profile().r_id)
            if not rel_id or rel_id not in presentation_rels:
                raise ValueError(f"slide {index} has no resolvable relationship")
            relation_type, slide_part, relation_mode, _full_type, raw_target = presentation_rels[rel_id]
            if relation_type != "slide" or relation_mode != "internal" or slide_part is None or not slide_part.startswith("ppt/slides/"):
                raise ValueError(
                    f"slide {index} relationship {rel_id!r} does not target a presentation slide: "
                    f"type={relation_type!r}, target={raw_target!r}"
                )
            if slide_part not in parts:
                raise ValueError(f"slide relationship points to missing part: {slide_part}")
            slide_root = _read_xml(zf, slide_part)
            slide_rels = _relationships(zf, slide_part)
            layout_targets = _internal_targets(slide_rels, "slideLayout", f"slide {index}")
            if len(layout_targets) > 1:
                raise ValueError(f"slide {index} has multiple slide layout relationships")
            layout_part = layout_targets[0] if layout_targets else None
            if layout_part and (not layout_part.startswith("ppt/slideLayouts/") or layout_part not in parts):
                raise ValueError(f"slide {index} points to missing or invalid layout part: {layout_part}")
            master_part = None
            layout_root = _read_xml(zf, layout_part) if layout_part else None
            if layout_part:
                layout_rels = _relationships(zf, layout_part)
                master_targets = _internal_targets(layout_rels, "slideMaster", f"layout {layout_part}")
                if len(master_targets) > 1:
                    raise ValueError(f"layout {layout_part} has multiple slide master relationships")
                master_part = master_targets[0] if master_targets else None
            if master_part and (not master_part.startswith("ppt/slideMasters/") or master_part not in parts):
                raise ValueError(f"layout {layout_part} points to missing or invalid master part: {master_part}")
            master_root = _read_xml(zf, master_part) if master_part else None
            tree = slide_root.find("p:cSld/p:spTree", _ns())
            elements: list[ElementRecord] = []
            design_elements: list[ElementRecord] = []
            warnings: list[str] = []
            if tree is None:
                warnings.append("slide has no shape tree")
            else:
                for child in tree:
                    if _tag(child) in {"nvGrpSpPr", "grpSpPr", "extLst"}:
                        continue
                    # Keep direct source geometry in the spike; inherited layout/master matching
                    # is heuristic and belongs in a later explicitly designed mapper.
                    elements.extend(_record_element(child, slide_part, slide_rels, slide_index=index, source_order=len(elements)))
                for source_order, element in enumerate(elements):
                    element.source_order = source_order
            for design_part, design_root in ((layout_part, layout_root), (master_part, master_root)):
                if not design_part or design_root is None:
                    continue
                design_tree = design_root.find("p:cSld/p:spTree", _ns())
                if design_tree is None:
                    continue
                design_rels = _relationships(zf, design_part)
                for child in design_tree:
                    if _tag(child) in {"nvGrpSpPr", "grpSpPr", "extLst"}:
                        continue
                    design_elements.extend(_record_element(child, design_part, design_rels, source_order=len(design_elements)))
                for source_order, element in enumerate(design_elements):
                    element.source_order = source_order
            for element in elements:
                warnings.extend(element.warnings)
            for element in design_elements:
                warnings.extend(element.warnings)
            slides.append(
                SlideRecord(
                    index=index,
                    part=slide_part,
                    layout_part=layout_part,
                    master_part=master_part,
                    elements=elements,
                    design_elements=design_elements,
                    warnings=sorted(set(warnings)),
                    relationships=_relationship_observations(zf, slide_part),
                    background=_background_observation(slide_root, slide_rels),
                )
            )
        notes_parts = [part for part in parts if part.startswith("ppt/notesSlides/") or part.startswith("ppt/notesMasters/")]
        media_parts = [part for part in parts if part.startswith("ppt/media/")]
        template_library = _template_library(
            zf,
            parts,
            presentation,
            presentation_rels,
            {"width": width, "height": height, "unit": "EMU"},
        )
        unsupported = _unsupported_parts(parts)
        parser_warnings = {warning for slide in slides for warning in slide.warnings}
        for slide in slides:
            for rel_id, (rel_type, _target_part, _mode, _full_type, raw_target) in _relationships(zf, slide.part).items():
                if rel_type.lower() in {"audio", "video", "media", "quicktime"}:
                    unsupported.append(
                        {
                            "kind": "unsupported_relationship",
                            "slide": str(slide.index),
                            "part": slide.part,
                            "relationship_id": rel_id,
                            "target": raw_target,
                            "reason": f"{rel_type} media relationship is inventoried but not interpreted",
                        }
                    )
            for element in slide.elements:
                if element.type == "unsupported" or element.warnings:
                    unsupported.append(
                        {
                            "kind": "unsupported_object",
                            "slide": str(slide.index),
                            "element": element.name,
                            "part": element.source_part,
                            "reason": "; ".join(element.warnings) or "object type was not interpreted",
                        }
                    )
        template_elements = [
            (master["master_part"], element)
            for master in template_library["masters"]
            for element in master["design_elements"]
        ] + [
            (layout["layout_part"], element)
            for layout in template_library["layouts"]
            for element in layout["elements"]
        ]
        for container_part, element in template_elements:
            element_warnings = element.get("warnings", [])
            parser_warnings.update(element_warnings)
            if element.get("type") == "unsupported" or element_warnings:
                unsupported.append(
                    {
                        "kind": "unsupported_object",
                        "element": element.get("name", ""),
                        "part": container_part,
                        "reason": "; ".join(element_warnings) or "object type was not interpreted",
                    }
                )
        return Inspection(
            schema_status=SCHEMA_STATUS,
            source=str(path),
            slide_size={"width": width, "height": height, "unit": "EMU"},
            slide_count=len(slides),
            slides=slides,
            theme=_theme(
                zf,
                parts,
                presentation_rels,
                [master["master_part"] for master in template_library["masters"]],
            ),
            unsupported=unsupported,
            notes_parts=notes_parts,
            media_parts=media_parts,
            template_library=template_library,
            warnings=sorted(parser_warnings),
        )
