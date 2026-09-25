# Live Qwen qualification

This runbook prepares and runs a bounded live qualification against the configured OpenAI-compatible semantic endpoint. It does not create, inspect, restart, or stop cloud resources. The operator starts and stops the Pod in the provider console.

## Requirements and endpoint configuration

Use the repository-pinned Node.js 24 and pnpm 10.33.2. A local Python 3.12 runtime is needed for PPTX inspection and post-export reopen validation. Install the locked JavaScript dependencies with `pnpm install --frozen-lockfile` if this checkout has not been prepared.

The runner reads the existing adapter configuration:

- `LCT_SEMANTIC_BASE_URL`: absolute HTTPS URL for the OpenAI-compatible API base. The current adapter appends `/chat/completions`; for vLLM, set the base to the `/v1` path, not to `/chat/completions`.
- `LCT_SEMANTIC_MODEL`: must resolve to the `Qwen/Qwen3.8-27B` model alias.
- `LCT_SEMANTIC_ENABLE_THINKING`: must be explicitly set to `false` for this qualification.
- `LCT_SEMANTIC_API_KEY`: optional; used only in request headers when the endpoint requires it.

In PowerShell, from the repository root:

```powershell
$env:LCT_SEMANTIC_BASE_URL = 'https://<YOUR_ENDPOINT>/v1'
$env:LCT_SEMANTIC_MODEL = 'Qwen/Qwen3.8-27B'
$env:LCT_SEMANTIC_ENABLE_THINKING = 'false'

# If the endpoint requires a bearer token, read it without echo:
# $secureKey = Read-Host 'Semantic API key' -AsSecureString
# $env:LCT_SEMANTIC_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
# Remove-Variable secureKey
```

The runner verifies `GET /health` and `GET /v1/models` before any generation and requires the configured model alias to appear in the model list. It starts its own isolated loopback daemon for the normal project API flow and shuts it down when the run ends; no separate daemon command is needed.

## Smoke and quality suite

Run the smoke first. It uses the `retention-growth` case, makes one small strict-schema request, then runs one production Worker → DeckPlan validation → Supervisor flow. It saves and reloads planning state, then locally compiles A/B/C, audits, previews, exports, and reopens each PPTX.

```powershell
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-live-quality-suite.mjs --smoke --provider-kind runpod --profile A100_BF16 --template 'C:\path\to\organizer-template.pptx'
```

Omit `--template` to use the generated synthetic T1 fixture when no local template is available. The output then demonstrates runtime connectivity and the offline compiler path, not unknown-template compatibility.

If smoke passes, the sequential suite runs the five fixed cases: `retention-growth`, `platform-architecture`, `quarterly-metrics`, `sparse-evidence`, and `conflicting-brief`.

```powershell
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-live-quality-suite.mjs --suite --provider-kind runpod --profile A100_BF16 --template 'C:\path\to\organizer-template.pptx'
```

For the organizer-provided VK endpoint, use `--provider-kind vk --profile VK_REMOTE`. These are safe run labels only; they do not configure the model provider. The semantic endpoint still comes from the adapter environment above.

Expected upper bounds are three semantic requests for smoke (strict probe + Worker + Supervisor) and ten for the five-case suite (Worker + Supervisor per case). There are no requests for A/B/C. There is no automatic retry. Each scenario is limited to two model requests; if Supervisor asks for a `local-replan`, the third request is blocked and the run stops. Any failed strict response, planning validation, HTTP error, persistence check, audit blocker, repeated unsupported numeric fact across slides, or PPTX validation also stops the suite before the next case.

The runner prints a run ID and output directory. Its ignored output is under:

```text
.lct/experiments/<run-id>/
  manifest.json
  summary.json
  manual-review.md
  <scenario>/planning-state.json
  <scenario>/variants/variant-a.pptx
  <scenario>/variants/variant-b.pptx
  <scenario>/variants/variant-c.pptx
  <scenario>/previews/
  <scenario>/audit/
  <scenario>/matrix/
```

The manifest and summary retain safe model/provider labels, hashes, prompt/schema/compiler/audit versions, request counts, finish reasons, and measured timing. They omit endpoint URLs, authorization headers, and API keys. Stages that the application does not expose separately, including ContentIR parse and semantic repair duration, stay `null`. The smoke scenario's `total_under_300s` is computed from its measured scenario wall time; the five-case suite reports this per scenario and leaves a single suite-wide five-minute claim unset.

The current custom renderer does not claim its own native reopen check (`backend_reopen_status` remains `not-run`). The runner independently reopens every export through the existing PPTX inspection adapter, checks the expected slide count, and records that result under `lct_reopen_validation`/`pptx_validation`.

After a successful planning run, the state can be evaluated offline:

```powershell
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/evaluate-planning-runs.mjs '.lct/experiments/<run-id>/retention-growth/planning-state.json' --out '.lct/experiments/<run-id>/retention-growth/evaluation.json'
```

## Real PPTX compatibility and manual review

For a held-out local PPTX, this command runs the existing compatibility harness. The live runner also invokes that harness on a supplied template before sending any semantic request.

```powershell
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/compare-pptx-backends.mjs 'C:\path\to\organizer-template.pptx' --out '.lct/compatibility/organizer-template'
```

The current harness reports `safeForOfficeKitBackend=no` until native PowerPoint or LibreOffice open/save evidence exists. Keep the current custom backend selected. If `LCT_PPTX_BACKEND=office-kit` is set for an unqualified template, the live runner stops before inference instead of forcing that backend.

Open all three exported PPTX files for each scenario in PowerPoint or LibreOffice. Compare the takeaway, source/numeric fidelity, narrative sequence, theme/template fidelity, clipping, chart/table correctness, visual hierarchy, and A/B/C differences. Fill `manual-review.md`; the script leaves subjective quality fields blank. Diagnostic PNG/SVG files are useful for quick inspection but do not replace native Office review.

## Persistent model volume restart evidence

After a Pod restart, record these values from the self-hosted inference container logs or console:

- `LCT_MODEL_STORAGE_ROOT` and the resolved local snapshot path;
- whether expected model files were reused from the persistent volume;
- whether a full approximately 55 GB download happened again;
- container startup time, model load time, and first-request/warmup time.

This runner does not query RunPod or modify a volume. It does not claim the 300-second gate until a successful run reports measured Worker, Supervisor, compile, render, preview, audit, export, and per-scenario wall times. A failed or incomplete stage is not counted as zero.

When qualification ends or a stop condition is hit, stop the GPU/Pod in the provider console. The script has no cloud-control credentials and never destroys a volume.
