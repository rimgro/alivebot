# Белый IP для живых пультов (rathole + vpn2)

Заменяет временные Cloudflare Quick Tunnels на постоянный публичный адрес на белом IP.

```
Телефон ──HTTPS──► tungnetwork.ftp.sh:432X   (vpn2, 153.52.66.88)
                        │  nginx (TLS терминируется здесь, сертификат tungnetwork.ftp.sh)
                        ▼
                 127.0.0.1:1432X   (rathole server)
                        │  обратный туннель через NAT / без проброса портов
                        ▼
                   ts: 127.0.0.1:432X  (alive browser pult / controller)
```

## Карта портов

| Агент           | Публичный адрес                          | vpn2 (rathole bind)  | ts (local) |
| --------------- | ---------------------------------------- | -------------------- | ---------- |
| main            | https://tungnetwork.ftp.sh:4323          | 127.0.0.1:14323      | 4323       |
| developer       | https://tungnetwork.ftp.sh:4324          | 127.0.0.1:14324      | 4324       |
| slava-manager   | https://tungnetwork.ftp.sh:4325          | 127.0.0.1:14325      | 4325       |
| sre_devops      | https://tungnetwork.ftp.sh:4326          | 127.0.0.1:14326      | 4326       |
| researcher      | https://tungnetwork.ftp.sh:4327          | 127.0.0.1:14327      | 4327       |
| dashboard       | https://tungnetwork.ftp.sh:7777          | 127.0.0.1:14777      | 7777       |

Публичный порт совпадает с локальным портом сервиса — так проще не путать.

## Где что лежит

**vpn2** (сервер, `153.52.66.88`, домен `tungnetwork.ftp.sh`):

- `/usr/local/bin/rathole` (v0.5.0)
- `/etc/rathole/server.toml` — bind control `0.0.0.0:23333`, сервисы `127.0.0.1:143XX`
- `rathole-server.service` (`enabled`)
- `/etc/nginx/conf.d/alive-tunnels.conf` — TLS-терминация на 4323-4327, проксирование в `127.0.0.1:143XX`
- `/etc/nginx/alive-proxy.inc` — общие proxy-заголовки (WebSocket upgrade, `X-Forwarded-Proto`)
- сертификат: `/root/cert/tungnetwork.ftp.sh/{fullchain.pem,privkey.pem}`, обновляется `acme.sh` (cron каждые 6 ч);
  в `Le_ReloadCmd` домена добавлен `systemctl reload nginx`, чтобы после продления nginx подхватил новый файл

**ts** (AMELIA-PC, WSL, клиент):

- `/usr/local/bin/rathole`
- `/etc/rathole/client.toml` — `remote_addr = "153.52.66.88:23333"` (по IP, чтобы не зависеть от DNS/fake-ip)
- `rathole-client.service` (`enabled`)

## Dashboard

Раньше `alive dashboard --tunnel` поднимал одноразовый `trycloudflare.com` и слот origin был валиден
только на время жизни процесса. Теперь origin постоянный, а TLS терминируется на vpn2:

```bash
node dist/index.js dashboard --serve --port 7777 --public-url https://tungnetwork.ftp.sh:7777
```

Для этого в CLI/сервер дашборда добавлен флаг `--public-url URL` (в `src/cli.ts` и `src/dashboard/server.ts`):
он включает те же проверки, что и `--tunnel` (loopback bind + установленный пароль + HTTPS-origin),
но **не запускает cloudflared** — сервер просто доверяет этому origin в Origin/Host-проверках
и в тикетах (`/t?t=…`). `--public-url` и `--tunnel` взаимоисключающие.

Процесс держит `alive-dashboard.service` (systemd, `User=rimgro`, `Restart=always`) — раньше дашборд
жил руками в терминале.

Что **не** покрыто: рантайм-инструмент `dashboard` (агентский `dashboard({action:"open", mode:"tunnel"})`)
по-прежнему стартует свой quick tunnel и пишет его в `<stateDir>/dashboard/state.json`.
Чтобы ссылки из Telegram тоже были постоянными, инструменту нужно уметь переиспользовать внешний origin
(сейчас он переиспользует только собственный in-process туннель).

Проверка:

```bash
curl --resolve tungnetwork.ftp.sh:7777:153.52.66.88 -o /dev/null -w '%{http_code}\n' https://tungnetwork.ftp.sh:7777/login   # 200
```

### Почему вход с телефона/браузера давал 403 «request origin or host is not allowed»

Дашборд отдаёт все страницы с `Referrer-Policy: no-referrer`, а Chrome в этом случае
сериализует `Origin` у same-origin POST-формы как строку `null`. Проверка `originAndHostAllowed`
сравнивала `Origin` с `Host` и такой запрос резала → 403 на `POST /login` (и так же на
`POST /agent/<id>/settings` и `/logout`, т.е. на весь write path). Баг был и с quick-туннелем.

Фикс (`src/dashboard/server.ts`): `Origin: null` принимается только при `Sec-Fetch-Site: same-origin`
(и `Sec-Fetch-Mode: navigate`/`same-origin`), при совпадении `Host` с публичным origin или loopback;
без `Sec-Fetch-Site` — fail closed. `Sec-*` заголовки нельзя выставить через `fetch` (forbidden header
names), поэтому тесты в `src/dev/dashboard-auth-test.ts` бьют по серверу через `node:http`.

Отдельно: когда браузер идёт через VPN (mihomo → xray на vpn2), соединение приходит в nginx
с `127.0.0.1`, поэтому входы с любых устройств считаются одним IP для лимитера логинов
(5 попыток/минуту на всех).

## Настройки, которые пришлось учесть

- **mihomo (ts)**: добавлено правило `IP-CIDR,153.52.66.88/32,DIRECT,no-resolve` — иначе трафик к vpn2
  заворачивался в сам VPN (лишний хоп, а при падении VPN рвался бы и туннель).
  Применено через hot-reload API `PUT http://127.0.0.1:9090/configs?force=true` (без сброса fake-ip кэша).
- **fake-ip**: `tungnetwork.ftp.sh` и `+.ftp.sh` в `fake-ip-filter` (правка от 2026-10-29) — без неё mihomo
  отдаёт fake-ip на домен самого прокси и соединение зацикливается.
- **publicUrl у агентов** должен быть ровно HTTPS-origin (`https://host:port`), без пути — поэтому один агент =
  один порт. Пути не годятся: `browser.publicUrl must be an HTTPS origin`.
- alive сам подхватывает смену `publicUrl`: роутер опрашивает конфиг раз в секунду
  (`src/modules/browser/router.ts`, `originMonitor`) и обновляет origin, роняя старые control-ключи.

## Что отключено

На `ts` выключены временные туннели, которые перезаписывали `publicUrl` и меняли адрес при каждом рестарте:

```bash
systemctl disable --now alive-browser-tunnel@main alive-browser-tunnel@developer \
  alive-browser-tunnel@slava-manager alive-browser-tunnel@sre_devops
systemctl disable --now alive-browser-tunnel-watch.timer alive-browser-tunnel-watch.service
```

Юниты и скрипты (`/home/rimgro/.local/lib/alive-browser-tunnel.mjs`, `/usr/local/lib/alive-browser-tunnel-watch.mjs`)
остались на диске — вернуть Quick Tunnel можно обычным `systemctl enable --now`.

## Проверка

```bash
# на любой машине
for p in 4323 4324 4325 4326 4327; do
  curl -sS -m 20 --resolve tungnetwork.ftp.sh:$p:153.52.66.88 \
    -o /dev/null -w "$p: %{http_code} tls=%{ssl_verify_result}\n" https://tungnetwork.ftp.sh:$p/browser
done
```

Ожидаемо `200` (страница «Alive browser: открой новую кнопку браузера из своего личного чата»).
`502` = туннель жив, но на `ts` не запущен агент (его порт `432X` никто не слушает).

```bash
# vpn2
systemctl status rathole-server; journalctl -u rathole-server -n 20
# ts
systemctl status rathole-client; journalctl -u rathole-client -n 20
```

## Добавить новый порт

1. `ts` `/etc/rathole/client.toml`: `[client.services.NAME]` → `local_addr = "127.0.0.1:PORT"`.
2. `vpn2` `/etc/rathole/server.toml`: `[server.services.NAME]` → `bind_addr = "127.0.0.1:1PORT"`.
3. `vpn2` `/etc/nginx/conf.d/alive-tunnels.conf`: upstream `127.0.0.1:1PORT` + server-блок `listen PORT ssl`.
4. `systemctl restart rathole-client` (ts), `systemctl restart rathole-server && nginx -t && systemctl reload nginx` (vpn2).
   rathole умеет hot-reload конфига, но рестарт надёжнее и рвёт только этот туннель.

## Ограничения

- Домен один и сертификат на один SAN (без wildcard), поддомены в DNS не настроены — поэтому разные агенты
  различаются портами, а не именами.
- Порт `443` на vpn2 занят xray/REALITY, `8443` тоже; поэтому пульты живут на 4323-4327.
- Контрольный порт `23333` открыт наружу и защищён только токеном (rathole v0.5 использует Noise-хендшейк).
