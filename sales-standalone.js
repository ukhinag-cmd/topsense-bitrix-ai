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


const QUAL_CRITERIA=[
 {key:"need",name:"Потребность клиента",weight:20},
 {key:"fit",name:"Соответствие решения",weight:15},
 {key:"budget",name:"Бюджет",weight:15},
 {key:"decision",name:"Лицо, принимающее решение",weight:15},
 {key:"timing",name:"Срок закупки",weight:10},
 {key:"process",name:"Процесс выбора поставщика",weight:10},
 {key:"evidence",name:"Подтверждение сведений",weight:15}
];
function qualificationDemo(i){
 const criteria=QUAL_CRITERIA.map((criterion,j)=>{
   const k=(i*2+j*3)%7;
   let state=k===0?"нет данных":k===1||k===2?"частично":"подтверждено";
   if([1,3,7,8,11,13,16].includes(i)&&["fit","budget","decision"].includes(criterion.key))state="подтверждено";
   const points=state==="подтверждено"?criterion.weight:state==="частично"?Math.floor(criterion.weight/2):0;
   let finding=state==="нет данных"?"Сведения не установлены":state==="частично"?"Требуется подтверждение клиента":"Сведения подтверждены клиентом (демо)";
   if(j===2&&state==="подтверждено")finding=i%6===1?"Клиент подтвердил отсутствие бюджета (демо)":"Клиент подтвердил наличие бюджета (демо)";
   return {...criterion,state,points,finding};
 });
 return {qualificationCriteria:criteria,qualificationScore:criteria.reduce((t,c)=>t+c.points,0)};
}
function scoreDemo({stage,nextStatus,contact,stageDays,qualificationCriteria,i}){
 const disciplineFactors=[],commercialFactors=[],prospectFactors=[],disciplineMissing=[],commercialMissing=[];
 const add=(arr,text,points)=>arr.push({text,points});
 const budget=qualificationCriteria.find(c=>c.key==="budget");
 const decision=qualificationCriteria.find(c=>c.key==="decision");
 const fit=qualificationCriteria.find(c=>c.key==="fit");
 // Процессные нарушения оцениваются отдельно от реакции клиента.
 if(contact===null)disciplineMissing.push("сведения о последнем контакте");
 else if(contact>21)add(disciplineFactors,"Контакт не зафиксирован более 21 дня",25);
 else if(contact>7)add(disciplineFactors,"Контакт не зафиксирован более 7 дней",15);
 if(nextStatus==="Просрочено")add(disciplineFactors,"Следующее действие просрочено",35);
 else if(nextStatus==="Не проверено")add(disciplineFactors,"Следующее действие не подтверждено",20);
 const discipline=disciplineMissing.length?null:Math.max(0,100-disciplineFactors.reduce((sum,f)=>sum+f.points,0));
 // Коммерческий риск: клиент, бюджет, решение о покупке и срок стадии.
 // Просрочка менеджера НЕ включается, чтобы не смешивать две оценки.
 if(budget.state!=="подтверждено")commercialMissing.push("бюджет клиента");
 else if(i%6===1)add(commercialFactors,"Клиент подтвердил отсутствие бюджета",35);
 if(decision.state!=="подтверждено")commercialMissing.push("процесс принятия решения");
 else if(i%4===0)add(commercialFactors,"Лицо, принимающее решение, не вовлечено",20);
 if(fit.state!=="подтверждено")commercialMissing.push("соответствие решения требованиям");
 else if(i%7===3)add(commercialFactors,"Решение не полностью соответствует запросу клиента",20);
 if(contact===null)commercialMissing.push("активность клиента");
 else if(i%4===2||[1,7,13].includes(i))add(commercialFactors,"Клиент слабо отвечает на коммуникации (демо)",25);
 if(stageDays===null)commercialMissing.push("длительность текущей стадии");
 else if(stageDays>30)add(commercialFactors,"На стадии более 30 дней",20);
 else if(stageDays>14)add(commercialFactors,"На стадии более 14 дней",10);
 if(i%5===4)add(commercialFactors,"Высокое конкурентное давление (демо)",15);
 const risk=commercialMissing.length?null:Math.min(100,commercialFactors.reduce((sum,f)=>sum+f.points,0));
 // Перспективность: положительные коммерческие сигналы, а не дисциплина.
 if(budget.state==="подтверждено"&&i%6!==1)add(prospectFactors,"Бюджет подтверждён",30);
 if(decision.state==="подтверждено"&&i%4!==0)add(prospectFactors,"Есть доступ к лицу, принимающему решение",25);
 if(fit.state==="подтверждено"&&i%7!==3)add(prospectFactors,"Решение соответствует запросу",25);
 if(stage==="Коммерческое предложение"||stage==="Согласование")add(prospectFactors,"Сделка на продвинутой стадии",20);
 const prospect=commercialMissing.length?null:prospectFactors.reduce((sum,f)=>sum+f.points,0);
 return {discipline,disciplineFactors,disciplineMissing,risk,riskFactors:commercialFactors,missing:commercialMissing,prospect,prospectFactors};
}
// Load-test fixture: 240 entirely fictional active deals.
const demo=Array.from({length:240},(_,i)=>{
 const client=clients[i%clients.length]+" (демо "+(Math.floor(i/clients.length)+1)+")";
 const createdDaysAgo=(i*11)%540;
 const createdAt=new Date(Date.now()-createdDaysAgo*86400000).toISOString().slice(0,10);
 const days=[-9,-2,0,1,3,7,14][i%7];
 const nextStatus=i%6===0?"Не проверено":days<0?"Просрочено":"Запланировано";
 const currency=["RUB","RUB","USD","EUR"][i%4];
 const stage=stages[i%stages.length];
 const contact=[2,10,25,4,14,null,30,5,18,3,8,26,1,15,null,9,24,6][i%18];
 const stageDays=[5,18,34,4,14,9,45,8,24,3,17,33,6,36,20,null,32,2][i%18];
 const q=qualificationDemo(i);
 const scores=scoreDemo({stage,nextStatus,contact,stageDays,qualificationCriteria:q.qualificationCriteria,i});
 const qualification=q.qualificationScore>=85?"Данные собраны":q.qualificationScore>=60?"Не полностью":"Требует уточнения";
 return {
   id:1001+i,client,name:["Поставка оборудования","Сервисный контракт","Запрос КП","Модернизация проекта"][i%4],
   manager:managers[i%managers.length],stage,amount:((i%22)+2)*85000,currency,createdAt,
   ...q,...scores,qualification,contact,stageDays,nextStatus,
   due:new Date(Date.UTC(2026,9,18+days)).toISOString().slice(0,10),
   history:[{at:"2026-10-14",text:"Создана демонстрационная сделка"},{at:"2026-10-16",text:"Проверка коммерческого предложения"}]
 };
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
:root{font-family:system-ui,-apple-system,sans-serif;color:#142333;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}header{background:#102d43;color:#fff;padding:22px clamp(16px,4vw,56px)}h1{font-size:24px;margin:0}header p{margin:5px 0 0;color:#cfe1ee}.wrap{max-width:1480px;margin:auto;padding:24px clamp(12px,3vw,40px)}.banner{background:#fff4db;color:#825000;border:1px solid #f0d394;padding:12px 16px;border-radius:10px;font-weight:700;margin-bottom:16px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px;margin-bottom:20px}.card,.panel{background:white;border:1px solid #e1e7ee;border-radius:12px;padding:17px;box-shadow:0 2px 8px #162c3b09}.card span{color:#607181;font-size:13px}.card strong{display:block;font-size:27px;margin-top:5px}.card{min-width:0}.currency-card{grid-column:1/-1;display:flex;align-items:center;gap:16px 32px;flex-wrap:wrap;padding:13px 17px;min-height:62px}.currency-card .currency-title{font-weight:600;white-space:nowrap}.currency-values{display:flex;align-items:center;gap:10px 28px;flex-wrap:wrap}.currency-value{display:inline-flex;gap:6px;align-items:baseline;white-space:nowrap}.currency-value strong{display:inline;font-size:16px;line-height:1.3;margin:0;font-weight:750}.currency-value span{font-size:12px;font-weight:600}.currency-empty{font-size:14px;color:#607181}.panel{margin-bottom:20px}h2{font-size:18px;margin:0 0 14px}.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:14px}input,select{width:100%;padding:10px;border:1px solid #cdd7e1;border-radius:8px;background:white;color:#132e40}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;min-width:1340px}th,td{padding:12px 10px;border-bottom:1px solid #ecf0f4;text-align:left}th{background:#f0f5f8;color:#425568;white-space:nowrap}tr:hover{background:#f8fbfd}button{cursor:pointer;border:1px solid #bed0dd;border-radius:7px;background:#fff;padding:7px 9px;color:#144364}button:hover{background:#eaf4fc}.pill{padding:4px 7px;border-radius:7px;font-weight:700;display:inline-block}.good{background:#e7f7ee;color:#167047}.mid{background:#fff4d7;color:#815e06}.bad{background:#ffe9e9;color:#ad3030}.muted{background:#eff1f5;color:#5c6772}dialog{border:0;border-radius:14px;max-width:620px;width:calc(100% - 20px);padding:25px;box-shadow:0 20px 80px #102d4355}dialog::backdrop{background:#0b263b88}.dialogtop{display:flex;justify-content:space-between;align-items:center}.modebar{display:flex;gap:9px;margin-bottom:16px;flex-wrap:wrap}.modebar button{font-weight:700;padding:11px 16px}.modebar button.active{background:#144364;color:white;border-color:#144364}.focus{margin:0 0 16px;padding:14px 18px;background:#eaf4fc;border:1px solid #bbd9ef;border-radius:10px;color:#15415d}.foot{color:#657889;font-size:12px}ul{line-height:1.9}@media(max-width:550px){h1{font-size:21px}.wrap{padding:12px}.card strong{font-size:23px}}
.insight-table{overflow-x:auto}.insight-table table{min-width:780px}.insight-label{font-weight:700}.insight-hint{font-size:12px;color:#607181;margin:0 0 12px}.insight-heading{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}.insight-heading h2{margin-bottom:8px}.insight-action{color:#16466a}.insight-empty{background:#f4f8fa;border-radius:8px;padding:14px}.missing-data{background:#fff4db;color:#825000;padding:10px;border-radius:8px}.pager{display:flex;justify-content:flex-end;align-items:center;gap:12px;flex-wrap:wrap;padding-top:14px}.pager button:disabled{opacity:.45;cursor:not-allowed}.pager span{font-size:13px;color:#455968}</style></head><body><header><h1>TOP-SENS / Sales Control</h1><p>Панель коммерческого директора · демонстрационная версия</p></header><main class="wrap"><div class="banner">ДЕМО — данные вымышленные. Bitrix24 не подключён, оценки не являются реальной аналитикой.</div><nav class="modebar" aria-label="Режим панели"><button type="button" id="ownerMode" class="active" aria-pressed="true">Собственник</button><button type="button" id="ropMode" aria-pressed="false">РОП</button></nav><div class="focus" id="modeFocus" role="status"></div><section class="cards" id="kpis"></section><section class="panel" id="insights" aria-label="Приоритеты режима"></section><section class="panel"><h2>Сделки и контроль действий</h2><p class="insight-hint">По умолчанию показаны все активные сделки, даже старые. Фильтр периода ограничивает дату создания. Все сведения — вымышленные.</p><p class="insight-hint">Два независимых показателя: коммерческий риск — угроза сделке, дисциплина — выполнение действий менеджером. Качество квалификации оценивает полноту подтверждённых сведений, а не вероятность покупки.</p><div class="filters"><select id="period" aria-label="Период создания"><option value="all">Все активные сделки</option><option value="30">Созданы за 30 дней</option><option value="90">Созданы за 90 дней</option><option value="365">Созданы за 365 дней</option></select><input id="search" placeholder="Поиск клиента или сделки" aria-label="Поиск"><select id="manager" aria-label="Менеджер"><option value="">Все менеджеры</option></select><select id="stage" aria-label="Стадия"><option value="">Все стадии</option></select><select id="risk" aria-label="Коммерческий риск"><option value="">Любой риск</option><option value="high">Высокий (≥ 60)</option><option value="low">Низкий (&lt; 60)</option><option value="unknown">Недостаточно данных</option></select><select id="discipline" aria-label="Дисциплина менеджера"><option value="">Любая дисциплина</option><option value="low">Ниже 60</option><option value="unknown">Недостаточно данных</option></select><select id="quality" aria-label="Качество квалификации"><option value="">Любое качество квалификации</option><option value="low">Ниже 70</option><option value="high">70 и выше</option></select><select id="next" aria-label="Следующий шаг"><option value="">Любое следующее действие</option><option>Просрочено</option><option>Запланировано</option><option>Не проверено</option></select><select id="sort" aria-label="Сортировка"><option value="risk">Сначала риск</option><option value="prospect">Сначала перспективные</option><option value="amount">Сначала крупные</option><option value="due">По сроку следующего действия</option></select></div><p class="insight-hint">Все оценки учебные, по вымышленным сведениям. Нажмите «Открыть», чтобы увидеть расчёт и подтверждение критериев.</p><div class="scroll"><table><thead><tr><th>Клиент / сделка</th><th>Менеджер</th><th>Стадия</th><th>Сумма</th><th>Перспективность</th><th>Коммерческий риск</th><th>Дисциплина</th><th>Качество квалификации</th><th>Дата создания</th><th>Следующее действие</th><th>Детали</th></tr></thead><tbody id="rows"></tbody></table></div><div class="pager"><button id="prevPage" type="button">← Назад</button><span id="pageInfo" aria-live="polite"></span><button id="nextPage" type="button">Вперёд →</button></div><p class="foot" id="count"></p></section><p class="foot">Демо-данные существуют только в коде и браузере; изменений CRM и отправки писем нет.</p></main><dialog id="details"><div class="dialogtop"><h2 id="detailTitle">Сделка</h2><button id="close">Закрыть</button></div><div id="detailBody"></div></dialog><script>

"use strict";
const deals=${safeJson};
const $=id=>document.getElementById(id);
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const score=v=>v===null?"Недостаточно данных":String(v)+"/100";
const cssScore=(v,badHigh=false)=>v===null?"muted":badHigh?(v>=60?"bad":v>=35?"mid":"good"):(v>=80?"good":v>=60?"mid":"bad");
const money=d=>new Intl.NumberFormat("ru-RU",{maximumFractionDigits:0}).format(d.amount)+" "+d.currency;
let mode="owner";
const PAGE_SIZE=50;let page=1;
const priorities=d=>(d.nextStatus==="Просрочено"?5:0)+(d.discipline!==null&&d.discipline<60?4:0)+(d.risk!==null&&d.risk>=60?3:0)+(d.qualificationScore<70?2:0)+(d.risk===null||d.discipline===null?1:0);
function setMode(nextMode){mode=nextMode;page=1;for(const [id,on] of [["ownerMode",mode==="owner"],["ropMode",mode==="rop"]]){$(id).classList.toggle("active",on);$(id).setAttribute("aria-pressed",String(on))}render()}
$("ownerMode").addEventListener("click",()=>setMode("owner"));
$("ropMode").addEventListener("click",()=>setMode("rop"));
for(const [id,vals] of [["manager",[...new Set(deals.map(d=>d.manager))]],["stage",[...new Set(deals.map(d=>d.stage))]]])
 for(const value of vals){const o=document.createElement("option");o.value=value;o.textContent=value;$(id).append(o)}
function current(){
 const query=$("search").value.toLocaleLowerCase("ru"),manager=$("manager").value,stage=$("stage").value;
 const risk=$("risk").value,discipline=$("discipline").value,quality=$("quality").value,next=$("next").value,period=$("period").value;
 const a=deals.filter(d=>(d.client+" "+d.name).toLocaleLowerCase("ru").includes(query)
  &&(!manager||manager===d.manager)&&(!stage||stage===d.stage)
  &&(!risk||(risk==="unknown"?d.risk===null:risk==="high"?d.risk!==null&&d.risk>=60:d.risk!==null&&d.risk<60))
  &&(!discipline||(discipline==="unknown"?d.discipline===null:d.discipline!==null&&d.discipline<60))
  &&(!quality||(quality==="low"?d.qualificationScore<70:d.qualificationScore>=70))
  &&(!next||d.nextStatus===next)
  &&(period==="all"||(Date.now()-new Date(d.createdAt+"T00:00:00Z").getTime())/86400000<=Number(period)));
 const sort=$("sort").value;
 a.sort((x,y)=>mode==="rop"&&sort==="risk"?(priorities(y)-priorities(x)||((y.risk??-1)-(x.risk??-1))):
  sort==="due"?x.due.localeCompare(y.due):((y[sort]??-1)-(x[sort]??-1)));
 return a;
}
function factors(items,negative=false){
 return items.length?'<ul>'+items.map(f=>'<li>'+esc(f.text)+' <strong>'+(negative?"−":"+")+f.points+'</strong></li>').join("")+'</ul>':
 '<p>По учебным правилам дополнительные баллы не начислены.</p>';
}
function reasons(d){
 const out=[],actions=[];
 if(d.discipline===null){out.push("Недостаточно данных о дисциплине: "+d.disciplineMissing.join(", "));actions.push("Проверить записи о контактах")}
 else if(d.discipline<60){out.push("Нарушения процесса: "+d.disciplineFactors.map(f=>f.text+" (−"+f.points+")").join("; "));actions.push("Проверить своевременность действий менеджера")}
 if(d.risk===null){out.push("Не оценён коммерческий риск: "+d.missing.join(", "));actions.push("Уточнить коммерческие сведения")}
 else if(d.risk>=60){out.push("Коммерческий риск: "+d.riskFactors.map(f=>f.text+" (+"+f.points+")").join("; "));actions.push("Проверить препятствия для покупки")}
 if(d.qualificationScore<70){out.push("Недостаточно качественная квалификация: "+d.qualificationScore+"/100");actions.push("Выяснить и подтвердить недостающие критерии")}
 if(d.nextStatus==="Просрочено"&&d.discipline===null)actions.push("Согласовать новый срок следующего действия");
 return {out,actions:[...new Set(actions)]};
}
function scoreDetails(d){
 const qual='<h3>Качество квалификации: '+d.qualificationScore+'/100</h3><p>Высокий балл означает полноту и подтверждение сведений, а не высокую вероятность покупки. Подтверждённое отсутствие бюджета даёт баллы за качество выяснения.</p>'+
 '<div class="insight-table"><table class="qual-table"><thead><tr><th>Критерий</th><th>Подтверждение</th><th>Результат</th><th>Баллы</th></tr></thead><tbody>'+
 d.qualificationCriteria.map(q=>'<tr><td>'+esc(q.name)+'</td><td>'+esc(q.state)+'</td><td>'+esc(q.finding)+'</td><td>'+q.points+'/'+q.weight+'</td></tr>').join("")+'</tbody></table></div>';
 const comm='<h3>Коммерческий риск: '+esc(score(d.risk))+'</h3>'+
 (d.missing.length?'<p class="missing-data">Невозможно выставить итоговую оценку: '+esc(d.missing.join(", "))+'</p>':'')+
 factors(d.riskFactors);
 const dis='<h3>Дисциплина менеджера: '+esc(score(d.discipline))+'</h3><p>100 — своевременная работа по учебным правилам; снижение балла означает сигналы, требующие проверки РОПом, а не доказанную вину.</p>'+
 (d.disciplineMissing.length?'<p class="missing-data">Недостаточно данных: '+esc(d.disciplineMissing.join(", "))+'</p>':'')+
 factors(d.disciplineFactors,true);
 const prospect='<h3>Перспективность: '+esc(score(d.prospect))+'</h3>'+factors(d.prospectFactors);
 const act=reasons(d).actions;
 return '<p class="insight-hint">ДЕМО. Баллы основаны только на вымышленных данных. Ни одна оценка не является процентом вероятности потери или продажи.</p>'+comm+dis+qual+prospect+
 '<h3>Что делать РОПу</h3>'+(act.length?'<ul>'+act.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul>':'<p>Плановый контроль; тревожных сигналов по выбранным учебным правилам нет.</p>');
}
function renderInsights(a){
 const el=$("insights");
 if(mode==="owner"){
  const result=[...new Set(a.map(d=>d.manager))].map(manager=>{
   const ds=a.filter(d=>d.manager===manager),totals={};
   for(const d of ds)totals[d.currency]=(totals[d.currency]||0)+d.amount;
   return {manager,count:ds.length,commercial:ds.filter(d=>d.risk!==null&&d.risk>=60).length,
    discipline:ds.filter(d=>d.discipline!==null&&d.discipline<60).length,
    missing:ds.filter(d=>d.risk===null||d.discipline===null).length,
    quality:Math.round(ds.reduce((t,d)=>t+d.qualificationScore,0)/ds.length),
    amounts:Object.entries(totals).map(([cur,n])=>new Intl.NumberFormat("ru-RU").format(n)+" "+cur).join(" · ")};
  });
  result.sort((a,b)=>a.discipline-b.discipline||a.commercial-b.commercial||b.quality-a.quality);
  el.innerHTML='<h2>Обзор менеджеров: дисциплина и качество данных</h2><p class="insight-hint">Среднее качество квалификации и учебные сигналы по сделкам. Не является кадровой оценкой.</p>'+
  '<div class="insight-table"><table><thead><tr><th>Менеджер</th><th>Сделок</th><th>Высокий коммерческий риск</th><th>Низкая дисциплина</th><th>Недостаточно данных</th><th>Качество квалификации (среднее)</th><th>Суммы по валютам</th></tr></thead><tbody>'+
  result.map(x=>'<tr><td class="insight-label">'+esc(x.manager)+'</td><td>'+x.count+'</td><td>'+x.commercial+'</td><td>'+x.discipline+'</td><td>'+x.missing+'</td><td>'+x.quality+'/100</td><td>'+esc(x.amounts)+'</td></tr>').join("")+'</tbody></table></div>';
 }else{
  const attention=a.filter(d=>reasons(d).out.length).sort((x,y)=>priorities(y)-priorities(x)||x.id-y.id);
  const top=attention.slice(0,10);
  el.innerHTML='<h2>Очередь разбора РОПа</h2><p class="insight-hint">Первые 10 из '+attention.length+' проблемных сделок в выборке. Полный список ниже разбит на страницы. Отдельно показаны проблемы процесса, коммерческие препятствия и пробелы в квалификации.</p>'+
  (attention.length?'<div class="insight-table"><table><thead><tr><th>Клиент и сделка</th><th>Менеджер</th><th>Что обнаружено</th><th>Действие</th></tr></thead><tbody>'+
  top.map(d=>{const r=reasons(d);return '<tr><td class="insight-label">'+esc(d.client)+' — '+esc(d.name)+'</td><td>'+esc(d.manager)+'</td><td>'+esc(r.out.join("; "))+'</td><td>'+esc(r.actions.join("; "))+'</td></tr>'}).join("")+'</tbody></table></div>':
  '<p class="insight-empty">В этой выборке нет требующих разбора учебных сделок.</p>');
 }
}
function render(){
 const a=current(),totals={};for(const d of a)totals[d.currency]=(totals[d.currency]||0)+d.amount;
 const pages=Math.max(1,Math.ceil(a.length/PAGE_SIZE));page=Math.min(Math.max(page,1),pages);
 const start=(page-1)*PAGE_SIZE,visible=a.slice(start,start+PAGE_SIZE);
 $("modeFocus").textContent=mode==="owner"?
 "Собственник: коммерческие риски, дисциплина отдела, качество квалификации и суммы отдельно по валютам.":
 "РОП: три независимые проверки — коммерческие препятствия, дисциплина менеджера, достоверность квалификации.";
 const cells=[
 ["Сделок в выборке",a.length],
 ["Высокий коммерческий риск (≥ 60)",a.filter(d=>d.risk!==null&&d.risk>=60).length],
 ["Низкая дисциплина (< 60)",a.filter(d=>d.discipline!==null&&d.discipline<60).length],
 ["Среднее качество квалификации",a.length?Math.round(a.reduce((t,d)=>t+d.qualificationScore,0)/a.length)+"/100":"—"],
 ["Недостаточно данных",a.filter(d=>d.risk===null||d.discipline===null).length]];
 if(mode==="rop")cells.push(["Квалификация ниже 70",a.filter(d=>d.qualificationScore<70).length]);
 $("kpis").innerHTML=cells.map(([name,value])=>'<div class="card"><span>'+esc(name)+'</span><strong>'+esc(value)+'</strong></div>').join("")+
 '<div class="card currency-card"><span class="currency-title">Сумма по валютам</span><div class="currency-values">'+
 (Object.entries(totals).length?Object.entries(totals).map(([cur,value])=>'<span class="currency-value"><strong>'+esc(new Intl.NumberFormat("ru-RU").format(value))+'</strong><span>'+esc(cur)+'</span></span>').join(""):'<span class="currency-empty">Нет сумм в текущей выборке</span>')+
 '</div></div>';
 $("rows").innerHTML=visible.map(d=>'<tr><td><strong>'+esc(d.client)+'</strong><br>'+esc(d.name)+'</td>'+
 '<td>'+esc(d.manager)+'</td><td>'+esc(d.stage)+'</td><td>'+esc(money(d))+'</td>'+
 '<td><span class="pill '+cssScore(d.prospect)+'">'+esc(score(d.prospect))+'</span></td>'+
 '<td><span class="pill '+cssScore(d.risk,true)+'">'+esc(score(d.risk))+'</span></td>'+
 '<td><span class="pill '+cssScore(d.discipline)+'">'+esc(score(d.discipline))+'</span></td>'+
 '<td><span class="pill '+cssScore(d.qualificationScore)+'">'+d.qualificationScore+'/100</span></td><td>'+esc(d.createdAt)+'</td>'+
 '<td><span class="pill '+(d.nextStatus==="Просрочено"?"bad":d.nextStatus==="Не проверено"?"muted":"good")+'">'+esc(d.nextStatus)+'</span><br>'+esc(d.due)+'</td>'+
 '<td><button type="button" data-id="'+d.id+'">Открыть</button></td></tr>').join("");
 $("count").textContent=a.length?"На странице "+visible.length+" сделок; в выборке "+a.length+" из "+deals.length+" активных вымышленных сделок. Общие показатели — по всей выборке.":"В выборке 0 из "+deals.length+" активных вымышленных сделок.";
 $("pageInfo").textContent="Страница "+page+" из "+pages+" · "+(a.length?start+1:0)+"–"+(start+visible.length)+" из "+a.length;
 $("prevPage").disabled=page<=1;$("nextPage").disabled=page>=pages;
 renderInsights(a);
}
for(const id of ["period","search","manager","stage","risk","discipline","quality","next","sort"])$(id).addEventListener(id==="search"?"input":"change",()=>{page=1;render()});
$("prevPage").addEventListener("click",()=>{if(page>1){page--;render()}});
$("nextPage").addEventListener("click",()=>{if(page*PAGE_SIZE<current().length){page++;render()}});
$("rows").addEventListener("click",e=>{
 const b=e.target.closest("button[data-id]");if(!b)return;
 const d=deals.find(item=>item.id===Number(b.dataset.id));if(!d)return;
 $("detailTitle").textContent=d.client+" — "+d.name;
 $("detailBody").innerHTML='<p><strong>Менеджер:</strong> '+esc(d.manager)+'</p><p><strong>Стадия:</strong> '+esc(d.stage)+'</p><p><strong>Сумма:</strong> '+esc(money(d))+'</p>'+
 '<p><strong>Дата создания:</strong> '+esc(d.createdAt)+'</p><p><strong>Следующее действие:</strong> '+esc(d.nextStatus)+' ('+esc(d.due)+')</p>'+scoreDetails(d)+
 '<h3>Демонстрационная история</h3><ul>'+d.history.map(h=>'<li>'+esc(h.at)+' — '+esc(h.text)+'</li>').join("")+'</ul>';
 $("details").showModal();
});
$("close").onclick=()=>$("details").close();
render();
</script></body></html>`;
const security={"Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'","X-Frame-Options":"DENY","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
http.createServer((req,res)=>{
  if(!authorized(req)){res.writeHead(401,{...security,"WWW-Authenticate":'Basic realm="TOP-SENS Sales"'});return res.end("Authentication required")}
  if(req.method!=="GET"){res.writeHead(405,{...security,Allow:"GET"});return res.end()}
  const path=String(req.url||"").split("?")[0];
  if(path==="/sales"){res.writeHead(200,{...security,"Content-Type":"text/html; charset=utf-8"});return res.end(html)}
  if(path==="/sales/status"){res.writeHead(200,{...security,"Content-Type":"application/json; charset=utf-8"});return res.end(JSON.stringify({ok:true,mode:"demo",crmConnected:false,demoDeals:demo.length}))}
  res.writeHead(404,security);res.end("Not found");
}).listen(port,"0.0.0.0",()=>console.log("TOP-SENS demo staging started"));
