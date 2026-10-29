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

## Изоляция по умолчанию

Shell и файловые инструменты каждого агента изолированы через **microsandbox microVM**.
VM запускается лениво; обычные файлы приватного `/home/<имя-агента>` доступны без boot, пока VM остановлена.
Этот persistent том также служит `HOME` и рабочей директорией; например, `Alive` получает `/home/alive`.
Образы и read-only resource volumes переиспользуются; RAM/CPU, общие тома и idle policy настраиваются
в `sandbox` собственного конфига каждого агента. Спящие процессы, Docker, watcher'ы и durable holds
не дают автоматике выключить VM. Ошибка проверки означает «оставить включённой», не host fallback.
Runtime, модель, память и Telegram остаются на хосте; их ключи не передаются в VM.
Гостевая сеть по умолчанию public-only: доступ к хосту/LAN/metadata закрыт, кроме host DNS.
Операторский opt-out — `sandbox.networkAccess:"unrestricted"`; `sandbox.network:false` отключает сеть.
Это не DLP: секрет, явно переданный в guest env или файлы, может утечь в интернет.

Linux: нужен доступ к `/dev/kvm`. Статус без boot: `npm run alive -- sandbox status`.
Настройки, границы доверия, перенос старого workspace и проверки: **[SANDBOX.md](SANDBOX.md)**.
Старый host workspace автоматически не монтируется и не импортируется.
Host `browser`, `web_search`, исполняемый tool registry и pi-расширения недоступны изолированным агентам;
оператор может явно вернуть прежний режим через `sandbox.enabled:false`.

## Fortress в agent-browser

Это операторские команды; инструменты `browser`/`web_search` доступны агенту только при явном отключении sandbox.

Команды используют локальный `agent-browser` из зависимостей проекта, отдельную сессию `alive-fortress` и явное подключение по CDP. Если Fortress не запущен, он автоматически стартует в фоне на `127.0.0.1:9223`. Первый запуск скачивает бинарник; ошибки запуска — в `.alive/browser/fortress.log`. Запасной обычный Chrome не запускается.

```bash
npm run browser:agent -- open https://example.com
npm run browser:agent -- snapshot -i
npm run browser:agent -- click @e1
npm run browser:agent -- eval 'navigator.webdriver'  # false
npm run browser:agent -- close
```

После изменения параметров запуска уже работающий Fortress продолжает использовать старые значения (в том числе при обновлении `dist`). Для применения: `npm run build`, затем остановите фоновый экземпляр командой ниже и выполните следующую команду `npm run browser:agent`. Проверка Windows UA, `platform` и Client Hints, включая HTTP User-Agent, без внешних сайтов: `ALIVE_BROWSER_IDENTITY_TEST=1 npm run test:fortress`.

`TRANSPARENT_PIXEL`: canvas в Fortress 151.0.7908.0 возвращает ненулевые RGB при нулевой альфе. Проверены seed `0`, пустой seed и запуск с `TILION_NO_DEFAULTS=1` без seed: ни один вариант не устраняет дефект надёжно; единичный нулевой результат не означает исправления. Адаптер не подменяет readback. Воспроизводимый тест пустого canvas, прозрачного PNG и `clearRect`: `ALIVE_BROWSER_CANVAS_TEST=1 npm run test:fortress` (ожидается ошибка до исправления upstream). Исправление в движке должно сохранять нулевые RGB при alpha=0.

`close` отключает сессию `agent-browser`, но оставляет Fortress работающим. Профиль находится в `.alive/browser/profile-9223`, отдельно от других установок Fortress. Для ручного запуска с диагностикой: `npm run browser:fortress`. Для остановки фонового экземпляра: `kill "$(<.alive/browser/fortress-9223.pid)"`.

Настройки:
- `ALIVE_FORTRESS_PORT` — локальный порт (по умолчанию `9223`).
- `ALIVE_FORTRESS_CDP=http://host:port` — уже запущенный внешний Fortress; автоматический запуск отключён. Endpoint должен быть доверенным: CDP сообщает `Chrome/...`, а не `Fortress`, и не удостоверяет происхождение браузера.
- `TILION_TZ` — часовой пояс, соответствующий выходному IP. По умолчанию используется системный пояс вместо сетевого geo-запроса, который может зависнуть.

Инструмент агента `browser` принимает массив аргументов, например `{"args":["snapshot","-i"]}`. `web_search` ищет через DuckDuckGo в отдельной временной вкладке того же Fortress, возвращает заголовки, ссылки и сниппеты. Python, `uvx` и MCP не нужны. CAPTCHA/блокировка возвращается как ошибка. Оба инструмента включены в стандартный allowlist; для профилей с явным `tools.allowlist` добавьте их вручную. Текст сайтов — недоверенные данные, не инструкции.

Проверки: `npm run test:fortress`; проверка настоящего браузера и поиска: `ALIVE_BROWSER_LIVE_TEST=1 npm run test:fortress`.

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
| `alive update [--check] [--auto] [--rollback] [--status] [--tag vX.Y.Z] [--force]` | обновление харнесса до стабильного тега; `--check` — отчёт, `--auto` — автообновление с проверками и кодом 10 «перезапусти меня», `--rollback` — откат по маркеру, `--status` — состояние |
| `alive logs [-n 50] [-f] [--file stdout\|alive\|thoughts] [--json]` | хвост логов; `-f` — следить за новыми строками |
| `alive say <text> [--thread t] [--no-reply]` | кладёт сообщение человека в durable-инбокс |
| `alive emit <text> [--kind k] [--priority p] [--json '<obj>']` | observability-событие |
| `alive remind <text> --in 5m \| --at <ISO>` | напоминание агенту |
| `alive reminders [--all]` | список напоминаний |
| `alive status [--json]` | состояние рантайма, инбокса, политики, бюджета |
| `alive heartbeat [--status] [--json]` | живость процесса: pid, `startedAt`, версия, возраст heartbeat; код 0 — свежий, 1 — нет/устарел |
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

### Heartbeat и внешний watchdog

При старте рантайм один раз на процесс (не на каждый run) атомарно пишет
`.alive/heartbeat.json`: временный файл в том же каталоге, затем `rename`, поэтому
читатель никогда не увидит половину записи.

```json
{
  "pid": 4242,
  "startedAt": "2026-01-02T03:04:05.000Z",
  "version": "0.2.0",
  "tag": "v0.2.0",
  "ref": "master"
}
```

`tag` и `ref` необязательны: это последний успешно применённый тег `alive update` и
git-ветка (или короткий коммит), с которой запущен харнесс — насколько их можно
определить на месте. Запись делается один раз при старте; чтобы долгоживущий процесс
не выглядел мёртвым, рантайм раз в треть `updates.heartbeatStaleMs` обновляет только
mtime файла — `startedAt`, pid и версия остаются теми же. Ошибка записи логируется на
уровне warn и никогда не мешает старту.

```bash
alive heartbeat            # содержимое: pid, start, uptime, version, tag/ref, возраст
alive heartbeat --status   # одной строкой: fresh | stale | missing, возраст, pid, версия
alive heartbeat --json     # то же машинно-читаемо: path, state, fresh, ageMs,
                           # uptimeMs, staleAfterMs, heartbeat
```

Код возврата: `0` — heartbeat свежий, `1` — файла нет или он старше
`updates.heartbeatStaleMs` (по умолчанию 300000 мс = 5 минут). Именно по этому сигналу
внешний watchdog (systemd timer, cron, мониторинг) понимает, что харнесс жив; автообновление
по этому сигналу появится отдельной задачей. После штатной остановки файл остаётся, поэтому
«свежий» значит «процесс писал heartbeat недавно», а не «прямо сейчас работает».

### Релизы и теги

Тег — обязательная часть релиза, а не необязательная отметка. Правило:

1. Перед мержем релизных изменений в `master` поднимите `version` в `package.json`
   (semver: патч — фиксы, минор — новые возможности, мажор — несовместимые изменения).
2. После мержа поставьте на `master` аннотированный тег `vX.Y.Z`, совпадающий с этой
   версией: `git tag -a vX.Y.Z -m "Alive X.Y.Z: <короткий список изменений>"`.
3. Запушьте тег: `git push origin vX.Y.Z`. Без пуша `alive update` его не увидит —
   команда читает только remote-теги.
4. Пре-релизы (`vX.Y.Z-rc.1`) допустимы для промежуточных проверок, но `alive update`
   их игнорирует: обновление идёт только на стабильный `vX.Y.Z`.

Если тега нет, обновляться некуда: `alive update --check` честно ответит
`no stable vX.Y.Z tags found`. Один тег — одна версия: переиспользовать или
переставлять существующий тег нельзя.

### Обновление харнесса

Харнесс обновляется до последнего стабильного тега `vX.Y.Z` явной командой:

```bash
alive update --check        # только отчёт: текущий ref, тег, маркер, dist/ и dist.prev/
alive update                # применить: checkout + npm ci + npm run build + health gate
alive update --tag v0.2.0   # конкретный стабильный тег вместо последнего
alive update --status       # текущий ref, содержимое маркера, наличие dist/ и dist.prev/
alive update --rollback     # вернуть previousRef и dist.prev/ из маркера
```

`--check` не меняет checkout: команда делает `git fetch --tags origin` (обновляются
только remote-теги, рабочее дерево не трогается), выбирает самый новый стабильный тег
(`vX.Y.Z`; пре-релизы вроде `v1.0.0-rc.1` игнорируются), сравнивает его с текущим
состоянием (тег через `git describe --tags --exact-match`, иначе ветка/коммит и версия
из `package.json`) и печатает команду для применения. В конце отчёта видны маркер
обновления и наличие `dist/`/`dist.prev/`.

Перед первым изменяющим шагом `alive update` пишет в корень репозитория маркер
`.alive-update.json` (файл в `.gitignore`):

```json
{
  "previousRef": "main",
  "previousTag": "v0.1.0",
  "targetTag": "v0.2.0",
  "startedAt": "2026-01-01T12:00:00.000Z",
  "finishedAt": "2026-01-01T12:05:00.000Z",
  "outcome": "success",
  "restartRequested": true
}
```

`outcome` принимает `in-progress`, `success`, `rolled-back` или `failed`. Маркер
обновляется на успехе и после любой неудачи, поэтому `--status` и `--rollback` работают
даже если процесс обновления был прерван. `restartRequested` появляется только после
успешного `alive update --auto` и означает «watchdog, перезапусти харнесс».

Перед сборкой нового тега текущий `dist/` переезжает в `dist.prev/` (хранится одно
поколение; существующий `dist.prev/` заменяется). После `npm run build` выполняется
короткая health-проверка `node dist/index.js --help` с таймаутом ~15 с: ненулевой код
или таймаут считаются провалом и запускают автоматический откат.

`alive update` отказывается работать, если рабочее дерево грязное (`git status
--porcelain` не пуст): сначала закоммитьте или спрячьте изменения, либо передайте
`--force`. Даже с `--force` checkout остаётся обычным — локальные изменения никогда не
выбрасываются, и git может отказать, если они конфликтуют с тегом. Команда также
откажется обновлять detached HEAD, который не стоит на теге.

При любой неудаче автоматического обновления (checkout, установка, сборка, health gate)
команда возвращает предыдущий ref, восстанавливает сохранённый `dist.prev/` (мгновенно,
без сети) или пересобирает старый ref, и завершается с ненулевым кодом, сообщая, что
именно откатилось. `.alive/`, `alive.config.json`, `SOUL.md` и `.env` не трогаются;
`git push` не выполняется, ветки не удаляются, за пределы checkout команда не выходит.

`alive update --rollback` читает `.alive-update.json`, возвращает `previousRef` и
восстанавливает `dist.prev/` (rename, без сети и пересборки). Если сохранённого
`dist.prev/` нет, старый ref пересобирается (`npm ci` + `npm run build` + health gate).
Грязное дерево требует `--force`; отсутствующий или повреждённый маркер приводит к
понятной ошибке, и команда ничего не меняет. `--rollback` работает и тогда, когда
текущий HEAD или сборка сломаны, а при наличии `dist.prev/` не требует сети.

`alive update --status` показывает текущий ref, поля маркера (`previousRef`,
`previousTag`, `targetTag`, `outcome`, timestamps) и наличие `dist/`/`dist.prev/`.
Те же сведения печатает `--check`.

Команда никогда не перезапускает работающий харнесс. После успешного обновления или
отката старый процесс продолжает исполнять старый код, поэтому перезапустите его
вручную: `alive restart` (или `alive stop && alive run`).

### Авто-обновление

Автообновление состоит из двух частей: `alive update --auto` решает, можно ли
обновляться, и применяет обновление, а внешний watchdog перезапускает харнесс и
проверяет, что новый процесс действительно поднялся. Сам `--auto` **никогда** не
перезапускает и не останавливает ничего: процесс не может надёжно заменить сам себя и
доказать, что замена жива.

```bash
alive update --auto        # автообновление; обычное ручное — `alive update`
```

`--auto` выполняет проверки по порядку и пишет в лог каждую из них. Любая неудачная
проверка — это «ничего не делать» и код 0:

1. `updates.auto` равно `true`;
2. локальное время внутри `updates.window` (`HH:MM-HH:MM`, пусто = любое время,
   переход через полночь разрешён);
3. рантайм не занят: heartbeat моложе ~2 минут **и** `runtime.json` показывает
   `status: "working"` (идёт run) или `"starting"`. Свежий heartbeat значит, что
   процесс жив; `runtime.json` — единственный файл, куда loop пишет текущий run, и он
   обновляется каждые несколько секунд. Если heartbeat свежий, а `runtime.json` не
   читается, обновление считается занятым: доказать idle нельзя. Устаревший heartbeat
   означает, что процесс уже мёртв, и обновляться безопасно;
4. в origin есть стабильный тег `vX.Y.Z` новее текущего;
5. в корне репозитория есть читаемый маркер `.alive-update.json` — это база для
   отката. Отсутствующий, повреждённый маркер или `outcome: "in-progress"` — тоже
   «ничего не делать» с записью в лог. После установки один раз выполните ручной
   `alive update`, чтобы создать базу; дальше автообновления смогут идти сами.

Если все проверки прошли, `--auto` применяет тег тем же путём, что и ручная команда
(checkout → `npm ci --prefer-offline` → `npm run build` → health gate) и завершается
по контракту:

| код | что значит | что делать watchdog'у |
|---|---|---|
| `0` | ничего не делать: проверка не прошла или нового тега нет | остановиться |
| `1` | обновление упало, автоматический откат уже выполнен | остановиться и сообщить об ошибке |
| `10` | обновление применено, в маркере `restartRequested: true` и `targetTag` | перезапустить и проверить heartbeat |

При успехе в `.alive-update.json` появляются `"restartRequested": true` и целевой тег,
а при неудаче — `outcome: "rolled-back"` (или `failed`, если откат не удался) и
`restartRequested` снят. Ручной `--rollback` тоже снимает `restartRequested`.

#### Watchdog

Готовый watchdog лежит в `deploy/update/`: инструкция по установке, выбору команды
перезапуска и хукам уведомлений — в `deploy/update/README.md`. Кратко:

```bash
deploy/update/alive-auto-update.sh <repo-dir> <state-dir> <restart-command>
```

1. запускает `alive update --auto`: 0 → выход 0, 1 → выход 1, 10 → продолжает;
2. запоминает момент времени, выполняет команду перезапуска и опрашивает
   `<state-dir>/heartbeat.json`, пока `startedAt` не станет новее этого момента
   (таймаут 180 с, переопределяется `ALIVE_UPDATE_RESTART_TIMEOUT_SEC`);
3. свежий heartbeat → успех, выход 0;
4. heartbeat не появился → `alive update --rollback`, повторный перезапуск, повторный
   опрос; если и старый код не поднялся — выход с ошибкой. Любой исход с откатом
   считается неудачным обновлением и завершается ненулевым кодом, чтобы systemd
   (или `OnFailure=`/`ExecStopPost=` хук) сообщил оператору.

Все шаги пишутся в `<state-dir>/logs/auto-update.log`; команда перезапуска и
переменные окружения туда не попадают. `deploy/update/alive-auto-update.service` и
`.timer` запускают watchdog раз в сутки в окне обслуживания (по умолчанию 04:00,
`Persistent=true`, случайная задержка).

#### Выключить

1. `"updates": { "auto": false }` в `alive.config.json` — следующий запуск watchdog'а
   залогирует отказ и выйдет с кодом 0;
2. `sudo systemctl disable --now alive-auto-update.timer` — таймер больше не будит
   сервис; ручной `systemctl start` по-прежнему возможен;
3. удалить оба unit-файла и сделать `systemctl daemon-reload`;
4. ручные `alive update`, `--check`, `--status`, `--rollback` работают независимо от
   `updates.auto` и watchdog'а.

Неудачный старт нового билда восстановим только снаружи процесса: если новый код не
запускается, откат должен выполнить кто-то, кто не является этим процессом. Поэтому
проверка heartbeat и откат живут в watchdog'е, а не внутри `alive update --auto`.

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

## Маскирование секретов

Секреты маскируются на границах, где текст покидает процесс. Хранимые историю и память
это не переписывает: они локальные, и маскирование там спрятало бы информацию, которая
агенту ещё пригодится.

- **Логи** (`src/log.ts`): сообщение каждой строки и все поля структурированных
  данных — вложенные объекты, массивы и `Error.message`/`stack`.
- **Telegram, исходящие** (`src/modules/telegram/module.ts`): текст `send_message`,
  подписи вложений и остаток длинной подписи, который уходит отдельным сообщением.
- **Текст для агента**: заголовки, тела и `payload` событий, ошибки worker'ов и
  поля `lastError` в статусе/записях прогонов. Сами события и историю это не меняет.

Формат маски: `[тип#id]`, например `[github#1]`, `[telegram-bot#2]`,
`[env:GROQ_API_KEY#3]`. От значения секрета не остаётся ни одного символа.
Внутри одного контекста (строка лога, исходящее сообщение, отрисованный промпт)
один и тот же секрет получает тот же `id`, а разные секреты — разные `id` в порядке
первого появления. Значения короче 8 символов маскируются с общим ярлыком `custom`.

Встроенные форматы: Telegram bot token, GitHub (`ghp_…`, `github_pat_…`), OpenAI
(`sk-…`), Anthropic (`sk-ant-…`), Groq (`gsk_…`), AWS access key id (`AKIA…`), JWT,
`Authorization: Bearer …` и голый `Bearer …`, PEM-блоки приватных ключей и
`https://user:password@host`. Обычный текст, числа, URL без учётных данных, git-хеши
и UUID не трогаются.

Дополнительно маскируются значения `process.env`, если имя переменной содержит
`TOKEN`, `SECRET`, `PASSWORD`, `PASS`, `KEY` или `CREDENTIAL`, а значение не короче
8 символов. Это страховка для ключей провайдеров с неизвестным форматом.

Настройки (значения по умолчанию безопасны):

```json
"secrets": {
  "maskEnv": true,
  "extraPatterns": ["acme_[A-Za-z0-9]{16,}"]
}
```

Каждый шаблон в `extraPatterns` проверяется при загрузке конфига и должен
компилироваться как `RegExp`. Маскирование — не замена безопасному хранению:
держите токены в `.env`/`alive.config.local.json`, не в репозитории и не в промптах.

## Модули и Events API

Опциональный браузерный модуль использует Patchright, постоянный профиль Chrome и плавные действия мыши/клавиатуры, добавляет остановку при проверке/ограничении доступа и ручное управление той же вкладкой с телефона. Команды `alive browser setup`, `doctor`, `pair` и `serve --tunnel` помогают настроить и проверить подключение без модели. Пошаговое подключение телефона: [BROWSER_QUICKSTART.ru.md](BROWSER_QUICKSTART.ru.md). Архитектура, ограничения и Web Bot Auth для подписанных запросов Chrome: [BROWSER.md](BROWSER.md).


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
  читает историю чатов, реакции, файлы, участники. Голосовые распознаются, если в
  окружении хоста задан `GROQ_API_KEY` (отключается `modules.telegram.transcription`).
  Подробно: [TELEGRAM.md](./TELEGRAM.md).
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
heartbeat.json          признак жизни процесса: pid, startedAt, version, tag/ref
                        (его читает `alive heartbeat` и внешний watchdog)
logs/alive.jsonl        структурный лог рантайма
logs/thoughts.jsonl     приватный монолог (текст и thinking)
sessions/               jsonl-сессии pi (контекст живёт здесь, пока агент не уснул)
workspace/              рабочая директория агента для read/write/bash
agent/                  изолированный pi agent dir (расширения, skills)
tools/                  созданные агентом Node.js-инструменты и npm-зависимости
workers/<id>/           записи и pi-сессии эфемерных coding-worker'ов
workers/worktrees/<id>/  git worktree host-профиля (в sandbox он живёт в guest)
workers/usage.jsonl     расход worker-run'ов (учитывается в дневном бюджете)
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

## Конфиг обновлений

```json
"updates": {
  "auto": false,               // автообновление выключено по умолчанию
  "window": "",                // локальное окно "HH:MM-HH:MM"; пусто = любое время
  "heartbeatStaleMs": 300000,  // heartbeat старше — процесс считается мёртвым
  "restartCommand": ""         // чем перезапускать после обновления; пусто = вручную
}
```

Всё выключено по умолчанию: агент не обновляет и не перезапускает себя без явного
разрешения оператора. `window` проверяется на формат `HH:MM-HH:MM` (24-часовое
локальное время, переход через полночь разрешён), `heartbeatStaleMs` должен быть
положительным целым. `alive heartbeat` использует `updates.heartbeatStaleMs` как порог
устаревания. Автообновление и рестарт по heartbeat реализованы в `alive update --auto`
и watchdog'е из `deploy/update/`; см. раздел «Авто-обновление» выше.

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

### Coding workers (эфемерные субагенты)

Отдельно от постоянных агентов есть **workers** — одноразовые сессии
pi-coding-agent. У них нет памяти, inbox, напоминаний, `idle` и жизненного цикла:
агент даёт задачу, worker правит код в репозитории (по умолчанию в изолированном
git worktree), прогоняет тесты и возвращает краткий отчёт. Follow-up продолжает
ту же сессию, поэтому «напиши» и «протестируй» — это два сообщения одному worker'у.

Это отдельное операторское разрешение `workers`, а не часть `agentManagement`:
managed-агенты его не наследуют. Модели ограничиваются `workers.models`, инструменты
— `workers.tools`, публикация — отдельным `pullRequest` permission. Worker не создаёт
отдельный host-shell или отдельную VM: в sandbox-профиле его файлы/команды идут в
той же VM и том же guest workspace, что и у агента, а без sandbox — в host
workspace профиля. Host-fallback отсутствует.

```bash
alive workers list
alive workers status <worker-id>
alive workers diff <worker-id> [--full]
alive workers models
```

Конфиг, workflow (start → событие → send → diff → pr → remove), состояние и границы
описаны в [WORKERS.md](./WORKERS.md).

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
