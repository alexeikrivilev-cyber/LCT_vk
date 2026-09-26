# Матрица поддержки браузеров

## Требование кейса

Официальное ТЗ, с. 3: десктопный веб-интерфейс должен работать в текущей и предыдущей версиях Chrome, Firefox, Safari и Яндекс Браузера на Windows и macOS. Мобильные устройства не требуются.

## Текущее состояние

Матрица ниже фиксирует целевую совместимость отдельно от фактически проверенной. В репозитории нет Playwright/WebDriver-матрицы, а эта сессия не запускала UI в браузерах. Поэтому ни один браузер не помечен как runtime-verified.

| Браузер | ОС из требования | Целевые релизы | Проверено в этой сессии | Статус |
|---|---|---|---|---|
| Chrome | Windows, macOS | Текущий и предыдущий стабильный релиз на дату квалификации | Нет; только статический просмотр UI-кода и typecheck | PARTIAL |
| Firefox | Windows, macOS | Текущий и предыдущий стабильный релиз на дату квалификации | Нет; только статический просмотр UI-кода и typecheck | PARTIAL |
| Safari | macOS | Текущий и предыдущий поддерживаемый релиз macOS | Нет; браузерный runtime недоступен | PARTIAL |
| Safari | Windows | Текущего поддерживаемого релиза нет | Не применимо: Apple сообщает, что последним Safari для Windows был 5.1.7 в 2010 году; обновления больше не выпускаются | NOT_APPLICABLE |
| Яндекс Браузер | Windows, macOS | Текущий и предыдущий стабильный релиз на дату квалификации | Нет; Chromium-совместимость не считается тестом Яндекс Браузера | PARTIAL |

Источник по доступности Safari для Windows: [Apple Support — Update to the latest version of Safari](https://support.apple.com/en-gb/102665). Другие целевые версии намеренно не зафиксированы номерами: перед реальным тестированием следует записать текущий и предыдущий релизы браузеров на дату запуска.

## Статический просмотр UI

В исходниках найдены обычный `history.pushState` и `crypto.randomUUID` с запасным генератором. Поиск по `apps/web` не нашёл `window.chrome`, WebKit-prefixed API, проверки user-agent/vendor, `showSaveFilePicker`, `FileSystemHandle` или `document.execCommand`. Это не заменяет тест браузерных API, скачивания файлов, фокуса клавиатуры и реального layout.

Команды, использованные для статического поиска и типа UI:

```powershell
rg -n "window\.chrome|webkit|webkitURL|showSaveFilePicker|FileSystemHandle|document\.execCommand|navigator\.userAgent|navigator\.vendor|crypto\.randomUUID|history\.pushState" apps/web
pnpm dlx pnpm@10.33.2 --filter @lct/web run typecheck
```

## Gate перед claiming support

Для каждого релиза записать точные версии Chrome/Firefox/Safari/Яндекс Браузера и ОС, открыть product happy path, проверить upload PPTX/материалов, reload, generation state, скачивание PPTX/PDF/HTML, клавиатурный фокус, печатную страницу PDF/HTML, консоль ошибок и размеры 1280–1920 px. Safari на Windows не тестировать; эту комбинацию отмечать как `NOT_APPLICABLE`, а не заменять старым Safari 5.1.7.
