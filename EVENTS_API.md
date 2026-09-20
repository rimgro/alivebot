# Events API

Events API — это публичный шов, через который в `alive` подключается внешний мир:
чаты, алерты, вебхуки, что угодно. Telegram, Grafana и Discord в этом проекте —
не особые случаи, а **модули** на одном и том же интерфейсе.

Модуль умеет ровно три вещи (и может ограничиться любой из них):

1. **Входящие события** — `ctx.emit()` / `ctx.userMessage()` / `ctx.event()`
   кладут событие в durable-инбокс агента.
2. **Исходящие сообщения** — `ctx.onOutbound()` получает то, что агент отправил
   через `send_message`; `handles()` говорит, какие треды модуль считает своими.
3. **Инструменты агента** — `tools()` / `ctx.registerTools()` добавляют
   LLM-инструменты (например, чтение истории чата или реакции).

Плюс общая **durable-история диалогов** (`ctx.history`), из которой работает
универсальный инструмент `history`, и вклад в `alive status`.

Определения типов: [`src/events/api.ts`](./src/events/api.ts).
Хост, который всё это связывает: [`src/events/host.ts`](./src/events/host.ts).

## 1. Быстрый старт

Встроенные модули включаются в `alive.config.json` ключом `enabled`:

```json
"modules": {
  "telegram": { "enabled": true, "tokenEnv": "ALIVE_TELEGRAM_TOKEN" },
  "grafana":  { "enabled": true, "port": 4322 },
  "external": []
}
```

Свой модуль подключается по пути (относительно корня проекта или абсолютному):

```json
"modules": {
  "external": [
    {
      "name": "discord",
      "path": "examples/discord-module.ts",
      "enabled": true,
      "options": { "webhookUrl": "https://discord.com/api/webhooks/…" }
    }
  ]
}
```

Файл модуля должен экспортировать `default` (или `createModule`) — фабрику:

```ts
import type { AliveModule, AliveModuleFactory } from "../src/events/api.js";

const factory: AliveModuleFactory = ({ config, log, options }) => new MyModule(options);
export default factory;
export const createModule = factory;
```

`options` — это ровно тот JSON, что лежит в `modules.external[].options`;
`config` — весь `AliveConfig`; `log` — scoped-логгер.

Посмотреть, что загружено:

```bash
alive modules            # on/off, источник (builtin/external), детали
alive modules --json
```

## 2. Интерфейс модуля

```ts
interface AliveModule {
  readonly name: string;
  /** "chat" — говорит с людьми, "events" — сообщает о машинах. Только для статуса. */
  readonly kind?: "chat" | "events";

  /**
   * Какие исходящие сообщения модуль берёт на себя. Если метод определён, модуль
   * получает только свои треды и отвечает за их доставку; если нет — модуль
   * пассивный слушатель всех сообщений.
   */
  handles?(message: OutgoingMessage): boolean;

  start(ctx: ModuleContext): Promise<void>;
  stop(): Promise<void>;

  /** Снимок для `alive status` / GET /status. */
  status?(): Record<string, unknown>;

  /** Инструменты агента. */
  tools?(ctx: ModuleContext): ToolDefinition[];
}
```

`ModuleContext` — всё, что модулю дано:

| Поле | Что делает |
|---|---|
| `name`, `config`, `paths`, `log` | имя, конфиг, пути состояния, scoped-логгер |
| `signal: AbortSignal` | отменяется при остановке рантайма; фоновые циклы обязаны его уважать |
| `emit(event)` | положить произвольное `NewEvent` в durable-инбокс |
| `userMessage(input)` | входящее сообщение человека (kind/source/title по умолчанию) |
| `event(input)` | машинное/observability-событие |
| `onOutbound(handler)` | подписка на `send_message`; возвращает unsubscribe |
| `history` | общая durable-история диалогов (см. §4) |
| `registerTools(tools)` | добавить инструменты агенту (вызывать в `start()`) |
| `contributeStatus(fn)` | добавить поля в `alive status` |
| `runtimeStatus()` | текущий статус рантайма (pid, run, pending, …) |
| `moduleDir(...segments)` | приватная durable-папка `<stateDir>/modules/<name>` |

### Порядок жизненного цикла

```
AliveRuntime.init()
  ├─ ModuleHost.init()
  │    ├─ start() транспортов (console/http)
  │    └─ для каждого модуля: ctx → start(ctx) → tools(ctx)
  ├─ moduleTools передаются в сессию агента
  └─ AgentRunner.init()  (собирается pi-сессия со всеми инструментами)
```

Следствия:

- инструменты нужно отдавать в `start()` или в `tools()` — сессия собирается
  **один раз** сразу после старта модулей;
- `start()` должен быстро вернуться: длинные циклы (long polling, серверы)
  запускаются «в фоне» и завершаются по `ctx.signal` / `stop()`;
- ошибка одного модуля не роняет рантайм: она попадает в лог и в `alive status`
  как `modules.<name>.error`.

## 3. Маршрутизация исходящих сообщений

`deliver()` в хосте различает три роли:

| Роль | Как задаётся | Что получает | Ошибка доставки |
|---|---|---|---|
| **claimer** | есть `handles()` и он вернул `true` | только свои треды | **фатальна**: `send_message` вернёт ошибку |
| **listener** | `handles()` не определён | все сообщения | логируется, не фатальна |
| **tap** | транспорт (`console`, `http`) | все сообщения | фатальна только если нет claimer'ов |

Правила:

- если сообщение кто-то **claim**'ит, доставка считается успешной только при
  успехе всех claimer'ов; taps и listeners всё равно видят сообщение
  (console печатает, listener пишет своё), но их падение ни на что не влияет;
- если claimer'ов нет, поведение прежнее: успех, если доставил хотя бы один
  транспорт;
- **один тред должен иметь одного claimer'а**. Два модуля с `handles()` на один
  тред — это два отправленных сообщения; так делать не нужно.

За это отвечает `ChatTransport`-совместимость: старые транспорты продолжают
работать как taps, их не пришлось переписывать.

## 4. История диалогов

`ctx.history` — общий append-only лог того, что модули видели и что сказал агент.
Это то, что делает «прочитай историю чата» универсальной возможностью, а не
фичей одного Telegram-модуля.

```ts
interface HistoryRecord {
  id: string;              // стабильный id, напр. "telegram:42:1005"
  thread: string;          // канонический тред, напр. "telegram:42"
  module: string;          // "telegram" | "grafana" | "discord" | …
  direction: "inbound" | "outbound";
  ts: number;
  author?: string; authorId?: string;
  text: string;
  messageId?: string;      // id сообщения у провайдера
  replyTo?: string;
  attachments?: HistoryAttachment[];
  meta?: Record<string, unknown>;
}
```

Основные методы:

```ts
history.append(record)          // идемпотентно по id
history.query({ thread, module, direction, search, since, until,
                before, after, limit, order })
history.search("текст")
history.threads({ module })
history.thread(threadId)
history.upsertThread({ thread, module, title, participants, meta })
history.prune(thread, keep)     // ретеншн для болтливых чатов
history.stats()
```

Агент читает историю универсальным инструментом `history`:

```
history({ action: "threads" })
history({ action: "read", thread: "telegram:42", limit: 50 })
history({ action: "search", query: "деплой", since: "1d" })
history({ action: "around", message_id: "1005", thread: "telegram:42" })
```

Это ключевой мост между сном и реальностью: транскрипт агента сбрасывается
(`sleep`), а история — нет.

CLI для человека:

```bash
alive history                                  # список тредов
alive history --thread telegram:42 -n 50
alive history --search "деплой" --since 1d
alive history --all --module telegram -n 20
alive history --json
```

Файлы: `.alive/history/messages.jsonl`, `.alive/history/threads.json`.
Читают и пишут несколько процессов (рантайм + CLI) — JSONL append-only, поэтому
одна атомарная запись на строку.

## 5. Встроенные модули

| Модуль | Роль | Что даёт |
|---|---|---|
| `telegram` | chat | long polling, приём/отправка, история чатов, инструмент `telegram` (см. [TELEGRAM.md](./TELEGRAM.md)) |
| `grafana` | events | webhook для Grafana Alerting и generic-событий, инструмент не нужен — события читаются через `history` |

### Grafana

```
POST /grafana/alert   Grafana alerting webhook payload
POST /grafana/event   { title, text, priority?, thread?, payload?, dedupe_key? }
GET  /grafana/health
```

Каждый алерт становится `observability`-событием с дедупликацией по
`fingerprint + status + startsAt/endsAt`, приоритет — из
`modules.grafana.firingPriority` / `resolvedPriority`. Если в labels/annotations
есть `thread`, событие привяжется к треду (и агент сможет ответить туда).

## 6. Свой модуль: минимальный скелет

```ts
import { Type } from "typebox";
import type { AliveModule, ModuleContext } from "../src/events/api.js";

export class MyModule implements AliveModule {
  readonly name = "my-service";
  readonly kind = "chat" as const;

  handles(message: { thread: string }) {
    // этот модуль отвечает только за свои треды
    return message.thread.startsWith("myservice:");
  }

  async start(ctx: ModuleContext) {
    ctx.onOutbound(async (message) => {
      await postToMyService(message.thread.slice("myservice:".length), message.text);
      ctx.history.append({
        id: `myservice:${Date.now()}`,
        thread: message.thread,
        module: "myservice",
        direction: "outbound",
        text: message.text,
        author: "agent",
      });
    });

    ctx.contributeStatus(() => ({ connected: true }));

    ctx.registerTools([
      {
        name: "myservice_ping",
        label: "Ping my service",
        description: "Ping the service.",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
      } as never,
    ]);

    // входящие события — откуда угодно: таймер, очередь, сокет
    setInterval(() => {
      ctx.event({ title: "heartbeat", text: "service is up", kind: "heartbeat" });
    }, 60_000).unref();
  }

  async stop() {}
}
```

Готовый, но при этом не встроенный пример — Discord:
[`examples/discord-module.ts`](./examples/discord-module.ts). В нём есть входящий
HTTP-релей, отправка через webhook или bot token, вклад в историю, свой
инструмент и статус. Это самый близкий к «написать модуль руками» образец.

## 7. Гарантии и ограничения

**Гарантии**

- Входящие события durable: `emit()` пишет в append-only JSONL и переживает
  перезапуск; `dedupeKey` защищает от повторной доставки при перезапуске
  long-poll цикла или вебхука.
- Идемпотентность истории: `history.append` с тем же `id` не создаёт дубль.
- Изоляция ошибок: падение модуля не роняет агента; падение claimer'а честно
  возвращается агенту как ошибка `send_message`.
- Порядок старта детерминирован: транспорты → модули (в порядке конфига) → сессия.

**Ограничения**

- Инструменты модуля регистрируются один раз при старте; динамически добавить
  инструмент в уже собранную сессию нельзя.
- `handles()` — единственный механизм маршрутизации; несколько claimer'ов на один
  тред приведут к нескольким отправкам (и, возможно, к ошибке одного из них).
- Горячей перезагрузки модулей нет: `alive restart` (или `alive run`) перезапускает процесс.
- Историю читает только рантайм/CLI с доступом к файлам состояния; сетевого API
  истории нет (кроме `GET /outbox` у HTTP-транспорта).
- Внешние модули — это обычный `import()`: TS-файлы работают под `tsx`
  (`npm run run`), в собранном `dist/` подключайте `.js`.
