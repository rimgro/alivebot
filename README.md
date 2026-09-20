# alive

Долгоживущий агент, который «живёт» непрерывно, отдельно от чатов, на базе
[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) в headless-режиме
(без TUI, полностью управляется своим рантаймом).

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

- `sleepAfterMs` (по умолчанию 15m) — сколько рантайм ждёт, прежде чем предложить сон.
- В `idle` после этого приходит SLEEP OFFER с инструкцией.
- `sleep({ summary })` пишет summary в `journal/` и сбрасывает контекст
  (`rebuildSession`), поэтому следующий run начинается с чистого транскрипта, но с
  notes, journal и reminders.
- `idle({ important: true })` — отказ от сна: ожидание продолжается бесконечно.
- Всё, что не записано до сна, теряется осознанно.

## Модули и Events API

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
```

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

Подробности архитектуры, компромиссов и roadmap — в [ARCHITECTURE.md](./ARCHITECTURE.md).
