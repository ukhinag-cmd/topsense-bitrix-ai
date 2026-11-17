'use strict';

// Admission control for optional analytics work: never suppress Bitrix event
// acknowledgement or core CRM reads. This is backpressure, not an OOM cure.
const MIB=1024*1024;
function limits(env=process.env){
  const configured=Number(env.TOPSENSE_ANALYTICS_HEAP_GUARD_MB);
  const heapMB=Number.isFinite(configured)&&configured>=256&&configured<=900?configured:460;
  return {heapMB,rssMB:900};
}
function sample(memory=process.memoryUsage()){
  return {heapMB:Math.round(Number(memory.heapUsed||0)/MIB),
    rssMB:Math.round(Number(memory.rss||0)/MIB)};
}
function shouldDefer(memory=process.memoryUsage(),env=process.env){
  const now=sample(memory),maximum=limits(env);
  return now.heapMB>=maximum.heapMB||now.rssMB>=maximum.rssMB;
}
module.exports={limits,sample,shouldDefer};
