# Fortress: подключение и прозрачный Canvas

Alive может использовать [один общий Fortress-сервис для всех агентов](../shared/README.ru.md), сам управлять отдельным Fortress для каждого разрешённого Telegram-пользователя или подключиться к внешнему Chromium/Fortress через CDP. Агент и телефон работают с одной страницей и её cookies. Используется публичный **OSS Fortress 151.0.7908.0** под [BSD-3-Clause](https://github.com/tiliondev/fortress/blob/v151.0.7908.0/LICENSE), как в исходном launcher. Аккаунт, активация и license token не нужны. Новый upstream `latest` — другая source-available ветка; мы её не используем. Сторонние сервисы решения CAPTCHA не подключаются.

## Управляемый Fortress

Нужен работающий Docker. Образ скачивается оператором; Alive не выполняет скрытых загрузок:

```sh
docker pull tilion/fortress@sha256:0f81aefbc15fc7aa70cb94efe26ace491bbcfb0d21441b7b2b3383a6587bc925
npm run browser -- setup --engine fortress --driver patchright --headless true --cdp-env "" --executable-env ""
npm run browser -- diagnose
```

Образ закреплён по digest, npm launcher — на `tilion-fortress@151.0.7910`; исходный BSD tag — `v151.0.7908.0` (`fef9b333ff34e23fdd4b36e918ab5236f3f3e926`). Код активации, проверки JWT, credential mounts и activation metadata удалены. Старые `fortressRequireLicense` / `fortressLicenseFileEnv` больше не используются и удаляются из локального override при `setup`. `setup --engine fortress` выбирает OSS digest; другой образ возможен только как явная настройка `--fortress-image`.

Перед сменой ранее настроенного образа остановите свой host/агент: автоматического принятия контейнера с другим image/profile нет. Сами профили не удаляются. Для нескольких агентов используйте [shared host](../shared/README.ru.md): один движок и отдельные BrowserContext/daemon agent-browser на разговор.

У этого OSS-бинарника есть подтверждённая нативная ошибка прозрачного Canvas. Отчёт `fortressCanvas` остаётся в status, провал даёт предупреждение, но не запрещает запуск браузера. `diagnose` честно возвращает код 1 при провале. JS-подмены не применяются; native-патч ниже не установлен в официальный OSS-образ. Это не гарантия корректности любого рендеринга или доступа к сайтам.

Профили находятся в `sessions/<thread-hash>/profile-fortress/`, постоянный HOME — в соседнем `fortress-home/`. Старые Chrome-профили сохраняются отдельно; cookies не копируются. Штатный launcher сохраняет seed и выполняет ограниченное по времени определение страны/часового пояса по текущему выходному IP. Оператор может задать согласованные `TILION_COUNTRY` / `TILION_TZ`. VPN и идентичности не переключаются при отказе сайта.

На Mac контейнер работает без отдельного окна Chrome, изображение видно в том же Mini App. При закрытии браузер сначала сохраняет cookies/storage, затем Alive удаляет только проверенный принадлежащий ему контейнер. Живой контейнер после остановки runtime может быть принят обратно. Проверяются ID, labels, фактический image ID, mounts и loopback-порт; чужой контейнер не меняется. Ошибки Docker/образа/подключения возвращают ошибку без автоматической замены на Chrome. Нативный Canvas-дефект диагностируется отдельно, не выдаётся за исправленный и не останавливает OSS-браузер.

Одновременно допускаются два контейнера. Каждый ограничен 3 GiB памяти, двумя CPU, 512 процессами и 512 MiB `/dev/shm`; root filesystem read-only, capabilities сняты, CDP доступен только на `127.0.0.1`. OSS-образ и shared-host E2E проверены на Linux x64. На Mac ARM понадобится эмуляция Docker; эта OSS-конфигурация на нём и на будущем телефоне Debian/ARM пока не проверена.

Для доверенного нативного Fortress вместо Docker задайте абсолютный путь в `ALIVE_BROWSER_EXECUTABLE` и `setup --engine fortress --executable-env ALIVE_BROWSER_EXECUTABLE --cdp-env ""`. Режим/совместимость конкретной OSS-сборки проверяются отдельно; Alive не читает и не передаёт license token. Используйте бинарник или официальный launcher, а не SDK CLI.

Закончите ручной ввод перед `alive restart`: перезапуск применяет настройки и отзывает временные ключи пульта. Правила Telegram, инструменты и Web Bot Auth сохраняются.

## Внешний CDP

В Fortress MCP вызов `get_stealth_cdp_endpoint` возвращает `cdp_url`. SDK предоставляет `Fortress.cdpUrl`. Используйте отдельный профиль для Alive и один управляющий агент. Другие клиенты MCP/CDP могут менять ту же страницу независимо от паузы Alive: исключительный доступ человека гарантируется только для команд модуля Alive.

В gitignored `.env` задайте адрес уже запущенного браузера, например:

```dotenv
ALIVE_BROWSER_CDP_URL=http://127.0.0.1:9222
```

Затем:

```sh
npm run browser -- setup --driver playwright --cdp-env ALIVE_BROWSER_CDP_URL
npm run browser -- diagnose
npm run browser -- doctor --online
```

`playwright` соответствует примеру подключения в SDK Fortress; `patchright` также доступен как CDP-клиент. Версия и совместимость фактического движка проверяются на машине оператора. Настройки `channel`, `headless`, `viewport` и каталог профиля Alive применяются только при управляемом запуске Chrome. В режиме CDP их задаёт запускающий Fortress процесс. `close` и остановка Alive отключают клиент, сохраняя внешний браузер. Потеря подключения отзывает доступ телефона и оставляет агента на паузе; после восстановления браузера нужен новый `handoff` и явное возвращение управления человеком.

CDP даёт полный доступ к браузеру. Alive принимает только loopback HTTP/WebSocket URL. Для браузера на другом сервере используйте приватное перенаправление порта; не открывайте порт CDP в Интернет. Телефон подключается к защищённому HTTPS-интерфейсу Alive, а не к CDP. Для Docker публикуйте порт только на loopback, например `127.0.0.1:9222:9222`.

Чтобы снова запускать Chrome силами Alive:

```sh
npm run browser -- setup --driver patchright --cdp-env ""
```

## `TRANSPARENT_PIXEL`

В публичных Canvas-патчах Fortress на commit `026da4dab70e15f2f03b767f8039e71bec5dc762` шум RGB добавляется и к пикселям с `alpha == 0`. Это нарушает ожидаемое значение пустого/очищенного Canvas `[0, 0, 0, 0]`. Обнаружение такой ошибки не означает, что остальные свойства движка согласованы или что сайт разрешит доступ.

Источники: [getImageData](https://github.com/tiliondev/fortress/blob/026da4dab70e15f2f03b767f8039e71bec5dc762/patches/0020-third_party-blink-renderer-modules-canvas-canvas2d-base_rendering_context_2d-cc.patch), [PNG/Blob encoding](https://github.com/tiliondev/fortress/blob/026da4dab70e15f2f03b767f8039e71bec5dc762/patches/0031-third_party-blink-renderer-platform-graphics-image_data_buffer-cc.patch).

Соседний `transparent-pixel.patch` исправляет оба пути в нативном Chromium-коде: полностью прозрачные пиксели остаются без изменений, существующий шум непрозрачных пикселей сохраняется. Это дополнительный патч **после** применения соответствующих публичных патчей Fortress к исходникам Chromium. Из каталога этих исходников:

```sh
git apply --check /PATH/TO/alivebot/deploy/browser/fortress/transparent-pixel.patch
git apply /PATH/TO/alivebot/deploy/browser/fortress/transparent-pixel.patch
```

Затем нужен обычный процесс сборки Fortress и замена используемого бинарника/образа. Патч не меняет уже установленный браузер. Если проверка применения не проходит, версия исходников отличается или исправление уже присутствует; не применяйте патч принудительно.

Для независимой проверки дополнительного патча без полной сборки Chromium:

```sh
python3 deploy/browser/fortress/check-canvas-patch.py --fortress-source /PATH/TO/fortress
```

Нужны Python 3, Git и `clang++` (или `--compiler g++`). Проверка извлекает реальные циклы шума из публичных патчей, компилирует небольшой C++-стенд, сначала воспроизводит ошибку, затем применяет исправление в временном каталоге. Проверяются RGBA/BGRA, прозрачные/полупрозрачные/непрозрачные пиксели, padding строк и согласованность чтения/кодирования на 50 seeds. Непрозрачный результат до/после должен совпасть. Исходники Fortress не изменяются; это не сборка полного Blink и не проверка бинарного релиза.

Для публичного движка, чьи исходники проверены выше, временное отключение Canvas-шума предусмотрено через `--uxr-canvas-seed=0`; Node SDK принимает его через `extraArgs`. Это оставляет нативный Canvas-отпечаток и требует перезапуска браузера. Поддержка флага в другой/закрытой версии должна подтверждаться диагностикой фактического бинарника. Не накладывайте JavaScript-подмену `getImageData` поверх нативного исправления.

`npm run browser -- diagnose` использует отдельную пустую вкладку, проверяет пустой, очищенный, PNG round-trip и OffscreenCanvas, а также непрозрачный контрольный пиксель. Вывод включает версию браузера и реальные RGBA; провал возвращает код 1. В управляемом режиме используется временный профиль, в CDP — временная вкладка, которая закрывается после проверки. Команда не читает страницы и cookies пользователя. Остановите свой Alive перед диагностикой, чтобы временная вкладка не стала активной страницей агента.

## Пароли, коды и CAPTCHA

Видимые редактируемые поля `type="password"` и `autocomplete="one-time-code"`, включая iframe, автоматически останавливают агента и вызывают передачу управления человеку. Значения полей не считываются детектором. Пока требуется ручной ввод, команды чтения/снимка экрана агенту блокируются; человек видит страницу через защищённый интерфейс телефона. Возвращение управления разрешается после выхода из формы и завершения проверки. Поля кода без стандартного `autocomplete` могут требовать явного `browser({ action: "handoff" })`.

Настройка Telegram и HTTPS остаётся общей: [BROWSER.md](../../../BROWSER.md), [быстрый запуск](../../../BROWSER_QUICKSTART.ru.md). Адрес публичного каталога Web Bot Auth не заменяет адрес живого интерфейса телефона.

Проверка границы CDP: `npm run test:browser:cdp`. Она запускает внешний Chrome на локальных фикстурах, проверяет сохранение сессии, временную Canvas-диагностику, приватный ввод через телефонный API, iframe, отключение и отзыв доступа. Это проверка адаптера, а не тест конкретного релиза Fortress или доступа к Авито.

Проверка реального управляемого движка: `npm run test:browser:fortress:e2e`; полный пульт на двух контейнерах: `ALIVE_BROWSER_TEST_FORTRESS=1 npm run test:browser:router:e2e`. Общий OSS-хост и настоящий agent-browser: `ALIVE_BROWSER_TEST_FORTRESS=1 pnpm test:browser:agent:e2e`; пульт на одном общем OSS-контейнере: `ALIVE_BROWSER_TEST_CHANNEL=chromium ALIVE_BROWSER_TEST_SHARED=1 ALIVE_BROWSER_TEST_FORTRESS=1 pnpm test:browser:router:e2e`. Активация не нужна. Тесты используют локальные фикстуры и не отправляют сообщения реальным Telegram-пользователям.
