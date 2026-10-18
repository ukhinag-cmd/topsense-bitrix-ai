"use strict";
const valid={has:require("./client-taxonomy").known};
const rules=[
["Нефтеперерабатывающий завод",/(?:нпз|нефтепереработ|нефтеперерабатывающ|новойл|нефтехимпереработ)/i],
["Газоперерабатывающее предприятие",/(?:гпз|газоперерабатывающ|газопереработк|гелиевый завод)/i],
["Нефтебаза / нефтетерминал / хранение",/(?:нефтебаз|нефтетерминал|нефтеналив|нефтехранилищ|нефтепродукт.*терминал|морской.*терминал)/i],
["Горно-обогатительное / горнодобывающее предприятие",/(?:горно.?обогатитель|гок|горнорудн|рудник|золотодобыв|угольн.*разрез|шахта|горнодобываю|рудодобыв|россып|добыча руды|добыча золота)/i],
["Нефтедобывающее / газодобывающее предприятие",/(?:нефтедобыч|газодобыч|нефтегазодобыч|добыча (?:нефти|газа)|нефтепромысл|нгду|газпром добыча|нефтегазразведк)/i],
["Нефтехимическое / химическое предприятие",/(?:нефтехим|нефтехимическ|химическ.*(?:завод|комбинат|предприят)|химпром|азот.*(?:завод|хим)|уральхим|сибур|каучук|полиэтилен|полипропилен|пластмасс|полимер|метафракс|акрон|минеральн.*удобрен)/i],
["Энергогенерирующая / теплоснабжающая компания",/(?:грэс|тэц|теплоэлектроцентрал|теплоэнерго|теплоснабж|теплосет|тепловая электростанц|электростанц|энергогенерир|генерац|электрогенерац|\bтгк[- ]?\d|\bогк[- ]?\d|теплокоммунэнерго)/i],
["Металлургическое предприятие",/(?:металлург|сталелитейн|сталеплавиль|чермет|цветмет|алюминиев.*завод|медеплавил|ферросплав|меткомбинат|металлургическ|электростал|русал|нлмк|ммк|северсталь)/i],
["Водоканал / канализационные сооружения",/(?:водоканал|водоочист|очистн.*сооруж|канализацион|водоснабжен|водоотведен|водоканализац)/i],
["Оператор магистральных газопроводов",/(?:газотранспорт|магистральн.*газопровод|газпром трансгаз|газопровод.*оператор)/i],
["Газоспасательная / аварийно-спасательная организация",/(?:газоспасатель|аварийно.?спасатель|спасательн.*отряд|вгсо|газоспасени)/i],
["Интегратор систем газового контроля",/(?:интегратор.*газоанализ|систем.*газов.*контрол|систем.*газоанализ|газоаналитическ.*систем|газосигнализац.*(?:монтаж|систем))/i],
["Производитель газоаналитических приборов",/(?:производств.*газоанализ|завод.*газоанализ|нииит.*сенсон|производитель.*газосигнализ|газоаналитическ.*прибор)/i],
["Производитель КИПиА / датчиков",/(?:завод.*(?:прибор|датчик|кип)|приборостроитель|измерительн.*прибор.*завод|приборный завод|датчик.*производств|контрольно.?измерительн.*завод)/i],
["Интегратор АСУ ТП",/(?:\bасу\s*тп\b|автоматизац.*технологическ|интеграц.*автоматизац|промышленн.*автоматизац|разработк.*асу)/i],
["Интегратор КИПиА",/(?:интегратор.*кип|монтаж.*кип|системы кипиа|инжиниринг.*кип)/i],
["Интегратор промышленных систем безопасности",/(?:интегратор.*безопасност|комплексн.*систем.*безопасност|систем.*пожарн.*безопасност|промышленн.*видеоаналитик)/i],
["Интегратор электротехнических систем и диспетчеризации",/(?:диспетчеризац|электротехническ.*интеграц|систем.*электроснабжен|автоматизац.*подстанц)/i],
["Проектная организация / проектный институт",/(?:проектн.*институт|\bгипро\w*|\bнипи\w*|ниипроект|проектиров|проектн.*организац|проектно.?конструкторск|проектно.?изыскательск)/i],
["EPC / EPCM инженерно-строительная компания",/(?:\bepc\b|\bepcm\b|инжиниринг.*строительств|строительств.*нефтегазов.*объект)/i],
["Промышленный генподрядчик",/(?:генподряд|газстройпром|газстрой|промстрой|нефтегазстрой|нефтестрой|спецстрой|промышленн.*строительств|нефтегазмонтаж)/i],
["Монтажно-строительная организация",/(?:строймонтаж|строительно.?монтаж|спецмонтаж|монтажная организац|электромонтаж|тепломонтаж|монтажстрой)/i],
["Ремонтный подрядчик ОПО / остановочный ремонт",/(?:ремонт.*(?:нпз|опо|завод|скважин|компрессор)|промремонт|ремстрой|капремонт|ремонтно.?механическ|ремонтн.*предприят)/i],
["Пусконаладочная организация",/(?:пусконалад|наладочн.*работ|наладка.*оборудован)/i],
["Промышленный сервис / техническая эксплуатация",/(?:техобслуживан|техническ.*эксплуатац|сервис.*нефтегаз|промышленн.*сервис|техсервис|сервисн.*компан|ремонтно.?сервисн)/i],
["Горнодобывающий сервис / буровые работы",/(?:буров|\bбурени|буровой сервис|скважинн.*сервис|геофизик.*скважин|нефтесервис|шлюмберже|бурсервис)/i],
["Диагностика трубопроводов и оборудования",/(?:дефектоскоп|неразрушающ.*контрол|диагностик.*трубопровод|промышленн.*диагностик|техническ.*диагностик)/i],
["Машиностроительный завод",/(?:машиностроительн.*(?:завод|предприят|комбинат)|машзавод|машиностроен|механическ.*завод|тракторн.*завод|двигателестро|станкостро)/i],
["OEM-производитель технологических установок",/(?:производств.*(?:реактор|установк|технологическ.*комплекс)|завод.*технологическ.*оборуд)/i],
["Системный интегратор промышленной автоматизации",/(?:системный интегратор|интеграционн.*решен|автоматизация промышленност)/i],
["Инжиниринговая компания",/(?:инжиниринг|инженерн.*решени|инженерн.*компан)/i],
["OEM / комплектовщик технологических установок",/(?:комплектован.*технологическ|комплектац.*установ|комплектатор)/i],
["Сервисный центр измерительного оборудования",/(?:сервисн.*центр.*прибор|ремонт.*измерительн.*оборуд|сервис.*кип|обслуживан.*газоанализ)/i],
["Поверочная / калибровочная лаборатория",/(?:поверк|калибров|метрологическ.*центр|метрологическ.*служб|центр метрологи)/i],
["Арендная компания газоанализаторов / КИПиА",/(?:аренд.*газоанализ|прокат.*измерительн|аренда.*кип)/i],
["Испытательная лаборатория / сертификационный орган",/(?:испытательн.*лаборатор|центр сертификац|сертификационн.*орган|испытательн.*центр|сертификац)/i],
["Учебный центр промышленной безопасности",/(?:учебн.*центр|центр обучен|курсы.*промышленн.*безопасност)/i],
["Централизованный закупочный центр холдинга",/(?:центр.*закуп|закупочн.*центр|единая.*закуп)/i],
["Тендерный посредник / комплектация закупок",/(?:тендер|тендерное сопровожд|закупочн.*посредник)/i],
["Дистрибьютор / оптовый поставщик",/(?:дистрибьют|оптов.*постав|торговый дом|торговая компания|снабжение|снабсбыт)/i],
["Дилер промышленного оборудования",/(?:дилер|официальн.*представител|поставщик.*промышленн.*оборуд|торгово.?сервисн.*предприят)/i],
["Головная компания промышленной группы / холдинга",/(?:промышленн.*холдинг|холдинговая компания|группа компаний|управляющ.*компан.*промыш)/i],
["Производитель смежного промышленного оборудования",/(?:электротехническ.*завод|кабельн.*завод|трансформаторн.*завод|насосн.*завод|компрессорн.*завод|арматурн.*завод|оборудован.*завод)/i],
["Непрофильный контрагент",/(?:гостиниц|отель|ресторан|кафе|такси|туристическ|рекламн.*агентств|юридическ.*бюро|бухгалтерск.*услуг|банк\b|страхов|благотворительн|девелопер|жилой комплекс|строительство жилья|продуктов.*магазин|школа|детский сад)/i]
];
function infer(name){
 const s=String(name||"").toLowerCase().replace(/[«»"']/g," ");
 if(!s.trim()||/^(?:без названия|без имени|москва|санкт.?петербург|красногорск|омск|город|ооо копыта)$/i.test(s.trim()))return null;
 const matches=rules.filter(([t,re])=>valid.has(t)&&re.test(s));
 if(matches.length===0)return null;
 const distinct=[...new Set(matches.map(x=>x[0]))];
 if(distinct.length>1){
 const priorities=["Нефтеперерабатывающий завод","Газоперерабатывающее предприятие","Горно-обогатительное / горнодобывающее предприятие","Нефтедобывающее / газодобывающее предприятие","Энергогенерирующая / теплоснабжающая компания","Нефтехимическое / химическое предприятие"];
 const sorted=distinct.sort((a,b)=>(priorities.indexOf(a)===-1?99:priorities.indexOf(a))-(priorities.indexOf(b)===-1?99:priorities.indexOf(b)));
 return {type:sorted[0],confidence:"Низкая",reason:"По названию; несколько возможных типов"};
 }
 return {type:distinct[0],confidence:"Предварительная",reason:"Признаки деятельности в названии CRM"};
}

// Website content can mention mines and other customer sectors without operating them.
// Prefer the company's own manufacturer/dealer statements over use-case keywords.
const operatingTypes=new Set([
 "Горно-обогатительное / горнодобывающее предприятие",
 "Нефтедобывающее / газодобывающее предприятие",
 "Нефтеперерабатывающий завод",
 "Газоперерабатывающее предприятие",
 "Металлургическое предприятие",
 "Нефтехимическое / химическое предприятие",
 "Энергогенерирующая / теплоснабжающая компания",
 "Водоканал / канализационные сооружения"
]);
// Evidence that the enterprise itself makes drinks/malt, NOT that it
// performs industrial construction for other enterprises.  Such factories
// can still be END USERS of instrumentation; 45-type taxonomy has no exact
// "brewery/food-production plant" subtype. Do not guess a contractor type.
function beverageManufacturerEvidence(company,site){
 const name=String(company?.name||company||"").toLowerCase().replace(/ё/g,"е");
 const companyHint=/пив(?:о|овар|завод)|солодов|напитк|квас/i.test(name);
 if(!companyHint)return false;
 const meta=[site?.siteTitle,site?.siteDescription,...(site?.siteHeadings||[])].join(" ").toLowerCase().replace(/ё/g,"е");
 const beverage=/пив(?:о|а|овар|завод)|солод|напитк|квас/.test(meta);
 const production=/производств|пищев|бренд|солодовенн|о производстве/.test(meta);
 const firstParty=site&&["site_profiled","site_read_no_clear_type"].includes(site.status)&&beverage&&production;
 const prior=String(company?.aiExplanation||"").toLowerCase().replace(/ё/g,"е");
 const priorFirstParty=/производител.*(?:напит|солод|пив)|производство.*(?:напит|солод|пив)/.test(prior)
  &&/брянскпиво|пив|солод|напитк|квас/i.test(name)
  &&/^https?:\/\//i.test(String(company?.siteVerified||""));
 return Boolean(firstParty||priorFirstParty);
}
// First-party industrial-contractor work outranks incidental mention of
// schools, charity, accommodation, retail or suppliers on the same website.
// Cached profiles contain service headings even if the crawler lost its body.
function ownIndustrialContractingEvidence(site){
 if(!site||site.status!=="site_profiled")return false;
 const headings=(site.siteHeadings||[]).map(x=>String(x||"").toLowerCase().replace(/ё/g,"е"));
 const words=headings.join(" ");
 const construction=/капитальн[а-яё]*\s+строительств|строительств[а-яё]*\s+объектов/i.test(words);
 const installation=/монтажн[а-яё]*\s+работ|строительно.?монтажн[а-яё]*\s+работ/i.test(words);
 const sector=/теплоизоляционн[а-яё]*\s+работ|антикоррозионн[а-яё]*\s+(?:обработк|работ)|нефтехим|нефтепереработ|опо/i.test(words);
 return construction&&installation&&sector;
}
function firstPartyGeneralContractorClaim(core,name){
 const text=String(core||"").toLowerCase().replace(/ё/g,"е");
 const legalName=String(name||"").toLowerCase().replace(/ё/g,"е")
  .replace(/^(?:ооо|оао|ао|пао)\s*["«]?\s*/,"").replace(/["»]/g,"").trim();
 const ownName=legalName.length>=5&&text.includes(legalName);
 const selfClaim=/(?:мы\s+выполняем|наша\s+компания.{0,100}|компания\s+.{0,85}|предприятие\s+.{0,85}|общество\s+.{0,85})\s*(?:выполня(?:ет|ем|я)\s+функции\s+генерального\s+подрядчика|явля(?:ется|емся)\s+генеральным\s+подрядчиком|оказыва(?:ем|ет)\s+услуги\s+генподрядчика)/i.test(text);
 const direct=/выполня(?:ет|ем|я)\s+функции\s+генерального\s+подрядчика|договор[аыу]?\s+генерального\s+подряда|выступа\w*\s+(?:в\s+качестве\s+)?генерального\s+подрядчика/i.test(text);
 const projects=/нефтехим|нефтепереработ|нефтегаз|опасн\w*\s+производственн\w*\s+объект|промышленн\w*\s+объект/i.test(text);
 return (selfClaim&&projects)||(ownName&&direct&&projects);
}
function inferWebsiteActivity(pages,companyName){
 const data=(pages||[]).map(p=>({
  header:[p.meta?.title,p.meta?.description,...(p.meta?.headings||[])].join(" ").toLowerCase().replace(/ё/g,"е"),
  body:String(p.meta?.body||"").toLowerCase().replace(/ё/g,"е"),
  path:String(p.pageUrl||"").toLowerCase()
 }));
 const selected=data.filter(p=>/(?:\/about|\/o-kompanii|\/onas|о компании|о нас|предприятие)/i.test(p.path+" "+p.header));
 const chosen=selected.length?selected:data;
 const core=chosen.map(p=>p.header+" "+p.body.slice(0,3500)).join(" ");
 const combinedPages=data.map(p=>p.header+" "+p.body.slice(0,3800)).join(" ");
 const name=String(companyName||"").toLowerCase().replace(/ё/g,"е");
 if(firstPartyGeneralContractorClaim(core,companyName))
  return {type:"Промышленный генподрядчик",reason:"Сайт прямо подтверждает собственные генподрядные работы на промышленных объектах"};
 // The site may mention construction contractors among its suppliers.
 // Its own beer / malt production is a stronger first-party activity signal.
 if(beverageManufacturerEvidence({name:companyName},{
  status:"site_profiled",
  siteTitle:data.map(x=>x.header).join(" "),
  siteDescription:chosen.map(x=>x.body.slice(0,400)).join(" "),
  siteHeadings:data.map(x=>x.header)
 }))return {type:"Производство напитков",reason:"Собственное производство напитков и солода подтверждено профильными разделами сайта"};
 // Product specialization is applied only when the company's own
 // manufacturing is described, not when a dealer sells third-party goods.
 const manufacturing=/собственн[а-яё]*\s+производств|мы\s+производим|мы\s+выпускаем|наш[ао]\s+производств|предприяти[ея]\s+производит|завод\s+производит|производител|производств[оае]\s+(?:удобрен|бытов|сигарет|табачн)/i.test(core);
 const shopOnly=/интернет-магазин|розничн\w*\s+магазин|магазин\s+товаров/i.test(core)&&
   !/собственн\w*\s+производств|завод\s+производит|мы\s+выпускаем/i.test(core);
 if(manufacturing&&!shopOnly){
  const sectors=[
   ["Производство бытовой химии",/бытов[а-яё]*\s+хим|моющ[а-яё]*\s+средств|чистящ[а-яё]*\s+средств|стиральн[а-яё]*\s+порошк/i],
   ["Производство табачных изделий",/табачн[а-яё]*\s+(?:издел|продукц|фабрик)|сигарет|производств[а-яё]*\s+табака/i],
   ["Производство удобрений",/производств[а-яё]*\s+(?:минеральн[а-яё]*\s+|органическ[а-яё]*\s+)?удобрен|минеральн[а-яё]*\s+удобрен|карбамид|аммиачн[а-яё]*\s+селитр/i]
  ].filter(x=>x[1].test(core));
  if(sectors.length===1)return {type:sectors[0][0],
   reason:"Собственное отраслевое производство подтверждено материалами сайта"};
 }
  const gas=/газоаналитическ|газоанализатор|газоанализ\w*|газосигнализ|течеискател/i.test(core);
 if(gas){
  const dealer=/(?:явля[а-я]{0,12}\s+(?:официальн[а-я]{0,10}\s+)?дилер[а-я]*|официальн[а-я]*\s+дилер[а-я]*|дилер[а-я]*\s+(?:всех|прибор|производител|оборудован))/i.test(core);
  const manufacturer=/(?:собственн[а-я]*\s+(?:производств[а-я]*|сборк[а-я]*)|разрабатываем\s+и\s+производим|производител[а-я]*\s+газоаналитическ|производств[а-я]*\s+(?:газоанализатор|газоаналитическ)|(?:нпп|научно.производственн).*газоаналит)/i.test(core+" "+name);
  if(dealer&&!manufacturer)return {type:"Дилер промышленного оборудования",reason:"Официальное дилерство газоаналитического оборудования"};
  if(manufacturer)return {type:"Производитель газоаналитических приборов",reason:"Собственное изготовление газоаналитического оборудования"};
 }

 // Catalogue vendors are not technical-inspection contractors merely because
 // product pages mention defectoscopes or non-destructive testing.
 const diagnosticEquipment=/дефектоскоп|толщиномер|вихретоков|ультразвуков.*датчик|оборудован.*(?:неразрушающ|дефектоскоп|диагностик)|прибор.*(?:диагностик|контроля)|измерительн.*оборудован/i.test(combinedPages);
 const tradeRole=/(?:дилер|дистрибьют|поставщик|поставка|оптов\w*\s+продаж|прода[её]м|продажа|купить|интернет-магазин|торговый дом|торговая компания|каталог\s+оборудован|реализуем\s+(?:оборудован|прибор|техник))/i.test(combinedPages);
 const actualTesting=/(?:оказыва(?:ем|ет)\s+услуг[иу]\s+(?:по\s+)?(?:неразрушающ|диагностик|испытан)|проводим\s+(?:контроль|диагностик|испытани|дефектоскоп)|выполняем\s+(?:диагностик|неразрушающ|обследован)|(?:осуществляем|проводим)\s+техническ\w*\s+диагностик|наша\s+лаборатори[яи])/i.test(core);
 if(diagnosticEquipment&&tradeRole&&!actualTesting){
  const authorized=/(?:официальн[а-яё]*\s+дилер[а-яё]*|дилер[а-яё]*\s+производител|авторизованн[а-яё]*\s+дилер[а-яё]*)/i.test(core);
  return {type:authorized?"Дилер промышленного оборудования":"Дистрибьютор / оптовый поставщик",
   reason:"Продажа и поставка диагностических приборов, а не выполнение диагностических работ"};
 }
 if(actualTesting&&/(?:диагностик|неразрушающ|дефектоскоп)/i.test(core)){
  return {type:"Диагностика трубопроводов и оборудования",reason:"Подтверждены собственные услуги технической диагностики и неразрушающего контроля"};
 }
 const ownName=/(?:шахта|рудник|горно.?обогатительн|нефте(?:перерабат|добывающ)|газо(?:перерабат|добывающ)|металлургическ|тэц|грэс|водоканал|газпром добыча)/i.test(name);
 const ownClaim=/(?:наша компания|наше предприятие|компания|предприятие|общество|мы)\s.{0,90}(?:ведет добыч|осуществляет добыч|добывает|эксплуатирует (?:шахт|месторожд|нефтепереработ)|занимается (?:добыч|переработк)|осуществляет переработк)/i.test(core);
 if(!ownName&&!ownClaim){
  const role=require("./corporate-role-evidence").classify(pages);
  if(role&&valid.has(role.type))return role;
 }
  let result=infer(chosen.map(p=>p.header).join(". "));
 if(!result)result=infer(core.slice(0,3500));
 // A contractor name mentioned as a supplier or renovation partner on
 // a factory's site is NOT proof that the factory is a general contractor.
 if(result?.type==="Промышленный генподрядчик"){
  const ownRoleName=infer(companyName)?.type==="Промышленный генподрядчик";
  const firstPartyContract=/((?:мы|наша\s+компания|наше\s+предприятие)\s.{0,100}(?:выступа\w*\s+ген(?:еральн\w*)?\s*подрядчик|осуществля\w*\s+генподряд|выполня\w*\s+(?:функции|работы)\s+генподряд))|(?:явля[ею]мся|является)\s+ген(?:еральным\s+)?подрядчик|выполня(?:ем|ет)\s+функции\s+генерального\s+подрядчика/i.test(core);
  if(!ownRoleName&&!firstPartyContract)
   return {type:"",reason:"Подрядчик упомянут на сайте, но собственные генподрядные услуги организации не подтверждены"};
 }
 if(result&&operatingTypes.has(result.type)&&!ownName&&!ownClaim){
  return {type:"",reason:"Отрасли потребителей упомянуты на сайте, но не являются деятельностью компании"};
 }
 return result?{type:result.type,reason:"Деятельность в профильных разделах сайта"}:null;
}
function apply(records){
 const sites=require("./website-profiler");
 return records.map(c=>{
  const completion=require("./client-finalization");
  if(completion.isComplete(c.id))return completion.apply(c);
  const site=sites.get(c.id);
  const previous=valid.has(c.organizationType)?c.organizationType:(valid.has(c.type)?c.type:"");
  const byName=infer(c.name);
  const officiallyVerifiedType=valid.has(c.verifiedOrgType)?c.verifiedOrgType:"";
  // Primary TOP-SENSE rule: a direct CRM deal's inbound sender domain
  // matches the site host, and the site itself unambiguously describes
  // its own activity. CRM company legal requisites are optional.
  const domainBasedType=site?.status==="site_profiled"&&
   site?.siteIdentityVerified===true&&
   site?.siteIdentityEvidence==="inbound_sender_domain_matches_website"&&
   valid.has(site.siteType)&&site.emailSenderDomain;
  if(domainBasedType)return {...c,
   organizationType:site.siteType,type:site.siteType,
   proposedType:"",siteStatus:"site_profiled",
   siteProfileUrl:site.url||"",siteVerified:site.url||"",
   siteIdentityVerified:true,siteSource:"Домен отправителя входящего письма",
   emailSenderDomain:site.emailSenderDomain,
   segmentConfidence:"Подтверждено — домен входящего отправителя совпал с сайтом",
   segmentSource:"Собственная деятельность на сайте "+(site.url||"")+
    "; домен совпадает с корпоративной почтой отправителя входящей сделки",
   verification:"Сайт изучен; корпоративный домен отправителя и сайта совпадают",
   researchStatus:"mail_domain_site_qualified"};

  // Reconcile previously persisted false non-profile site classifications;
  // no new site crawling or paid model calls. An actual contractor's own
  // service headings take precedence over a stray "charity"/"school" keyword.
  if(ownIndustrialContractingEvidence(site) &&
    (!previous||previous==="Непрофильный контрагент"||site.siteType==="Непрофильный контрагент")){
   return {...c,organizationType:"Промышленный генподрядчик",
    type:"Промышленный генподрядчик",proposedType:"",
    category:"Подрядчики",siteStatus:"site_profiled",
    siteProfileUrl:site.url||c.siteProfileUrl||"",siteVerified:site.url||c.siteVerified||"",
    segmentConfidence:"Подтверждено профильными разделами официального сайта",
    segmentSource:"Капитальное строительство, монтаж, теплоизоляция и антикоррозионные работы на сайте организации",
    verification:"Исправлена ошибочная классификация «Непрофильный контрагент»",
    industryDescription:"Генподряд, строительство, реконструкция и ремонт объектов нефтехимии и нефтепереработки"};
  }
  // Reconcile persisted wrong website profiles too: a previous crawler
  // may have classified a beverage manufacturer as a general contractor
  // from construction keywords elsewhere on the site. No new paid calls.
  if(beverageManufacturerEvidence(c,site)){
   const correctedSite=site&&["site_profiled","site_read_no_clear_type"].includes(site.status)?site.url:"";
   return {...c,siteStatus:correctedSite?"site_profiled":c.siteStatus||"site_pending",
    siteProfileUrl:correctedSite||c.siteVerified||"",siteVerified:correctedSite||c.siteVerified||"",
    organizationType:"Производство напитков",type:"Производство напитков",proposedType:"",
    category:"Конечные потребители",
    industryDescription:"Производство пива, напитков и солода",
    segmentConfidence:"Производственная деятельность подтверждена; тип включён в расширяемый справочник",
    segmentSource:"Официальный сайт предприятия и ранее сохранённый AI-профиль",
    verification:"Исправлена ошибочная классификация подрядчика — не является генподрядчиком по найденным сведениям"};
  }
  const provisionalOwnLegalSite=site?.status==="site_preliminary_profiled";
  const bySite=["site_profiled","site_preliminary_profiled"].includes(site?.status)&&valid.has(site.siteType)?{type:site.siteType}:null;
  const siteBelongs=site?.status==="site_profiled"||site?.status==="site_read_no_clear_type";
  const websiteEvidence={
   siteStatus:site?.status||"site_pending",
   siteProfileUrl:siteBelongs?(site?.url||""):"",
   siteProfileTitle:siteBelongs?(site?.siteTitle||""):"",
   siteProfileDescription:siteBelongs?(site?.siteDescription||""):"",
   ...(provisionalOwnLegalSite?{
    siteCandidate:site.url||c.siteCandidate||"",
    siteSource:"Поиск по юридическому наименованию — предварительно",
    siteIdentityVerified:false,
    siteActivityEvidenceStatus:"preliminary_legal_name_match"
   }:{})
  };
  // An inspected first-party product site is more specific than a broad
  // legacy chemical/manufacturing label, even if that older label is stored.
  if(bySite&&!provisionalOwnLegalSite&&["Производство бытовой химии","Производство табачных изделий","Производство удобрений","Производство напитков"].includes(bySite.type)&&
   (previous!==bySite.type||officiallyVerifiedType!==bySite.type)){
   return {...c,...websiteEvidence,organizationType:bySite.type,type:bySite.type,
    category:"Конечные потребители",proposedType:"",
    segmentConfidence:"Отраслевая специализация подтверждена страницами собственной продукции",
    segmentSource:"Профильные страницы проверенного сайта компании",verification:"Предварительная классификация"};
  }
  if(officiallyVerifiedType)return {...c,...websiteEvidence,siteStatus:"official_site_verified",siteProfileUrl:c.siteCandidate||websiteEvidence.siteProfileUrl,organizationType:officiallyVerifiedType,segmentConfidence:"Высокая — официальный сайт",segmentSource:c.verifiedOrgEvidence||"Юридическое наименование и описание деятельности на официальном сайте"};
  if(previous==="Диагностика трубопроводов и оборудования"&&bySite&&
   ["Дилер промышленного оборудования","Дистрибьютор / оптовый поставщик"].includes(bySite.type)){
   return {...c,...websiteEvidence,organizationType:bySite.type,proposedType:bySite.type,
    segmentConfidence:"Предварительная — исправлена роль поставщика",segmentSource:"Проверка сайта: продаёт приборы диагностики, не проводит диагностику",
    verification:"Предварительная классификация"};
  }
  if(previous)return {...c,...websiteEvidence,organizationType:previous,segmentConfidence:c.verification||"Ранее назначен",segmentSource:"Ранее сохранённая аналитика / классификация"};
  let selected=null,confidence="",basis="";
  const notes=valid.has(c.crmActivityHint?.type)?c.crmActivityHint:null;
  // Existing evidence from company note fields is provisional, distinct
  // from what the customer is asking TOP-SENSE to supply in a deal.
  const noteAgreesWithName=!byName||byName.type===notes?.type;
  if(notes&&!bySite&&noteAgreesWithName){
   selected=notes.type;confidence=notes.confidence;
   basis=notes.source;
  }
  if(!selected&&bySite&&byName&&bySite.type===byName.type){
   selected=bySite.type;confidence=provisionalOwnLegalSite?"Предварительная — принадлежность сайта не подтверждена":"Выше средней";basis=(site.siteActivityReason||"Основная деятельность на сайте")+"; совпадает с названием организации";
  }else if(!selected&&bySite){
   selected=bySite.type;confidence="Предварительная — принадлежность сайта не подтверждена";basis=(site.siteActivityReason||"Публичные сведения о собственной деятельности компании")+" · "+(site.source||"сайт-кандидат");
  }else if(!selected&&byName&&(!notes||noteAgreesWithName)){
   selected=byName.type;confidence=byName.confidence;basis="Название CRM, без подтверждения сайтом";
  }
  if(!selected)return {...c,...websiteEvidence,organizationType:"",segmentConfidence:notes&&byName&&!noteAgreesWithName?"Конфликт источников — нужна проверка":"Недостаточно данных",segmentSource:site?.status==="site_absent"?"Сайт и домен в CRM отсутствуют; внешняя идентификация ещё требуется":site?.status==="site_unavailable"?"Сайт не открылся; деятельность не подтверждена":site?.status==="site_pending"?"Сайт ещё не проверен":"На доступных страницах нет достаточных данных для выбора типа"};
  return {...c,...websiteEvidence,organizationType:selected,proposedType:selected,segmentConfidence:confidence,segmentSource:basis,verification:"Предварительная классификация"};
 });
}
module.exports={infer,apply,inferWebsiteActivity,beverageManufacturerEvidence,ownIndustrialContractingEvidence,firstPartyGeneralContractorClaim};
