# Workers — эфемерные coding-субагенты

`alive` различает два разных вида исполнителей:

| | managed agent | worker |
|---|---|---|
| кто это | постоянный агент | одноразовая сессия pi-coding-agent |
| жизненный цикл | `enabled`/`running`, start/stop/restart | start → task → report → follow-up → stop/remove |
| память | journal, notes, SQLite, summary, reminders | только jsonl-сессия pi; никакой памяти Alive |
| проактивность | `idle`, пробуждения, уведомления | нет; работает только по задаче |
| каналы | Telegram, события, `send_message` | нет |
| инструменты | Alive + модули + coding tools | только `read/write/edit/bash/grep/find/ls` |
| для чего | «живёт», общается, помнит | «сделай код, прогони тесты, покажи diff» |

Идея: основной агент не затаскивает в свой контекст все патчи, логи и итерации.
Он делегирует кодинг worker'у, а себе оставляет задачу, результат и diff по
запросу.

## Включение

Workers — отдельное операторское разрешение. Оно не входит в
`agentManagement` и никогда не наследуется managed-агентами: `create_agent` не
может создать профиль с worker-доступом. Managed-агенту нужно включить
`workers` вручную в его `alive.config.json`.

```json
{
  "workers": {
    "enabled": true,
    "permissions": {
      "spawn": true,
      "send": true,
      "stop": true,
      "inspect": true,
      "worktree": true,
      "pullRequest": true
    },
    "models": [
      "anthropic/claude-sonnet-4-5:high",
      "anthropic/claude-haiku-4-5",
      "openai/*"
    ],
    "defaultModel": "anthropic/claude-sonnet-4-5:high",
    "tools": ["read", "write", "edit", "bash", "grep", "find", "ls"],
    "maxConcurrent": 2,
    "maxRuntimeMs": 1800000,
    "repository": ".",
    "worktreesDirectory": "",
    "baseRef": "origin/main",
    "remote": "origin",
    "notifyOnFinish": true
  }
}
```

`workers.repository` — путь к рабочей копии. В sandbox-профиле это путь внутри
гостевой VM (относительно guest workspace, по умолчанию `/home/<agent>`), в host-
профиле — относительно директории конфига профиля. По умолчанию `"."`. Чтобы
работать с проектом, склонируй его в guest workspace (сеть в sandbox по умолчанию
public) или смонтируй явный shared volume через `sandbox.sharedVolumes`.

`tools.allowlist` трогать не нужно: при `workers.enabled: true` инструмент
`worker` включается автоматически. `models` — обязательный allowlist; пустой
список при включённых workers считается ошибкой конфигурации. Поддерживаются
точные specs и `*` в provider/model (`openai/*`). Thinking-суффикс (`:high`) не
меняет identity модели, поэтому `anthropic/claude-sonnet-4-5:low` разрешён,
если в списке есть `anthropic/claude-sonnet-4-5:high`.

### Права

| permission | что разрешает |
|---|---|
| `spawn` | запускать новых worker'ов |
| `send` | отправлять follow-up в существующую сессию |
| `stop` | `stop` и `remove` |
| `inspect` | `list`, `status`, `wait`, `diff` |
| `worktree` | создавать git worktree и делать checkout PR |
| `pullRequest` | commit/push ветки worker'а и создание PR |

## Окружение: та же VM, что у агента

Worker **не получает отдельный host-shell и отдельную VM**. Его модель работает
как in-process pi-сессия, а файлы/команды идут через ровно ту же границу, что и у
родительского агента:

- `sandbox.enabled: true` — worker-сессия получает те же sandbox-инструменты
  (`read/write/edit/bash/grep/find/ls`), работает в том же microVM, под тем же
  guest-пользователем и в том же persistent workspace. Host-файлы не монтируются,
  host-fallback отсутствует.
- `sandbox.enabled: false` — worker работает в host workspace профиля, как и сам
  агент.

`workers.repository` и `workers.worktreesDirectory` — это пути **внутри окружения
worker'а**: guest-пути для sandbox-профиля, host-пути для host-профиля.
`worktree`, `diff`, `commit/push`, `pr` выполняются в этом же окружении. Поэтому
для sandbox-worker'а `git` (а для `pr` — `gh` и его авторизация) должны быть
доступны внутри VM. Их можно поставить в guest (`bash` + network) или собрать
свой `sandbox.image`.

Worker наследует ограничения окружения, а не host-секреты: в sandbox он не видит
host `.env`, host auth и host-репозиторий, если они не переданы в guest явно.
В host-профиле его `bash` — обычный host shell с правами процесса `alive`.

Sandbox-worker использует тот же `SandboxManager` и ту же очередь, что и агент:
долгая команда worker'а (например, `npm test` на 10 минут) сериализуется с
sandbox-инструментами агента. Пока worker работает, агенту лучше уходить в `idle`,
а не пытаться параллельно читать/писать в ту же VM.

Managed-агенты не наследуют workers: `create_agent` не может выдать это право.
Оператор включает `workers` вручную в конфиге конкретного профиля.

## Как агент этим пользуется

```text
worker({ action: "start", task: "Добавь ретраи в клиент Telegram. Прогони npm test." })
  → { id: "wrk_...", status: "starting", branch: "alive/wrk_...", workspace: "<guest или host>/.alive-workers/worktrees/wrk_..." }

# агент занимается другими делами / уходит в idle
# по завершении в inbox приходит событие kind=worker

worker({ action: "send", id: "wrk_...", prompt: "Тесты падают на таймауте. Исправь." })
worker({ action: "diff", id: "wrk_...", full: true })
worker({ action: "pr", id: "wrk_...", title: "Add Telegram retries", commit_message: "Add retries" })
worker({ action: "remove", id: "wrk_..." })
```

Команды:

- `start` по умолчанию создаёт **worktree**: отдельную ветку и директорию, чтобы
  работа не задевала текущий checkout. `isolation: "shared"` работает прямо в
  `workers.repository` и подходит для чтения/анализа или когда worktree не нужен.
- `pr` проверяет, что рабочее дерево чистое (или коммитит с `commit_message`),
  пушит ветку в `workers.remote` и вызывает `gh pr create` **в окружении worker'а**.
  В sandbox для этого нужны `git`, `gh` и credentials внутри guest; иначе ветку
  можно запушить/опубликовать host-инструментами отдельно. Ветка остаётся после
  `remove`.
- `diff` показывает `git status`, `diffstat` и по `full: true` сам патч.
  Для shared-workspace diff может включать чужие изменения.
- `wait` блокирует текущий run; лучше сначала `start`, потом событие
  `worker`, а `wait` использовать только когда результат нужен немедленно.
- `stop` прерывает активный run. `remove` удаляет запись и worktree (грязный
  worktree требует `force: true`); ветка не удаляется.

Follow-up (`send`) продолжает ту же pi-сессию: «напиши» и «протестируй» — это
два сообщения одному worker'у, без повторного объяснения контекста.

## Lifecycle и состояние

```text
starting → running → idle → running → ... 
                    ↘ failed / stopped / interrupted
```

Файлы:

```text
.alive/workers/<worker-id>/worker.json    durable-запись (статус, модель, ветка, usage)
.alive/workers/<worker-id>/sessions/      jsonl-сессии pi для follow-up
.alive/workers/worktrees/<worker-id>/     git worktree host-профиля (в sandbox — внутри guest)
.alive/workers/usage.jsonl                расход worker-run'ов для дневного бюджета
```

Worker-сессии живут в процессе `alive`. Если процесс останавливается во время
run, при следующем старте запись помечается `interrupted`, а агенту приходит
событие. Сессия pi сохранена: `send` возобновит её; `status` покажет состояние,
`remove` — очистит.

`maxConcurrent` ограничивает одновременно выполняющиеся runs (idle-сессии не
считаются). `maxRuntimeMs` — жёсткий лимит одного run: по истечении сессия
абортится, запись получает `failed`. Стоимость worker-run входит в дневной
`budget.maxDailyCostUsd`; при исчерпанном бюджете новые `start`/`send` отклоняются.

## CLI оператора

```bash
alive workers list
alive workers status <worker-id>
alive workers diff <worker-id> [--full]
alive workers models
```

`stop`/`remove`/`pr` из CLI намеренно не дублируются: worker-сессии принадлежат
процессу агента, поэтому управлять ими должен агент. CLI читает durable-записи;
для host-worker'ов он дополнительно показывает git-состояние. Для sandbox-worker'а
git-состояние находится в VM, поэтому `status`/`diff` нужно смотреть инструментом
`worker` из самого агента — CLI не открывает второй владелец VM.

## Границы

- Worker не является managed agent: у него нет inbox, reminders, memory,
  `send_message`, `idle`, `sleep` и доступа к `create_agent`/`manage_agents`.
- Worker не может запускать других worker'ов через tools: в его pi-сессии нет
  Alive-тулов. Host-shell worker'а технически может вызвать `alive` CLI, если он
  установлен и доступен (это обычное следствие shell-доступа).
- В sandbox-профиле worker ограничен той же VM и guest-пользователем, что и агент.
  В host-профиле его `bash` имеет host-права пользователя `alive`.
- Модели ограничены `workers.models`; инструменты — `workers.tools` (только
  built-in coding tools).
- Push/PR не происходят автоматически: публикация — явный `pr` с отдельным
  permission.
- `pr`/checkout PR рассчитаны на GitHub (`gh`, `refs/pull/<n>/head`) и требуют
  `gh`/credentials в окружении worker'а. Для других forge используйте свои
  команды/интеграции или `isolation: "shared"`.
