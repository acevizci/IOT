# Systemd Servisleri

Bu dizin, backend'in aksine (docker-compose ile yönetilen) doğrudan host
üzerinde çalıştırılan servislerin systemd birim dosyalarını içerir.

## iot-dashboard.service

Dashboard (React/Vite), Docker container'ı olarak DEĞİL, doğrudan host'ta
`npm run dev` (Vite dev server) ile çalışıyor -- aktif geliştirme sürdüğü
için hot-reload'un çalışması isteniyor, production build+statik dosya
sunumuna henüz geçilmedi. Bu servis, o dev server'ı systemd altında
yönetilebilir (start/stop/status), çökerse otomatik yeniden başlayan
(Restart=always) ve reboot sonrası otomatik açılan (enable) bir sürece
dönüştürür -- daha önce sadece `nohup ... &` ile geçici olarak
çalıştırılıyordu, bu da terminal kapanınca ya da reboot sonrası kaybolan
kırılgan bir kurulumdu.

### Kurulum (yeni bir sunucuda)
```bash
cp infra/systemd/iot-dashboard.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now iot-dashboard
```

### Yönetim
```bash
systemctl status iot-dashboard
systemctl restart iot-dashboard
journalctl -u iot-dashboard -f   # canlı log takibi
```

### Not
`WorkingDirectory` bu sunucudaki mutlak yola (`/root/datacenter-observability/...`)
sabitlenmiş -- farklı bir yola kurulursa bu satır güncellenmelidir.
