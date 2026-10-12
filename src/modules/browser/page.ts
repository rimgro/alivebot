/** Control surface; Telegram launches optionally load the integrity-pinned official SDK. */
export function controlPage(nonce: string): string {
	return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Alive — управление браузером</title><style nonce="${nonce}">
:root{--surface:#f5f4ef;--panel:#fff;--text:#202622;--muted:#58625c;--line:#c5cdc7;--action:#176143;--focus:#165ec7;--error:#9e2424}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--surface);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:1120px;margin:auto;padding:calc(24px + var(--tg-content-safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right),var(--tg-content-safe-area-inset-right,0px)) max(24px,env(safe-area-inset-bottom),var(--tg-content-safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left),var(--tg-content-safe-area-inset-left,0px))}header{display:flex;justify-content:space-between;align-items:start;gap:16px;margin-bottom:20px}
h1{font-size:24px;line-height:1.2;margin:4px 0 8px}.eyebrow{font:600 12px/1.5 ui-monospace,monospace;letter-spacing:.12em;color:var(--action)}p{margin:0;color:var(--muted)}#status{min-height:24px}#status.error,#input-status.error{color:var(--error)}#connection-metrics{min-height:1.5em;margin:4px 0 0;font-size:12px}
button,input{font:inherit}button{min-height:48px;padding:10px 16px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--text);cursor:pointer}button:active{background:#e1e8e2}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,#frame:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
#resume{background:var(--action);border-color:var(--action);color:white}#viewer{position:relative;overflow:auto;background:#e5e8e3;border:1px solid var(--line);border-radius:8px;min-height:200px;margin:16px 0;max-height:72vh;max-height:72dvh}#frame{display:block;width:100%;height:auto;touch-action:none}#viewer.zoom #frame{width:var(--frame-width,900px);max-width:none}#viewer.pan #frame{touch-action:pan-x pan-y;cursor:grab}
#pointer-marker{position:absolute;width:36px;height:36px;border:3px dashed var(--focus);border-radius:50%;background:#165ec733;transform:translate(-50%,-50%);pointer-events:none}#pointer-marker[data-state="accepted"]{border-style:solid}#pointer-status{min-height:3em}
.tools{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}form{display:flex;gap:8px;align-items:end}label{display:block;color:var(--muted);font-size:14px}.field{flex:1;min-width:0}input{width:100%;padding:12px;border:1px solid var(--line);border-radius:6px;background:var(--panel);min-height:48px}.hint{font-size:14px;margin-top:16px;max-width:70ch}
@media(max-width:600px){main{padding-top:max(20px,env(safe-area-inset-top),var(--tg-content-safe-area-inset-top,0px))}header{display:block}#resume{width:100%;margin-top:16px}h1{font-size:22px}form{flex-wrap:wrap}.field{flex-basis:100%}form button{width:100%}}
</style></head><body><main>
<header><div><span class="eyebrow">ALIVE / РУЧНОЕ УПРАВЛЕНИЕ</span><h1>Браузер ждёт тебя</h1><p id="status" role="status" aria-live="polite">Подключение к сессии…</p><p id="connection-metrics" class="hint"></p></div><button id="resume" disabled>Готово — вернуть агенту</button></header>
<div class="tools"><button id="pause" disabled>Приостановить изображение</button><button id="zoom" aria-pressed="false">Увеличить</button><button id="pan" aria-pressed="false" hidden>Перемещать изображение</button></div>
<p id="pointer-status" class="hint" role="status" aria-live="polite">Нажми нужный элемент на изображении.</p>
<div id="viewer"><img id="frame" alt="Текущая вкладка удалённого браузера" tabindex="0" draggable="false"><span id="pointer-marker" hidden aria-hidden="true"></span></div>
<div class="tools" id="keys"><button data-key="Tab">Tab</button><button data-key="Enter">Enter</button><button data-key="Backspace">Удалить символ</button><button data-key="Escape">Esc</button><button data-scroll="-500">Прокрутить вверх</button><button data-scroll="500">Прокрутить вниз</button><button data-action="reload">Обновить страницу</button></div>
<form id="typing"><div class="field"><label for="text">Текст в выбранное поле браузера</label><input id="text" autocomplete="off" maxlength="4096"></div><button type="submit">Ввести текст</button></form>
<p id="input-status" class="hint" role="status" aria-live="polite">Сначала нажми нужное поле на изображении выше. Затем введи текст здесь и нажми «Ввести текст».</p>
<p class="hint">Нажимай и перетаскивай элементы прямо на изображении. Мелкие элементы можно увеличить; кнопка «Перемещать изображение» включает перемещение вида вместо кликов. Перед вводом текста выбери поле. Агент приостановлен, пока ты не вернёшь управление.</p>
</main><script nonce="${nonce}">
const statusEl=document.getElementById('status'),frame=document.getElementById('frame'),viewer=document.getElementById('viewer');
let credential='',ended=false,paused=false,dragging=false,queue=Promise.resolve(),lastMove=0,streamAbort,telegram,telegramActive=true,useStream=true;
let pointerId,pointerDown,gesture=0,markerTimer;const marker=document.getElementById('pointer-marker'),pointerStatus=document.getElementById('pointer-status');
let liveSocket,liveReady=false,requestId=0,remoteWidth=0,remoteHeight=0,moveInFlight=false,pendingMove;
const requests=new Map(),metrics=document.getElementById('connection-metrics');
// Telegram appends launch data to the fragment. Keep the activation key out of its SDK storage.
const launchHash=location.hash.slice(1).replace(/^\\?/,''),launchParams=new URLSearchParams(launchHash);
const firstPart=launchHash.split('&')[0],link=launchParams.get('aliveKey')||(/^[A-Za-z0-9_-]{43}$/.test(firstPart)?firstPart:'');
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
  if(telegram.isVersionAtLeast('7.7'))telegram.disableVerticalSwipes();
  telegram.onEvent('deactivated',()=>{telegramActive=false;stopStream()});
  telegram.onEvent('activated',()=>{telegramActive=true});
}
const storageKey='alive.browser.operator';
function forget(){try{sessionStorage.removeItem(storageKey)}catch{}}
function remember(expiresAt,fingerprint){try{sessionStorage.setItem(storageKey,JSON.stringify({credential,expiresAt,fingerprint}))}catch{}}
function restore(fingerprint){try{const saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(!saved||!(/^[A-Za-z0-9_-]{43}$/).test(saved.credential)||!Number.isFinite(saved.expiresAt)||saved.expiresAt<=Date.now()||(fingerprint&&saved.fingerprint!==fingerprint)){forget();return false}credential=saved.credential;return true}catch{forget();return false}}
async function fingerprint(link){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(link)))).map(byte=>byte.toString(16).padStart(2,'0')).join('')}
function report(message,error=false){statusEl.textContent=message;statusEl.className=error?'error':''}
function stopStream(){streamAbort?.abort();liveSocket?.close()}
function disable(){document.querySelectorAll('button,input').forEach(e=>e.disabled=true)}
function connectionError(status,message){if(status===401||status===410){ended=true;forget();disable();stopStream();telegram?.disableClosingConfirmation()}const errors={'Select an editable text field on the browser image first':'Сначала нажми текстовое поле на изображении браузера, затем повтори ввод.','Invalid access key':'Ссылка уже использована или заменена. Запроси новую ссылку у агента.','No active handoff':'Сессия управления завершена. Можно закрыть страницу.','Link expired. Request a new handoff.':'Срок ссылки истёк. Запроси новую ссылку у агента.'};return Error(errors[message]||message||'Ошибка подключения')}
async function api(path,body,signal){const r=await fetch('/browser/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+credential,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal});if(!r.ok){const j=await r.json();throw connectionError(r.status,j.error)}return r}
function liveInput(body,type='input'){return new Promise(resolve=>{if(!liveReady||liveSocket?.readyState!==WebSocket.OPEN){resolve({ok:false,error:'Соединение прервано · проверь результат нажатия'});return}const id=++requestId,timer=setTimeout(()=>{requests.delete(id);resolve({ok:false,error:'Нет подтверждения действия · проверь соединение и изображение'})},8000);requests.set(id,{resolve,timer});liveSocket.send(JSON.stringify({type,id,body}))})}
function send(body){const action=liveReady?liveInput(body):queue.then(async()=>{if(ended)return {ok:false};await api('input',body);return {ok:true}});const outcome=action.catch(e=>({ok:false,error:e.message})).then(result=>{if(result.error)report(result.error,true);return result});queue=Promise.all([queue,outcome]).then(([,result])=>result);return outcome}
function point(e){const r=frame.getBoundingClientRect(),width=remoteWidth||frame.naturalWidth,height=remoteHeight||frame.naturalHeight;return {x:Math.max(0,Math.min(width-1,(e.clientX-r.left)*width/r.width)),y:Math.max(0,Math.min(height-1,(e.clientY-r.top)*height/r.height))}}
function showPointer(e,state='pending'){clearTimeout(markerTimer);const p=point(e);marker.style.left=(frame.offsetLeft+p.x*frame.clientWidth/(remoteWidth||frame.naturalWidth))+'px';marker.style.top=(frame.offsetTop+p.y*frame.clientHeight/(remoteHeight||frame.naturalHeight))+'px';marker.dataset.state=state;marker.hidden=false}
function pumpMove(){if(moveInFlight||!pendingMove||!dragging)return;const point=pendingMove;pendingMove=undefined;moveInFlight=true;send({type:'move',...point}).finally(()=>{moveInFlight=false;pumpMove()})}
frame.addEventListener('pointerdown',e=>{if(dragging||!credential||ended||paused||viewer.classList.contains('pan')||!frame.naturalWidth)return;e.preventDefault();const p=point(e);frame.focus();dragging=true;pointerId=e.pointerId;gesture++;frame.setPointerCapture(e.pointerId);showPointer(e);pointerStatus.textContent='Передача нажатия…';pointerDown=send({type:'down',...p})});
frame.addEventListener('pointermove',e=>{if(dragging&&e.pointerId===pointerId&&Date.now()-lastMove>30){lastMove=Date.now();showPointer(e);pendingMove=point(e);pumpMove()}});
async function release(e){if(!dragging||e.pointerId!==pointerId)return;dragging=false;pendingMove=undefined;const current=gesture,down=pointerDown,up=send({type:'up',...point(e)}),accepted=(await down).ok&&(await up).ok;if(current!==gesture)return;if(accepted&&e.type==='pointerup'){showPointer(e,'accepted');pointerStatus.textContent='Нажатие передано браузеру · проверь результат'}else{marker.hidden=true;pointerStatus.textContent=e.type==='pointercancel'?'Касание прервано · проверь изображение':'Нет подтверждения · проверь соединение'}markerTimer=setTimeout(()=>{marker.hidden=true},900)}frame.addEventListener('pointerup',release);frame.addEventListener('pointercancel',release);
frame.addEventListener('keydown',e=>{if(['Tab','Enter','Backspace','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Delete',' '].includes(e.key)){e.preventDefault();send({type:'key',key:e.key===' '?'Space':e.key})}});
document.getElementById('keys').addEventListener('click',e=>{const b=e.target.closest('button');if(!b||!credential)return;if(b.dataset.key)send({type:'key',key:b.dataset.key});if(b.dataset.scroll)send({type:'scroll',delta:Number(b.dataset.scroll)});if(b.dataset.action)send({type:b.dataset.action})});
document.getElementById('typing').addEventListener('submit',async e=>{e.preventDefault();const input=document.getElementById('text'),feedback=document.getElementById('input-status'),button=e.target.querySelector('button');if(!credential||ended||!input.value)return;const text=input.value;button.disabled=true;feedback.textContent='Отправка текста…';feedback.className='hint';const outcome=await send({type:'text',text});if(outcome.ok){if(input.value===text)input.value='';feedback.textContent='Текст отправлен в выбранное поле. Если на сайте нужна кнопка подтверждения, нажми её на изображении.'}else{feedback.textContent=outcome.error||'Текст не отправлен.';feedback.className='hint error'}if(!ended)button.disabled=false});
document.getElementById('zoom').onclick=e=>{const zoom=viewer.classList.toggle('zoom');e.target.setAttribute('aria-pressed',String(zoom));e.target.textContent=zoom?'По ширине':'Увеличить';viewer.classList.remove('pan');const pan=document.getElementById('pan');pan.hidden=!zoom;pan.setAttribute('aria-pressed','false');pan.textContent='Перемещать изображение'};
document.getElementById('pan').onclick=e=>{const pan=viewer.classList.toggle('pan');e.target.setAttribute('aria-pressed',String(pan));e.target.textContent=pan?'Вернуться к кликам':'Перемещать изображение'};
document.getElementById('pause').onclick=e=>{paused=!paused;if(paused)stopStream();e.target.textContent=paused?'Продолжить изображение':'Приостановить изображение'};
document.getElementById('resume').onclick=async()=>{const button=document.getElementById('resume');button.disabled=true;try{await queue;if(liveReady){const outcome=await liveInput({},'resume');if(!outcome.ok)throw Error(outcome.error)}else await api('resume',{});ended=true;stopStream();forget();disable();telegram?.disableClosingConfirmation();report('Управление возвращено агенту. Можно закрыть страницу.')}catch(e){report(e.message,true);if(!ended)button.disabled=false}};
async function showFrame(blob){if(ended||paused||document.hidden||!telegramActive)return;const next=URL.createObjectURL(blob),previous=frame.src;await new Promise(resolve=>{const timer=setTimeout(resolve,2000);frame.onload=frame.onerror=()=>{clearTimeout(timer);resolve()};frame.src=next});viewer.style.setProperty('--frame-width',frame.naturalWidth+'px');if(previous.startsWith('blob:'))URL.revokeObjectURL(previous)}
let latestFrame,rendering=false;
function queueFrame(blob){latestFrame=blob;if(rendering)return;rendering=true;(async()=>{try{while(latestFrame){const next=latestFrame;latestFrame=undefined;await showFrame(next)}}finally{rendering=false}})()}
async function live(){return new Promise((resolve,reject)=>{
  const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/browser/live');liveSocket=ws;ws.binaryType='arraybuffer';let authenticated=false,pingTimer,lastPing=0;
  const timeout=setTimeout(()=>{ws.close();reject(Error('WebSocket недоступен'))},5000);
  ws.onopen=()=>ws.send(JSON.stringify({type:'auth',credential}));
  ws.onmessage=async event=>{try{if(typeof event.data==='string'){const packet=JSON.parse(event.data);
    if(packet.type==='authenticated'){authenticated=true;liveReady=true;clearTimeout(timeout);report('Подключено · агент приостановлен');metrics.textContent='Поток подключён';pingTimer=setInterval(()=>{lastPing=performance.now();if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ping',id:lastPing}))},3000)}
    if(packet.type==='ack'){const request=requests.get(packet.id);if(request){clearTimeout(request.timer);requests.delete(packet.id);request.resolve(packet.ok?{ok:true}:{ok:false,error:connectionError(packet.status,packet.error).message})}}
    if(packet.type==='pong')metrics.textContent='Отклик соединения: '+Math.round(performance.now()-packet.id)+' мс';
    if(packet.type==='error')throw connectionError(packet.status,packet.error);
  }else{const bytes=new Uint8Array(event.data),header=new DataView(event.data);if(bytes.length<16||header.getUint32(0)!==0x414c4956)throw Error('Некорректный кадр браузера');remoteWidth=header.getUint32(8);remoteHeight=header.getUint32(12);const id=header.getUint32(4);await showFrame(new Blob([bytes.subarray(16)],{type:'image/jpeg'}));if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'frame_ack',id}))}
  }catch(e){report(e.message,true);ws.close()}};
  ws.onerror=()=>{};
  ws.onclose=()=>{clearTimeout(timeout);clearInterval(pingTimer);if(liveSocket===ws){liveSocket=undefined;liveReady=false}for(const request of requests.values()){clearTimeout(request.timer);request.resolve({ok:false,error:'Соединение прервано · проверь результат действия'})}requests.clear();authenticated?resolve():reject(Error('WebSocket недоступен'))};
})}
async function stream(){let liveFailures=0;while(!ended){if(!paused&&!document.hidden&&telegramActive){if(liveFailures<2){try{await live();if(!ended&&!paused&&!document.hidden&&telegramActive)liveFailures++}catch{liveFailures++}if(ended)break;if(liveFailures<2){await new Promise(resolve=>setTimeout(resolve,300));continue}}remoteWidth=remoteHeight=0;metrics.textContent='Совместимый режим изображения';const abort=new AbortController();streamAbort=abort;let watchdog;
  try{if(!useStream){const r=await api('frame',undefined,abort.signal);await showFrame(await r.blob())}else{
    watchdog=setTimeout(()=>{useStream=false;abort.abort()},10000);
    const r=await api('stream',undefined,abort.signal);if(!r.body?.getReader){useStream=false;continue}
    const reader=r.body.getReader(),decoder=new TextDecoder();let pending='',first=true;
    try{while(!ended&&!abort.signal.aborted){const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});if(pending.length>6*1024*1024)throw Error('Слишком большой кадр браузера');let newline;
      while((newline=pending.indexOf('\\n'))>=0){const packet=JSON.parse(pending.slice(0,newline));pending=pending.slice(newline+1);if(packet.error)throw connectionError(packet.status,packet.error);if(typeof packet.frame!=='string')throw Error('Некорректный кадр браузера');clearTimeout(watchdog);watchdog=setTimeout(()=>abort.abort(),10000);const bytes=Uint8Array.from(atob(packet.frame),c=>c.charCodeAt(0));queueFrame(new Blob([bytes],{type:'image/jpeg'}));if(first&&!ended){report('Подключено · агент приостановлен');first=false}}
    }}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
  }}catch(e){if(e.name!=='AbortError'&&(!abort.signal.aborted||ended))report(e.message,true)}finally{clearTimeout(watchdog);if(streamAbort===abort)streamAbort=undefined}
}await new Promise(resolve=>setTimeout(resolve,useStream?700:200))}}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopStream()});window.addEventListener('pagehide',stopStream);
// A browser may open another fragment link without loading a new document.
window.addEventListener('hashchange',()=>{if(location.hash)location.reload()});
async function connect(){disable();try{await initializeTelegram();history.replaceState(null,'',location.pathname);const id=link?await fingerprint(link):'';if(!restore(id)){if(!link){report('В ссылке нет ключа доступа. Запроси новую ссылку у агента.',true);return}credential=link;const r=await api('claim',{});const claim=await r.json();credential=claim.credential;remember(claim.expiresAt,id)}document.querySelectorAll('button,input').forEach(e=>e.disabled=false);report('Подключено · агент приостановлен');await stream()}catch(e){report(e.message,true)}}connect();
</script></body></html>`;
}
