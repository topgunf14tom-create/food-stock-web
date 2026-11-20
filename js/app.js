// 食品管理 Web版（Android 版と同じ Firebase の冷蔵庫を読み書きする）
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, query, where,
  onSnapshot, getDoc, getDocs, setDoc, updateDoc, writeBatch, runTransaction, arrayUnion,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js";
import { getAI, getGenerativeModel, GoogleAIBackend } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-ai.js";
import { getMessaging, getToken, isSupported } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js";
import { firebaseConfig, recaptchaSiteKey, vapidKey } from "./config.js";
import * as C from "./core.js";

C.initShelf(await (await fetch("shelf_life.json")).json());

const app = initializeApp(firebaseConfig);
if (recaptchaSiteKey) initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey), isTokenAutoRefreshEnabled: true });
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const ai = getAI(app, { backend: new GoogleAIBackend() });
const AI_MODEL = "gemini-3.5-flash";

const $app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const LABEL = { fridge: "冷蔵", freezer: "冷凍", pantry: "常温" };
const md = (ymd) => `${+ymd.slice(5, 7)}/${+ymd.slice(8, 10)}`;

const S = { user: undefined, me: null, fridges: [], items: [], filter: null, modal: null, busy: false, toast: "", error: "", imported: false };
const subs = {};
function sub(name, fn) { subs[name]?.(); subs[name] = fn ? fn() : null; }
const current = () => S.fridges.find((f) => f.id === S.me?.activeFridgeId) || S.fridges[0] || null;
const itemsCol = (fid) => collection(db, "fridges", fid, "items");
const myName = () => S.me?.name || S.user?.displayName || "メンバー";

function toast(msg) { S.toast = msg; render(); setTimeout(() => { S.toast = ""; render(); }, 3000); }
async function busy(fn) {
  S.busy = true; S.error = ""; render();
  try { await fn(); } catch (e) { S.error = e.message || String(e); toast(S.error); } finally { S.busy = false; render(); }
}

// ======================= 購読 =======================
onAuthStateChanged(auth, (u) => {
  S.user = u; S.me = null; S.fridges = []; S.items = []; S.imported = false;
  if (!u) { sub("me"); sub("fridges"); sub("items"); render(); return; }
  sub("me", () => onSnapshot(doc(db, "users", u.uid), (s) => {
    const d = s.data() || {};
    S.me = { uid: u.uid, name: d.name, householdId: d.householdId, activeFridgeId: d.activeFridgeId, notifyHour: d.notifyHour ?? 18 };
    watchItems(); maybeImport(); render();
  }));
  sub("fridges", () => onSnapshot(query(collection(db, "fridges"), where("members", "array-contains", u.uid)), (s) => {
    S.fridges = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((f) => !f.archived).sort((a, b) => a.name.localeCompare(b.name, "ja"));
    watchItems(); maybeImport(); render();
  }));
});

let watching = null;
function watchItems() {
  const f = current();
  if ((f?.id ?? null) === watching) return;
  watching = f?.id ?? null;
  if (!f) { sub("items"); S.items = []; return; }
  sub("items", () => onSnapshot(query(itemsCol(f.id), where("status", "==", "active")), (s) => {
    S.items = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.expiry.localeCompare(b.expiry));
    render();
  }));
}

/** 家計簿のレシートを在庫に取り込む（Spark プランのため、開いたときに行う） */
async function maybeImport() {
  const f = current();
  if (S.imported || !S.me?.householdId || !f) return;
  S.imported = true;
  const joinedAt = f.joinedAt?.[S.me.uid];
  if (!joinedAt) return;
  try {
    const snaps = await getDocs(query(collection(db, "households", S.me.householdId, "receipts"), where("createdBy", "==", S.me.uid)));
    let added = 0;
    for (const d of snaps.docs) {
      const r = d.data();
      if ((r.createdAt ?? 0) < joinedAt || typeof r.date !== "number") continue;
      const list = C.receiptToItems({ id: d.id, ...r, createdBy: S.me.uid }, { now: Date.now() });
      const mark = doc(db, "fridges", f.id, "receiptImports", d.id);
      const done = await runTransaction(db, async (t) => {
        if ((await t.get(mark)).exists()) return false;
        t.set(mark, { importedAt: Date.now(), by: S.me.uid });
        list.forEach((it) => t.set(doc(itemsCol(f.id)), it));
        return true;
      });
      if (done) added += list.length;
    }
    if (added) toast(`レシートから${added}品を追加しました`);
  } catch (e) { console.warn("レシートの取り込みに失敗", e); }
}

// ======================= 操作 =======================
const code6 = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");

const act = {
  async login(form) { await signInWithEmailAndPassword(auth, form.email.value.trim(), form.pw.value); },
  async createFridge(name) {
    const uid = S.user.uid, ref = doc(collection(db, "fridges")), code = code6(), now = Date.now();
    const b = writeBatch(db);
    b.set(ref, { name: name || "冷蔵庫", inviteCode: code, members: [uid], memberNames: { [uid]: myName() }, joinedAt: { [uid]: now }, createdBy: uid, createdAt: now, archived: false });
    b.set(doc(db, "fridgeInvites", code), { fridgeId: ref.id });
    b.set(doc(db, "users", uid), { activeFridgeId: ref.id }, { merge: true });
    await b.commit();
  },
  async joinFridge(raw) {
    const uid = S.user.uid, code = raw.trim().toUpperCase();
    const inv = await getDoc(doc(db, "fridgeInvites", code));
    const fid = inv.data()?.fridgeId;
    if (!fid) throw new Error("招待コードが見つかりません");
    await updateDoc(doc(db, "fridges", fid), { members: arrayUnion(uid), [`memberNames.${uid}`]: myName(), [`joinedAt.${uid}`]: Date.now(), joinCode: code });
    await setDoc(doc(db, "users", uid), { activeFridgeId: fid }, { merge: true });
  },
  switchFridge: (fid) => setDoc(doc(db, "users", S.user.uid), { activeFridgeId: fid }, { merge: true }),
  async add(name, qty, storage) {
    const f = current(), base = C.todayJst();
    const { expiry, matched } = C.computeExpiry({ name, baseDate: base, storage, opened: false });
    await setDoc(doc(itemsCol(f.id)), { name: name.trim(), storage, qty, unit: "", expiry, baseDate: base, opened: false, manual: false, matched,
      source: "manual", receiptId: null, price: null, status: "active", addedBy: S.user.uid, addedAt: Date.now(), closedAt: null });
  },
  dial: (it, steps) => updateDoc(doc(itemsCol(current().id), it.id), { expiry: C.dialStep(it.expiry, steps), manual: true }),
  async state(it, storage = it.storage, opened = it.opened) {
    const ref = doc(itemsCol(current().id), it.id);
    if (it.manual) { await updateDoc(ref, { storage, opened }); toast("手動で決めた期限はそのまま残しました"); return; }
    const base = C.todayJst();
    await updateDoc(ref, { storage, opened, baseDate: base, expiry: C.computeExpiry({ name: it.name, baseDate: base, storage, opened }).expiry });
  },
  close: (it, status) => updateDoc(doc(itemsCol(current().id), it.id), { status, closedAt: Date.now() }),
  async notifyHour(h) {
    await setDoc(doc(db, "users", S.user.uid), { notifyHour: h }, { merge: true });
    toast(`毎日${h}時ごろにお知らせします`);
  },
  async merge(fromId, toId) {
    const from = (await getDocs(query(itemsCol(fromId), where("status", "==", "active")))).docs.map((d) => ({ id: d.id, ...d.data() }));
    const b = writeBatch(db), now = Date.now();
    C.mergePlan(from).forEach((it) => b.set(doc(itemsCol(toId)), it));
    from.forEach((it) => b.update(doc(itemsCol(fromId), it.id), { status: "moved", closedAt: now }));
    b.update(doc(db, "fridges", fromId), { archived: true });
    b.set(doc(db, "users", S.user.uid), { activeFridgeId: toId }, { merge: true });
    await b.commit();
    toast("冷蔵庫をまとめました");
  },
  async enableNotify() {
    if (!vapidKey) throw new Error("通知の鍵がまだ設定されていません");
    if (!(await isSupported())) throw new Error("この画面では通知が使えません。Safari の共有ボタン →「ホーム画面に追加」から開いてください");
    if ((await Notification.requestPermission()) !== "granted") throw new Error("通知が許可されませんでした");
    const reg = await navigator.serviceWorker.register("firebase-messaging-sw.js");
    const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: reg });
    await setDoc(doc(db, "users", S.user.uid, "fcmTokens", token), { platform: "web", updatedAt: Date.now() });
    toast("このスマホで通知を受け取ります");
  },
  async photo(file, storage) {
    const data = await shrink(file, 1280);
    const model = getGenerativeModel(ai, { model: AI_MODEL, generationConfig: { responseMimeType: "application/json" } });
    const prompt = "冷蔵庫・冷凍庫・食品棚の写真です。写っている食品を1つずつ日本語の短い一般名で挙げ、次の形のJSONだけを返してください。{\"items\":[\"牛乳\",\"卵\"]}\nルール：同じ物が複数あればその数だけ繰り返す。中身の分からない容器は「作り置き」。食品でない物は含めない。";
    const res = await model.generateContent([prompt, { inlineData: { data, mimeType: "image/jpeg" } }]);
    const t = res.response.text();
    const names = (JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)).items || []).map((s) => String(s).trim()).filter(Boolean);
    const diff = C.photoDiff(names, S.items, storage);
    S.modal = { type: "photo", storage, diff, add: new Set(diff.toAdd.map((_, i) => i)), miss: new Set() };
  },
  async applyPhoto() {
    const m = S.modal, f = current(), base = C.todayJst(), b = writeBatch(db), now = Date.now();
    const add = m.diff.toAdd.filter((_, i) => m.add.has(i));
    add.forEach((name) => {
      const { expiry, matched } = C.computeExpiry({ name, baseDate: base, storage: m.storage, opened: false });
      b.set(doc(itemsCol(f.id)), { name, storage: m.storage, qty: 1, unit: "", expiry, baseDate: base, opened: false, manual: false, matched,
        source: "photo", receiptId: null, price: null, status: "active", addedBy: S.user.uid, addedAt: now, closedAt: null });
    });
    m.miss.forEach((id) => b.update(doc(itemsCol(f.id), id), { status: "used", closedAt: now }));
    await b.commit();
    S.modal = null;
    toast(`追加${add.length}品・使い切り${m.miss.size}品を反映しました`);
  },
};

function shrink(file, maxSide) {
  return new Promise((ok, ng) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      ok(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => ng(new Error("写真を読み込めませんでした"));
    img.src = URL.createObjectURL(file);
  });
}

// ======================= 画面 =======================
function render() {
  if (S.user === undefined) { $app.innerHTML = `<div class="page center">読み込み中…</div>`; return; }
  if (S.user === null) return renderLogin();
  if (!S.me) { $app.innerHTML = `<div class="page center">読み込み中…</div>`; return; }
  if (!S.fridges.length) return renderNoFridge();
  renderStock();
}

function renderLogin() {
  $app.innerHTML = `<div class="page stack"><h1>食品管理</h1><p class="muted">家計簿と同じメールアドレスとパスワードでログインします。</p>
    <form id="login" class="stack"><input name="email" type="email" placeholder="メールアドレス" autocomplete="username" required>
    <input name="pw" type="password" placeholder="パスワード" autocomplete="current-password" required>
    <button ${S.busy ? "disabled" : ""}>ログイン</button></form>${S.error ? `<p class="err">${esc(S.error)}</p>` : ""}</div>`;
  document.getElementById("login").onsubmit = (e) => { e.preventDefault(); busy(() => act.login(e.target)); };
}

function renderNoFridge() {
  $app.innerHTML = `<div class="page stack"><h1>冷蔵庫を用意しましょう</h1><p class="muted">新しく作るか、もう一人から招待コードを教えてもらって参加します。</p>
    <input id="fname" placeholder="冷蔵庫の名前（例：瑞希の家）"><button id="create">新しく作る</button>
    <hr><input id="code" placeholder="招待コード（6文字）" maxlength="6"><button class="ghost" id="join">参加する</button>${toastHtml()}</div>`;
  document.getElementById("create").onclick = () => busy(() => act.createFridge(document.getElementById("fname").value.trim()));
  document.getElementById("join").onclick = () => busy(() => act.joinFridge(document.getElementById("code").value));
}

const toastHtml = () => (S.toast ? `<div class="toast">${esc(S.toast)}</div>` : "");

function expClass(it, today) { const d = C.daysLeft(it.expiry, today); return d < 0 ? "over" : d <= 2 ? "soon" : ""; }

function renderStock() {
  const f = current(), today = C.todayJst();
  const shown = S.items.filter((i) => !S.filter || i.storage === S.filter);
  const chip = (k, label) => `<button class="chip ${S.filter === k ? "on" : ""}" data-filter="${k ?? ""}">${label}</button>`;
  $app.innerHTML = `<div class="page">
    <div class="bar"><select id="fridge">${S.fridges.map((x) => `<option value="${x.id}" ${x.id === f.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      <button class="icon" id="cam" title="冷蔵庫を撮る">📷</button><button class="icon" id="set" title="設定">⚙️</button></div>
    ${S.busy ? `<p class="muted">処理中…</p>` : ""}
    <div class="chips">${chip(null, `すべて ${S.items.length}`)}${Object.entries(LABEL).map(([k, v]) => chip(k, `${v} ${S.items.filter((i) => i.storage === k).length}`)).join("")}</div>
    ${shown.length ? `<div class="list">${shown.map((it) => `<div class="row" data-id="${it.id}">
      <div class="name">${esc(it.name)}<div class="meta">${LABEL[it.storage]}${it.opened ? "・開封済み" : ""}${!it.matched && !it.manual ? `・<span class="soon">目安なし</span>` : ""}${it.qty !== 1 ? `・×${it.qty}` : ""}</div></div>
      <div class="exp ${expClass(it, today)}">${md(it.expiry)}<small>${C.daysLeftLabel(it.expiry, today)}</small></div></div>`).join("")}</div>`
      : `<p class="muted">在庫はまだありません。＋で追加するか、📷で冷蔵庫を撮ってください。</p>`}
    <button class="fab" id="add">＋</button>${modalHtml()}${toastHtml()}</div>
    <input type="file" id="file" accept="image/*" capture="environment" hidden>`;
  document.getElementById("fridge").onchange = (e) => busy(() => act.switchFridge(e.target.value).then(() => { S.imported = false; }));
  document.querySelectorAll("[data-filter]").forEach((b) => (b.onclick = () => { S.filter = b.dataset.filter || null; render(); }));
  document.querySelectorAll(".row").forEach((r) => (r.onclick = () => { S.modal = { type: "item", id: r.dataset.id }; render(); }));
  document.getElementById("add").onclick = () => { S.modal = { type: "add" }; render(); };
  document.getElementById("set").onclick = () => { S.modal = { type: "settings" }; render(); };
  document.getElementById("cam").onclick = () => { S.modal = { type: "camera" }; render(); };
  bindModal();
}

function modalHtml() {
  const m = S.modal;
  if (!m) return "";
  const today = C.todayJst(), f = current();
  let body = "";
  if (m.type === "item") {
    const it = S.items.find((i) => i.id === m.id);
    if (!it) { S.modal = null; return ""; }
    body = `<h2>${esc(it.name)}</h2>
      <div class="dial" id="dial"><button data-step="-1">◀</button><div><div class="date ${expClass(it, today)}">${md(it.expiry)}</div>
      <div class="hint">（${C.daysLeftLabel(it.expiry, today)}）↔ 左右になぞると1日ずつ</div></div><button data-step="1">▶</button></div>
      ${it.manual ? `<p class="muted">期限は手動で調整済みです</p>` : ""}
      <div class="btns">${it.storage === "freezer" ? `<button class="ghost" data-state="fridge">解凍した</button>` : `<button class="ghost" data-state="freezer">冷凍した</button>`}
      ${!it.opened ? `<button class="ghost" data-open="1">開封した</button>` : ""}${it.storage === "pantry" ? `<button class="ghost" data-state="fridge">冷蔵へ</button>` : ""}</div>
      <div class="btns"><button data-close="used">使い切った</button><button class="ghost" data-close="discarded">捨てた</button></div>`;
  } else if (m.type === "add") {
    const name = m.name || "", storage = m.storage || (name ? C.defaultStorage(name) : "fridge");
    const e = name ? C.computeExpiry({ name, baseDate: today, storage, opened: false }) : null;
    body = `<h2>食品を追加</h2><input id="aname" placeholder="品名" value="${esc(name)}"><input id="aqty" type="number" step="0.5" min="0.5" value="${m.qty ?? 1}">
      <div class="chips">${Object.entries(LABEL).map(([k, v]) => `<button class="chip ${storage === k ? "on" : ""}" data-astore="${k}">${v}</button>`).join("")}</div>
      <p class="muted" id="ahint">${e ? `期限：${md(e.expiry)}（${e.matched ? "目安" : "目安なし・あとで調整"}）` : ""}</p>
      <div class="btns"><button id="adone" ${name.trim() ? "" : "disabled"}>追加</button><button class="ghost" data-x>やめる</button></div>`;
  } else if (m.type === "camera") {
    body = `<h2>どこを撮りますか？</h2><div class="btns">${Object.entries(LABEL).map(([k, v]) => `<button data-shoot="${k}">${v}</button>`).join("")}</div>
      <p class="muted">写っている食品を読み取り、在庫と見比べて「追加しますか？」「使い切りましたか？」を確認します。</p>`;
  } else if (m.type === "photo") {
    body = `<h2>${LABEL[m.storage]}の写真の結果</h2>
      ${m.diff.toAdd.length ? `<b>追加しますか？</b>${m.diff.toAdd.map((n, i) => `<label class="check"><input type="checkbox" data-padd="${i}" ${m.add.has(i) ? "checked" : ""}>${esc(n)}</label>`).join("")}` : ""}
      ${m.diff.missing.length ? `<b>使い切りましたか？（写っていない物）</b>${m.diff.missing.map((it) => `<label class="check"><input type="checkbox" data-pmiss="${it.id}" ${m.miss.has(it.id) ? "checked" : ""}>${esc(it.name)}</label>`).join("")}` : ""}
      ${m.diff.matched.length ? `<p class="muted">在庫と一致：${m.diff.matched.map((i) => esc(i.name)).join("、")}</p>` : ""}
      <div class="btns"><button id="papply">まとめて反映</button><button class="ghost" data-x>やめる</button></div>`;
  } else if (m.type === "settings") {
    const others = S.fridges.filter((x) => x.id !== f.id);
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    body = `<h2>設定</h2><div class="card stack"><b>${esc(f.name)}</b><div>招待コード：<b>${esc(f.inviteCode)}</b></div>
      <div class="muted">メンバー：${Object.values(f.memberNames || {}).map(esc).join("、")}</div></div>
      <div class="card stack"><b>期限のお知らせ</b><div class="btns"><select id="hour">${Array.from({ length: 24 }, (_, h) => `<option ${h === S.me.notifyHour ? "selected" : ""} value="${h}">${h}時</option>`).join("")}</select><button id="savehour">保存</button></div>
      ${standalone ? `<button class="ghost" id="notify">このスマホで通知を受け取る</button>` : `<p class="muted">iPhone で通知を受け取るには、Safari の共有ボタン →「ホーム画面に追加」で追加して、そこから開いてください。</p>`}
      <p class="muted">Web版の通知は数分〜30分ほど遅れることがあります。</p></div>
      <div class="card stack"><input id="nname" placeholder="新しい冷蔵庫の名前"><button class="ghost" id="ncreate">冷蔵庫を作る</button>
      <input id="ncode" placeholder="招待コードで参加" maxlength="6"><button class="ghost" id="njoin">参加する</button></div>
      ${others.length ? `<div class="card stack"><b>冷蔵庫をまとめる（同棲したとき）</b><p class="muted">「${esc(f.name)}」の在庫を移して、この冷蔵庫は閉じます。同じ品目があっても両方残します。</p>
      ${others.map((o) => `<button class="ghost" data-merge="${o.id}">→「${esc(o.name)}」へ移す</button>`).join("")}</div>` : ""}
      <div class="btns"><button class="ghost" id="logout">ログアウト</button><button data-x>閉じる</button></div>`;
  }
  return `<div class="sheet-bg" id="bg"><div class="sheet stack">${body}</div></div>`;
}

function bindModal() {
  const m = S.modal;
  if (!m) return;
  const $ = (id) => document.getElementById(id);
  const close = () => { S.modal = null; render(); };
  $("bg").onclick = (e) => { if (e.target.id === "bg") close(); };
  document.querySelectorAll("[data-x]").forEach((b) => (b.onclick = close));
  const it = m.type === "item" ? S.items.find((i) => i.id === m.id) : null;
  if (it) {
    document.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => busy(() => act.dial(it, +b.dataset.step))));
    let x0 = null, acc = 0;
    const dial = $("dial");
    dial.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; acc = 0; }, { passive: true });
    dial.addEventListener("touchmove", (e) => { if (x0 === null) return; acc = e.touches[0].clientX - x0; }, { passive: true });
    dial.addEventListener("touchend", () => { const steps = Math.trunc(acc / 40); x0 = null; if (steps) busy(() => act.dial(it, steps)); });
    document.querySelectorAll("[data-state]").forEach((b) => (b.onclick = () => busy(() => act.state(it, b.dataset.state))));
    document.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => busy(() => act.state(it, it.storage, true))));
    document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => { S.modal = null; busy(() => act.close(it, b.dataset.close)); }));
  }
  if (m.type === "add") {
    const name = $("aname"), qty = $("aqty");
    name.focus();
    name.oninput = () => {
      m.name = name.value;
      const n = m.name.trim(), st = m.storage || (n ? C.defaultStorage(n) : "fridge");
      document.querySelectorAll("[data-astore]").forEach((b) => b.classList.toggle("on", b.dataset.astore === st));
      const e = n ? C.computeExpiry({ name: n, baseDate: C.todayJst(), storage: st, opened: false }) : null;
      $("ahint").textContent = e ? `期限：${md(e.expiry)}（${e.matched ? "目安" : "目安なし・あとで調整"}）` : "";
      $("adone").disabled = !n;
    };
    qty.oninput = () => { m.qty = +qty.value || 1; };
    document.querySelectorAll("[data-astore]").forEach((b) => (b.onclick = () => { m.storage = b.dataset.astore; m.qty = +qty.value || 1; render(); }));
    $("adone").onclick = () => { const n = m.name.trim(), q = m.qty ?? 1, s = m.storage || C.defaultStorage(n); S.modal = null; busy(() => act.add(n, q, s)); };
  }
  if (m.type === "camera") {
    document.querySelectorAll("[data-shoot]").forEach((b) => (b.onclick = () => {
      const file = $("file"), storage = b.dataset.shoot;
      file.onchange = () => { const fl = file.files[0]; S.modal = null; if (fl) busy(() => act.photo(fl, storage)); };
      file.click();
    }));
  }
  if (m.type === "photo") {
    document.querySelectorAll("[data-padd]").forEach((c) => (c.onchange = () => { const i = +c.dataset.padd; c.checked ? m.add.add(i) : m.add.delete(i); }));
    document.querySelectorAll("[data-pmiss]").forEach((c) => (c.onchange = () => { const id = c.dataset.pmiss; c.checked ? m.miss.add(id) : m.miss.delete(id); }));
    $("papply").onclick = () => busy(() => act.applyPhoto());
  }
  if (m.type === "settings") {
    $("savehour").onclick = () => busy(() => act.notifyHour(+$("hour").value));
    $("notify")?.addEventListener("click", () => busy(() => act.enableNotify()));
    $("ncreate").onclick = () => { const n = $("nname").value.trim(); if (n) { S.modal = null; busy(() => act.createFridge(n)); } };
    $("njoin").onclick = () => { const c = $("ncode").value; S.modal = null; busy(() => act.joinFridge(c)); };
    document.querySelectorAll("[data-merge]").forEach((b) => (b.onclick = () => {
      const to = S.fridges.find((x) => x.id === b.dataset.merge);
      if (confirm(`「${current().name}」の在庫をすべて「${to.name}」に移します。よろしいですか？`)) { S.modal = null; busy(() => act.merge(current().id, to.id)); }
    }));
    $("logout").onclick = () => { S.modal = null; signOut(auth); };
  }
}

// 通知から開いたとき（?fid=）はその冷蔵庫を表示
const qfid = new URLSearchParams(location.search).get("fid");
if (qfid) onAuthStateChanged(auth, (u) => { if (u) act.switchFridge(qfid).catch(() => {}); });
render();
