"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {key}=require("./company-display-key");
test("Аверус name variants share one visual key, not a legal merge",()=>{
 const names=["АВЕРУС","ООО «АВЕРУС»","АВЕРУС, ООО","Компания Аверус"];
 assert.deepEqual([...new Set(names.map(key))],["аверус"]);
});
test("АСПЭК-Интерстрой punctuation and legal form do not duplicate display cards",()=>{
 assert.equal(key("АСПЭК-ИНТЕРСТРОЙ"),key("ООО АСПЭК Интерстрой"));
 assert.notEqual(key("АСПЭК-ИНТЕРСТРОЙ"),key("АСПЭК-ДОМСТРОЙ"));
});
