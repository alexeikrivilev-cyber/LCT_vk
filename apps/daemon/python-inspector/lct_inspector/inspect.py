# Adapted from EdYaRdx/LCT_2026_hack, commit b065024ac349b04aceac8211cc166274a1978d48.
# Internal, replaceable inspection code; observations are not a product contract.

"""Private inspection entry point."""

from .model import Inspection
from .ooxml import inspect_pptx

__all__ = ["Inspection", "inspect_pptx"]
