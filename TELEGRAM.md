# Telegram

Полноценная интеграция с Telegram Bot API: бот **принимает** сообщения, **отправляет**
ответы агента, **читает историю чатов** и имеет инструмент для всего остального
(участники, реакции, пины, форварды, файлы).

Реализация: [`src/modules/telegram/`](./src/modules/telegram/).
Контракт, на котором она построена: [EVENTS_API.md](./EVENTS_API.md).

## 1. Настройка за 3 шага

1. Создайте бота у [@BotFather](https://t.me/BotFather) и получите токен.
2. Положите токен в окружение (в конфиг лучше не коммитить):

   ```bash
   export ALIVE_TELEGRAM_TOKEN="123456:ABC-DEF..."
   ```

3. Включите модуль в `alive.config.json`:

   ```json
   "modules": {
     "telegram": { "enabled": true, "tokenEnv": "ALIVE_TELEGRAM_TOKEN" }
   }
   ```

   Либо положите токен в gitignored `alive.config.local.json` (работает без env):

   ```json
   { "modules": { "telegram": { "enabled": true, "token": "123456:ABC-DEF…" } } }
   ```

Проверка без запуска агента:

```bash
alive telegram me                       # кто я: имя, @username, id
alive telegram chat @some_channel       # getChat по @username или id
alive telegram send 123456789 "привет"  # отправить сообщение
alive telegram chats                    # что уже записано локально
```

Для приватного чата пользователь должен сначала написать боту сам (или нажать
`/start`) — Bot API не позволяет писать первым произвольному пользователю.
В группах бота нужно добавить и (для чтения обычных сообщений) отключить privacy
mode у BotFather, либо обращаться к нему через упоминание/реплай.

## 2. Конфиг

```json
"modules": {
  "telegram": {
    "enabled": true,
    "token": "",
    "tokenEnv": "ALIVE_TELEGRAM_TOKEN",
    "apiBase": "https://api.telegram.org",
    "allowedChatIds": [],
    "allowedUserIds": [],
    "pollTimeoutSec": 25,
    "allowedUpdates": ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query"],
    "parseMode": "",
    "linkPreview": true,
    "typingIndicator": true,
    "ackReaction": "",
    "ingestEdits": true,
    "historyLimitPerThread": 0,
    "maxMessageChars": 4000
  }
}
```

| Поле | Смысл |
|---|---|
| `token` / `tokenEnv` | токен; переменная окружения приоритетнее файла |
| `apiBase` | базовый URL Bot API (для локального bot-api server) |
| `allowedChatIds` | белый список chat id; пусто = все чаты бота |
| `allowedUserIds` | белый список user id; пусто = все пользователи |
| `pollTimeoutSec` | long-poll таймаут `getUpdates` |
| `allowedUpdates` | какие типы апдейтов подписывать |
| `parseMode` | `""` (plain), `"HTML"` или `"MarkdownV2"`; при ошибке разметки сообщение уходит plain-текстом |
| `linkPreview` | показывать превью ссылок |
| `typingIndicator` | слать `typing…`, пока агент работает над ответом |
| `ackReaction` | эмодзи-реакция на входящее сообщение как подтверждение (пусто = выкл) |
| `ingestEdits` | приносить ли редактирования сообщений |
| `historyLimitPerThread` | хранить не больше N сообщений на чат (0 = без лимита) |
| `maxMessageChars` | размер части при разбиении длинных ответов (Telegram лимит — 4096) |

## 3. Как это работает

### Треды

Тред — канонический ключ диалога во всём рантайме (enforcement ответов,
правила уведомлений, маршрутизация исходящих). Формат:

```
telegram:<chatId>              обычный чат (личный, группа, супергруппа, канал)
telegram:<chatId>/<topicId>    тема в форуме (message_thread_id)
```

`chatId` отрицательный для групп/каналов (`-100…`), поэтому разделитель темы — `/`.

### Входящие

Модуль держит long polling `getUpdates` с durable-offset (`.alive/modules/telegram/state.json`),
поэтому после перезапуска старые апдейты не переигрываются. Каждый апдейт:

- фильтруется (свои сообщения и сообщения других ботов игнорируются, allowlist
  проверяется);
- превращается в `user_message` в durable-инбоксе с `dedupeKey`
  `telegram:msg:<chatId>:<messageId>` — повторная доставка не создаст дубль;
- записывается в общую историю (`history`), с `meta.eventId`, чтобы `reply_to`
  агента можно было превратить в Telegram `reply_to_message_id`;
- обновляет каталог чатов (заголовок, тип, @username, тема последнего сообщения).

Что попадает в текст события: текст или подпись, цитата сообщения, на которое
ответили, метка форварда, список вложений (фото/документ/голос/видео/стикер/
локация/контакт/опрос), пометка «edited». В `payload` — структурированные
`chat`, `author`, `messageId`, `topicId`, `attachments`.

`expectsReply` (агент обязан ответить или закрыть тред):

- личный чат — всегда;
- команда (`/start`), упоминание бота (`@bot`) или `text_mention` — да;
- реплай на сообщение бота — да;
- прочая болтовня в группе и посты каналов — нет (наблюдение, не долг).

Callback-кнопки (`callback_query`) приходят как `user_message` «[button pressed] …»,
и бот сразу отвечает на callback, чтобы у клиента не висел спиннер.

### Исходящие

`send_message` в тред `telegram:…` попадает в модуль (он claimer этих тредов).
Дальше:

- текст разбивается по границам абзацев/строк/предложений на части
  ≤ `maxMessageChars`, каждая часть уходит отдельным `sendMessage`;
- `reply_to` агента резолвится: числовой message id, id записи истории
  (`telegram:42:1005`) или id события (`evt_…`) — последний ищется по `meta.eventId`
  в истории;
- ответ уходит в ту же тему форума (`message_thread_id`);
- при ошибке парсинга разметки сообщение автоматически переотправляется plain-текстом;
- всё отправленное пишется в историю как `outbound` с id `telegram:<chatId>:<messageId>`;
- `typing…` гасится, как только сообщение ушло.

### Индикатор набора

Пока агент работает над ответом, модуль раз в 4.5 секунды шлёт `sendChatAction: typing`
для треда. Индикатор жёстко ограничен по времени, поэтому упавший run не оставит
бота «печатающим» навсегда.

## 4. Инструмент `telegram`

Основной канал ответа — `send_message` (маршрутизируется сам). Инструмент
`telegram` нужен для всего остального:

| `action` | Что делает | Основные параметры |
|---|---|---|
| `me` | личность бота и статус модуля | — |
| `list_chats` | локальный каталог чатов с количеством сообщений | `limit` |
| `chat_info` | `getChat` + счётчик участников + локальная статистика | `chat` |
| `resolve_chat` | найти чат по `@username`, id или ссылке | `chat` |
| `history` | читать локальную историю (по умолчанию свежие сверху) | `chat`, `query`, `limit`, `before`, `after`, `since`, `until`, `direction`, `order` |
| `search` | поиск по всем Telegram-чатам | `query`, `limit` |
| `members` | администраторы + число участников | `chat` |
| `member` | статус участника | `chat`, `user_id` |
| `send` | отправить в произвольный чат/тему (проактивно) | `chat`, `text`, `reply_to`, `topic` |
| `edit` | отредактировать сообщение бота | `chat`, `message_id`, `text` |
| `delete` | удалить сообщение | `chat`, `message_id` |
| `forward` | переслать сообщение | `from_chat`, `to_chat`, `message_id`, `topic` |
| `react` | поставить реакцию | `chat`, `message_id`, `emoji` |
| `typing` | включить `typing…` | `chat`, `topic` |
| `pin` / `unpin` | закрепить/открепить | `chat`, `message_id` |
| `download_file` | скачать файл в workspace | `file_id`, `name` |
| `set_commands` | зарегистрировать команды бота | `commands` |

`chat` везде принимает полный тред (`telegram:-100123/7`), голый id (`-100123`)
или `@username`. Скачанные файлы кладутся в
`<workspace>/telegram-files/<имя>` (лимит 25 МБ).

Плюс есть **универсальный** инструмент `history` — он видит историю всех модулей,
не только Telegram.

## 5. История чата: важная деталь про Bot API

Telegram **не даёт ботам серверную историю**: `getUpdates` возвращает только
апдейты за последние 24 часа, а «прочитать переписку» через API нельзя. Поэтому
история — это локальный durable-лог, который ведёт модуль:

- `.alive/history/messages.jsonl` — все входящие и исходящие сообщения;
- `.alive/history/threads.json` — каталог чатов (заголовок, тип, участники, мета);
- `.alive/modules/telegram/state.json` — offset long polling, счётчики, identity.

Практические следствия:

- история начинается с момента, когда бот был запущен (и подключён к чату);
- `historyLimitPerThread` ограничивает рост на болтливых чатах (прунинг с запасом,
  не на каждом сообщении);
- `alive history` и инструмент `history`/`telegram` работают и когда рантайм не
  запущен — они читают файлы.

## 6. Ограничения

- Нет webhook-режима: используется long polling. Один процесс на токен
  (`getUpdates` конфликтует сам с собой).
- Медиа не скачивается автоматически — модель видит описание вложения и `file_id`,
  а файл забирает через `telegram({ action: "download_file" })`.
- Голос/видео не транскрибируются.
- Telegram-лимиты (30 сообщений/сек, 20 сообщений/мин в группу) не соблюдаются
  специально: при 429 модуль уважает `retry_after` для polling, а отправка
  деградирует в ошибку доставки, которую увидит агент.
- Правка/удаление чужих сообщений невозможна (ограничение Telegram).

## 7. Тесты

```bash
npm run test:modules
```

Покрыто без сети: маппинг апдейтов (личка/группа/упоминание/реплай/топик/
медиа/callback/edit), разбиение длинных сообщений, парсинг тредов, клиент Bot API
(конверт, коды ошибок, `retry_after`) и полный цикл модуля на фейковом Bot API —
от `getUpdates` до события в инбоксе, записи в историю и отправки ответа.
