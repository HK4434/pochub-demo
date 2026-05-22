# PoCHub Firebase Functions Deploy Rehberi v2

**Sürüm**: v4.97
**Tarih**: Mayıs 2026
**Hedef**: İlk paying customer geldiğinde Functions deploy etme

---

## 📋 Genel Durum

PoCHub Firebase Functions kodu **tamamen hazır** ama henüz deploy edilmedi. Sebep: Blaze plan (pay-as-you-go) gerekli ve stratejik karar olarak **ilk paying customer gelene kadar** beklendi.

### Hazır Olanlar
- ✅ TypeScript kod yapısı (`functions/src/`)
- ✅ Starter functions (helloWorld, getServerTime, getCurrentUser)
- ✅ iyzico entegrasyonu (checkoutInit, callback)
- ✅ EmailJS server-side (notification, invoice)
- ✅ Cron jobs (daily, hourly, weekly, **cycle reset** - v4.97)
- ✅ **Calendly webhook handler** - v4.97

### Deploy Sırası (Aşamalı)
1. **Önce**: Starter + cron jobs (risksiz)
2. **Sonra**: Calendly webhook (lead tracking için)
3. **En son**: iyzico + EmailJS (gerçek para hareketi var, dikkatli test)

---

## 🚀 1. Blaze Plan Aktivasyonu

### Adımlar
1. Firebase Console: https://console.firebase.google.com/project/pochub-co
2. Sol menü → **Usage and billing** → **Modify plan**
3. **Blaze (Pay as you go)** seç
4. Kredi kartı ekle (faturalama hesabı)
5. **Budget alert** kur: aylık $25 (güvenlik için)

### Bekleyen Ücret Tahmini
- Cloud Functions: İlk 2M çağrı ücretsiz/ay
- Firestore: İlk 50K okuma + 20K yazma ücretsiz/gün
- Realistic monthly cost (10 vendor): **$0-5**
- 100 vendor: **$5-25**

---

## 🛠 2. Local Build & Test

### Gereksinimler
```bash
node --version    # 22+
npm --version     # 10+
firebase --version  # 13+
```

### Build
```bash
cd C:\Users\hk\Documents\Projects\pochub-demo\functions
npm install
npm run build
```

Hatalar varsa `tsconfig.json` veya `package.json` versiyonlarını kontrol et.

### Local Emulator Test
```bash
firebase emulators:start --only functions
```
http://localhost:4000 → Functions emulator UI

`helloWorld` çalışıyorsa devam et. Çalışmıyorsa loglara bak (`firebase-debug.log`).

---

## 🎯 3. Aşama 1: Cron Jobs Deploy (Düşük Risk)

### Önce Test
```bash
firebase deploy --only functions:helloWorld
```

Başarılıysa Firebase Console → Functions sekmesinde görünür. URL'sini kopyala, browser'da test et:
```
https://europe-west1-pochub-co.cloudfunctions.net/helloWorld
```

### Cron Jobs
```bash
firebase deploy --only \
  functions:dailyMaintenanceCron,\
functions:hourlyBillingCheckCron,\
functions:weeklyDigestCron,\
functions:cycleResetCron
```

**Beklenen**: 4 cron job deploy edilir. Cloud Scheduler'da otomatik oluşturulur.

### Manuel Tetikleme (Test)
```bash
# Cycle reset'i test et
gcloud scheduler jobs run firebase-schedule-cycleResetCron-europe-west1 \
  --location=europe-west1
```

Loglara bak:
```bash
firebase functions:log --only cycleResetCron
```

---

## 📅 4. Aşama 2: Calendly Webhook Deploy

### Önce: Calendly Hesabı
1. https://calendly.com → giriş yap
2. **Account → Integrations → Webhooks**
3. **Create Webhook**:
   - URL: `https://europe-west1-pochub-co.cloudfunctions.net/calendlyWebhook`
   - Events: `invitee.created`, `invitee.canceled`
   - **Signing Key**'i kopyala (cancel'a basmadan önce!)

### Secret Set
```bash
firebase functions:secrets:set CALENDLY_SIGNING_KEY
# Yapıştır: signing key
```

### Deploy
```bash
firebase deploy --only functions:calendlyWebhook
```

### Test
Calendly Dashboard → Webhooks → **Send test event**

Firebase Console → Functions → calendlyWebhook → Logs:
```
[calendlyWebhook] Event: invitee.created
[calendlyWebhook] Updated existing demo_request: xxx
```

PoCHub → Admin → Demo Talepleri: **status: booked** olmalı.

---

## 💳 5. Aşama 3: iyzico Deploy (Gerçek Para!)

⚠️ **DİKKAT**: Bu aşamada gerçek para hareketleri başlar. Önce **sandbox** test et.

### iyzico Hesabı
1. https://sandbox-api.iyzipay.com → developer hesabı
2. API Key + Secret Key al

### Secrets Set
```bash
firebase functions:secrets:set IYZICO_API_KEY
firebase functions:secrets:set IYZICO_SECRET_KEY
firebase functions:secrets:set IYZICO_BASE_URL
# Sandbox: https://sandbox-api.iyzipay.com
# Production: https://api.iyzipay.com
```

### Deploy
```bash
firebase deploy --only \
  functions:iyzicoCheckoutInit,\
functions:iyzicoCallback
```

### Test
- PoCHub → vendor → Subscription → Pro paket al
- Sandbox kart: `5528790000000008` (Halkbank test)
- Callback URL'i Firebase Functions'a yönlendirilmeli

### Production'a Geçiş
HTML içinde:
```javascript
const USE_PRODUCTION_PAYMENTS = true;  // ⚠️ Sadece test tamamlandıktan sonra
```

---

## 📧 6. Aşama 4: EmailJS Deploy

### EmailJS Hazırlık
1. https://emailjs.com → 7 template oluştur:
   - `template_pkg_active` (paket aktivasyonu)
   - `template_pay_received` (ödeme alındı)
   - `template_invoice` (fatura)
   - `template_poc_received` (yeni PoC)
   - `template_offer_sent` (teklif geldi)
   - `template_demo_booked` (demo onayı)
   - `template_reset` (cycle reset bildirim)

### Secrets
```bash
firebase functions:secrets:set EMAILJS_SERVICE_ID
firebase functions:secrets:set EMAILJS_USER_ID
firebase functions:secrets:set EMAILJS_PRIVATE_KEY
```

### Deploy
```bash
firebase deploy --only \
  functions:sendNotificationEmail,\
functions:sendInvoiceEmail
```

### Test
Admin panel → bir vendor'a manual notification → mail gelmeli

### Production Toggle
HTML içinde:
```javascript
const USE_PRODUCTION_EMAIL = true;
```

---

## 🔥 7. Production Firestore Rules

⚠️ **EN SON**, tüm Functions çalıştıktan sonra deploy et.

```bash
firebase deploy --only firestore:rules
```

Mevcut `firestore.rules` dosyası açık moddu (`read: if true`, `write: if request.auth != null`). Production rules'a geçmeden önce:

1. **Önce backup**: `firestore.rules.backup` oluştur
2. **Test environment'ta dene** (varsa)
3. **Aşamalı deploy**: koleksiyon bazlı

Production rules için ayrı dokümana bakın: `firestore-rules-deploy-guide.md`

---

## 🧪 8. Smoke Test Checklist

Deploy sonrası test sırası:

- [ ] `helloWorld` çalışıyor
- [ ] `getServerTime` doğru zaman dönüyor
- [ ] `cycleResetCron` manuel tetikleme — log'da reset edilen kayıtlar görünmeli
- [ ] Calendly webhook — sandbox event al, demo_requests dokümanı güncellenmeli
- [ ] iyzico sandbox payment — test kartla başarılı ödeme
- [ ] EmailJS — vendor signup sonrası welcome mail
- [ ] Admin paneli → Demo Talepleri → Funnel doğru gösteriyor
- [ ] Vendor abonelik sayfası → bonus PoC doğru görünüyor (v4.96)

---

## ⚠️ Sık Sorunlar

### "Permission denied" deploy sırasında
```bash
firebase login --reauth
firebase use pochub-co
```

### Region mismatch
Tüm functions `europe-west1`'de. URL'ler bu region ile başlamalı.

### Secret kullanılamıyor
```bash
firebase functions:secrets:access CALENDLY_SIGNING_KEY
```

### Functions başlangıçta yavaş
İlk çağrı cold start'tan dolayı yavaş. 2-3sn normal. Production'da `minInstances: 1` set edilirse hızlanır (ama maliyet artar).

### Calendly webhook 401 dönüyor
Signing key yanlış. Firebase Console → Functions → Configuration → Secret yeniden set et.

---

## 📊 9. Monitoring

### Daily Check (5dk)
- Firebase Console → Functions → tüm function'ların invocation/error count
- Hata > 1% → investigate

### Weekly Check
- Cloud Logging → `severity>=ERROR` filtrele
- Billing → günlük spend trend

### Aylık
- Firestore okuma/yazma growth
- Function execution time trend (>1sn ise optimize)

---

## 🛣 Sonraki Adımlar

Deploy sonrası açılan kapılar:
- **Production Firestore Rules** (sıkı güvenlik)
- **Vendor → Vendor automatic notifications** (webhook tetikli)
- **Customer email digest** (haftalık özet)
- **EmailJS template iyileştirmeleri** (markalı template)
- **Audit logging** (production'da kim ne yaptı)

---

**Versiyon**: v4.97
**Hazırlayan**: PoCHub Team
**İletişim**: hasan.kayapinar@gitsteknoloji.com
