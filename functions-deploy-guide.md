# PoCHub Firebase Functions — Deploy Guide

**Versiyon**: v4.75
**Tarih**: Mayıs 2026
**Hedef**: Hasan'ın bilgisayarında ilk Functions deploy

---

## 🎯 Bu Doküman Ne İçin?

Bu versiyonda (v4.75) **Firebase Functions** altyapısı kuruldu. Functions kodu artık `functions/` klasöründe — ama deploy edilmesi gerek ki çalışsın. Bu döküman:

1. Lokal kurulumun nasıl yapılacağını
2. İlk deploy adımlarını
3. Test etmeyi
4. Sorun giderme önerilerini içerir

---

## 📦 1. Ön Gereksinimler

Hasan'ın bilgisayarında olması gerekenler:

### Node.js 20 (Firebase Functions v6 gereği)
```bash
# macOS:
brew install node@20

# Windows: https://nodejs.org/en/download (LTS sürümünü indir)

# Doğrula:
node --version  # v20.x.x olmalı
npm --version   # 10.x.x olmalı
```

### Firebase CLI
```bash
npm install -g firebase-tools

# Doğrula:
firebase --version  # 13.x veya 14.x olmalı
```

### Git (varsa atla)
```bash
git --version  # 2.x olmalı
```

---

## 🏗️ 2. Proje Yapısını Yerelleştir

Mevcut PoCHub repo'nuza şu dosyaları ekleyin:

```
PoCHub repo/
├── pochub-v4.75.html      (mevcut — ana app)
├── functions/             ← YENİ klasör
│   ├── package.json
│   ├── tsconfig.json
│   ├── .eslintrc.json
│   ├── .gitignore
│   ├── .env.example
│   └── src/
│       ├── index.ts
│       ├── hello.ts
│       └── helpers.ts
└── firebase.json          ← YENİ root config
```

Bütün bu dosyalar v4.75 teslimine dahildir.

---

## 🔥 3. Firebase Login + Project Init

### 3.1 Firebase Login
```bash
firebase login
# Tarayıcı açılır, Google hesabınla giriş yap (PoCHub Firebase projesinin sahibi).
```

### 3.2 Proje Kontrolü
PoCHub için kullandığın Firebase projesinin **ID**'sini öğren:
- Firebase Console (https://console.firebase.google.com) → Project Settings → Project ID

Örnek: `pochub-prod` veya benzer.

### 3.3 .firebaserc Oluştur (manuel)
Repo root'unda `.firebaserc` dosyası oluştur:

```json
{
  "projects": {
    "default": "BURAYA-PROJE-ID-YAZ"
  }
}
```

Veya CLI ile:
```bash
firebase use --add
# Listeden projeyi seç, alias olarak "default" yaz
```

---

## 💰 4. Blaze Plan'a Geç (Önemli!)

Firebase Functions **Spark (free)** planında **çalışmaz**. Blaze (pay-as-you-go) gerekir.

### Blaze Maliyet Tahmini
- İlk 2M invocation/ay: **ücretsiz**
- Sonrası: $0.40 / milyon invocation
- PoCHub MVP'de aylık ~$0–5 beklenir
- **Limit koyabilirsin**: Console → Billing → Budget alert (örn. $20/ay limit)

### Blaze'e Geç
1. Firebase Console → Sol alt köşede plan adı → Modify Plan
2. Blaze (Pay-as-you-go) seç
3. Kredi kartı ekle
4. **Budget alert mutlaka kur**: $20/ay = uyarı, $50/ay = limit

---

## 🚀 5. Functions Deploy

### 5.1 Bağımlılıkları Yükle
```bash
cd functions
npm install
```

İlk seferde ~2 dakika alır (firebase-admin + firebase-functions paketleri).

### 5.2 Build (TypeScript → JavaScript)
```bash
npm run build
# lib/ klasörü oluşur, içinde derlenmiş .js dosyaları var
```

Hata alırsan:
```bash
# Lint hataları
npm run lint

# TypeScript hataları
npx tsc --noEmit
```

### 5.3 İlk Deploy
```bash
# functions klasöründen veya repo root'undan:
firebase deploy --only functions
```

İlk deploy ~3-5 dakika sürer. Sonunda:
```
✔  functions[europe-west1-helloWorld]: Successful create operation.
✔  functions[europe-west1-getServerTime]: Successful create operation.
✔  functions[europe-west1-getCurrentUser]: Successful create operation.
```

URL şuna benzer:
```
https://europe-west1-PROJE-ID.cloudfunctions.net/helloWorld
```

---

## ✅ 6. Test

### 6.1 PoCHub Üzerinden Test (En Kolay)
1. `pochub-v4.75.html`'i deploy et (GitHub Pages'a push)
2. Admin olarak giriş yap
3. **Sistem Ayarları → ☁️ Firebase Functions Sağlık Kontrolü** bölümüne git
4. **🔵 helloWorld testi** tıkla → result kutusunda yeşil sonuç görmelisin:
   ```json
   {
     "ok": true,
     "data": {
       "message": "Hello from PoCHub Functions!",
       "version": "v4.75",
       "region": "europe-west1",
       "timestamp": 1715000000000,
       "authenticated": true
     }
   }
   ```

### 6.2 Diğer Testler
- **⏰ getServerTime**: Server saat dilimini görür + client/server clock skew hesaplar
- **👤 getCurrentUser**: Server-side kendi user bilginizi okur (rol, subscription, billing)

### 6.3 Logs
```bash
firebase functions:log

# Sadece son 5 dakika:
firebase functions:log --since 5m

# Sadece bir function:
firebase functions:log --only helloWorld
```

---

## 🔧 7. Lokal Emulator (Opsiyonel, Geliştirme İçin)

Deploy yapmadan lokal test için:

```bash
cd functions
npm run build
firebase emulators:start --only functions
```

Emulator açılır:
- Functions: http://localhost:5001
- UI: http://localhost:4000

PoCHub'ı emulator'a bağlamak için (geçici, geliştirme için):
```javascript
// HTML'de getFunctions(app, 'europe-west1') sonrası:
import { connectFunctionsEmulator } from 'firebase-functions';
connectFunctionsEmulator(fns, 'localhost', 5001);
```

⚠️ Production'a deploy ederken bu satırı kaldırmayı unutma!

---

## 🛡️ 8. Güvenlik

### 8.1 Secrets (v4.76+)
iyzico API key gibi hassas bilgiler **kesinlikle koda yazılmaz**. Functions secrets kullan:

```bash
# Secret tanımla (deploy gerektirmez):
firebase functions:secrets:set IYZICO_API_KEY
# Değeri yapıştır, Enter

# Listeyi gör:
firebase functions:secrets:access IYZICO_API_KEY
```

Kodda kullanım:
```typescript
import {defineSecret} from "firebase-functions/params";
const iyzicoKey = defineSecret("IYZICO_API_KEY");

export const myFunction = onCall(
  { secrets: [iyzicoKey] },
  async (request) => {
    const key = iyzicoKey.value();
    // ...
  }
);
```

### 8.2 CORS
Functions v2 callable function'larda CORS otomatik handle edilir. Sadece **gerçek browser**'dan çağrıldığında çalışır (curl ile çağırılamaz, auth token zorunlu).

### 8.3 Auth Token Kontrolü
Tüm protected function'lar `requireAuth()`/`requireAdmin()`/`requireVendor()` helper'ları kullanır (helpers.ts'te).

---

## 🚨 9. Sorun Giderme

### Hata: "permission-denied" — Auth gerekli
**Sebep**: Function `requireAuth()` çağırıyor, ama client'tan auth token gelmemiş.
**Çözüm**: Firebase Auth'a login yapılmış olmalı. PoCHub'da zaten otomatik.

### Hata: "internal" — Bir şeyler ters gitti
**Sebep**: Function içinde uncaught exception.
**Çözüm**: `firebase functions:log` ile logları kontrol et. Genelde Firestore okuma hatası veya TypeScript runtime hatası.

### Hata: "deadline-exceeded" — Timeout
**Sebep**: Function 60 saniyeden uzun sürdü.
**Çözüm**: `index.ts`'te `timeoutSeconds` artır (max 540 saniye HTTP'de).

### Hata: Build başarısız
**Çözüm**:
```bash
cd functions
rm -rf node_modules lib
npm install
npm run build
```

### Hata: "Region mismatch" — Function europe-west1'de değil
**Sebep**: Client `europe-west1` kullanıyor ama function başka region'da.
**Çözüm**: `index.ts`'te `setGlobalOptions({region: 'europe-west1'})` doğru. Re-deploy.

### Hata: Cold start çok yavaş
**Çözüm**: Min instances ayarla (v4.76+ için):
```typescript
// Sadece kritik function'lar için:
export const importantFn = onCall({minInstances: 1}, async (req) => { ... });
```
Ekstra ücret olur (~$5/ay), ama latency 50ms'e iner.

---

## 📊 10. Bundan Sonra

v4.75 tamamlandığında:

| Versiyon | İçerik | Hasan'ın Yapacağı |
|---|---|---|
| **v4.75** ✅ | Functions kurulumu | İlk deploy + sağlık testi |
| **v4.76** | iyzico entegrasyonu | iyzico merchant hesabı + sandbox key |
| **v4.77** | EmailJS templates | EmailJS hesabı + 7 template oluştur |
| **v4.78** | Scheduled cron | Sadece deploy (kod hazır) |
| **v4.79** | Firestore Rules | Production rules deploy |
| **v4.80** | Premium lazy-load | Sadece HTML yenileme |

---

## 📝 Hızlı Komutlar (Cheatsheet)

```bash
# Deploy
firebase deploy --only functions

# Sadece belirli function
firebase deploy --only functions:helloWorld

# Logs
firebase functions:log --since 1h

# Listele
firebase functions:list

# Sil (gerekirse)
firebase functions:delete helloWorld --region europe-west1

# Emulator
firebase emulators:start --only functions

# Secrets
firebase functions:secrets:set MY_KEY
firebase functions:secrets:access MY_KEY
```

---

## ❓ Bu Aşamada Beklenen Sorular

**S: Functions kurulu değilse PoCHub çalışmaz mı?**
C: **Çalışır.** v4.75'te sadece sağlık kontrolü testleri Functions'a gidiyor. Ana akışların hepsi (paket alma, PoC kabul, override, vs.) **henüz Firestore üzerinden direkt**. Functions'a v4.76+ taşınacak.

**S: Test ortamı (dev) ve production'ı nasıl ayıracağım?**
C: İki yöntem:
1. **Aynı projede environment alanı** (`.env` veya secrets'tan farklı değerler)
2. **İki ayrı Firebase projesi** (`pochub-dev`, `pochub-prod`) — `.firebaserc`'te alias'larla

İlerde Phase 3'te ikincisini şiddetle öneririm.

**S: Functions deploy'u CI/CD ile yapayım mı?**
C: Şimdilik **manuel deploy** yeterli. Phase 3'te GitHub Actions ile otomatize edilir (`firebase deploy --token CI_TOKEN`).

---

**Sorularını v4.75 test ettikten sonra sor. Çıkan hata mesajlarını paylaş, gerekirse v4.75.1 patch'i çıkarırım.**

— Claude (Anthropic)
