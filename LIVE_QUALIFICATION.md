# План ограниченной live-квалификации

Этот документ описывает процедуру, если владелец отдельно разрешит live test. Никакой endpoint, GPU, Cloud/RunPod ресурс и платный запрос не запускался при его подготовке. Сначала снимите offline blockers из [READY_FOR_QWEN.md](./docs/READY_FOR_QWEN.md). Для top-10 итоговый provider должен быть organizer-provided VK inference; self-hosted тест его не заменяет.

## Предусловия

- Node.js 24, pnpm 10.33.2 и локальный Python 3.12 для PPTX inspection.
- Секретный endpoint/model alias настроены вне Git.
- Для текущего runner model alias должен быть `Qwen/Qwen3.8-27B`; `LCT_SEMANTIC_ENABLE_THINKING=false` обязателен.
- Убедитесь, что база URL заканчивается на `/v1`, не содержит credentials/query. Runner делает ограниченные health/models и adapter calls, сохраняет результаты под ignored `.lct/experiments/` без endpoint URL/ключа.
- Уточните заранее допустимый request budget и проверьте, что endpoint доступен. Не включайте автоматический retry.

## Ограниченный smoke

Только после отдельного разрешения запускается smoke, который делает один небольшой strict-schema probe, один production Worker и один Supervisor запрос; generation должен быть без inference. Максимум — 3 semantic request. Команда должна быть перечитана по текущему `--help` перед запуском:

```powershell
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-live-quality-suite.mjs --smoke --provider-kind vk --profile VK_REMOTE --template 'C:\path\to\organizer-template.pptx'
```

`--provider-kind` и `--profile` — labels для manifest, они не создают или не настраивают модельный endpoint. Если smoke не проходит или достигает request budget, остановите эксперимент; не запускайте suite.

У runner нет отдельного успешного `--help`: usage печатается при неизвестном аргументе. Команда со `--smoke` выше — процедура для будущего разрешённого live run; сам live invocation здесь не проверен и выполняться не должен, потому что он может обратиться к настроенному endpoint.

Пять-сценарный `--suite` допускает до 10 semantic запросов и не является частью начального qualification budget. Для него нужна отдельная цель/разрешение. Не выполнять его как продолжение без согласованного лимита.

## Интерпретация

Проверяйте schema result, Worker/DeckPlan validation, Supervisor outcome, checkpoint/persisted state, фактическую latency, package reopen и export checks. Не интерпретируйте HTTP health/models как доказательство product compatibility. Реальное VK integration остаётся не подтверждённым, пока smoke не выполнен через предоставленный VK endpoint.
