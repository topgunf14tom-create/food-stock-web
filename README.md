# 🥬 食品管理 Web版

Android版（food-stock）と同じ冷蔵庫をブラウザで使うページです。iPhone では Safari の共有ボタン →「ホーム画面に追加」で使うと通知も受け取れます。

- 公開：GitHub Pages（Settings → Pages → main / root）
- 設定：`js/config.js`（家計簿 Web版と同じ Firebase の値）。通知を使うには `vapidKey` にウェブプッシュ証明書の鍵を入れる
- 期限の目安表 `shelf_life.json` は food-stock の `shared/` からコピーしたもの
- テスト：`node --test`（Android版と同じテストケースで計算が一致するか）
