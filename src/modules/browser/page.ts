/** Control surface; Telegram launches optionally load the integrity-pinned official SDK. `pageUrl` is the optional URL of the streamed page shown in the domain chip. */
export function controlPage(nonce: string, controlPath = "/browser", pageUrl = ""): string {
	return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Браузер агента</title><style nonce="${nonce}">
:root{
  color-scheme:dark;
  --background:#09090b;--foreground:#fafafa;--card:#18181b;--card-2:#27272a;
  --muted:#a1a1aa;--border:rgba(250,250,250,.10);--border-strong:rgba(250,250,250,.16);
  --primary:#fafafa;--primary-foreground:#18181b;--stage:#000;
  --waiting:#fbbf24;--live:#34d399;--error:#f87171;
  --radius:12px;--radius-small:9px;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;overflow:hidden;background:var(--background);color:var(--foreground);font-family:var(--font);font-size:14px;line-height:1.35;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
button,input{font:inherit}
button{cursor:pointer;touch-action:manipulation}
button:disabled{opacity:.45;cursor:default}
button:focus-visible,input:focus-visible,#frame:focus-visible{outline:2px solid var(--foreground);outline-offset:3px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.sr-only.error{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));left:50%;z-index:70;width:auto;height:auto;max-width:calc(100% - 24px);margin:0;padding:8px 12px;overflow:visible;clip:auto;white-space:normal;transform:translateX(-50%);background:rgba(24,24,27,.96);border:1px solid var(--border-strong);border-radius:var(--radius-small);color:var(--error);font-size:12px;line-height:1.4;box-shadow:0 12px 32px rgba(0,0,0,.5)}
.app{position:fixed;inset:0;overflow:hidden;background:var(--background);isolation:isolate}
.viewer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--stage);touch-action:none}
.viewer.zoom,.viewer.pan{display:block;overflow:auto;overscroll-behavior:contain;touch-action:pan-x pan-y}
.viewer.zoom .frame{margin:0}
.frame{display:block;width:var(--frame-width,100%);height:auto;max-width:100%;max-height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none;touch-action:none;background:var(--stage)}
.viewer.mode-desktop .frame{width:var(--frame-width,100%);height:var(--frame-height,auto);max-width:none;max-height:none;object-fit:contain}
.viewer.zoom .frame{max-width:none;max-height:none}
.viewer.pan .frame{touch-action:pan-x pan-y;cursor:grab}
.frame-wait{margin:0;padding:24px;color:var(--muted);font-size:13px;text-align:center}
.pointer-marker{position:absolute;z-index:10;width:32px;height:32px;border:2px dashed var(--foreground);border-radius:50%;background:rgba(250,250,250,.12);transform:translate(-50%,-50%);pointer-events:none}
.pointer-marker[data-state="accepted"]{border-style:solid}
.dot{width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:var(--waiting);transition:background-color .2s ease}
.dot.live{background:var(--live)}
.dot.error{background:var(--error)}
.dock{position:absolute;left:12px;right:12px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:20;height:56px;display:flex;align-items:center;gap:6px;padding:0 6px;background:rgba(24,24,27,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--border-strong);border-radius:var(--radius);box-shadow:0 16px 40px rgba(0,0,0,.55);transition:opacity .2s ease,transform .28s cubic-bezier(.32,.72,0,1),visibility 0s linear .28s}
.site{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto;padding:0 4px;color:var(--muted);font-size:12px;line-height:1}
.site .host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.icon{width:36px;height:36px;flex:0 0 auto;border:0;border-radius:var(--radius-small);background:transparent;color:var(--muted);display:grid;place-items:center;padding:0;transition:background-color .15s ease,color .15s ease,transform .1s ease}
.icon:active{transform:scale(.96)}
.icon svg{width:18px;height:18px;stroke:currentColor;stroke-width:1.75;fill:none;stroke-linecap:round;stroke-linejoin:round}
.seg{display:flex;flex:0 0 auto;gap:2px;padding:2px;background:rgba(0,0,0,.35);border:1px solid var(--border);border-radius:var(--radius-small)}
.seg button{width:32px;height:32px;border:0;border-radius:7px;background:transparent;color:var(--muted);display:grid;place-items:center;padding:0;transition:background-color .15s ease,color .15s ease,transform .1s ease}
.seg button.on{background:var(--card-2);color:var(--foreground)}
.seg button:active{transform:scale(.96)}
.seg svg{width:17px;height:17px;stroke:currentColor;stroke-width:1.75;fill:none;stroke-linecap:round;stroke-linejoin:round}
.done{height:36px;flex:0 0 auto;padding:0 12px;border:0;border-radius:var(--radius-small);background:var(--primary);color:var(--primary-foreground);font-size:13px;font-weight:600;line-height:1;white-space:nowrap;transition:opacity .15s ease,transform .1s ease}
.done:active{transform:scale(.97);opacity:.92}
.zoom{position:absolute;right:12px;bottom:calc(92px + env(safe-area-inset-bottom,0px));z-index:20;display:flex;align-items:center;gap:2px;padding:2px;background:rgba(24,24,27,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--border-strong);border-radius:var(--radius-small);transition:opacity .2s ease,transform .28s cubic-bezier(.32,.72,0,1),visibility 0s linear .28s}
.zoom button{width:32px;height:32px;border:0;border-radius:7px;background:transparent;color:var(--muted);display:grid;place-items:center;padding:0;transition:background-color .15s ease,color .15s ease,transform .1s ease}
.zoom button:active{transform:scale(.96)}
.zoom .pct{min-width:38px;padding:0 6px;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;text-align:center;white-space:nowrap}
.zoom svg{width:16px;height:16px;stroke:currentColor;stroke-width:1.75;fill:none;stroke-linecap:round;stroke-linejoin:round}
.app.dock-idle .dock,.app.dock-idle .zoom{opacity:0;transform:translateY(18px);pointer-events:none;visibility:hidden}
.app.sheet-open .dock,.app.sheet-open .zoom{opacity:0;transform:translateY(24px);pointer-events:none;visibility:hidden}
.sheet{position:absolute;left:0;right:0;bottom:0;z-index:30;padding:8px 10px calc(16px + env(safe-area-inset-bottom,0px));background:rgba(24,24,27,.98);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-top:1px solid var(--border-strong);border-radius:16px 16px 0 0;box-shadow:0 -16px 40px rgba(0,0,0,.45);transform:translateY(104%);visibility:hidden;transition:transform .28s cubic-bezier(.32,.72,0,1),visibility 0s linear .28s}
.sheet.open{transform:translateY(0);visibility:visible;transition:transform .28s cubic-bezier(.32,.72,0,1),visibility 0s}
.grab-button{display:block;width:100%;height:24px;margin:0 0 4px;padding:0;border:0;border-radius:8px;background:transparent}
.grab{width:34px;height:3px;margin:9px auto 0;border-radius:2px;background:rgba(250,250,250,.20)}
.sheet-head{display:flex;align-items:center;gap:6px;min-height:30px;padding:0 4px 8px;color:var(--muted);font-size:12px;line-height:1}
.sheet-head .host{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sheet-head .done{height:30px;padding:0 10px;font-size:12px}
.keys{display:flex;gap:5px;margin-bottom:8px}
.key{flex:1 1 0;min-width:0;height:36px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--muted);font-size:11px;font-weight:500;display:grid;place-items:center;padding:0;transition:background-color .15s ease,color .15s ease,transform .1s ease}
.key:active{transform:scale(.96)}
.key svg{width:15px;height:15px;stroke:currentColor;stroke-width:1.75;fill:none;stroke-linecap:round;stroke-linejoin:round}
.reply{display:flex;gap:6px}
.reply input{flex:1 1 auto;min-width:0;height:38px;padding:0 12px;border:1px solid var(--border);border-radius:8px;background:rgba(0,0,0,.4);color:var(--foreground);font-size:13px;line-height:1;caret-color:var(--foreground)}
.reply input::placeholder{color:#71717a}
.reply button{flex:0 0 auto;height:38px;padding:0 14px;border:0;border-radius:8px;background:var(--primary);color:var(--primary-foreground);font-size:13px;font-weight:600;line-height:1;transition:opacity .15s ease,transform .1s ease}
.reply button:active{transform:scale(.97);opacity:.92}
.sheet-actions{display:flex;gap:5px;margin-top:8px}
.sheet-actions .key{height:32px}
.hint{min-height:0;margin:6px 0 0;color:var(--muted);font-size:11px;line-height:1.4}
.hint.error{color:var(--error)}
.fullscreen-exit{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:60;height:36px;padding:0 14px;border:0;border-radius:var(--radius-small);background:var(--primary);color:var(--primary-foreground);font-size:13px;font-weight:600;transform:translateX(-50%)}
.app.fullscreen-chrome .dock,.app.fullscreen-chrome .zoom,.app.fullscreen-chrome .sheet{display:none!important}
@media(hover:hover){
  .icon:hover,.seg button:hover,.zoom button:hover,.key:hover{background:var(--card-2);color:var(--foreground)}
  .done:hover{opacity:.94}
}
@media(prefers-reduced-motion:reduce){
  *,*:before,*:after{scroll-behavior:auto!important;transition-duration:0s!important;animation-duration:0s!important}
}
@media(min-width:720px){
  /* Keep the control cluster compact on tablets and desktops instead of spanning the window. */
  .dock{left:0;right:0;margin-inline:auto;max-width:440px}
  .zoom{right:max(12px,calc((100% - 440px)/2))}
}
@media(max-width:380px){
  .dock{left:8px;right:8px;gap:4px;padding:0 4px}
  .zoom{right:8px}
  .site{font-size:11px}
  .keys{gap:4px}
  .key{font-size:10px}
}
</style></head><body>
<main id="app" class="app">
  <section id="viewer" class="viewer mode-phone" aria-label="Удалённый браузер">
    <p id="frame-wait" class="frame-wait">Ждём изображение браузера…</p>
    <img id="frame" class="frame" hidden alt="Текущая вкладка удалённого браузера" tabindex="0" draggable="false">
    <span id="pointer-marker" class="pointer-marker" hidden aria-hidden="true"></span>
  </section>
  <p id="status" class="sr-only" role="status" aria-live="polite">Подключение к сессии…</p>
  <span id="connection-metrics" class="sr-only"></span>
  <span id="agent-state" class="sr-only">Соединяемся</span>

  <div id="zoom-control" class="zoom" role="group" aria-label="Масштаб изображения">
    <button id="zoom-out" type="button" aria-label="Отдалить"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6"/></svg></button>
    <span id="zoom-level" class="pct" role="status" aria-live="polite" aria-label="Масштаб 100 процентов">100%</span>
    <button id="zoom-in" type="button" aria-label="Приблизить"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg></button>
    <button id="fit" type="button" aria-label="Вписать в экран"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/></svg></button>
  </div>

  <div id="dock" class="dock" role="toolbar" aria-label="Управление браузером">
    <div class="site"><span id="dock-dot" class="dot" aria-hidden="true"></span><span id="dock-host" class="host">Подключение…</span></div>
    <button id="keyboard" class="icon" type="button" aria-label="Клавиатура" aria-expanded="false" aria-controls="sheet"><svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/></svg></button>
    <div class="seg" role="group" aria-label="Режим отображения">
      <button id="mode-phone" class="on" type="button" aria-pressed="true" aria-label="Режим телефона"><svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/></svg></button>
      <button id="mode-desktop" type="button" aria-pressed="false" aria-label="Режим ПК 16:9"><svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg></button>
    </div>
    <button id="resume" class="done" type="button" aria-label="Готово — вернуть агенту" disabled>Готово</button>
  </div>

  <section id="sheet" class="sheet" aria-label="Клавиатура браузера" aria-hidden="true">
    <button class="grab-button" type="button" aria-label="Скрыть клавиатуру"><span class="grab" aria-hidden="true"></span></button>
    <div class="sheet-head"><span id="sheet-dot" class="dot" aria-hidden="true"></span><span id="sheet-host" class="host">Подключение…</span><button id="sheet-done" class="done" type="button" aria-label="Готово — вернуть агенту" disabled>Готово</button></div>
    <div id="keys" class="keys">
      <button class="key" data-key="Tab" type="button">Tab</button>
      <button class="key" data-key="Enter" type="button" aria-label="Enter"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/></svg></button>
      <button class="key" data-key="Backspace" type="button" aria-label="Удалить символ"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z"/><path d="m18 9-6 6M12 9l6 6"/></svg></button>
      <button class="key" data-key="Escape" type="button" aria-label="Escape">Esc</button>
      <button class="key" data-scroll="-500" type="button" aria-label="Прокрутить вверх"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7M12 19V5"/></svg></button>
      <button class="key" data-scroll="500" type="button" aria-label="Прокрутить вниз"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M19 12l-7 7-7-7"/></svg></button>
      <button class="key" data-action="reload" type="button" aria-label="Обновить страницу"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg></button>
    </div>
    <form id="typing" class="reply">
      <label for="text" class="sr-only">Ввод в выбранное поле</label>
      <input id="text" aria-label="Текст в выбранное поле браузера" autocomplete="off" maxlength="4096" placeholder="Текст в выбранное поле">
      <button type="submit" aria-label="Ввести текст">Ввести</button>
    </form>
    <div class="sheet-actions" role="group" aria-label="Дополнительные действия">
      <button id="fullscreen" class="key" type="button" aria-label="Во весь экран"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H5v4M15 4h4v4M9 20H5v-4M15 20h4v-4"/></svg></button>
      <button id="pan" class="key" type="button" aria-pressed="false" aria-label="Перемещать изображение" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9V6a2 2 0 0 1 4 0v3M9 9V5a2 2 0 0 1 4 0v4M13 9V6a2 2 0 0 1 4 0v3M17 9V8a2 2 0 0 1 4 0v7a5 5 0 0 1-5 5h-2a6 6 0 0 1-4.6-2.2L5 13a2 2 0 0 1 3-2.6L9 11"/></svg></button>
      <button id="pause" class="key" type="button" aria-label="Приостановить изображение" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg></button>
      <button id="reconnect" class="key" type="button" aria-label="Переподключиться"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg></button>
    </div>
    <p id="input-status" class="hint" role="status" aria-live="polite">Нажми поле на экране, затем введи текст здесь.</p>
    <p id="pointer-status" class="hint" role="status" aria-live="polite">Нажимай прямо на изображении браузера.</p>
  </section>

  <button id="fullscreen-exit" class="fullscreen-exit" type="button" hidden>Вернуться к пульту</button>
</main><script nonce="${nonce}">
const app=document.getElementById('app'),statusEl=document.getElementById('status'),frame=document.getElementById('frame'),viewer=document.getElementById('viewer'),frameWait=document.getElementById('frame-wait');
const dock=document.getElementById('dock'),zoomControl=document.getElementById('zoom-control'),sheet=document.getElementById('sheet'),keyboardButton=document.getElementById('keyboard'),textInput=document.getElementById('text'),feedback=document.getElementById('input-status');
const dockHost=document.getElementById('dock-host'),sheetHost=document.getElementById('sheet-host'),zoomLevel=document.getElementById('zoom-level'),panButton=document.getElementById('pan'),pauseButton=document.getElementById('pause');
const controlPath=${JSON.stringify(controlPath)},initialSiteUrl=${JSON.stringify(pageUrl)};
let credential='',ended=false,paused=false,dragging=false,queue=Promise.resolve(),lastMove=0,streamAbort,telegram,telegramActive=true,useStream=true;
let pointerId,pointerDown,gesture=0,markerTimer,sheetOpen=false,mode='phone',zoomScale=1,dockTimer;const marker=document.getElementById('pointer-marker'),pointerStatus=document.getElementById('pointer-status');
let liveSocket,liveReady=false,requestId=0,remoteWidth=0,remoteHeight=0,moveInFlight=false,pendingMove,expiryTimer;
const requests=new Map(),metrics=document.getElementById('connection-metrics'),dots=[document.getElementById('dock-dot'),document.getElementById('sheet-dot')];
function setDots(state){for(const dot of dots){dot.className='dot '+state;dot.setAttribute('title',state==='live'?'Агент может продолжать':state==='error'?'Ошибка соединения':'Агент ждёт тебя')}}
function agentState(isPaused){document.getElementById('agent-state').textContent=isPaused?'Агент ждёт тебя':'Агент может продолжать';setDots(isPaused?'waiting':'live');report(isPaused?'Пройди проверку и нажми «Готово».':'Можно смотреть и управлять страницей.')}
function hostName(value){if(!value)return '';try{const host=new URL(value,location.href).hostname;return host.startsWith('www.')?host.slice(4):host}catch{return ''}}
function initialHost(){const params=new URLSearchParams(location.search),candidates=[initialSiteUrl];for(const key of ['url','page','pageUrl','site','target']){const fromHash=launchParams.get(key),fromQuery=params.get(key);if(fromHash)candidates.push(fromHash);if(fromQuery)candidates.push(fromQuery)}const hashUrl=launchHash.match(/https?:\\/\\/[^&]+/);if(hashUrl)candidates.push(decodeURIComponent(hashUrl[0]));candidates.push(document.referrer,location.href);for(const value of candidates){const host=hostName(value);if(!host||host==='t.me'||host==='telegram.org'||host.endsWith('.telegram.org'))continue;return host}return '—'}
function setSite(host){for(const element of [dockHost,sheetHost]){element.textContent=host;element.title=host}}
function setSiteFromUrl(value){const host=hostName(value);if(host)setSite(host)}
const launchHash=location.hash.slice(1).replace(/^\\?/,''),launchParams=new URLSearchParams(launchHash);
const firstPart=launchHash.split('&')[0],link=launchParams.get('aliveKey')||(/^[A-Za-z0-9_-]{43}$/.test(firstPart)?firstPart:'');
setSite(initialHost());
const telegramParams=new URLSearchParams([...launchParams].filter(([key])=>key.startsWith('tgWebApp')));
history.replaceState(null,'',location.pathname+(telegramParams.size?'#'+telegramParams:''));
async function initializeTelegram(){
  let launched=telegramParams.size>0;try{launched ||= sessionStorage.getItem('alive.browser.telegram')==='true'}catch{}
  if(!launched)return;
  if(!window.Telegram?.WebApp)await new Promise(resolve=>{
    const script=document.createElement('script');script.nonce=${JSON.stringify(nonce)};script.src='https://telegram.org/js/telegram-web-app.js?64';
    script.integrity='sha256-Ekvf97o/6GyLpRQ0Z6/sIeAgQF50q9uSz92mwO47WQg=';script.crossOrigin='anonymous';script.referrerPolicy='no-referrer';
    const timer=setTimeout(()=>{script.remove();resolve()},5000);script.onload=script.onerror=()=>{clearTimeout(timer);resolve()};document.head.append(script);
  });
  telegram=window.Telegram?.WebApp;if(!telegram)return;
  try{sessionStorage.setItem('alive.browser.telegram','true')}catch{}
  telegram.ready();telegram.expand();telegram.enableClosingConfirmation();
  if(telegram.isVersionAtLeast('6.1'))telegram.setBackgroundColor?.('#09090b');
  if(telegram.isVersionAtLeast('6.9'))telegram.setHeaderColor?.('#09090b');
  if(telegram.isVersionAtLeast('7.10'))telegram.setBottomBarColor?.('#09090b');
  if(telegram.isVersionAtLeast('7.7'))telegram.disableVerticalSwipes();
  telegram.onEvent('deactivated',()=>{telegramActive=false;stopStream()});
  telegram.onEvent('activated',()=>{telegramActive=true});
}
const storageKey='alive.browser.operator'+(controlPath==='/browser'?'':':'+controlPath);
function stores(){return [()=>localStorage,()=>sessionStorage]}
function forget(){for(const get of stores())try{const store=get(),saved=JSON.parse(store.getItem(storageKey)||'null');if(!saved||saved.credential===credential)store.removeItem(storageKey)}catch{}}
function remember(expiresAt,fingerprint){for(const get of stores())try{get().setItem(storageKey,JSON.stringify({credential,expiresAt,fingerprint}))}catch{}clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>{connectionError(410,'Link expired. Request a new handoff.');report('Сессия истекла. Запроси новый пульт у агента.',true)},Math.max(0,expiresAt-Date.now()));metrics.title='Доступ до '+new Date(expiresAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});metrics.textContent='Подключение…'}
function restore(fingerprint){for(const get of stores())try{const store=get(),saved=JSON.parse(store.getItem(storageKey)||'null');if(!saved)continue;if(!(/^[A-Za-z0-9_-]{43}$/).test(saved.credential)||!Number.isFinite(saved.expiresAt)||saved.expiresAt<=Date.now()){store.removeItem(storageKey);continue}if(fingerprint&&saved.fingerprint!==fingerprint)continue;credential=saved.credential;return saved}catch{}return false}
async function fingerprint(link){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(link)))).map(byte=>byte.toString(16).padStart(2,'0')).join('')}
function report(message,error=false){statusEl.textContent=message;statusEl.className=error?'sr-only error':'sr-only';if(frame.hidden||ended)frameWait.textContent=message;if(error)setDots('error')}
function stopStream(){streamAbort?.abort();liveSocket?.close()}
function disable(){document.querySelectorAll('button,input').forEach(e=>e.disabled=true);document.getElementById('fullscreen-exit').disabled=false}
function clearFrame(){const src=frame.src;frame.removeAttribute('src');frame.hidden=true;if(src.startsWith('blob:'))URL.revokeObjectURL(src);frameWait.hidden=false;marker.hidden=true;viewer.style.removeProperty('--frame-width');viewer.style.removeProperty('--frame-height')}
function finish(){ended=true;clearTimeout(expiryTimer);clearTimeout(dockTimer);forget();disable();stopStream();clearFrame();setSheet(false);textInput.value='';document.getElementById('agent-state').textContent='Доступ завершён';setDots('waiting');metrics.textContent='';telegram?.disableClosingConfirmation()}
function connectionError(status,message){if(status===401||status===410)finish();const errors={'Select an editable text field on the browser image first':'Сначала нажми текстовое поле на изображении браузера, затем повтори ввод.','Invalid access key':'Ссылка уже использована или заменена. Запроси новую ссылку у агента.','No active handoff':'Сессия управления завершена. Можно закрыть страницу.','Link expired. Request a new handoff.':'Срок сессии истёк. Запроси новую ссылку у агента.','Control reopened in another window':'Пульт открыт в другом окне. Продолжи там.','Browser control revoked by the agent':'Агент отозвал пульт. Управление завершено.','Telegram identity does not match this browser session':'Этот пульт принадлежит другому Telegram-пользователю.','Site still requires verification, private login entry, or denies access. Finish the permitted action before resuming.':'Страница ещё ждёт проверку или вход. Закончи действие и повтори «Готово».','Rate limit cooldown has not elapsed':'Сайт попросил подождать. Повтори действие позже.','Browser page closed':'Вкладка браузера закрыта. Запроси новый пульт.','A browser stream is already open':'Пульт уже открыт в другом окне. Переподключись.','Stream receiver is too slow':'Соединение не успевает. Переподключаемся…','Browser operation interrupted':'Действие прервалось. Проверь результат на экране.'};return Error(errors[message]||message||'Ошибка подключения')}
async function api(path,body,signal){const r=await fetch(controlPath+'/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+credential,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal});if(!r.ok){const j=await r.json();throw connectionError(r.status,j.error)}return r}
function liveInput(body,type='input'){return new Promise(resolve=>{if(!liveReady||liveSocket?.readyState!==WebSocket.OPEN){resolve({ok:false,error:'Соединение прервано · проверь результат нажатия'});return}const id=++requestId,timer=setTimeout(()=>{requests.delete(id);resolve({ok:false,error:'Нет подтверждения действия · проверь соединение и изображение'})},8000);requests.set(id,{resolve,timer});liveSocket.send(JSON.stringify({type,id,body}))})}
function send(body){const action=liveReady?liveInput(body):queue.then(async()=>{if(ended)return {ok:false};await api('input',body);return {ok:true}});const outcome=action.catch(e=>({ok:false,error:e.message})).then(result=>{if(result.error)report(result.error,true);return result});queue=Promise.all([queue,outcome]).then(([,result])=>result);return outcome}
function imageBox(){const rect=frame.getBoundingClientRect(),width=remoteWidth||frame.naturalWidth||rect.width,height=remoteHeight||frame.naturalHeight||rect.height;if(!width||!height)return rect;const scale=Math.min(rect.width/width,rect.height/height),shownWidth=width*scale,shownHeight=height*scale;return {left:rect.left+(rect.width-shownWidth)/2,top:rect.top+(rect.height-shownHeight)/2,width:shownWidth,height:shownHeight}}
function point(e){const box=imageBox(),width=remoteWidth||frame.naturalWidth||box.width,height=remoteHeight||frame.naturalHeight||box.height;return {x:Math.max(0,Math.min(width-1,(e.clientX-box.left)*width/box.width)),y:Math.max(0,Math.min(height-1,(e.clientY-box.top)*height/box.height))}}
function showPointer(e,state='pending'){clearTimeout(markerTimer);const p=point(e),box=imageBox(),host=viewer.getBoundingClientRect(),width=remoteWidth||frame.naturalWidth||box.width,height=remoteHeight||frame.naturalHeight||box.height;marker.style.left=(box.left-host.left+viewer.scrollLeft+p.x*box.width/width)+'px';marker.style.top=(box.top-host.top+viewer.scrollTop+p.y*box.height/height)+'px';marker.dataset.state=state;marker.hidden=false}
function pumpMove(){if(moveInFlight||!pendingMove||!dragging)return;const point=pendingMove;pendingMove=undefined;moveInFlight=true;send({type:'move',...point}).finally(()=>{moveInFlight=false;pumpMove()})}
frame.addEventListener('pointerdown',e=>{if(dragging||!credential||ended||paused||viewer.classList.contains('pan')||!frame.naturalWidth)return;e.preventDefault();const p=point(e);frame.focus({preventScroll:true});dragging=true;pointerId=e.pointerId;gesture++;frame.setPointerCapture(e.pointerId);showPointer(e);pointerStatus.textContent='Передача нажатия…';pointerDown=send({type:'down',...p})});
frame.addEventListener('pointermove',e=>{if(dragging&&e.pointerId===pointerId&&Date.now()-lastMove>30){lastMove=Date.now();showPointer(e);pendingMove=point(e);pumpMove()}});
async function release(e){if(!dragging||e.pointerId!==pointerId)return;dragging=false;pendingMove=undefined;const current=gesture,down=pointerDown,up=send({type:'up',...point(e)}),accepted=(await down).ok&&(await up).ok;if(current!==gesture)return;if(accepted&&e.type==='pointerup'){showPointer(e,'accepted');pointerStatus.textContent='Нажатие передано браузеру · проверь результат'}else{marker.hidden=true;pointerStatus.textContent=e.type==='pointercancel'?'Касание прервано · проверь изображение':'Нет подтверждения · проверь соединение'}markerTimer=setTimeout(()=>{marker.hidden=true},900)}frame.addEventListener('pointerup',release);frame.addEventListener('pointercancel',release);
frame.addEventListener('keydown',e=>{if(['Tab','Enter','Backspace','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Delete',' '].includes(e.key)){e.preventDefault();send({type:'key',key:e.key===' '?'Space':e.key})}});
document.getElementById('keys').addEventListener('click',e=>{const b=e.target.closest('button');if(!b||!credential)return;if(b.dataset.key)send({type:'key',key:b.dataset.key});if(b.dataset.scroll)send({type:'scroll',delta:Number(b.dataset.scroll)});if(b.dataset.action)send({type:b.dataset.action})});
document.getElementById('typing').addEventListener('submit',async e=>{e.preventDefault();const input=textInput,button=e.target.querySelector('button');if(!credential||ended||!input.value)return;const text=input.value;button.disabled=true;feedback.textContent='Отправка текста…';feedback.className='hint';const outcome=await send({type:'text',text});if(outcome.ok){if(input.value===text)input.value='';feedback.textContent='Текст введён. Подтверди действие на странице, если нужно.';feedback.className='hint'}else{feedback.textContent=outcome.error||'Текст не отправлен.';feedback.className='hint error'}if(!ended)button.disabled=false});
function setZoom(next){zoomScale=Math.max(1,Math.min(3,Math.round(next*100)/100));const zoomed=zoomScale>1.001;viewer.classList.toggle('zoom',zoomed);if(!zoomed)viewer.classList.remove('pan');panButton.hidden=!zoomed;panButton.setAttribute('aria-pressed',String(!panButton.hidden&&viewer.classList.contains('pan')));panButton.setAttribute('aria-label',viewer.classList.contains('pan')?'Вернуться к кликам':'Перемещать изображение');const percent=Math.round(zoomScale*100);zoomLevel.textContent=percent+'%';zoomLevel.setAttribute('aria-label','Масштаб '+percent+' процентов');fitFrame()}
function fitFrame(){if(!frame.naturalWidth)return;const rect=viewer.getBoundingClientRect(),ratio=frame.naturalWidth/frame.naturalHeight,desktop=viewer.classList.contains('mode-desktop');let width,height=0;if(desktop){const availableWidth=Math.max(120,rect.width-24),availableHeight=Math.max(90,rect.height-24);width=Math.min(availableWidth,availableHeight*16/9);height=width*9/16}else{width=Math.min(Math.max(120,rect.width),Math.max(120,rect.height*ratio));height=width/ratio}width*=zoomScale;height*=zoomScale;viewer.style.setProperty('--frame-width',Math.round(width)+'px');if(desktop)viewer.style.setProperty('--frame-height',Math.round(height)+'px');else viewer.style.removeProperty('--frame-height')}
document.getElementById('zoom-out').onclick=()=>setZoom(zoomScale-.25);
document.getElementById('zoom-in').onclick=()=>setZoom(zoomScale+.25);
panButton.onclick=e=>{const pan=viewer.classList.toggle('pan');e.currentTarget.setAttribute('aria-pressed',String(pan));e.currentTarget.setAttribute('aria-label',pan?'Вернуться к кликам':'Перемещать изображение')};
pauseButton.onclick=e=>{paused=!paused;if(paused)stopStream();e.currentTarget.setAttribute('aria-pressed',String(paused));e.currentTarget.setAttribute('aria-label',paused?'Продолжить изображение':'Приостановить изображение')};
document.getElementById('reconnect').onclick=()=>location.reload();
async function resizeRemote(width,height,message){const wasPaused=paused;paused=true;stopStream();clearFrame();report(message);try{await queue;await api('input',{type:'viewport',width:Math.round(width),height:Math.round(height)})}finally{paused=wasPaused}}
function phoneViewport(){return resizeRemote(Math.max(360,Math.min(600,Math.round(innerWidth-32))),Math.max(600,Math.min(1000,Math.round(innerHeight))),'Подстраиваем изображение под телефон…')}
function desktopViewport(){return resizeRemote(1280,720,'Подстраиваем изображение под экран 16:9…')}
async function fitView(){try{await (mode==='desktop'?desktopViewport():phoneViewport());setZoom(1);viewer.classList.remove('pan');panButton.setAttribute('aria-pressed','false');panButton.setAttribute('aria-label','Перемещать изображение');fitFrame()}catch(e){report(e.message,true)}}
document.getElementById('fit').onclick=fitView;
function updateModeButtons(){const desktop=mode==='desktop';viewer.classList.toggle('mode-desktop',desktop);viewer.classList.toggle('mode-phone',!desktop);document.getElementById('mode-phone').classList.toggle('on',!desktop);document.getElementById('mode-phone').setAttribute('aria-pressed',String(!desktop));document.getElementById('mode-desktop').classList.toggle('on',desktop);document.getElementById('mode-desktop').setAttribute('aria-pressed',String(desktop))}
function setMode(next){if(mode===next)return;mode=next;updateModeButtons();setZoom(1);void fitView()}
document.getElementById('mode-phone').onclick=()=>setMode('phone');document.getElementById('mode-desktop').onclick=()=>setMode('desktop');
function setSheet(open){if(sheetOpen===open)return;sheetOpen=open;sheet.classList.toggle('open',open);sheet.setAttribute('aria-hidden',String(!open));keyboardButton.setAttribute('aria-expanded',String(open));app.classList.toggle('sheet-open',open);if(open){app.classList.remove('dock-idle');clearTimeout(dockTimer)}else scheduleDock()}
keyboardButton.onclick=()=>setSheet(!sheetOpen);
textInput.addEventListener('focus',()=>{if(!sheetOpen)setSheet(true)});
sheet.addEventListener('click',e=>{if(e.target.closest('.grab-button'))setSheet(false)});
document.getElementById('resume').onclick=e=>endSession(e.currentTarget);document.getElementById('sheet-done').onclick=e=>endSession(e.currentTarget);
async function endSession(button){if(button.disabled)return;button.disabled=true;try{await queue;if(liveReady){const outcome=await liveInput({},'resume');if(!outcome.ok)throw Error(outcome.error)}else await api('resume',{});finish();report('Управление возвращено агенту. Можно закрыть страницу.')}catch(e){report(e.message,true);if(!ended)button.disabled=false}}
document.getElementById('fullscreen').onclick=()=>{setSheet(false);viewer.classList.add('fullscreen');app.classList.add('fullscreen-chrome');viewer.classList.remove('pan');setZoom(1);document.getElementById('fullscreen-exit').hidden=false;fitFrame()};
document.getElementById('fullscreen-exit').onclick=()=>{viewer.classList.remove('fullscreen');app.classList.remove('fullscreen-chrome');document.getElementById('fullscreen-exit').hidden=true;fitFrame()};
function scheduleDock(){clearTimeout(dockTimer);if(sheetOpen||ended)return;dockTimer=setTimeout(()=>{if(!sheetOpen&&!ended)app.classList.add('dock-idle')},3500)}
function wakeDock(){app.classList.remove('dock-idle');scheduleDock()}
document.addEventListener('pointerdown',wakeDock,true);window.addEventListener('keydown',wakeDock,true);
window.addEventListener('resize',fitFrame);window.visualViewport?.addEventListener('resize',fitFrame);scheduleDock();
async function showFrame(blob,dimensions){if(ended||paused||document.hidden||!telegramActive)return false;const next=URL.createObjectURL(blob),decoded=new Image();decoded.src=next;try{await decoded.decode();if(ended||paused||dimensions?.ws&&dimensions.ws!==liveSocket){URL.revokeObjectURL(next);return false}const previous=frame.src;frame.src=next;await frame.decode();remoteWidth=dimensions?.width||0;remoteHeight=dimensions?.height||0;if(ended){clearFrame();return false}frame.hidden=false;frameWait.hidden=true;fitFrame();if(previous.startsWith('blob:'))URL.revokeObjectURL(previous);return true}catch{URL.revokeObjectURL(next);if(!ended)report('Изображение не загрузилось · переподключение…',true);return false}}
let latestFrame,rendering=false;
function queueFrame(blob,dimensions){latestFrame={blob,dimensions};if(rendering)return;rendering=true;(async()=>{try{while(latestFrame){const next=latestFrame;latestFrame=undefined;const shown=await showFrame(next.blob,next.dimensions);if(shown&&next.dimensions?.ws.readyState===WebSocket.OPEN)next.dimensions.ws.send(JSON.stringify({type:'frame_ack',id:next.dimensions.id}))}}finally{rendering=false}})()}
async function live(){return new Promise((resolve,reject)=>{
  const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+controlPath+'/live');liveSocket=ws;ws.binaryType='arraybuffer';let authenticated=false,pingTimer,lastPing=0;
  const timeout=setTimeout(()=>{ws.close();reject(Error('WebSocket недоступен'))},5000);
  ws.onopen=()=>ws.send(JSON.stringify({type:'auth',credential}));
  ws.onmessage=async event=>{try{if(typeof event.data==='string'){const packet=JSON.parse(event.data);
    if(packet.type==='authenticated'){authenticated=true;liveReady=true;clearTimeout(timeout);if(packet.url)setSiteFromUrl(packet.url);agentState(packet.paused!==false);metrics.textContent='Прямой эфир';pingTimer=setInterval(()=>{lastPing=performance.now();if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ping',id:lastPing}))},3000)}
    if(packet.type==='state'){if(packet.url)setSiteFromUrl(packet.url);agentState(packet.paused)}
    if(packet.type==='ack'){const request=requests.get(packet.id);if(request){clearTimeout(request.timer);requests.delete(packet.id);request.resolve(packet.ok?{ok:true}:{ok:false,error:connectionError(packet.status,packet.error).message})}}
    if(packet.type==='pong')metrics.textContent=Math.round(performance.now()-packet.id)+' мс';
    if(packet.type==='error')throw connectionError(packet.status,packet.error);
  }else{const bytes=new Uint8Array(event.data),header=new DataView(event.data);if(bytes.length<16||header.getUint32(0)!==0x414c4956)throw Error('Некорректный кадр браузера');queueFrame(new Blob([bytes.subarray(16)],{type:'image/jpeg'}),{id:header.getUint32(4),width:header.getUint32(8),height:header.getUint32(12),ws})}
  }catch(e){report(e.message,true);ws.close()}};
  ws.onerror=()=>{};
  ws.onclose=()=>{clearTimeout(timeout);clearInterval(pingTimer);if(liveSocket===ws){liveSocket=undefined;liveReady=false}for(const request of requests.values()){clearTimeout(request.timer);request.resolve({ok:false,error:'Соединение прервано · проверь результат действия'})}requests.clear();authenticated?resolve(true):reject(Error('WebSocket недоступен'))};
})}
async function stream(){let liveFailures=0;while(!ended){if(!paused&&!document.hidden&&telegramActive){if(liveFailures<2){try{await live();liveFailures=0}catch{liveFailures++}if(ended)break;if(liveFailures<2){await new Promise(resolve=>setTimeout(resolve,600));continue}}remoteWidth=remoteHeight=0;metrics.textContent='Совместимый режим';const abort=new AbortController();streamAbort=abort;let watchdog;
  try{if(!useStream){const r=await api('frame',undefined,abort.signal);await showFrame(await r.blob())}else{
    watchdog=setTimeout(()=>{useStream=false;abort.abort()},10000);
    const r=await api('stream',undefined,abort.signal);if(!r.body?.getReader){useStream=false;continue}
    const reader=r.body.getReader(),decoder=new TextDecoder();let pending='',first=true;
    try{while(!ended&&!abort.signal.aborted){const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});if(pending.length>6*1024*1024)throw Error('Слишком большой кадр браузера');let newline;
      while((newline=pending.indexOf('\\n'))>=0){const packet=JSON.parse(pending.slice(0,newline));pending=pending.slice(newline+1);if(packet.error)throw connectionError(packet.status,packet.error);clearTimeout(watchdog);watchdog=setTimeout(()=>abort.abort(),10000);if(packet.type==='state'){if(packet.url)setSiteFromUrl(packet.url);if(!ended)agentState(packet.paused!==false);continue}if(typeof packet.frame!=='string')throw Error('Некорректный кадр браузера');const bytes=Uint8Array.from(atob(packet.frame),c=>c.charCodeAt(0));queueFrame(new Blob([bytes],{type:'image/jpeg'}));if(!ended)agentState(packet.paused!==false);first=false}
    }}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
  }}catch(e){if(e.name!=='AbortError'&&(!abort.signal.aborted||ended))report(e.message,true)}finally{clearTimeout(watchdog);if(streamAbort===abort)streamAbort=undefined}
}await new Promise(resolve=>setTimeout(resolve,useStream?700:200))}}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopStream()});window.addEventListener('pagehide',stopStream);
// A browser may open another fragment link without loading a new document.
window.addEventListener('hashchange',()=>{if(location.hash)location.reload()});
async function connect(){disable();document.getElementById('reconnect').disabled=false;try{await initializeTelegram();history.replaceState(null,'',location.pathname);const id=link?await fingerprint(link):'',saved=restore(id),initData=telegram?.initData||telegramParams.get('tgWebAppData');const auth=initData?{telegramInitData:initData}:{};if(!saved){if(!link){report('В ссылке нет ключа доступа. Запроси новую ссылку у агента.',true);return}credential=link}const r=await api('claim',auth),claim=await r.json();credential=claim.credential;remember(claim.expiresAt,id||saved?.fingerprint||'');document.querySelectorAll('button,input').forEach(e=>e.disabled=false);agentState(claim.paused);if(telegram?.initData&&innerWidth<600)await phoneViewport();await stream()}catch(e){report(e.message,true)}}connect();
</script></body></html>`;
}
