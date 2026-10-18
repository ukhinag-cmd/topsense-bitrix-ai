"use strict";
// TOP-SENS Sales Control — isolated demonstration only. No CRM access.
const http = require("node:http");
const crypto = require("node:crypto");
const token = process.env.SALES_DASHBOARD_TOKEN || "";
const port = Number(process.env.PORT || 10000);
if (!token || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Sales staging configuration missing or invalid");
  process.exit(1);
}
const managers = ["Анна Волкова", "Илья Петров", "Мария Соколова", "Денис Орлов"];
const stages = ["Новая", "Квалификация", "Переговоры", "Коммерческое предложение", "Согласование"];
const clients = ["Альфа Пром", "СеверТех", "Вектор Инжиниринг", "Гранит", "Меридиан", "ТехноГрупп", "ПромСнаб", "НордСтрой", "Магистраль", "Энергия", "Бета Сервис", "Спектр", "Горизонт", "Индустрия", "Монолит", "Оптима", "ГеоРесурс", "Прогресс"];
const demo = clients.map((client, i) => {
  const prospect = Math.min(97, 30 + (i * 17) % 65);
  const risk = (i * 23 + 11) % 96;
  const days = [-9, -2, 0, 1, 3, 7, 14][i % 7];
  const nextStatus = i % 6 === 0 ? "Не проверено" : days < 0 ? "Просрочено" : "Запланировано";
  const currency = ["RUB", "RUB", "USD", "EUR"][i % 4];
  return { id: 1001 + i, client, name: ["Поставка оборудования", "Сервисный контракт", "Запрос КП", "Модернизация проекта"][i % 4], manager: managers[i % managers.length], stage: stages[i % stages.length], amount: (i + 2) * 85000, currency, prospect, risk, qualification: ["Квалифицировано", "Не квалифицировано", "На проверке"][i % 3], nextStatus, due: new Date(Date.UTC(2026, 9, 18 + days)).toISOString().slice(0, 10), history: [{at:"2026-10-14",text:"Создана демонстрационная сделка"},{at:"2026-10-16",text:"Проверка коммерческого предложения"}] };
});
function authorized(req) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(req.headers.authorization || ""));
  if (!match) return false;
  const data = Buffer.from(match[1], "base64").toString("utf8");
  const at = data.indexOf(":");
  if (at < 0 || data.slice(0, at) !== "sales") return false;
  const a = Buffer.from(data.slice(at+1));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a,b);
}
const safeJson = JSON.stringify(demo).replace(/</g, "\\u003c").replace(/>/g,"\\u003e").replace(/&/g,"\\u0026");
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TOP-SENS — Sales Control DEMO</title><style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#142333;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}header{background:#102d43;color:#fff;padding:22px clamp(16px,4vw,56px)}h1{font-size:24px;margin:0}header p{margin:5px 0 0;color:#cfe1ee}.wrap{max-width:1480px;margin:auto;padding:24px clamp(12px,3vw,40px)}.banner{background:#fff4db;color:#825000;border:1px solid #f0d394;padding:12px 16px;border-radius:10px;font-weight:700;margin-bottom:16px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}.card,.panel{background:white;border:1px solid #e1e7ee;border-radius:12px;padding:17px;box-shadow:0 2px 8px #162c3b09}.card span{color:#607181;font-size:13px}.card strong{display:block;font-size:27px;margin-top:5px}.panel{margin-bottom:20px}h2{font-size:18px;margin:0 0 14px}.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:14px}input,select{width:100%;padding:10px;border:1px solid #cdd7e1;border-radius:8px;background:white;color:#132e40}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;min-width:1000px}th,td{padding:12px 10px;border-bottom:1px solid #ecf0f4;text-align:left}th{background:#f0f5f8;color:#425568;white-space:nowrap}tr:hover{background:#f8fbfd}button{cursor:pointer;border:1px solid #bed0dd;border-radius:7px;background:#fff;padding:7px 9px;color:#144364}button:hover{background:#eaf4fc}.pill{padding:4px 7px;border-radius:7px;font-weight:700;display:inline-block}.good{background:#e7f7ee;color:#167047}.mid{background:#fff4d7;color:#815e06}.bad{background:#ffe9e9;color:#ad3030}.muted{background:#eff1f5;color:#5c6772}dialog{border:0;border-radius:14px;max-width:620px;width:calc(100% - 20px);padding:25px;box-shadow:0 20px 80px #102d4355}dialog::backdrop{background:#0b263b88}.dialogtop{display:flex;justify-content:space-between;align-items:center}.foot{color:#657889;font-size:12px}ul{line-height:1.9}@media(max-width:550px){h1{font-size:21px}.wrap{padding:12px}.card strong{font-size:23px}}
</style></head><body><header><h1>TOP-SENS / Sales Control</h1><p>Панель коммерческого директора · демонстрационная версия</p></header><main class="wrap"><div class="banner">ДЕМО — данные вымышленные. Bitrix24 не подключён, оценки не являются реальной аналитикой.</div><section class="cards" id="kpis"></section><section class="panel"><h2>Сделки и контроль действий</h2><div class="filters"><input id="search" placeholder="Поиск клиента или сделки" aria-label="Поиск"><select id="manager" aria-label="Менеджер"><option value="">Все менеджеры</option></select><select id="stage" aria-label="Стадия"><option value="">Все стадии</option></select><select id="risk" aria-label="Риск"><option value="">Любой риск</option><option value="high">Высокий (≥ 60)</option><option value="low">Низкий (&lt; 60)</option></select><select id="next" aria-label="Следующий шаг"><option value="">Любой Next Step</option><option>Просрочено</option><option>Запланировано</option><option>Не проверено</option></select><select id="sort" aria-label="Сортировка"><option value="risk">Сначала риск</option><option value="prospect">Сначала перспективные</option><option value="amount">Сначала крупные</option><option value="due">По сроку Next Step</option></select></div><div class="scroll"><table><thead><tr><th>Клиент / сделка</th><th>Менеджер</th><th>Стадия</th><th>Сумма</th><th>Prospect</th><th>Risk</th><th>Квалификация</th><th>Next Step</th><th>Детали</th></tr></thead><tbody id="rows"></tbody></table></div><p class="foot" id="count"></p></section><p class="foot">Демо-данные существуют только в коде и браузере; изменений CRM и отправки писем нет.</p></main><dialog id="details"><div class="dialogtop"><h2 id="detailTitle">Сделка</h2><button id="close">Закрыть</button></div><div id="detailBody"></div></dialog><script>
"use strict";
const deals=${safeJson};
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const money=d=>new Intl.NumberFormat("ru-RU",{maximumFractionDigits:0}).format(d.amount)+" "+d.currency;
const color=(v,reverse=false)=>v>=70?(reverse?"bad":"good"):v>=45?"mid":(reverse?"good":"muted");
for(const [id,values] of [["manager",[...new Set(deals.map(d=>d.manager))]],["stage",[...new Set(deals.map(d=>d.stage))]]])for(const value of values){const o=document.createElement("option");o.value=value;o.textContent=value;$(id).append(o)}
function current(){const q=$("search").value.toLocaleLowerCase("ru");const m=$("manager").value,s=$("stage").value,r=$("risk").value,n=$("next").value;let a=deals.filter(d=>(d.client+" "+d.name).toLocaleLowerCase("ru").includes(q)&&(!m||d.manager===m)&&(!s||d.stage===s)&&(!r||(r==="high"?d.risk>=60:d.risk<60))&&(!n||d.nextStatus===n));const field=$("sort").value;a.sort((x,y)=>field==="due"?x.due.localeCompare(y.due):y[field]-x[field]);return a}
function render(){const a=current();const totals={};for(const d of a)totals[d.currency]=(totals[d.currency]||0)+d.amount;const cells=[["Сделок в выборке",a.length],["Сумма по валютам",Object.entries(totals).map(([c,v])=>new Intl.NumberFormat("ru-RU").format(v)+" "+c).join(" · ")||"—"],["Перспективные (≥ 70)",a.filter(d=>d.prospect>=70).length],["Высокий риск (≥ 60)",a.filter(d=>d.risk>=60).length],["Next Step просрочен",a.filter(d=>d.nextStatus==="Просрочено").length]];$("kpis").innerHTML=cells.map(([l,v])=>'<div class="card"><span>'+esc(l)+'</span><strong>'+esc(v)+'</strong></div>').join("");$("rows").innerHTML=a.map(d=>'<tr><td><strong>'+esc(d.client)+'</strong><br>'+esc(d.name)+'</td><td>'+esc(d.manager)+'</td><td>'+esc(d.stage)+'</td><td>'+esc(money(d))+'</td><td><span class="pill '+color(d.prospect)+'">'+d.prospect+'</span></td><td><span class="pill '+color(d.risk,true)+'">'+d.risk+'</span></td><td>'+esc(d.qualification)+'</td><td><span class="pill '+(d.nextStatus==="Просрочено"?"bad":d.nextStatus==="Не проверено"?"muted":"good")+'">'+esc(d.nextStatus)+'</span><br>'+esc(d.due)+'</td><td><button data-id="'+d.id+'">Открыть</button></td></tr>').join("");$("count").textContent="Показано "+a.length+" из "+deals.length+" демонстрационных сделок"}
for(const id of ["search","manager","stage","risk","next","sort"])$(id).addEventListener(id==="search"?"input":"change",render);
$("rows").addEventListener("click",e=>{const b=e.target.closest("button[data-id]");if(!b)return;const d=deals.find(x=>x.id===Number(b.dataset.id));if(!d)return;$("detailTitle").textContent=d.client+" — "+d.name;$("detailBody").innerHTML='<p><strong>Менеджер:</strong> '+esc(d.manager)+'</p><p><strong>Стадия:</strong> '+esc(d.stage)+'</p><p><strong>Сумма:</strong> '+esc(money(d))+'</p><p><strong>Prospect / Risk:</strong> '+d.prospect+' / '+d.risk+'</p><p><strong>Next Step:</strong> '+esc(d.nextStatus)+' ('+esc(d.due)+')</p><h3>Демонстрационная история</h3><ul>'+d.history.map(h=>'<li>'+esc(h.at)+' — '+esc(h.text)+'</li>').join("")+'</ul>';$("details").showModal()});$("close").onclick=()=>$("details").close();render();
</script></body></html>`;
const security={"Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'","X-Frame-Options":"DENY","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
http.createServer((req,res)=>{
  if(!authorized(req)){res.writeHead(401,{...security,"WWW-Authenticate":'Basic realm="TOP-SENS Sales"'});return res.end("Authentication required")}
  if(req.method!=="GET"){res.writeHead(405,{...security,Allow:"GET"});return res.end()}
  if(req.url==="/sales"){res.writeHead(200,{...security,"Content-Type":"text/html; charset=utf-8"});return res.end(html)}
  if(req.url==="/sales/status"){res.writeHead(200,{...security,"Content-Type":"application/json; charset=utf-8"});return res.end(JSON.stringify({ok:true,mode:"demo",crmConnected:false,demoDeals:demo.length}))}
  res.writeHead(404,security);res.end("Not found");
}).listen(port,"0.0.0.0",()=>console.log("TOP-SENS demo staging started"));
