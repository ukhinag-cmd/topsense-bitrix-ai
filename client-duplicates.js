"use strict";
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function cards(items,merged){
 if(!items.length)return '<p class="empty">Таких групп нет.</p>';
 return items.map(g=>{
  const info=merged?"Виртуально объединено в аналитике":"Нужна проверка перед объединением";
  const rows=(g.members||[]).map(m=>'<tr><td><a href="'+esc(m.crmUrl)+'" target="_blank" rel="noopener noreferrer">CRM '+esc(m.id)+' ↗</a></td><td>'+esc(m.name)+'</td><td>'+(m.hasEmail?"Есть e-mail":"Нет e-mail")+'</td><td>'+esc(m.saleStatus)+'</td><td>'+esc(m.type||"—")+'</td></tr>').join("");
  const sale=g.saleInfo||{};
  const buyer=String(sale.purchaseStatus||"").startsWith("БЫЛА")?"БЫЛА":String(sale.purchaseStatus||"").startsWith("НЕ БЫЛО")?"НЕ БЫЛО":"ПРОВЕРЯЕТСЯ";
  const amount=Number.isFinite(sale.purchaseAmount)?sale.purchaseAmount.toLocaleString("ru-RU")+" "+(sale.purchaseCurrency==="RUB"?"руб.":esc(sale.purchaseCurrency||"")):"Не установлена";
  const mergedDetails=merged?'<div class="summary"><p>Сводная аналитическая карточка: <a href="/contractors?group='+encodeURIComponent(g.virtualCardId)+'">открыть ↗</a></p><p><b>Покупка:</b> '+buyer+' · <b>Что покупали:</b> '+esc((sale.purchaseItems||[]).join("; ")||"Не указано")+' · <b>Сумма по документам:</b> '+esc(amount)+'</p><p><b>Все e-mail:</b> '+esc((g.crmEmails||[]).join("; ")||"Не указаны")+'</p><p><b>Контакты:</b> '+esc((g.contactNames||[]).join("; ")||"Не указаны")+'</p></div>':"";
  return '<details class="group"><summary><b>'+esc(g.name)+'</b><span>'+Number(g.count||0)+' карточки</span><small>'+info+'</small></summary><p class="note">'+esc(g.reason||"")+'</p>'+mergedDetails+'<div class="scroll"><table><thead><tr><th>CRM ID</th><th>Название</th><th>Контакты</th><th>Покупка</th><th>Тип клиента</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="note">Объединение исходных CRM-карточек выполняется вручную в Bitrix24.</p></details>';
 }).join("");
}
function csv(data){
 const all=[...(data.duplicateGroups||[]).map(g=>({...g,kind:"Виртуально объединены"})),
  ...(data.duplicateReview||[]).map(g=>({...g,kind:"Требует проверки"}))];
 const rows=[["Группа","Статус","Причина","CRM ID","Название CRM","Тип клиента","Статус покупки","Ссылка CRM"]];
 for(const g of all)for(const m of g.members||[])rows.push([g.name,g.kind,g.reason||"",m.id,m.name,m.type||"",m.saleStatus||"",m.crmUrl]);
 return "\ufeff"+rows.map(a=>a.map(v=>'"'+String(v??"").replace(/"/g,'""')+'"').join(";")).join("\r\n");
}
function html(data){
 const groups=data.duplicateGroups||[],reviews=data.duplicateReview||[],st=data.duplicateStats||{};
 const style='body{margin:0;font:14px system-ui;background:#f2f6f7;color:#233c49}header{background:#12475b;color:white;padding:25px}main{max-width:1300px;margin:auto;padding:20px}a{color:#14798a}h1{margin:0 0 7px}.stats{display:flex;gap:12px;flex-wrap:wrap}.stat,.group{background:white;border:1px solid #dde8ec;border-radius:12px;padding:15px}.stat{min-width:150px;flex:1}.stat strong{display:block;font-size:26px}.group{margin:10px 0}.group summary{display:flex;cursor:pointer;align-items:center;gap:14px;flex-wrap:wrap}.group summary b{flex:1}.group small,.note{color:#64808a;font-size:12px}.group .summary{background:#eff7f8;padding:8px 12px;margin:10px 0;border-radius:9px;line-height:1.55}.scroll{overflow:auto}table{width:100%;min-width:700px;border-collapse:collapse}td,th{border-bottom:1px solid #e4ecee;padding:9px;text-align:left;vertical-align:top}th{background:#f3f8fa}h2{margin:25px 0 9px;font-size:20px}.empty{background:white;padding:12px;border-radius:8px}header p{color:#d0e3e8}';
 return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ТОП-СЕНС — список дублей</title><style>'+style+'</style></head><body><header><h1>ТОП-СЕНС — дубли компаний</h1><p>Для ручного объединения в Bitrix24. Данные из исходных карточек в CRM не меняются.</p></header><main><p><a href="/contractors">← Общий дашборд</a> · <a href="/contractors/duplicates.csv">Скачать список дублей CSV ↓</a></p><div class="stats"><div class="stat"><strong>'+Number(st.rawCompanyCount||0).toLocaleString("ru-RU")+'</strong>Исходных CRM-карточек</div><div class="stat"><strong>'+Number(st.customerCardCount||0).toLocaleString("ru-RU")+'</strong>Аналитических карточек</div><div class="stat"><strong>'+Number(st.groupedCount||0)+'</strong>Групп с виртуальным объединением</div><div class="stat"><strong>'+Number(st.reviewGroupCount||0)+'</strong>Групп на проверку</div></div><h2>Виртуально объединены: '+groups.length+'</h2><p class="note">В общей карточке объединены связанные e-mail, контакты и сведения о сделках. Это не юридическое подтверждение дубля.</p>'+cards(groups,true)+'<h2>Проверить перед объединением: '+reviews.length+'</h2><p class="note">В этих группах совпадает часть названия, но данных недостаточно. Контакты и сделки намеренно не смешиваются.</p>'+cards(reviews,false)+'</main></body></html>';
}
module.exports={html,csv};