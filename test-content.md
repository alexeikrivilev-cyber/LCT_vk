# LCT Presentation Compiler

LCT Presentation Compiler is a system for generating editable PowerPoint presentations from an uploaded corporate PPTX template, source materials, and a user brief.

## Problem

Typical presentation generators often ignore the logic of the original corporate template. They may produce slides with incorrect layouts, generic typography, poor visual hierarchy, or designs that do not match the source presentation.

## Solution

LCT first analyzes the uploaded PowerPoint template and extracts its structure, layouts, typography, colors, and reusable slide patterns.

The system then analyzes source materials and creates a structured presentation plan with Qwen3.8-27B.

## Architecture

The pipeline contains several stages:

1. PPTX template analysis and TemplateIR creation.
2. Source-content analysis and ContentIR creation.
3. Worker generates a DeckPlan.
4. Supervisor reviews the plan.
5. The system generates A/B/C slide variants.
6. Deterministic audit checks layout and content issues.
7. The user selects variants and exports an editable PPTX.

## Key idea

The PowerPoint template is treated as a reusable design system rather than just a visual background.

Where possible, the system reuses real layouts and slide exemplars from the uploaded presentation instead of recreating the design from scratch.

## Output

The user receives an editable PowerPoint presentation that preserves the logic of the uploaded corporate template and can be opened and modified in Microsoft PowerPoint.