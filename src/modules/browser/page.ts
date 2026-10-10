/** Self-contained control surface: no third-party scripts, fonts, or analytics. */
export function controlPage(nonce: string): string {
	return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Alive — управление браузером</title><style nonce="${nonce}">
:root{--surface:#f5f4ef;--panel:#fff;--text:#202622;--muted:#58625c;--line:#c5cdc7;--action:#176143;--focus:#165ec7;--error:#9e2424}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--surface);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:1120px;margin:auto;padding:24px 16px max(24px,env(safe-area-inset-bottom))}header{display:flex;justify-content:space-between;align-items:start;gap:16px;margin-bottom:20px}
h1{font-size:24px;line-height:1.2;margin:4px 0 8px}.eyebrow{font:600 12px/1.5 ui-monospace,monospace;letter-spacing:.12em;color:var(--action)}p{margin:0;color:var(--muted)}#status{min-height:24px}#status.error{color:var(--error)}
button,input{font:inherit}button{min-height:48px;padding:10px 16px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--text);cursor:pointer}button:active{background:#e1e8e2}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,#frame:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
#resume{background:var(--action);border-color:var(--action);color:white}#viewer{overflow:auto;background:#e5e8e3;border:1px solid var(--line);border-radius:8px;min-height:200px;margin:16px 0;max-height:72vh}#frame{display:block;width:100%;height:auto;touch-action:none}#viewer.zoom #frame{width:var(--frame-width,900px);max-width:none}#viewer.pan #frame{touch-action:pan-x pan-y;cursor:grab}
.tools{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}form{display:flex;gap:8px;align-items:end}label{display:block;color:var(--muted);font-size:14px}.field{flex:1;min-width:0}input{width:100%;padding:12px;border:1px solid var(--line);border-radius:6px;background:var(--panel);min-height:48px}.hint{font-size:14px;margin-top:16px;max-width:70ch}
@media(max-width:600px){main{padding-top:max(20px,env(safe-area-inset-top))}header{display:block}#resume{width:100%;margin-top:16px}h1{font-size:22px}form{flex-wrap:wrap}.field{flex-basis:100%}form button{width:100%}}
</style></head><body><main>
<header><div><span class="eyebrow">ALIVE / РУЧНОЕ УПРАВЛЕНИЕ</span><h1>Браузер ждёт тебя</h1><p id="status" role="status" aria-live="polite">Подключение к сессии…</p></div><button id="resume" disabled>Готово — вернуть агенту</button></header>
<div class="tools"><button id="pause" disabled>Приостановить изображение</button><button id="zoom" aria-pressed="false">Увеличить</button><button id="pan" aria-pressed="false" hidden>Перемещать изображение</button></div>
<div id="viewer"><img id="frame" alt="Текущая вкладка удалённого браузера" tabindex="0" draggable="false"></div>
<div class="tools" id="keys"><button data-key="Tab">Tab</button><button data-key="Enter">Enter</button><button data-key="Backspace">Удалить символ</button><button data-key="Escape">Esc</button><button data-scroll="-500">Прокрутить вверх</button><button data-scroll="500">Прокрутить вниз</button><button data-action="reload">Обновить страницу</button></div>
<form id="typing"><div class="field"><label for="text">Текст в выбранное поле браузера</label><input id="text" autocomplete="off" maxlength="4096"></div><button type="submit">Ввести текст</button></form>
<p class="hint">Нажимай и перетаскивай элементы прямо на изображении. Мелкие элементы можно увеличить; кнопка «Перемещать изображение» включает перемещение вида вместо кликов. Перед вводом текста выбери поле. Агент приостановлен, пока ты не вернёшь управление.</p>
</main><script nonce="${nonce}">
const statusEl=document.getElementById('status'),frame=document.getElementById('frame'),viewer=document.getElementById('viewer');
let credential='',ended=false,paused=false,dragging=false,queue=Promise.resolve(),lastMove=0;
const storageKey='alive.browser.operator';
function forget(){try{sessionStorage.removeItem(storageKey)}catch{}}
function remember(expiresAt,fingerprint){try{sessionStorage.setItem(storageKey,JSON.stringify({credential,expiresAt,fingerprint}))}catch{}}
function restore(fingerprint){try{const saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(!saved||!(/^[A-Za-z0-9_-]{43}$/).test(saved.credential)||!Number.isFinite(saved.expiresAt)||saved.expiresAt<=Date.now()||(fingerprint&&saved.fingerprint!==fingerprint)){forget();return false}credential=saved.credential;return true}catch{forget();return false}}
async function fingerprint(link){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(link)))).map(byte=>byte.toString(16).padStart(2,'0')).join('')}
function report(message,error=false){statusEl.textContent=message;statusEl.className=error?'error':''}
function disable(){document.querySelectorAll('button,input').forEach(e=>e.disabled=true)}
async function api(path,body){const r=await fetch('/browser/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+credential,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});if(!r.ok){const j=await r.json();if(r.status===401||r.status===410){ended=true;forget();disable()}const errors={'Invalid access key':'Ссылка уже использована или заменена. Запроси новую ссылку у агента.','No active handoff':'Сессия управления завершена. Можно закрыть страницу.','Link expired. Request a new handoff.':'Срок ссылки истёк. Запроси новую ссылку у агента.'};throw Error(errors[j.error]||j.error||'Ошибка подключения')}return r}
function send(body){queue=queue.then(async()=>{if(ended)return;await api('input',body)}).catch(e=>report(e.message,true));return queue}
function point(e){const r=frame.getBoundingClientRect();return {x:Math.max(0,Math.min(frame.naturalWidth-1,(e.clientX-r.left)*frame.naturalWidth/r.width)),y:Math.max(0,Math.min(frame.naturalHeight-1,(e.clientY-r.top)*frame.naturalHeight/r.height))}}
frame.addEventListener('pointerdown',e=>{if(!credential||ended||paused||viewer.classList.contains('pan')||!frame.naturalWidth)return;e.preventDefault();frame.focus();dragging=true;frame.setPointerCapture(e.pointerId);send({type:'down',...point(e)})});
frame.addEventListener('pointermove',e=>{if(dragging&&Date.now()-lastMove>50){lastMove=Date.now();send({type:'move',...point(e)})}});
function release(e){if(dragging){dragging=false;send({type:'up',...point(e)})}}frame.addEventListener('pointerup',release);frame.addEventListener('pointercancel',release);
frame.addEventListener('keydown',e=>{if(['Tab','Enter','Backspace','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Delete',' '].includes(e.key)){e.preventDefault();send({type:'key',key:e.key===' '?'Space':e.key})}});
document.getElementById('keys').addEventListener('click',e=>{const b=e.target.closest('button');if(!b||!credential)return;if(b.dataset.key)send({type:'key',key:b.dataset.key});if(b.dataset.scroll)send({type:'scroll',delta:Number(b.dataset.scroll)});if(b.dataset.action)send({type:b.dataset.action})});
document.getElementById('typing').addEventListener('submit',async e=>{e.preventDefault();const input=document.getElementById('text');if(!credential||ended||!input.value)return;const text=input.value;input.value='';await send({type:'text',text})});
document.getElementById('zoom').onclick=e=>{const zoom=viewer.classList.toggle('zoom');e.target.setAttribute('aria-pressed',String(zoom));e.target.textContent=zoom?'По ширине':'Увеличить';viewer.classList.remove('pan');const pan=document.getElementById('pan');pan.hidden=!zoom;pan.setAttribute('aria-pressed','false');pan.textContent='Перемещать изображение'};
document.getElementById('pan').onclick=e=>{const pan=viewer.classList.toggle('pan');e.target.setAttribute('aria-pressed',String(pan));e.target.textContent=pan?'Вернуться к кликам':'Перемещать изображение'};
document.getElementById('pause').onclick=e=>{paused=!paused;e.target.textContent=paused?'Продолжить изображение':'Приостановить изображение'};
document.getElementById('resume').onclick=async()=>{const button=document.getElementById('resume');button.disabled=true;try{await queue;await api('resume',{});ended=true;forget();disable();report('Управление возвращено агенту. Можно закрыть страницу.')}catch(e){report(e.message,true);if(!ended)button.disabled=false}};
async function stream(){while(!ended){if(!paused&&!document.hidden&&!dragging){try{const r=await api('frame');const next=URL.createObjectURL(await r.blob());const previous=frame.src;await new Promise(resolve=>{frame.onload=resolve;frame.onerror=resolve;frame.src=next});viewer.style.setProperty('--frame-width',frame.naturalWidth+'px');if(previous.startsWith('blob:'))URL.revokeObjectURL(previous)}catch(e){report(e.message,true)}}await new Promise(resolve=>setTimeout(resolve,700))}}
// A browser may open another fragment link without loading a new document.
window.addEventListener('hashchange',()=>{if(location.hash)location.reload()});
async function connect(){disable();const link=location.hash.slice(1);history.replaceState(null,'',location.pathname);try{const id=link?await fingerprint(link):'';if(!restore(id)){if(!link){report('В ссылке нет ключа доступа. Запроси новую ссылку у агента.',true);return}credential=link;const r=await api('claim',{});const claim=await r.json();credential=claim.credential;remember(claim.expiresAt,id)}document.querySelectorAll('button,input').forEach(e=>e.disabled=false);report('Подключено · агент приостановлен');await stream()}catch(e){report(e.message,true)}}connect();
</script></body></html>`;
}
