# Квалификация шаблонов

Квалификационный результат привязывается к hash шаблона, ContentIR/brief/DeckPlan и к версии программных prompt/config. Generic selector должен работать по структуре, без organizer-specific имён или захардкоженных индексов.

Текущие verified facts берутся из [CASE_REQUIREMENTS.md](../compliance/CASE_REQUIREMENTS.md): на последней versioned organizer matrix получено 6/9 variants; WorkSpace остановил все три варианта, а held-out AIOS дошёл до планирования, но не прошёл distinctness gate. Это BLOCKED, не PASS. Contact sheets и ignored qualification artifacts являются проверочными материалами, но не заменяют PowerPoint visual review.

Повторяемые offline commands и manifest semantics: [TESTING.md](../../TESTING.md). Не запускайте Qwen, GPU или внешний endpoint в offline qualification.
