# Архитектура alive

Документ фиксирует цикл, гарантии и компромиссы. Читать вместе с
[README.md](./README.md).

## 1. Инварианты

1. **Агент живёт непрерывно, рантайм владеет только миром.**
   Нет «ранов по внешнему вызову». Процесс поднимается один раз, агент получает
   стартовое сообщение и дальше сам решает, что делать, через tool calls.
2. **Только агент решает остановиться.**
   Единственный штатный способ закончить работу — tool call `idle`. Рантайм
   никогда не «завершает вейк» из-за пришедшего события. Safety-лимиты
   (turn limit, active-time watchdog, budget, abort) — аварийные, а не режим работы.
3. **`idle` — блокирующий tool call.**
   Он работает как вывод очень долгой команды: пришло событие — `idle` вернул его
   как tool result, и агент продолжает в том же контексте. Ожидание не стоит токенов.
4. **Сон — осознанный сброс контекста.**
   После долгого ожидания рантайм предлагает сон. Агент либо пишет память и зовёт
   `sleep` (контекст стирается, journal/notes/reminders остаются), либо зовёт
   `idle({ important: true })` и продолжает ждать. Сон не теряет мир: напоминания
   и сообщения продолжают копиться и вернутся на следующем `idle`.
5. **Единственный выход наружу — tool call.**
   Текст ассистента = приватная мысль (в `thoughts.jsonl`). Ответ проверяем
   программно (outbox), а не парсим свободный текст.
6. **Ничего не теряется при перезапуске.**
   Входящие события живут в append-only логе с курсором и at-least-once доставкой.
7. **Уведомления во время работы — по политике.**
   Пока агент занят (не в `idle`), событие не прерывает его, если правило политики
   не разрешает `interrupt`. Политику агент настраивает сам (`notifications`).
8. **Один писатель на state-dir.**

## 2. Цикл

### Внешний цикл (рантайм, `src/runtime/loop.ts`)

```
        ┌────────────────────────────────────────────────────────────┐
        │  scheduler (pollIntervalMs)                                │
        │  fire due reminders → inbox   ·  active-time watchdog      │
        │  write runtime.json                                        │
        └──────────────────────────┬─────────────────────────────────┘
                                   │
        ┌──────────────────────────▼─────────────────────────────────┐
        │  budget allows?  ── нет ──▶ pause (до полуночи/кулдаун)    │
        └──────────────────────────┬─────────────────────────────────┘
                                   │ да
        ┌──────────────────────────▼─────────────────────────────────┐
        │              RUN (src/runtime/agent.ts)                    │
        │  beginRun → claim pending → awake prompt                   │
        │                                                            │
        │    LLM ↔ tools ──────────────────────────────┐            │
        │      tools: send_message / idle / sleep /     │            │
        │             notifications / remind / note /   │            │
        │             journal / close_thread / status    │            │
        │             + read/write/edit/bash/grep/...    │            │
        │                                                │            │
        │      turn_end: policy-approved события ────────┘ steer       │
        │      idle:      блокируется, возвращает события как вывод    │
        │                                                            │
        │  stop: sleep | stalled | timeout | budget | error |    │
        │        aborted                                          │
        └──────────────────────────┬─────────────────────────────────┘
                                   │
              ┌────────────────────┴─────────────────────┐
              │ sleep?                                    │ иначе
              ▼                                           ▼
   rebuild session (context reset)              loop → следующий RUN
   → следующий RUN с чистого контекста          (тех же сессия и контекст)
```

### Внутренний цикл (pi, `AgentSession.prompt`)

Отдан целиком `@earendil-works/pi-agent-core`: LLM → tool calls → tool results → LLM …
плюс retry, auto-compaction, drain очередей steering/follow-up. Мы не переизобретаем ReAct.

Раньше каждый «вейк» был отдельным `prompt`. Теперь `prompt` вызывается один раз на
**run**, а `idle` живёт внутри tool execution и растягивает этот один ReAct-цикл на
многие события. Если модель всё-таки закончила ход без `idle`/`sleep`, рантайм
переспрашивает (nudge) в той же сессии, пока не сработает safety-лимит.

## 3. Соответствие исходной идее

| Идея | Реализация |
|---|---|
| `system_prompt` | `buildSystemPrompt()`: идентичность (`SOUL.md`) + протокол непрерывного существования + правила вывода. Стабилен между run'ами. |
| `polling` | Два уровня: (а) фоновый scheduler рантайма (напоминания, watchdog); (б) сам `idle` — «опрос как tool call», который блокируется до события. |
| `tool_use` | Полный набор pi coding-agent + 11 своих инструментов. |
| `отправка сообщений как tool use` | `send_message` пишет в outbox и только потом в транспорт. Текст ассистента не доставляется никуда. |
| `-> polling` | Агент зовёт `idle`; рантайм продолжает жить. |
| «сон» | `sleep` → ack, запись summary в journal, `rebuildSession()` с чистым транскриптом. |

## 4. Компоненты

| Модуль | Ответственность |
|---|---|
| `src/config.ts` | конфиг, пути, дефолты, миграция старых loop-ключей, резолв модели из pi |
| `src/store/events.ts` | durable инбокс: append-only JSONL, dedupe, курсор, claim/ack/rollback, crash-recovery |
| `src/store/reminders.ts` | время агента: напоминания, fired/cancelled, ближайшее срабатывание |
| `src/store/policy.ts` | политика уведомлений: `interrupt`/`queue`/`mute`, правила по thread/source/kind/priority |
| `src/store/threads.ts` | открытые диалоги: unanswered, attempts, close |
| `src/store/outbox.ts` | журнал отправленного + результат доставки |
| `src/store/notes.ts`, `journal.ts` | рабочая и эпизодическая память вне транскрипта |
| `src/store/runs.ts` | RunRecord, дневная/часовая статистика, runtime.json |
| `src/runtime/prompt.ts` | system prompt + awake/nudge/idle/interrupt сообщения, секция политики |
| `src/runtime/tools.ts` | 11 инструментов агента; `idle`/`sleep`/`notifications` — ядро цикла |
| `src/runtime/session.ts` | сборка pi-сессии: изолированный agent dir, модель, tools, resource loader |
| `src/runtime/agent.ts` | один run: `idle`-цикл, steering, watchdog, settle, `rebuildSession` |
| `src/runtime/loop.ts` | внешний цикл, scheduler, бюджет, транспорты, состояние |
| `src/transports/*` | console (stdin/stdout), HTTP (inbound/outbound pull), интерфейс для своих |
| `src/events/api.ts` | публичный Events API: `AliveModule`, `ModuleContext`, `AliveModuleFactory` |
| `src/events/host.ts` | хост модулей: маршрутизация outbound (claimer/listener/tap), статус, инструменты |
| `src/events/loader.ts` | сборка модулей из конфига: builtin по имени, внешние по `path` |
| `src/modules/telegram/*` | Telegram Bot API: long polling, приём/отправка, история, инструмент `telegram` |
| `src/modules/grafana/*` | inbound webhook-модуль: алерты Grafana и generic-события |
| `src/store/history.ts` | общая durable-история диалогов всех модулей + каталог тредов |

## 5. Ключевые решения

### 5.1 `idle` вместо внешнего poll'а

**Решение.** Единственный вход для событий — блокирующий tool `idle`. Рантайм не
будит агента сам: он лишь складывает события в durable-инбокс и обслуживает
напоминания. `idle` крутит локальный poll и возвращает события как tool result.

**Почему.** Это ровно то, что просили: агент выключается только по своему решению,
а ожидание ничего не стоит. Контекст непрерывен — агент помнит, что делал до
ожидания, без «пересказа самому себе» на каждом вейке.

**Компромисс.** Один run может жить часами, поэтому бюджет и контекст ограничиваются
не границей вейка, а active-time watchdog и осознанным `sleep`. Лимита на число
шагов (LLM-ходов) намеренно нет: run длится столько, сколько нужно. Если процесс
упал, переотправляется только неподтверждённый
батч (см. 5.3), а не весь run.

### 5.2 Ответ только через tool call

**Решение.** `send_message` — единственный канал; текст ассистента логируется в
`thoughts.jsonl`.

**Почему.** «Ответил/не ответил» становится машинно-проверяемым фактом (outbox).
Это открывает: гарантии «не оставить человека без ответа», ретраи доставки, аудит,
метрики, интеграции с реальными чатами.

**Enforcement.** `threads.json`: входящее сообщение с `expects_reply` открывает
тред. Незакрытые треды попадают в awake/nudge-промпт как `UNANSWERED`. Тред
закрывается **только** `send_message` или явным `close_thread(reason)`.

### 5.3 Durable инбокс с at-least-once и границей подтверждения

**Решение.** `inbox/events.jsonl` (append-only) + `cursor.json`. Seq выводится из
номера строки, поэтому любой процесс может дописать событие одной атомарной
записью `O_APPEND`.

**Семантика.**
- `beginRun` → `openRun.lastSeq = ackedSeq`; `claim`/`claimPrefix` двигают только
  `openRun.lastSeq`; `ack` переносит его в `ackedSeq`.
- **`idle` подтверждает предыдущий батч в момент входа.** Агент зовёт `idle`
  только когда закончил с тем, что ему дали, — поэтому при падении
  переотправляется максимум текущий in-flight батч, а не весь многочасовой run.
- Если процесс умер, `recoverAfterCrash()` снимает `openRun` **не** двигая
  `ackedSeq`: события снова pending и приходят с `REDELIVERED_AFTER_INTERRUPTION`.
- Ошибка/таймаут/abort → rollback. Штатное завершение и сон → ack.

**Компромисс.** Возможны дубли (at-least-once). Маркер + идемпотентность действий
агента — цена за отсутствие потерь.

### 5.4 Политика уведомлений вместо «interrupt по умолчанию»

**Решение.** `policy.json` + tool `notifications`. Режимы:
- `interrupt` — событие вбрасывается в идущий run через `session.steer()`;
- `queue` — ждёт следующего `idle` (дефолт);
- `mute` — не показывается вовсе (событие остаётся в логе, курсор идёт дальше).

Правило матчится по `thread` / `source` / `kind` / `priority`. Побеждает более
специфичное правило, при равной специфичности — более новое. Seed-правило
`priority=interrupt → interrupt` можно удалить.

**Почему.** «Во время работы уведомления приходят только если это прописано в
политике». Агент сам решает, кто важный: `notifications({action:"add",
mode:"interrupt", thread:"alice"})`.

**Почему степпинг безопасен.** `claimPrefix` возвращает непрерывный префикс до
последнего подходящего события, поэтому interrupt не «перепрыгивает» более старые
события и не теряет их. Muted-события отфильтровываются перед рендером.

### 5.5 Сон: предложение, отказ и принуждение

**Решение.** `idle` считает, сколько ждёт.
- Дошло до `sleepAfterMs` → возвращает SLEEP OFFER: «пиши память и зови `sleep`,
  либо `idle({important:true})`, если ждёшь важное».
- Агент зовёт `sleep({summary})` → summary пишется в journal, `rebuildSession()`,
  контекст чистый.
- Агент после оффера снова зовёт `idle` без `important` → это согласие: сон
  форсируется (в journal попадает пометка), контекст сбрасывается.
- `important: true` — «не могу спать»: оффер не приходит, ожидание бесконечно.

**Почему.** «После слишком долгого ожидания агент засыпает — сбрасывает контекст и
сохраняет факты в память; агент может решить, что не может спать, если ждёт
чего-то важного.» Ровно эта семантика.

**Границы.** Сон не трогает journal, notes, reminders, inbox и outbox. Всё, что не
записано до сна, теряется осознанно.

### 5.6 Стабильный system prompt, волатильное — в awake-сообщении

**Решение.** В system prompt только идентичность, протокол и правила. Всё меняющееся
(события, треды, заметки, напоминания, дневник, политика, бюджет, время) — в
awake/nudge/idle-сообщениях.

**Почему.** Префикс промпта кэшируется провайдером. Плюс awake-сообщение читается
как «что случилось, пока меня не было».

### 5.7 Память в четырёх слоях

| Слой | Где | Зачем |
|---|---|---|
| Транскрипт | pi session jsonl + auto-compaction + sleep-reset | рабочий контекст, нюансы диалога |
| Дневник | `journal/*.md`, пишет сам агент | durable эпизоды, решения, обещания |
| Заметки | `notes.json` | короткое состояние, всегда в awake-промпте |
| Время | `reminders.json` | обещания и отложенные действия |

Транскрипт — единственный слой, который «портится» компакцией и сном. Поэтому
протокол требует писать обязательное в journal/notes/reminders.

### 5.8 Бюджеты и деградация

- `runTimeoutMs` — active-time watchdog: время внутри `idle` не считается,
  `session.abort()` → run помечается `timeout`, события переотправляются.
- Лимита на количество LLM-ходов нет: рантайм не обрывает run из-за «слишком
  много шагов». Cчётчик `turns` ведётся только для телеметрии.
- `maxDailyCostUsd`, `maxWakesPerHour` (лимит run'ов в час) — пауза без остановки
  процесса; при исчерпании внутри run — чистый стоп `budget`.
- Backoff при ошибках модели: 30s → 15m экспоненциально.
- `maxNudgesPerRun` — предохранитель от модели, которая упорно заканчивает ход
  без `idle`/`sleep`.

### 5.9 Изоляция от интерактивного pi

**Решение.** Свой `agentDir` (`.alive/agent`), свой `SettingsManager` (in-memory),
свой system prompt. Креды и каталог моделей — из общего `~/.pi/agent`. При
`sleep` сессия пересобирается с `forceNewSession`.

### 5.10 Где enforcement, а где — промпт
| Правило | Промпт | Рантайм |
|---|---|---|
| Ответ только через tool | формулирует правило | треды и UNANSWERED-секция |
| Не жечь бюджет | сообщает лимиты | watchdog, turn limit, budget guard |
| Не потерять обещание | просит писать в journal | reminders + journal на диске |
| Не спамить | «тишина — валидное действие» | нет ответа → нет сообщения |
| Не потерять события | объясняет `idle` | durable inbox + cursor + rollback |

### 5.11 Модули вместо «транспорта под каждый сервис»

**Решение.** Внешний мир подключается модулями на одном интерфейсе
(`src/events/api.ts`): входящие события (`ctx.emit`/`userMessage`/`event`),
исходящая доставка (`ctx.onOutbound` + `handles`), инструменты агента
(`tools`/`registerTools`), общая durable-история (`ctx.history`) и вклад в статус.
Встроенные модули: `telegram`, `grafana`. Свои — файл с `default`-фабрикой,
подключается по `path` через `modules.external`.

**Почему.** «Telegram», «Discord» и «Grafana» — это не три специальных случая в
ядре, а три реализации одного контракта. Ядро не знает ни про chat_id, ни про
Bot API: оно знает про `send_message`, треды и историю. Добавление нового сервиса
не трогает `loop.ts`, `agent.ts` и `tools.ts`.

**Маршрутизация outbound.** У модуля три возможные роли:
- **claimer** — есть `handles()`, вернувший `true`: получает только свои треды и
  **отвечает за доставку**; его падение — ошибка `send_message`;
- **listener** — без `handles()`: видит все сообщения, но его ошибки только логируются;
- **tap** — транспорт (`console`, `http`): видит всё для наблюдаемости; авторитетен
  только если никто не claim'ит.

Это сохранило семантику «ответил / не ответил» и позволило не переписывать
существующие транспорты.

**История.** Все модули пишут в один append-only лог (`history/messages.jsonl`),
и агент читает его универсальным инструментом `history`: `threads`, `read`,
`search`, `around`. Для Telegram это единственный способ «прочитать историю
чата»: Bot API отдаёт ботам только апдейты за 24 часа и не имеет серверной
истории. История — это то, что переживает `sleep` вместе с journal/notes.

**Границы.** Инструменты регистрируются один раз при старте (сессия собирается
сразу после `ModuleHost.init()`). Горячей перезагрузки модулей нет. Идемпотентность
входящих событий — на `dedupeKey` модуля, идемпотентность истории — на `id` записи.

## 6. Форматы данных

### `AliveEvent` (inbox)

```json
{
  "id": "evt_...", "ts": 1789551092461,
  "kind": "user_message | reminder | observability | heartbeat | system",
  "source": "cli | http | console | scheduler | runner",
  "priority": "low | normal | high | interrupt",
  "title": "short label", "text": "canonical text for the prompt",
  "payload": { "any": "structured data" },
  "thread": "console", "expectsReply": true,
  "dedupeKey": "reminder:rem_123"
}
```

### `NotifyPolicyFile` (`policy.json`)

```json
{
  "version": 1,
  "defaultMode": "queue",
  "rules": [
    { "id": "rule_...", "mode": "interrupt", "thread": "alice", "createdAt": 1789551092461 }
  ]
}
```

### `RunRecord` (`runs/runs.jsonl`)

`id, index, startedAt, finishedAt, durationMs, activeMs, idleMs, stopReason, error,
events[], outbound[], remindersCreated[], notesTouched[], journalEntries, idleReturns,
interruptDeliveries, nudges, turns, promptChars, usage, sleep?`

`stopReason`: `slept | stalled | timeout | budget | error | aborted`.
Это одновременно аудит, телеметрия и «сонник» для секции `Recent runs` в промпте.

### `HistoryRecord` (`history/messages.jsonl`)

```json
{
  "id": "telegram:-100123:1005",
  "thread": "telegram:-100123/7",
  "module": "telegram",
  "direction": "inbound",
  "ts": 1789551092461,
  "author": "Alice", "authorId": "7",
  "text": "look at this",
  "messageId": "1005", "replyTo": "1001",
  "attachments": [{ "kind": "photo", "fileId": "…", "size": 200000 }],
  "meta": { "eventId": "evt_…", "chatId": "-100123", "topicId": "7" }
}
```

`history/threads.json` хранит каталог тредов (заголовок, участники, мета чата).
И то, и другое — append-only/атомарные записи, читаются несколькими процессами.

### Курсор (`inbox/cursor.json`)

```json
{ "ackedSeq": 42, "openRun": { "runId": "run_...", "lastSeq": 45 } }
```

Старый формат `openWake: { wakeId, lastSeq }` читается и мигрирует на лету.

## 7. Roadmap

1. **Идемпотентная доставка outbox**: `pending` → retry с backoff → `delivered/failed`.
2. **Thread-aware управление контекстом**: активные треды всегда «свежие», давно
   закрытые — summarize-and-archive.
3. **Task-объекты для долгих задач** с отдельным бюджетированием, чтобы задача
   переживала не только сон, но и перезапуск.
4. **Sub-agents**: дорогой разбор (большой лог, репозиторий) — в отдельного
   субагента с чистой контекстной рамкой, результат — в journal.
5. **Multichannel**: ~~Telegram/Slack/веб-сокет транспорты, per-thread persona~~ →
   Events API + модули ([EVENTS_API.md](./EVENTS_API.md)); Telegram сделан
   полностью ([TELEGRAM.md](./TELEGRAM.md)). Осталось: Discord-модуль с gateway,
   Slack, webhook-транспорт общего вида, per-thread persona.
6. **Approval gates**: действия с внешними последствиями требуют подтверждения.
7. **Self-editing identity**: агент сам предлагает правки в `SOUL.md`.
8. **Метрики и режим наблюдения**: OTEL, `alive attach`, дашборд по стоимости.
9. **Мультиагентность**: несколько живых агентов на одном state-dir.
10. **Container sandbox** для `bash`.

## 8. Ограничения (честно)

- Один рантайм на state-dir; конкурентная запись курсора не защищена (`runtime.json`
  и отказ стартовать вторым процессом).
- Инбокс читается целиком в память: ок для десятков тысяч событий.
- Retry доставки outbox не автоматический (roadmap п.1).
- Напоминания в формате `at`/`after`, без cron/rrule и таймзон.
- Принудительный сон при повторном `idle` может сбросить контекст без подробного
  summary — в journal попадает только пометка; агент предупреждён оффером.
- Нет формального теста на конкурентные сценарии; `smoke` покрывает happy path
  на живой модели.
