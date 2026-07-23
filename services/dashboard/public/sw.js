// Web Push (bildirim sistemi parça 5): sunucudan (alarm-engine) gelen push olaylarını
// dinleyip tarayıcı bildirimi olarak gösterir. Uygulama sekmesi kapalıyken bile çalışır --
// bu yüzden ayrı bir service worker dosyası gerekiyor (normal sayfa script'i değil).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "Gözlem Platformu", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Gözlem Platformu";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/favicon.svg"
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow("/"));
});
