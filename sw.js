// よつば資材便（材料注文）service worker
// - 役目は、ホーム画面に追加できるようにすることと、プッシュ通知を出すこと
// - 画面のファイルは保存しません（予定アプリと同じ。いつもどおり、毎回新しいものを読みます）
// - プッシュ通知（10/14）：Cloud Functions（functions/notify.js）から Firebase Cloud Messaging で届きます。
//   予定アプリ・車両アプリと同じく、Firebase の部品は読まずに、届いた data（title・body・tag・url）をそのまま出します
// - 押したら、事務所の画面（jimusho.html）が開いていれば前に出し、なければ開きます
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// 届いたら出す（同じ tag の通知は重ねない）
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { p = { data: { body: e.data ? e.data.text() : '' } }; }
  const d = { ...(p.notification || {}), ...(p.data || {}) };
  e.waitUntil(self.registration.showNotification(d.title || 'よつば資材便', {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: './icons/zairyo-192.png?v=2',
    data: { url: d.url || './jimusho.html' },
  }));
});

// 押したら：事務所の画面が開いていれば前に出す。なければ開く
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './jimusho.html', self.registration.scope).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = list.find(c => c.url.startsWith(self.registration.scope) && c.url.includes('jimusho.html'));
    if (open) {
      try { await open.focus(); return; } catch (err) { }
    }
    await self.clients.openWindow(url);
  })());
});
