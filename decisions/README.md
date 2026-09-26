# Архитектурные решения

ADR описывают rationale на момент решения, а не автоматически текущий PASS. Если implementation или qualification изменились, обновите статус и evidence.

| ADR | Решение | Статус |
|---|---|---|
| [001](./ADR-001-office-kit-renderer-spike.md) | Office Kit renderer reuse и qualification | Replaceable offline backend; production adoption deferred |
| [002](./ADR-002-provider-neutral-inference.md) | SemanticInferenceAdapter не зависит от runtime vendor | Accepted |
| [003](./ADR-003-deterministic-geometry-boundary.md) | Semantic content decisions отдельно от deterministic geometry/validation | Accepted |
| [004](./ADR-004-template-as-component-library.md) | PPTX template рассматривается как источник компонентов/стилей | Accepted with limits |
| [005](./ADR-005-prompt-aware-profile-cache.md) | Semantic profile кэшируется по template + prompt/config fingerprint | Accepted |
| [006](./ADR-006-shared-plan-variant-strategies.md) | A/B/C создаются из общего DeckPlan и отличаются стратегией композиции | Accepted; not every template can yield all variants |
| [007](./ADR-007-native-editable-output.md) | Основной output — native editable PPTX objects | Accepted; Office visual pass pending |
| [008](./ADR-008-fake-offline-inference.md) | Fake endpoint для повторяемой offline qualification | Accepted for test/dev only |
| [009](./ADR-009-versioned-runtime-prompts.md) | Agent prompts/config версионируются вне TypeScript | Accepted |

Статус case/deployment публикуется в [READY_FOR_QWEN.md](../docs/READY_FOR_QWEN.md), не в каждой записи ADR.
