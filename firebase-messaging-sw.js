// ウェブ通知の受け取り（GitHub Actions の毎時ジョブから FCM で届く）
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyALc8DxVK6c8Nvi9mJKz2DQl_oYt2PzbPU",
  authDomain: "kakeibo-80efa.firebaseapp.com",
  projectId: "kakeibo-80efa",
  messagingSenderId: "412249164963",
  appId: "1:412249164963:web:11e154258e9b1dfb040316",
});
const messaging = firebase.messaging();
messaging.onBackgroundMessage((p) => {
  const d = p.data || {};
  self.registration.showNotification(d.title || "食品管理", { body: d.body || "", icon: "icons/icon.svg", data: { fid: d.fid || "" } });
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = "./?fid=" + encodeURIComponent(e.notification.data?.fid || "");
  e.waitUntil(clients.matchAll({ type: "window" }).then((ws) => (ws[0] ? ws[0].navigate(url).then((w) => w.focus()) : clients.openWindow(url))));
});
