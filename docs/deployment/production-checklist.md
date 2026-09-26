# Deployment checklist

Перед пользовательским или live окружением подтвердите каждый пункт по факту, а не по намерению:

- daemon не доступен публичной сети без принятой аутентификации/периметра (сейчас daemon loopback-only);
- secrets подаются через secret store и не попадают в `.env.example`, Git, browser bundle или logs;
- semantic endpoint и model alias заданы отдельно от domain code;
- base URL/auth/schema/output-size/timeout прошли bounded integration check;
- модель, revision, license, serving profile и persisted storage согласованы;
- snapshot exact-revision/offline preflight прошёл на self-hosted runtime, если он используется;
- input hashes, qualification manifest и экспортные артефакты хранятся с проектом согласно retention policy;
- backup/restore/delete, disk capacity и retention проверены на выбранной инфраструктуре;
- export reopened, audit findings видимы, native PPTX визуально просмотрен в PowerPoint/LibreOffice;
- browser/OS support проверен по требуемой матрице;
- актуальные blockers из [READY_FOR_QWEN.md](../READY_FOR_QWEN.md) закрыты для заявляемого use case.

Сейчас это checklist, а не заявление, что проект production-ready.
