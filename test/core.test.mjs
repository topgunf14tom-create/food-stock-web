import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initShelf, computeExpiry, normalizeName, defaultStorage, dialStep, daysLeftLabel, isSoon, photoDiff, mergePlan, receiptToItems, jstDate } from "../js/core.js";

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url)));
initShelf(read("shelf_life.json"));

for (const c of read("shelf_life_cases.json")) {
  test(`期限: ${c.name || "(空)"} ${c.storage}${c.opened ? " 開封" : ""}`, () => {
    assert.deepEqual(computeExpiry(c), { expiry: c.expiry, matched: c.matched });
  });
}

test("正規化と保存場所", () => {
  assert.equal(normalizeName("ｷｭｳﾘ 2本"), "きゅうり2本");
  assert.equal(defaultStorage("玉ねぎ"), "pantry");
  assert.equal(defaultStorage("謎の食品"), "fridge");
});

test("ダイヤル", () => {
  assert.equal(dialStep("2026-11-20", 3), "2026-11-23");
  assert.equal(dialStep("2026-11-20", -25), "2026-10-26");
  assert.equal(daysLeftLabel("2026-11-20", "2026-11-20"), "今日まで");
  assert.equal(daysLeftLabel("2026-11-23", "2026-11-20"), "あと3日");
  assert.equal(daysLeftLabel("2026-11-18", "2026-11-20"), "2日過ぎ");
  assert.equal(isSoon("2026-11-22", "2026-11-20"), true);
  assert.equal(isSoon("2026-11-23", "2026-11-20"), false);
});

const item = (id, name, storage = "fridge", status = "active") => ({ id, name, storage, status });

test("写真の突き合わせ", () => {
  let r = photoDiff(["ｷｭｳﾘ"], [item("a", "きゅうり")], "fridge");
  assert.deepEqual(r.matched.map((i) => i.id), ["a"]);
  r = photoDiff(["卵"], [item("a", "卵10個入")], "fridge");
  assert.deepEqual(r.matched.map((i) => i.id), ["a"]);
  r = photoDiff(["牛乳"], [item("a", "牛乳"), item("b", "牛乳")], "fridge");
  assert.deepEqual([r.matched.map((i) => i.id), r.missing.map((i) => i.id)], [["a"], ["b"]]);
  r = photoDiff([], [item("a", "アイス", "freezer")], "fridge");
  assert.deepEqual(r.missing, []);
  r = photoDiff(["納豆", "納豆"], [], "fridge");
  assert.deepEqual(r.toAdd, ["納豆", "納豆"]);
});

test("まとめ：active だけ、同名でも両方", () => {
  const moved = mergePlan([item("a", "卵"), item("b", "豆腐", "fridge", "used")], [item("c", "卵")]);
  assert.deepEqual(moved.map((i) => i.name), ["卵"]);
  assert.equal(moved[0].id, undefined);
});

test("レシート取り込み", () => {
  assert.equal(jstDate(Date.UTC(2026, 10, 20, 15, 30)), "2026-11-21");
  const r = receiptToItems({ id: "r1", date: Date.UTC(2026, 10, 20, 1), createdBy: "u1", items: [
    { name: "牛乳", price: 228, category: "FOOD" }, { name: "値引", price: -50, category: "FOOD" }, { name: "洗剤", price: 300, category: "DAILY" },
  ] }, { now: 1 });
  assert.deepEqual(r.map((i) => [i.name, i.expiry, i.source, i.receiptId]), [["牛乳", "2026-11-27", "receipt", "r1"]]);
});
