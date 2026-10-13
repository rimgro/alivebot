# Microsandbox: изоляция агентов

Alive использует **microsandbox 0.7.8**, закреплённый в `package-lock.json`.
По умолчанию `sandbox.enabled: true` даже у старых конфигов без секции `sandbox`.
Нет fallback на хост при ошибке SDK, образа, прав, нехватке ресурсов или KVM.

## Что изолируется

- `bash` выполняется в отдельной persistent microVM каждого агента.
- `read`, `write`, `edit`, `ls`, `find`, `grep`, `file` работают с **гостевыми**, а не хостовыми путями.
- `/home/<имя-агента>` — отдельный named directory volume `alive-private-<hash stateDir>`.
  Путь строится из `config.name`: lowercase ASCII slug до 48 символов (`Alive` → `/home/alive`,
  `Writer Team` → `/home/writer-team`); при пустом slug используется `agent-<hash name>`.
  Это также рабочая директория shell и default `HOME`; default `XDG_CACHE_HOME` — `$HOME/.cache`.
  Фактический путь показывает `alive sandbox status` в поле `workspaceDir`.
  Хостовый `workspace` **не монтируется**. State, credentials, Docker socket хоста не монтируются тоже.
- Имя VM `alive-<hash stateDir>` сохраняется между рестартами. Разные `stateDir` означают разные VM/приватные тома.
- VM не нужна для вызовов модели, памяти, сообщений, `idle`, `sleep` и обычных файлов в остановленном workspace.
- Host browser / `web_search`, исполняемый `tool_registry`, pi-расширения, workspace-discovery
  extensions/skills/templates отключены у изолированных профилей. Заявленные `extensions` вызывают ошибку запуска,
  а не скрытое исполнение на хосте. Браузер внутри VM пока не адаптирован.
- Runtime, память, Telegram/Grafana и **явно подключённые внешние модули** остаются доверенными хостовыми сервисами.
  Это изоляция shell/FS инструментов, **не изоляция всего Node-процесса**. Внешний модуль имеет права процесса;
  его автор обязан использовать `ctx.workspaceFiles` для файлов агента и не предоставлять произвольный host exec/FS.
  Telegram download/upload уже используют этот bridge.

Полностью отключить защиту может оператор: `"sandbox": { "enabled": false }`.
Тогда возвращаются прежние хостовые файловые/shell инструменты и разрешённые расширения/browser.
Agent-management tools намеренно не имеют поля для отключения sandbox у создаваемых/редактируемых агентов.

## Установка и диагностика

```sh
npm install
npm run alive -- sandbox status
npm run alive -- sandbox status --config .alive/agents/writer/alive.config.json
```

Npm SDK содержит native runtime; отдельный постоянно работающий server не нужен.
CLI доступен как `npx --no-install msb …`. Runtime/cache по умолчанию находятся в `~/.microsandbox`,
либо в явно настроенном `MSB_HOME`. Не задавайте отдельный `MSB_HOME` каждому агенту:
это размножит cache образов и отменит sharing томов. Поддерживается локальный backend.

Linux требует KVM и **read/write доступ** процесса Alive к `/dev/kvm`:

```sh
ls -l /dev/kvm
id
# Администратор системы при необходимости:
sudo usermod -aG kvm "$USER"
# Затем новый login / перезапуск пользовательского service с новой группой.
```

macOS: Apple Silicon; Windows: WHP (ограничения beta SDK применимы).
Первый shell call скачивает OCI-образ. Offline-файлы и просмотр статуса не скачивают образ и не запускают VM.
Перед новым boot на Linux Alive проверяет KVM, чтобы не скачивать образ заведомо зря.
Образ должен содержать `/bin/bash` и `python3`; штатный — `python:3.12-slim`.
Docker/браузер/другие toolchain в него не установлены: используйте свой совместимый OCI-образ.
Image entrypoint/CMD намеренно очищены; сервисы запускайте явными командами агента.

## Настройки каждого агента

Секция в его собственном `alive.config.json` (все приведённые значения — defaults):

```json
{
  "sandbox": {
    "enabled": true,
    "image": "python:3.12-slim",
    "cpus": 1,
    "memoryMiB": 512,
    "uid": 0,
    "gid": 0,
    "network": true,
    "networkAccess": "public",
    "env": {},
    "offlineFiles": true,
    "idleTimeoutMs": 300000,
    "checkIntervalMs": 30000,
    "dockerDiskMiB": 0,
    "maxFileBytes": 8388608,
    "sharedVolumes": [
      { "name": "alive-shared-resources", "mountPath": "/shared", "readOnly": true }
    ]
  }
}
```

```sh
# JSON с частичными настройками; только операторская CLI, не инструменты агента:
npm run alive -- agents create writer --sandbox-file writer-sandbox.json
npm run alive -- agents edit writer --sandbox-file writer-sandbox.json
```

Например `writer-sandbox.json`: `{"memoryMiB":256,"cpus":1,"network":false,"idleTimeoutMs":60000}`.
Новые managed агенты наследуют настройки creator profile, затем получают отдельные VM/приватный workspace.
Изменение одного профиля не изменяет остальные. Массив `sharedVolumes` и объект `env` в CLI overrides заменяются целиком.
Для профилей с явным `tools.allowlist` добавьте `sandbox_control` и `file`, если они нужны.
`tools.bash`, `tools.builtin`, общий allowlist продолжают ограничивать инструменты.

**Изменения boot-настроек** (образ, CPU/RAM, uid/gid, mounts, env, network, Docker disk) не применяются молча
к существующей VM: Alive проверяет owner/config labels и отказывает при несовпадении. Сначала остановите
агента, проверьте процессы/контейнеры старой VM, явно остановите и удалите её через `msb`, затем запустите
профиль с новыми параметрами. Приватный named workspace переживает удаление VM; writable rootfs и owned
Docker disk — нет, их нужно сохранить отдельно перед удалением. Idle/offline/maxFileBytes настройки
не требуют удаления VM. Смена `stateDir` меняет идентичность sandbox — старую VM/том надо обслужить явно.

### Переход с `/workspace` на `/home/<имя-агента>`

Смена layout или `config.name`, меняющая гостевой путь, требует явного пересоздания уже существующей VM:
остановите Alive, сохраните важные данные вне persistent mounts, затем остановите и удалите только VM
через `msb`. Приватный named volume **не удаляйте**: новая VM монтирует тот же том в новый home,
поэтому его файлы сохраняются без копирования. Старый `/workspace` больше не монтируется.
Старые default значения `sandbox.env.HOME=/workspace` и `XDG_CACHE_HOME=/workspace/.cache`
автоматически заменяются на новый путь; остальные явные env overrides сохраняются.
Каталог `/home` зарезервирован для приватного тома и недоступен для shared mounts.

## Сеть и секреты

Из ветки `strongf/microsandbox-agent-isolation-plan` перенесён принцип
**default-deny с public egress**, без переноса runtime в VM.
При `network:true, networkAccess:"public"` разрешены исходящие TCP/UDP и ICMP
к публичным адресам. К хосту разрешён только DNS (TCP/UDP порт 53).
Другие адреса хоста, loopback назначения сетевого gateway, приватные сети,
link-local и cloud metadata не разрешены; входящие соединения default-deny.
Внутреннее общение процессов через гостевой localhost не требует внешнего egress.
Это защита сетевой границы VM, не фильтр содержимого запросов и не DLP:
публичный сервер и DNS по-прежнему могут служить каналом утечки данных.

Для доверенного профиля оператор может явно задать `networkAccess:"unrestricted"`
и вернуть стандартную сеть SDK без этой политики (в том числе доступ к LAN/хосту).
`network:false` полностью отключает сеть независимо от `networkAccess`.
Политика входит в boot fingerprint: существующую VM нужно явно пересоздать
после проверки/сохранения фоновой работы. Изменение layout с v2 на v3 также
отказывает в молчаливом reuse старой VM с неизвестной сетевой политикой.

Ключи модели, embeddings и Telegram используются **хостовыми** клиентами,
не передаются в guest env и не требуют TLS-подстановки. Не помещайте секреты
в `sandbox.env`, image, shared volumes или файлы workspace: явный `env`
сохраняется в конфигурации VM, а гостевой shell может прочитать и отправить
переданные ему данные. Runtime и доверенные модули остаются вне VM и вне её
сетевой политики.

Host-referenced secret placeholders и Telegram approval из удалённой ветки
**не перенесены**: первые нужны при гостевых API-клиентах, которых у нас нет;
второй проверяет браузерный HTTP, но не защищает произвольный shell.
TLS inspection, запрет bash/UDP и browser sidecar также не включены.
Выдачу credentials гостевым задачам следует отдельно проектировать как
ограниченный host broker, а не обещать защиту уже раскрытого гостю секрета.

## Как экономятся место и RAM

- Один npm/runtime/cache образов на хосте. Одинаковый OCI image у агентов переиспользует microsandbox cache;
  Alive не копирует toolchain или host `node_modules` в каждый workspace.
- По умолчанию один общий **read-only** named directory volume `/shared` для подготовленных toolchain,
  моделей, datasets и других неизменяемых ресурсов. Он создаётся пустым и автоматически используется всеми
  профилями с этим именем. Наполняет его оператор. Монтирование не копирует данные каждому агенту.
- Свои файлы/кэши по умолчанию persistent в `/home/<имя-агента>`; только shell/guest-only файловые операции boot'ят VM.
- RAM/CPU настраиваются по профилю; 512 MiB / 1 vCPU по умолчанию. Sampling SDK metrics отключён:
  не плодим per-VM метрики и записи в хранилище. Idle monitor работает раз в 30 секунд, а не крутит busy loop.
- Idle shutdown освобождает память VM, но сохраняет workspace/диски и не пересоздаёт контейнерные images каждый раз.
- Alive **не обещает общий fleet RAM cap**: одновременно активные VM суммируют память плюс runtime overhead.
  Выбирайте лимиты профилей под размер хоста. Общий том экономит диск, но не делает память отдельных VM общей.
- Persistent данные не удаляются автоматическим GC. Для compaction/pruning используйте `msb` после проверки
  зависимостей. Directory volumes не имеют установленной Alive дисковой квоты; `maxFileBytes` ограничивает
  файловый tool call, но **не shell и не общий размер workspace**. Для жёстких квот нужна политика storage на хосте.

### Общие writable package caches — только по явному согласию

Для **взаимно доверенных** агентов можно разделить npm/pip cache:

```json
{
  "sandbox": {
    "env": {
      "npm_config_cache": "/cache/npm", "PIP_CACHE_DIR": "/cache/pip"
    },
    "sharedVolumes": [
      { "name": "alive-shared-resources", "mountPath": "/shared", "readOnly": true },
      { "name": "alive-npm-cache", "mountPath": "/cache/npm", "readOnly": false },
      { "name": "alive-pip-cache", "mountPath": "/cache/pip", "readOnly": false }
    ]
  }
}
```

Cache concurrency/locking — ответственность package manager. Writable sharing позволяет poisoning,
повреждение данных и связь между агентами; поэтому это **не default**. Не разделяйте `node_modules`,
виртуальные окружения, базы данных, credentials или Docker data-root как writable cache.
Для недоверенных агентов лучше общий immutable toolchain/image или read-only artifacts/mirror.
Guest env берётся только из образа и `sandbox.env`; host env и Pi session credentials не передаются.

## Безопасная остановка VM

VM/context lifecycle независимы: `sleep` сбрасывает разговор, **не выключает VM** и не стирает background work.
`idle({important:true})` — про контекст, **не VM hold**.

Monitor может остановить VM только при всех условиях:

1. Нет выполняющихся/ожидающих файловых/shell операций; boot/write/edit/probe/stop используют одну очередь.
2. После последней операции прошло `idleTimeoutMs`; `0` полностью выключает auto-stop.
3. Нет durable `sandbox_control` holds.
4. **Две успешные пустые проверки**, разделённые `checkIntervalMs`: `/proc`, Docker socket и native jobs.

В `/proc` учитываются даже спящие/idle процессы, `nohup`, watcher, dockerd/containerd и их потомки.
Необъявленный bind/overlay/tmpfs mount внутри `/home/<имя-агента>` тоже блокирует auto-stop: его view не представлен
в offline томе, а остановка может потерять tmpfs данные. Уберите mount после сохранения данных; VM hold
подходит и для других важных transient ресурсов.
Не учитываются только PID 1, kernel threads по флагу `PF_KTHREAD`, zombie/dead процессы и собственная цепочка
предков probe (exec helpers/agentd). Нет эвристики «0% CPU значит idle», whitelist по имени процесса,
startup baseline или предположения «bash вернулся значит работы больше нет».
Docker `/var/run/docker.sock`, если существует, дополнительно запрашивается на running containers.
Native jobs в `starting`, `running`, `lost` и неизвестном состоянии блокируют остановку — PID может ещё не появиться.
Неполный job inventory или любая ошибка проверки блокируют остановку. Нестандартная инфраструктура образа
может консервативно удерживать VM включённой; это безопаснее потери сервиса.

**Критичные сервисы закрепляйте до запуска**, особенно если работа удалённая или не представлена локальным PID:

```json
{"action":"pin","key":"database","reason":"Postgres/Docker обслуживает текущую задачу"}
```

Завершив работу: `sandbox_control({"action":"unpin","key":"database"})`.
Для shell background используйте `nohup … >"$HOME/service.log" 2>&1 </dev/null &` или Docker `-d`,
чтобы background не удерживал foreground stdout/stderr. VM hold не отменяет timeout/abort самой команды.

Holds хранятся атомарно в `<stateDir>/sandbox-holds.json` и переживают context reset/restart.
`status` не boot'ит VM, показывает её текущее lifecycle state, holds и **последние**, не live, activity evidence
(с timestamp `evidenceAt`). Актуальную инспекцию оператор делает через `msb exec/inspect`.

При остановке/crash **процесса Alive** VM detach'ится, но не уничтожается: важный Docker должен пережить
остановку чата. После этого Alive monitor больше не работает, и detached VM может занимать RAM до restart
Alive или явного операторского `msb stop`. Это сознательное fail-safe поведение, не скрытый host reaper.
Внешние команды start/stop/remove одной VM параллельно с Alive не поддерживаются; сначала остановите runtime.
`--force` не разрешает запустить второй runtime поверх живого изолированного профиля.
Не переназывайте/заменяйте VM: проверяется её stable identity и ownership labels.

Docker запускается **внутри VM**, host Docker socket не подключается. Для Docker image включите,
например, `dockerDiskMiB:8192`: это отдельный private persistent block disk `/var/lib/docker` этой VM.
Он не разделяется между агентами и удаляется вместе с VM; заранее сохраняйте нужные контейнерные данные.

## Файлы без boot и watcher/permission semantics

- Offline route доступен только при подтверждённом `not-created`/`created`/`stopped` state VM,
  `offlineFiles:true`, `uid:0,gid:0`, и для обычных путей внутри приватного `/home/<имя-агента>`.
- Используется capability-scoped native `Volume.fs()`, а не уязвимый `realpath → host open`.
  Защита от traversal/symlink escape реализована в закреплённой версии microsandbox.
- Symlink (включая dangling), special file, special mode, readonly target, путь вне workspace
  переводят операцию в гостя; non-root профиль всегда использует гостевую identity/permissions.
- После boot даже внутри одного multi-op tool дальнейшие операции переходят на guest route.
  Нет host-записей в running volume и обещания, что host virtiofs write доставляет гостевой inotify.
- Live операции выполняются Python FS helper в VM **под настроенным uid/gid**. Write сохраняет существующий
  inode/mode (без rename-over), поэтому обычные inotify/file watcher и hardlinks получают guest-семантику.
  Это не транзакция против произвольных параллельных гостевых процессов; для совместной записи используйте их locking.
- `read` — собственный guest-only reader с pagination и Pi image resizing/truncation (без скрытых host-path probes).
  Cancellation не освобождает lifecycle lock до завершения IO. `edit` сохраняет SDK multi-edit/overlap checks/diff.
  `file` добавляет stat/hash/mkdir; `find` поддерживает glob, `grep` — bounded **literal**, не regex search.
  **`file stat` запускает VM**: microsandbox виртуализирует mode/uid/gid, и metadata backing volume нельзя
  выдавать за гостевые permissions. Stat возвращает guest mode/uid/gid/mtime. Offline `ls` показывает только
  имена, типы и размеры; hash/mkdir/read/write обычных workspace файлов остаются без boot.
  Symlinks не обходятся рекурсивно. Oversized/binary файлы пропускаются search-инструментом.
- Пути POSIX: относительные к `/home/<имя-агента>`, `~/` — alias гостевого home, не home пользователя хоста.
- Лимиты: default 8 MiB на файл, 10000 обходимых entries, 32 MiB суммарного чтения grep, 64 KiB search/shell output; bash выдаёт tail и exit code.
  Большие артефакты создавайте гостевым shell, затем читайте ограниченные части/преобразуйте их.

### Перенос старого host workspace

Старые файлы не импортируются автоматически: вместе с ними можно случайно перенести секреты, symlinks и большие
dependency trees. Остановите runtime/VM, узнайте `workspaceVolume` через `alive sandbox status`, затем **явно**
перенесите выбранные файлы, например:

```sh
# Замените имя тома и исходный файл своими значениями; выполнение только оператором.
node --input-type=module - <<'JS'
import { Volume } from 'microsandbox';
import { readFile } from 'node:fs/promises';
const name = 'alive-private-REPLACE_WITH_VOLUME_ID';
let volume;
try { volume = await Volume.get(name); }
catch (error) {
  if (error.code !== 'volumeNotFound') throw error;
  volume = await Volume.builder(name).directory().create();
}
await volume.fs().write('/project/config.json', await readFile('./old-workspace/project/config.json'));
JS
```

Не редактируйте volume на хосте, когда VM работает; это обходит guest permissions/watchers.

## Проверки

```sh
npm run test:sandbox       # mock lifecycle + настоящий native offline volume; KVM не нужен
npm test                  # включая sandbox suite
npm run test:sandbox:vm    # opt-in настоящий boot/KVM; скачивает образ и удаляет test VM/volume
```

Portable suite проверяет native network policy (default-deny/public/DNS), её подключение
при boot, отключённую сеть и явный unrestricted режим. Это проверка конфигурации,
не доказательство фактической сетевой фильтрации запущенной VM.

Portable suite проверяет фактическую регистрацию SDK tools (host cwd не должен попасть в guest path), multi-edit,
symlink escape настоящего native API, offline vision, cancellation/IO lock, отдельные профили, route после boot, non-root identity, Telegram bridge,
background processes/containers/native jobs, ошибки inventory, durable holds и две пустые проверки.
Real-VM suite проверяет boot/restart/persistence, shared readonly mount, guest permissions/inotify и живой background process.
Если KVM недоступен, она падает явно — это **не подтверждение**, что реальная VM протестирована.
