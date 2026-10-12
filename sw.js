// よつば材料注文 service worker
// - いまの役目は、ホーム画面に追加できるようにすることだけです
// - 画面のファイルは保存しません（予定アプリと同じ。いつもどおり、毎回新しいものを読みます）
// - プッシュ通知は2回目に、予定アプリと同じやり方で足します
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
