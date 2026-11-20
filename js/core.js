// 計算ロジック（Android 版・通知ジョブと同じ仕様。テスト：node --test）
let table = null;
let index = [];

export function normalizeName(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・,，.。、()（）［］\[\]「」【】/／\-]/g, "")
    .toLowerCase();
}

export function initShelf(json) {
  table = json;
  index = json.entries
    .flatMap((entry, order) => entry.keys.map((k) => ({ key: normalizeName(k), entry, order })))
    .sort((a, b) => b.key.length - a.key.length || a.order - b.order);
}

function lookup(name) {
  const n = normalizeName(name);
  if (n) for (const { key, entry } of index) if (n.includes(key)) return { entry, matched: true };
  return { entry: table.default, matched: false };
}

export function addDays(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function computeExpiry({ name, baseDate, storage, opened }) {
  const { entry, matched } = lookup(name);
  let days = typeof entry[storage] === "number" ? entry[storage] : entry[entry.storage];
  if (typeof days !== "number") days = table.default[storage];
  if (opened && typeof entry.opened === "number") days = Math.min(days, entry.opened);
  return { expiry: addDays(baseDate, days), matched };
}

export const defaultStorage = (name) => lookup(name).entry.storage || "fridge";

export const dialStep = (ymd, steps) => addDays(ymd, steps);
export const daysLeft = (expiry, today) => Math.round((Date.parse(expiry) - Date.parse(today)) / 86400000);
export function daysLeftLabel(expiry, today) {
  const d = daysLeft(expiry, today);
  return d === 0 ? "今日まで" : d > 0 ? `あと${d}日` : `${-d}日過ぎ`;
}
export const isSoon = (expiry, today) => daysLeft(expiry, today) <= 2;

export function photoDiff(detected, stock, storage) {
  const pool = stock.filter((i) => i.status === "active" && i.storage === storage);
  const matched = [], toAdd = [];
  for (const name of detected) {
    const n = normalizeName(name);
    const at = !n ? -1 : pool.findIndex((i) => {
      const s = normalizeName(i.name);
      return s && (s === n || s.includes(n) || n.includes(s));
    });
    if (at >= 0) matched.push(pool.splice(at, 1)[0]); else toAdd.push(name);
  }
  return { toAdd, missing: pool, matched };
}

export const mergePlan = (from) => from.filter((i) => i.status === "active").map(({ id, ...rest }) => rest);

export const jstDate = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);

export function receiptToItems(receipt, { now }) {
  const baseDate = jstDate(receipt.date);
  return (receipt.items || [])
    .filter((i) => i.category === "FOOD" && Number(i.price) > 0)
    .map((i) => {
      const storage = defaultStorage(i.name);
      const { expiry, matched } = computeExpiry({ name: i.name, baseDate, storage, opened: false });
      return { name: i.name, storage, qty: 1, unit: "", expiry, baseDate, opened: false, manual: false, matched,
        source: "receipt", receiptId: receipt.id, price: Number(i.price), status: "active",
        addedBy: receipt.createdBy || "", addedAt: now, closedAt: null };
    });
}

export const todayJst = () => jstDate(Date.now());
