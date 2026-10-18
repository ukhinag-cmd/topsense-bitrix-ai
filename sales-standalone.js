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

function demoScores(stage,qual,next,contact,stageDays){
 const riskFactors=[],prospectFactors=[],missing=[];
 const add=(a,text,points)=>a.push({text,points});
 if(contact===null)missing.push("время последнего контакта");
 if(stageDays===null)missing.push("дата перехода на стадию");
 if(next==="Не проверено")missing.push("подтверждение следующего действия");
 if(contact!==null){
  if(contact>21)add(riskFactors,"Контакта нет более 21 дня",30);else if(contact>7)add(riskFactors,"Контакта нет более 7 дней",15);
  if(contact<=7)add(prospectFactors,"Контакт за последние 7 дней",20);else if(contact<=14)add(prospectFactors,"Контакт за последние 14 дней",10);
 }
 if(stageDays!==null){if(stageDays>30)add(riskFactors,"На стадии более 30 дней",25);else if(stageDays>14)add(riskFactors,"На стадии более 14 дней",10)}
 if(next==="Просрочено")add(riskFactors,"Просрочено следующее действиео",25);
 if(next==="Запланировано")add(prospectFactors,"Следующее действие запланировано",20);
 if(qual==="Не квалифицировано")add(riskFactors,"Квалификация не пройдена",15);
 if(qual==="На проверке"){add(riskFactors,"Квалификация не завершена",8);add(prospectFactors,"Идёт квалификация",10)}
 if(qual==="Квалифицировано")add(prospectFactors,"Квалификация подтверждена",30);
 const stagesScore={"Новая":0,"Квалификация":10,"Переговоры":18,"Коммерческое предложение":25,"Согласование":30};
 if(stagesScore[stage]>0)add(prospectFactors,"Стадия «"+stage+"»",stagesScore[stage]);
 const sum=a=>a.reduce((t,v)=>t+v.points,0);
 return {risk:missing.length?null:sum(riskFactors),prospect:missing.length?null:sum(prospectFactors),riskFactors,prospectFactors,missing};
}
const demo = clients.map((client, i) => {
  const days = [-9, -2, 0, 1, 3, 7, 14][i % 7];
  const nextStatus = i % 6 === 0 ? "Не проверено" : days < 0 ? "Просрочено" : "Запланировано";
  const currency = ["RUB", "RUB", "USD", "EUR"][i % 4];
  const stage=stages[i%stages.length],qualification=["Квалифицировано","Не квалифицировано","На проверке"][i%3];
  const contact=[2,10,25,4,14,null,30,5,18,3,8,26,1,15,null,9,24,6][i];
  const stageDays=[5,18,34,4,14,9,45,8,24,3,17,33,6,36,20,null,32,2][i];
  const scored=demoScores(stage,qualification,nextStatus,contact,stageDays);
  return { id: 1001 + i, client, name: ["Поставка оборудования", "Сервисный контракт", "Запрос КП", "Модернизация проекта"][i % 4], manager: managers[i % managers.length], stage, amount: (i + 2) * 85000, currency, ...scored, qualification, contact, stageDays, nextStatus, due: new Date(Date.UTC(2026, 9, 18 + days)).toISOString().slice(0, 10), history: [{at:"2026-10-14",text:"Создана демонстрационная сделка"},{at:"2026-10-16",text:"Проверка коммерческого предложения"}] };
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
:root{font-family:system-ui,-apple-system,sans-serif;color:#142333;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}header{background:#102d43;color:#fff;padding:22px clamp(16px,4vw,56px)}h1{font-size:24px;margin:0}header p{margin:5px 0 0;color:#cfe1ee}.wrap{max-width:1480px;margin:auto;padding:24px clamp(12px,3vw,40px)}.banner{background:#fff4db;color:#825000;border:1px solid #f0d394;padding:12px 16px;border-radius:10px;font-weight:700;margin-bottom:16px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}.card,.panel{background:white;border:1px solid #e1e7ee;border-radius:12px;padding:17px;box-shadow:0 2px 8px #162c3b09}.card span{color:#607181;font-size:13px}.card strong{display:block;font-size:27px;margin-top:5px}.panel{margin-bottom:20px}h2{font-size:18px;margin:0 0 14px}.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:14px}input,select{width:100%;padding:10px;border:1px solid #cdd7e1;border-radius:8px;background:white;color:#132e40}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;min-width:1000px}th,td{padding:12px 10px;border-bottom:1px solid #ecf0f4;text-align:left}th{background:#f0f5f8;color:#425568;white-space:nowrap}tr:hover{background:#f8fbfd}button{cursor:pointer;border:1px solid #bed0dd;border-radius:7px;background:#fff;padding:7px 9px;color:#144364}button:hover{background:#eaf4fc}.pill{padding:4px 7px;border-radius:7px;font-weight:700;display:inline-block}.good{background:#e7f7ee;color:#167047}.mid{background:#fff4d7;color:#815e06}.bad{background:#ffe9e9;color:#ad3030}.muted{background:#eff1f5;color:#5c6772}dialog{border:0;border-radius:14px;max-width:620px;width:calc(100% - 20px);padding:25px;box-shadow:0 20px 80px #102d4355}dialog::backdrop{background:#0b263b88}.dialogtop{display:flex;justify-content:space-between;align-items:center}.modebar{display:flex;gap:9px;margin-bottom:16px;flex-wrap:wrap}.modebar button{font-weight:700;padding:11px 16px}.modebar button.active{background:#144364;color:white;border-color:#144364}.focus{margin:0 0 16px;padding:14px 18px;background:#eaf4fc;border:1px solid #bbd9ef;border-radius:10px;color:#15415d}.foot{color:#657889;font-size:12px}ul{line-height:1.9}@media(max-width:550px){h1{font-size:21px}.wrap{padding:12px}.card strong{font-size:23px}}
.insight-table{overflow-x:auto}.insight-table table{min-width:780px}.insight-label{font-weight:700}.insight-hint{font-size:12px;color:#607181;margin:0 0 12px}.insight-heading{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}.insight-heading h2{margin-bottom:8px}.insight-action{color:#16466a}.insight-empty{background:#f4f8fa;border-radius:8px;padding:14px}.missing-data{background:#fff4db;color:#825000;padding:10px;border-radius:8px}</style></head><body><header><h1>TOP-SENS / Sales Control</h1><p>Панель коммерческого директора · демонстрационная версия</p></header><main class="wrap"><div class="banner">ДЕМО — данные вымышленные. Bitrix24 не подключён, оценки не являются реальной аналитикой.</div><nav class="modebar" aria-label="Режим панели"><button type="button" id="ownerMode" class="active" aria-pressed="true">Собственник</button><button type="button" id="ropMode" aria-pressed="false">РОП</button></nav><div class="focus" id="modeFocus" role="status"></div><section class="cards" id="kpis"></section><section class="panel" id="insights" aria-label="Приоритеты режима"></section><section class="panel"><h2>Сделки и контроль действий</h2><div class="filters"><input id="search" placeholder="Поиск клиента или сделки" aria-label="Поиск"><select id="manager" aria-label="Менеджер"><option value="">Все менеджеры</option></select><select id="stage" aria-label="Стадия"><option value="">Все стадии</option></select><select id="risk" aria-label="Риск"><option value="">Любой риск</option><option value="high">Высокий (≥ 60)</option><option value="low">Низкий (&lt; 60)</option><option value="unknown">Недостаточно данных</option></select><select id="next" aria-label="Следующий шаг"><option value="">Любое следующее действие</option><option>Просрочено</option><option>Запланировано</option><option>Не проверено</option></select><select id="sort" aria-label="Сортировка"><option value="risk">Сначала риск</option><option value="prospect">Сначала перспективные</option><option value="amount">Сначала крупные</option><option value="due">По сроку следующего действия</option></select></div><p class="insight-hint">Баллы демонстрационные, не являются процентом вероятности. Причины каждого балла — в карточке сделки.</p><div class="scroll"><table><thead><tr><th>Клиент / сделка</th><th>Менеджер</th><th>Стадия</th><th>Сумма</th><th>Перспективность</th><th>Риск потери</th><th>Квалификация</th><th>Следующее действие</th><th>Детали</th></tr></thead><tbody id="rows"></tbody></table></div><p class="foot" id="count"></p></section><p class="foot">Демо-данные существуют только в коде и браузере; изменений CRM и отправки писем нет.</p></main><dialog id="details"><div class="dialogtop"><h2 id="detailTitle">Сделка</h2><button id="close">Закрыть</button></div><div id="detailBody"></div></dialog><script>
"use strict";
const deals=${safeJson};
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let mode="owner";
const priorities=d=>d.nextStatus==="Просрочено"?4:d.risk!==null&&d.risk>=60?3:d.risk===null?2:d.qualification!=="Квалифицировано"?1:0;
function setMode(nextMode){mode=nextMode;for(const [id,active] of [["ownerMode",mode==="owner"],["ropMode",mode==="rop"]]){$(id).classList.toggle("active",active);$(id).setAttribute("aria-pressed",String(active))}render()}
$("ownerMode").addEventListener("click",()=>setMode("owner"));
$("ropMode").addEventListener("click",()=>setMode("rop"));
const money=d=>new Intl.NumberFormat("ru-RU",{maximumFractionDigits:0}).format(d.amount)+" "+d.currency;
const color=(v,reverse=false)=>v===null?"muted":v>=70?(reverse?"bad":"good"):v>=45?"mid":(reverse?"good":"muted");
for(const [id,values] of [["manager",[...new Set(deals.map(d=>d.manager))]],["stage",[...new Set(deals.map(d=>d.stage))]]])for(const value of values){const o=document.createElement("option");o.value=value;o.textContent=value;$(id).append(o)}
function current(){const q=$("search").value.toLocaleLowerCase("ru");const m=$("manager").value,s=$("stage").value,r=$("risk").value,n=$("next").value;let a=deals.filter(d=>(d.client+" "+d.name).toLocaleLowerCase("ru").includes(q)&&(!m||d.manager===m)&&(!s||d.stage===s)&&(!r||(r==="unknown"?d.risk===null:r==="high"?d.risk!==null&&d.risk>=60:d.risk!==null&&d.risk<60))&&(!n||d.nextStatus===n));const field=$("sort").value;a.sort((x,y)=>mode==="rop"&&field==="risk"?(priorities(y)-priorities(x)||(y.risk??-1)-(x.risk??-1)):field==="due"?x.due.localeCompare(y.due):(y[field]??-1)-(x[field]??-1));return a}

const scoreText=v=>v===null?"Недостаточно данных":String(v)+"/100";
const factors=a=>a.length?'<ul>'+a.map(f=>'<li>'+esc(f.text)+' <strong>+'+f.points+'</strong></li>').join("")+'</ul>':'<p>Дополнительных баллов по учебным правилам нет.</p>';
function explainDemo(d){
 const why=[],actions=[];
 if(d.nextStatus==="Просрочено"){why.push("Просрочено следующее действие");actions.push("Согласовать новую дату с менеджером")}
 if(d.nextStatus==="Не проверено"){why.push("Следующее действие не подтверждено");actions.push("Проверить наличие и дату активности")}
 if(d.risk===null){why.push("Недостаточно данных: "+d.missing.join(", "));actions.push("Уточнить недостающие данные")}
 else if(d.risk>=60){why.push("Высокий риск: "+d.riskFactors.map(f=>f.text+" (+"+f.points+")").join("; "));actions.push("Разобрать с менеджером причины риска")}
 if(d.qualification!=="Квалифицировано"){why.push("Не подтверждена квалификация");actions.push("Уточнить потребность клиента")}
 return {why,actions};
}
function scoreDetails(d){
 const gap=d.missing.length?'<p class="missing-data">Недостаточно данных для итогового балла: '+esc(d.missing.join(", "))+'</p>':'';
 return '<p>ДЕМО: баллы рассчитаны по вымышленным признакам; это не вероятность выигрыша или потери сделки.</p>'+gap+
 '<h3>Риск потери: '+esc(scoreText(d.risk))+'</h3>'+factors(d.riskFactors)+
 '<h3>Перспективность: '+esc(scoreText(d.prospect))+'</h3>'+factors(d.prospectFactors)+
 '<h3>Что проверить РОПу</h3><ul>'+explainDemo(d).actions.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul>';
}
function renderInsights(a){
 const el=$("insights");
 if(mode==="owner"){
   const names=[...new Set(a.map(d=>d.manager))];
   const managersView=names.map(name=>{
     const items=a.filter(d=>d.manager===name);
     const totals={};
     for(const d of items)totals[d.currency]=(totals[d.currency]||0)+d.amount;
     return {name,total:items.length,high:items.filter(d=>d.risk!==null&&d.risk>=60).length,overdue:items.filter(d=>d.nextStatus==="Просрочено").length,prospect:items.filter(d=>d.prospect>=70).length,amounts:Object.entries(totals).map(([c,v])=>new Intl.NumberFormat("ru-RU").format(v)+" "+c).join(" · ")};
   });
   managersView.sort((x,y)=>x.overdue-y.overdue||x.high-y.high||y.prospect-x.prospect||x.name.localeCompare(y.name,"ru"));
   el.innerHTML='<div class="insight-heading"><h2>Сводка по менеджерам</h2></div><p class="insight-hint">Условная сортировка по дисциплине: меньше просрочек и высоких рисков — выше в списке. Это демонстрация, не реальная оценка сотрудников.</p><div class="insight-table"><table><thead><tr><th>Менеджер</th><th>Сделок</th><th>Просрочки</th><th>Высокий риск</th><th>Перспективные</th><th>Суммы по валютам</th></tr></thead><tbody>'+
     managersView.map(m=>'<tr><td class="insight-label">'+esc(m.name)+'</td><td>'+m.total+'</td><td>'+m.overdue+'</td><td>'+m.high+'</td><td>'+m.prospect+'</td><td>'+esc(m.amounts)+'</td></tr>').join("")+
     '</tbody></table></div>';
 }else{
   const todo=a.filter(d=>explainDemo(d).why.length>0).sort((x,y)=>priorities(y)-priorities(x)||(y.risk??-1)-(x.risk??-1)||x.id-y.id);
   el.innerHTML='<div class="insight-heading"><h2>Очередь разбора для РОПа</h2></div><p class="insight-hint">Сначала просрочки Следующее действие, затем высокий риск и вопросы квалификации. Статус «Не проверено» не означает отсутствие действия.</p>'+
   (todo.length?'<div class="insight-table"><table><thead><tr><th>Сделка</th><th>Менеджер</th><th>Почему требует внимания</th><th>Рекомендуемое действие</th></tr></thead><tbody>'+
     todo.map(d=>{const info=explainDemo(d);return '<tr><td class="insight-label">'+esc(d.client)+" — "+esc(d.name)+'</td><td>'+esc(d.manager)+'</td><td>'+esc(info.why.join("; "))+'</td><td class="insight-action">'+esc(info.actions.join("; "))+'</td></tr>'}).join("")+
     '</tbody></table></div>':'<p class="insight-empty">В текущей выборке нет демонстрационных проблемных сделок.</p>');
 }
}
function render(){const a=current();$("modeFocus").textContent=mode==="owner"?"Собственник: обзор воронки, перспективных сделок и финансовых рисков. Все показатели — демонстрационные.":"РОП: ежедневная очередь контроля. Сначала просроченные Следующее действие, затем высокий риск и неполная квалификация. По умолчанию сортировка по приоритету.";const totals={};for(const d of a)totals[d.currency]=(totals[d.currency]||0)+d.amount;const cells=[[mode==="owner"?"Сделок в выборке":"Сделок для разбора",a.length],["Сумма по валютам",Object.entries(totals).map(([c,v])=>new Intl.NumberFormat("ru-RU").format(v)+" "+c).join(" · ")||"—"],["Перспективные (≥ 70)",a.filter(d=>d.prospect!==null&&d.prospect>=70).length],["Высокий риск (≥ 60)",a.filter(d=>d.risk!==null&&d.risk>=60).length],["Просрочено следующее действие",a.filter(d=>d.nextStatus==="Просрочено").length]];cells.push(["Недостаточно данных",a.filter(d=>d.risk===null).length]);if(mode==="rop")cells.push(["Нужна квалификация",a.filter(d=>d.qualification!=="Квалифицировано").length]);$("kpis").innerHTML=cells.map(([l,v])=>'<div class="card"><span>'+esc(l)+'</span><strong>'+esc(v)+'</strong></div>').join("");$("rows").innerHTML=a.map(d=>'<tr><td><strong>'+esc(d.client)+'</strong><br>'+esc(d.name)+'</td><td>'+esc(d.manager)+'</td><td>'+esc(d.stage)+'</td><td>'+esc(money(d))+'</td><td><span class="pill '+color(d.prospect)+'">'+esc(scoreText(d.prospect))+'</span></td><td><span class="pill '+color(d.risk,true)+'">'+esc(scoreText(d.risk))+'</span></td><td>'+esc(d.qualification)+'</td><td><span class="pill '+(d.nextStatus==="Просрочено"?"bad":d.nextStatus==="Не проверено"?"muted":"good")+'">'+esc(d.nextStatus)+'</span><br>'+esc(d.due)+'</td><td><button data-id="'+d.id+'">Открыть</button></td></tr>').join("");$("count").textContent="Показано "+a.length+" из "+deals.length+" демонстрационных сделок";renderInsights(a)}
for(const id of ["search","manager","stage","risk","next","sort"])$(id).addEventListener(id==="search"?"input":"change",render);
$("rows").addEventListener("click",e=>{const b=e.target.closest("button[data-id]");if(!b)return;const d=deals.find(x=>x.id===Number(b.dataset.id));if(!d)return;$("detailTitle").textContent=d.client+" — "+d.name;$("detailBody").innerHTML='<p><strong>Менеджер:</strong> '+esc(d.manager)+'</p><p><strong>Стадия:</strong> '+esc(d.stage)+'</p><p><strong>Сумма:</strong> '+esc(money(d))+'</p><p><strong>Перспективность / Риск потери:</strong> '+esc(scoreText(d.prospect))+' / '+esc(scoreText(d.risk))+'</p><p><strong>Следующее действие:</strong> '+esc(d.nextStatus)+' ('+esc(d.due)+')</p><h3>Демонстрационная история</h3><ul>'+d.history.map(h=>'<li>'+esc(h.at)+' — '+esc(h.text)+'</li>').join("")+'</ul>'+scoreDetails(d);$("details").showModal()});$("close").onclick=()=>$("details").close();render();
</script></body></html>`;
const security={"Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'","X-Frame-Options":"DENY","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
http.createServer((req,res)=>{
  if(!authorized(req)){res.writeHead(401,{...security,"WWW-Authenticate":'Basic realm="TOP-SENS Sales"'});return res.end("Authentication required")}
  if(req.method!=="GET"){res.writeHead(405,{...security,Allow:"GET"});return res.end()}
  if(req.url==="/sales"){res.writeHead(200,{...security,"Content-Type":"text/html; charset=utf-8"});return res.end(html)}
  if(req.url==="/sales/status"){res.writeHead(200,{...security,"Content-Type":"application/json; charset=utf-8"});return res.end(JSON.stringify({ok:true,mode:"demo",crmConnected:false,demoDeals:demo.length}))}
  res.writeHead(404,security);res.end("Not found");
}).listen(port,"0.0.0.0",()=>console.log("TOP-SENS demo staging started"));
