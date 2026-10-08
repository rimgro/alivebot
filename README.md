# alive

Долгоживущий агент, который «живёт» непрерывно, отдельно от чатов, на базе
[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) в headless-режиме
(рантайм управляет жизненным циклом самостоятельно; для оператора есть отдельный локальный TUI).

```
обычный агент:  user prompt -> tool use + react -> result + answer -> конец
alive:          system prompt -> работа -> idle (ждёт события) -> работа -> idle -> ...
```

## Главная идея

Агент больше не «отвечает на промпт» и не «будится по внешнему вызову». Это **один
непрерывный процесс**, который сам решает, когда работать, когда ждать и когда уснуть:

- **`idle` — блокирующий tool call.** Он работает как вывод очень долгой команды:
  пока ничего не происходит, он просто ждёт (это бесплатно), а когда приходит
  сообщение, напоминание или уведомление — возвращает его как tool result, и агент
  продолжает в том же контексте. Закончил работу — позвал `idle`.
- **Только агент решает остановиться.** Рантайм никогда не «завершает вейк» из-за
  события. Он обслуживает durable-инбокс, напоминания, бюджет и транспорты.
- **Уведомления во время работы — по политике.** Пока агент занят, событие не
  прерывает его, если правило не разрешает `interrupt`. Политику агент настраивает
  сам: «всё от alice — прерывай немедленно».
- **Сон — осознанный сброс контекста.** После долгого ожидания рантайм предлагает
  сон: агент пишет память в journal и зовёт `sleep`, контекст стирается. Если он ждёт
  что-то важное — зовёт `idle({ important: true })` и продолжает ждать.
- **Текст ассистента — приватная мысль.** Он никому не отправляется, только пишется в
  `thoughts.jsonl`. Единственный канал наружу — tool call `send_message`.

Почему это важно: жизнь в цикле не должна ни держать открытый стрим к модели, ни
пересказывать агенту его же состояние на каждом шаге. Контекст непрерывен, ожидание
бесплатно, а память между снами — это journal, notes и reminders.

## Как это выглядит

```text
09:31:49  [alive] run #1 start   events=1 (user_message from console)
09:31:52  💬 console  Тут.                       <- send_message tool call
09:31:55  ...агент зовёт idle({reason:"waiting for the user"}) и засыпает в ожидании...
09:42:17  ...приходит сообщение: idle возвращает его как вывод, run продолжается...
09:42:20  💬 console  Уже смотрю.
10:05:00  [alive] SLEEP OFFER -> агент пишет journal и зовёт sleep
10:05:02  [alive] run #1 · 33.2m · 12.4m idle · 3 events · 4 messages · slept (context reset)
```

Приватный монолог модели можно посмотреть отдельно — он никуда не ушёл:

```bash
npx alive thoughts -n 5
```

## Быстрый старт

```bash
npm install
npm run init                 # создаст alive.config.json и SOUL.md
npm run run                  # поднимет агента в фоне и сразу вернёт управление
npm run alive -- status      # pid, режим, uptime, инбокс
npm run alive -- logs -f     # смотреть, что происходит
```

`npm run run` (или `alive run`) стартует фоновый процесс: он переживает закрытие
терминала, а `Ctrl+C` в нём останавливает только `logs -f`. Чтобы получить старое
поведение «жить в этом терминале» — `npm run alive -- run --foreground`.

В другом терминале:

```bash
npm run alive -- say "привет, ты тут?"
npm run alive -- emit "deploy #42 failed" --kind observability --priority high --json '{"build":42}'
npm run alive -- remind "проверить CI" --in 10m
npm run alive -- status
npm run alive -- runs -n 10
npm run alive -- policy
```

Модель и ключи берутся из обычного конфига pi (`~/.pi/agent/settings.json`,
`auth.json`, `models.json`), так что отдельная авторизация не нужна. Модель можно
переопределить: `--model "anthropic/claude-sonnet-4-5:high"`.

E2E-проверка на живой модели (создаёт временный state-dir, поднимает агента на один
run, проверяет, что он ответил именно через `send_message`, и что он может уснуть):

```bash
npm run smoke
```

## Политика уведомлений

Пока агент работает, события по умолчанию **не** прерывают его — они ждут в инбоксе и
приходят на следующем `idle`. Прерывания настраиваются правилами:

```bash
# всё от alice прерывает немедленно
npx alive policy add interrupt alice
# шумный источник — только между делами
npx alive policy add queue alerting
# fallback
npx alive policy default queue
npx alive policy remove <rule-id>
npx alive policy reset
```

То же самое агент делает инструментом `notifications` во время работы. Режимы:
`interrupt` (steer здесь и сейчас), `queue` (на следующем `idle`), `mute` (не
показывать вовсе). Побеждает более специфичное правило; seed-правило
`priority=interrupt → interrupt` можно удалить.

## Доступ Telegram

Бот обрабатывает сообщения только от Telegram user ID из вайтлиста. По умолчанию
вайтлист пустой и все сообщения блокируются; незнакомому отправителю бот сообщает его
ID и команду для запроса доступа. Добавлять ID можно прямо при работающем боте:

```bash
alive telegram whitelist list
alive telegram whitelist add 123456789
alive telegram whitelist remove 123456789
```

Команда изменяет динамический вайтлист в `.alive/modules/telegram/allowlist.json`,
изменение вступает в силу сразу. ID из `modules.telegram.allowedUserIds` в конфиге
тоже разрешены.

## CLI

| Команда | Что делает |
|---|---|
| `alive init` | создаёт `alive.config.json` + `SOUL.md` |
| `alive run [--foreground] [--once] [--force] [--verbose]` | запускает агента **в фоне** (детач, переживает закрытие терминала); `--foreground` — остаться в терминале, `--once` — один run и выход |
| `alive stop [--force] [--timeout 30s]` | останавливает инстанс: SIGTERM, при игноре — SIGKILL; `--force` — сразу SIGKILL |
| `alive restart [--verbose]` | `stop` + `run` в фоне |
| `alive logs [-n 50] [-f] [--file stdout\|alive\|thoughts] [--json]` | хвост логов; `-f` — следить за новыми строками |
| `alive say <text> [--thread t] [--no-reply]` | кладёт сообщение человека в durable-инбокс |
| `alive emit <text> [--kind k] [--priority p] [--json '<obj>']` | observability-событие |
| `alive remind <text> --in 5m \| --at <ISO>` | напоминание агенту |
| `alive reminders [--all]` | список напоминаний |
| `alive status [--json]` | состояние рантайма, инбокса, политики, бюджета |
| `alive runs [-n 10]` | история run'ов (алиас: `wakes`) |
| `alive policy [list\|add\|remove\|default\|reset]` | показать/править политику уведомлений |
| `alive modules [--json]` | какие event-модули загружены и включены |
| `alive history [--thread t] [--search s] [--all] [-n 30] [--json]` | история диалогов всех модулей |
| `alive telegram me\|chats\|chat\|send` | проверка Telegram-бота без запуска агента |
| `alive telegram whitelist [list\|add <user-id>\|remove <user-id>]` | управление доступом к боту без перезапуска |
| `alive thoughts [-n 20]` | приватный монолог агента |

`say`/`emit`/`remind` пишут прямо в файлы состояния, поэтому работают и когда рантайм
не запущен: события дождутся следующего старта. Если рантайм запущен — он подхватит их
в течение ~`pollIntervalMs`; если агент в этот момент в `idle`, он проснётся сразу.

### Управление инстансом

```bash
alive run                 # старт в фоне, pid и путь к логам в ответе
alive status              # pid, режим (background/foreground), uptime, idle, инбокс
alive logs -f             # следить за stdout/stderr процесса
alive logs --file alive   # структурный JSONL лога рантайма
alive logs --file thoughts # приватный монолог агента
alive restart             # перезапуск (например, после правки конфига)
alive stop                # SIGTERM, потом SIGKILL
alive run --once          # один run в терминале, без демона
```

Один инстанс на `stateDir`: второй `alive run` откажется стартовать, пока живой pid
записан в `.alive/runtime.json` (обойти можно `--force`, но курсоры начнут гонку).
`runtime.json` пишется рантаймом — это единственный источник «кто сейчас работает»:
статус `stopped`, зомби-pid и pid, остановленный через `Ctrl+Z` (SIGSTOP), распознаются
отдельно, поэтому `alive status` не соврёт про «работает».

Stdout фонового процесса пишется в `.alive/logs/stdout.log`, структурированный лог —
в `.alive/logs/alive.jsonl`.

## Сон и память

- `summary.md` в корне проекта — компактная сводка, загружаемая при каждом пробуждении.
  Перед сном модель передаёт её обновлённое полное содержимое в `sleep.summary_md`.
- Факты и их embeddings хранятся в локальном файле `.alive/memory.sqlite` через встроенный
  в Node.js SQLite — отдельный PostgreSQL/pgvector сервер и npm-пакет не нужны. Поиск
  считает cosine similarity в приложении, поэтому для очень больших коллекций он будет
  медленнее специализированного vector index.
- Для генерации embeddings нужен доступ к выбранному API. Для Cloudflare Workers AI
  укажите `embeddingProvider: "cloudflare"`, URL аккаунта в `embeddingBaseUrl`, модель
  и размерность. Запрос отправляется на `{embeddingBaseUrl}/{embeddingModel}` с bearer-
  токеном Cloudflare и телом `{ "text": ["..."] }`. Пример для аккаунта Alive:

  ```json
  "memory": {
    "embeddingProvider": "cloudflare",
    "embeddingBaseUrl": "https://api.cloudflare.com/client/v4/accounts/538af39cbb2e80678fffef9a9435e4fa/ai/run",
    "embeddingApiKeyEnv": "CLOUDFLARE_API_TOKEN",
    "embeddingModel": "@cf/qwen/qwen3-embedding-0.6b",
    "embeddingDimensions": 1024
  }
  ```

  Токен Cloudflare с доступом Workers AI задайте в `.env` в корне проекта:
  `CLOUDFLARE_API_TOKEN=ваш_токен`. Файл `.env` автоматически загружается при запуске
  и уже исключён из Git; не записывайте секрет в `alive.config.json`.
- Перед сном модель обязана вызвать `retain({ facts: [...], scopes: [...] })`.
  Fact strings выбирает сама из своего контекста; scopes вроде `user:alex` и
  `project:alive` задаются на вызов. Для разных групп scope можно вызвать `retain`
  несколько раз. Затем `sleep({ summary, summary_md })` сохраняет journal note,
  обновляет сводку и сбрасывает контекст. Runtime не уснёт без успешного `retain`
  и `summary_md`.
- Похожие актуальные факты выше порога сходства связываются как версии: прежние
  записи помечаются superseded, но физически не удаляются. `memory({action:"history"})`
  показывает цепочку, а `memory({action:"search", query:"..."})` ищет по embedding.
- `sleepAfterMs` (по умолчанию 15m) — после этого `idle` предлагает сон. Сон больше
  не форсируется автоматически: модель может сохранить память или продолжить ожидание
  через `idle({ important: true })`.
- Всё, что не записано до сброса, теряется осознанно.

## Модули и Events API

Опциональный браузерный модуль добавляет постоянный профиль Chrome, остановку при проверке/ограничении доступа и ручное управление той же вкладкой с телефона. Настройка, ограничения и Web Bot Auth для подписанных HTTP-запросов: [BROWSER.md](BROWSER.md).


Внешний мир подключается **модулями** на одном интерфейсе: входящие события,
исходящая доставка `send_message`, инструменты агента и общая durable-история
диалогов. Telegram, Grafana и Discord — не особые случаи, а модули.

```json
"modules": {
  "telegram": { "enabled": true, "tokenEnv": "ALIVE_TELEGRAM_TOKEN" },
  "grafana":  { "enabled": true, "port": 4322 },
  "external": [
    { "name": "discord", "path": "examples/discord-module.ts", "enabled": false, "options": {} }
  ]
}
```

Секреты (токены) лучше держать в `alive.config.local.json` — он читается поверх
`alive.config.json` и уже в `.gitignore`:

```json
{ "modules": { "telegram": { "enabled": true, "token": "123:ABC…" } } }
```

- **Telegram** — полноценная интеграция: бот принимает и отправляет сообщения,
  читает историю чатов, реакции, файлы, участники. Подробно: [TELEGRAM.md](./TELEGRAM.md).
- **Grafana** — webhook для алертов и generic-событий: `POST /grafana/alert`,
  `POST /grafana/event`.
- **Свой модуль** — файл с `default`-фабрикой, подключается по `path`. Скелет,
  правила маршрутизации и полный справочник API: [EVENTS_API.md](./EVENTS_API.md).

История диалогов живёт в `.alive/history/` и доступна агенту инструментом
`history`, а человеку — командой `alive history`. Именно она переживает `sleep`:
транскрипт агента сбрасывается, история — нет.

Агент также может расширять набор возможностей через `tool_registry`: создавать
Node.js-инструменты с собственными именами, устанавливать npm-пакеты, просматривать
и удалять инструменты. Новые инструменты регистрируются в сессии сразу, без
перезапуска Alive, и сохраняются в `.alive/tools/` для следующих запусков. Код
инструмента исполняется с правами процесса Alive — устанавливать следует только
доверенные пакеты и проверять создаваемый код.

Старые транспорты (`console`, `http`) никуда не делись: они работают как
наблюдательные taps и включаются по-прежнему через `chat`.

## Файлы состояния (`.alive/`)

```
inbox/events.jsonl      durable лог входящих событий (append-only)
inbox/cursor.json       курсор доставки (ackedSeq + открытый run)
reminders.json          напоминания агента
policy.json             политика уведомлений (interrupt/queue/mute)
notes.json              короткая рабочая память агента
threads.json            открытые диалоги (enforcement «ответ только через tool call»)
journal/YYYY-MM-DD.md   дневник агента (durable, переживает сон)
history/messages.jsonl  общая история диалогов всех модулей (append-only)
history/threads.json    каталог тредов (заголовки, участники, мета)
modules/<name>/         приватное durable-состояние модуля (offset Telegram и т.п.)
outbox/messages.jsonl   всё, что агент реально отправил, + результат доставки
runs/runs.jsonl         запись каждого run: события, idle-время, токены, стоимость
logs/alive.jsonl        структурный лог рантайма
logs/thoughts.jsonl     приватный монолог (текст и thinking)
sessions/               jsonl-сессии pi (контекст живёт здесь, пока агент не уснул)
workspace/              рабочая директория агента для read/write/bash
agent/                  изолированный pi agent dir (расширения, skills)
tools/                  созданные агентом Node.js-инструменты и npm-зависимости
```

Факты и история revisions хранятся локально в `.alive/memory.sqlite`.

## Конфиг цикла

```json
"loop": {
  "pollIntervalMs": 750,     // пульс scheduler + idle
  "sleepAfterMs": 900000,    // когда предложить сон
  "runTimeoutMs": 240000,    // лимит активного (не-idle) времени на run
  "maxEventsPerIdle": 8,     // событий за один возврат из idle
  "maxNudges": 3,            // недоотвеченные треды
  "maxNudgesPerRun": 5,      // предохранитель от модели без idle/sleep
  "interrupt": true          // разрешить steer по политике
}
```

Старые ключи (`heartbeatMs`, `wakeTimeoutMs`, `maxTurnsPerWake`, `maxEventsPerWake`)
мигрируют на новые при загрузке. Лимит на число шагов (`maxTurnsPerRun`) убран
совсем: run длится столько, сколько нужно агенту.

## Несколько изолированных агентов

```bash
alive agents create researcher --name Researcher
alive agents list
alive agents start researcher
alive agents status researcher
alive agents stop researcher
alive agents edit researcher --name "Research editor" --role "Own literature reviews" --tools read,grep,send_message
alive agents enable researcher
alive agents disable researcher # also stops the process
```

Каждому агенту выделены собственные config, `SOUL.md`, workspace, state,
история, журналы и процесс. Файлы находятся в `.alive/agents/<id>/`; меняйте
модель, список инструментов и инструкции в индивидуальном `alive.config.json`,
`SOUL.md` и `CONTRACT.md`. Общая база памяти использует приватные scopes по умолчанию.

При `alive init` создаётся агент `admin`. Он может создавать и редактировать
профили, настраивать инструменты и permissions, а также запускать, останавливать,
включать и выключать агентов. Обычные агенты по умолчанию не получают этих прав.
Их можно делегировать через `manage_agents` только вместе с явным списком targets;
право создавать агентов, менять инструменты и выдавать permissions — отдельные
capabilities. `grantableTools` ограничивает инструменты, которые агент может
передавать дальше. Попытка выдать право/цель/инструмент за пределами собственных
полномочий отклоняется. Изменение инструмента или permissions у работающего агента
останавливает и перезапускает его, чтобы отозванные инструменты не остались активны.
`disable` сначала сохраняет флаг выключения, затем останавливает процесс; пока профиль
выключен, `start` и обычный `run --config` отказывают.

Для живого терминального мессенджера используйте:

```bash
alive agents tui
```

TUI показывает состояние `enabled/running`, историю выбранного агента, обновляет новые
сообщения автоматически и отправляет их напрямую во входящий ящик выбранного агента.
Управление: `↑`/`↓` выбрать агента, `Enter` отправить, `Ctrl+J` новая строка,
`PageUp`/`PageDown` прокрутить историю, `Alt+S` запустить, `Alt+X` остановить,
`Esc` или `Ctrl+C` выйти. Запуск доступен только включённому агенту.

Для machine-readable списка прав используйте `alive agents status <id>`.
Оператор может выдать набор прав через JSON-файл:

```json
{
  "create": false,
  "edit": true,
  "start": true,
  "stop": false,
  "enable": false,
  "configurePermissions": false,
  "targets": ["researcher"],
  "grantableTools": ["read", "grep"]
}
```

```bash
alive agents permissions analyst --permissions-file permissions.json
```

### Telegram-профиль агента

Создайте отдельного бота через `@BotFather`, затем настройте переменную окружения
с его токеном и подключите ее:

```bash
export RESEARCHER_TELEGRAM_TOKEN="..."
alive agents telegram researcher --token-env RESEARCHER_TELEGRAM_TOKEN
alive agents restart researcher
```

**Managed Bots (Bot API 9.6):** master-бот может запросить у пользователя создание
саб-бота через `KeyboardButtonRequestManagedBot`. Пользователь подтверждает создание
в Telegram; master-бот получает `managed_bot_created` и извлекает токен методом
`getManagedBotToken`. Для этого управление ботами должно быть включено для master-бота
через Mini App @BotFather. Настроить создание и привязку к агенту:

```bash
# master-бот Alive должен быть настроен и запущен; создайте агента
alive agents create researcher
# укажите Telegram ID владельца (личный чат с master-ботом)
alive agents request-telegram researcher --chat 123456789
```

Подтвердите создание в личке master-бота. Он автоматически сохранит токен в
конфиге агента с правами файла `0600`; затем запустите агента:

```bash
alive agents start researcher
```

Токен не выводится в чат или логи. Управляемый бот запускается отдельным процессом
и использует собственный workspace/state агента. Альтернатива для обычных ботов —
`alive agents telegram <id> --token-env ENV`.

Подробности архитектуры, компромиссов и roadmap — в [ARCHITECTURE.md](./ARCHITECTURE.md).
