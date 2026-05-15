# Firestore Rules Deploy Guide

**Versiyon**: v4.79
**Tarih**: Mayıs 2026
**Hedef**: Production Firestore Security Rules + Indexes deploy

---

## 🎯 Bu Versiyon NEDEN ÖNEMLİ

Şu anda PoCHub Firestore'u **test moddadır** — herkes her şeyi yazabilir/okuyabilir. Production'da bu güvenlik açığı:

| Tehdit | Sonuç |
|---|---|
| Vendor başka vendor'ın profilini yazabilir | Marka manipülasyonu |
| Müşteri başka müşterinin PoC'larını görebilir | Gizlilik ihlali |
| Herhangi biri `pochub_packages` fiyatını değiştirebilir | Fiyat manipülasyonu |
| `subscription_history` herkese açık | Mali bilgi sızıntısı |
| `audit_log` herkes silebilir | Trail bozulur |

**v4.79 bunları kapatır.**

---

## 🟢 Bu Versiyon Spark Plan'da Çalışır!

- ❌ Functions deploy GEREKMİYOR
- ❌ Blaze plan GEREKMİYOR  
- ❌ Ücret YOK
- ✅ Spark plan'da direkt çalışır
- ✅ Sadece Firestore Rules ve Indexes deploy edilir

---

## 📋 Ön Hazırlık

Bilgisayarınızda olması gerekenler:
- ✅ Node.js (v4.75'te kurduk)
- ✅ Firebase CLI (v4.75'te kurduk)
- ✅ `firebase login` yapılmış
- ✅ Repo lokal'de (`Documents\Projects\pochub-demo`)

Kontrol:
```powershell
cd $env:USERPROFILE\Documents\Projects\pochub-demo
firebase projects:list
# pochub-co görünmeli
```

---

## 🚀 Deploy Adımları

### Adım 1: Dosyaları Repo'na Kopyala

İndirdiğin v4.79 paketinde:
- `firestore.rules` → repo root'una
- `firestore.indexes.json` → repo root'una
- `firebase.json` → repo root'unda var olanın üzerine yaz

### Adım 2: Git'e Commit (önerilir)

```powershell
git status
# Yeni dosyaları gör

git add firestore.rules firestore.indexes.json firebase.json
git commit -m "v4.79: production firestore rules + indexes"
git push
```

### Adım 3: Rules'ları Lokal Test Et (opsiyonel)

```powershell
cd $env:USERPROFILE\Documents\Projects\pochub-demo
firebase emulators:start --only firestore
```

Tarayıcıda http://localhost:4000/firestore aç → Rules sekmesi → test kuralları çalışır mı kontrol et.

Bu adımı **atlayabilirsin** — production rules'da test edip rollback yapmak da OK.

### Adım 4: Rules Deploy

```powershell
firebase deploy --only firestore:rules
```

**Çıktı**:
```
=== Deploying to 'pochub-co'...

i  deploying firestore
i  firestore: reading indexes from firestore.indexes.json...
i  cloud.firestore: checking firestore.rules for compilation errors...
✔  cloud.firestore: rules file firestore.rules compiled successfully
✔  firestore: deployed cloud.firestore rules to firestore.rules

✔  Deploy complete!
```

**Süre**: ~10 saniye

### Adım 5: Indexes Deploy

```powershell
firebase deploy --only firestore:indexes
```

**Çıktı**:
```
i  firestore: deploying indexes...
✔  firestore: deployed indexes (15 new, 0 removed)
```

⚠️ **Önemli**: Indexes oluşturulurken **5-15 dakika** sürebilir (Firebase backend asenkron yapar). Çalışıyor olarak işaretlenir, sonra "Enabled" olur.

### Adım 6: Tek Komutla İkisi Birden (alternatif)

```powershell
firebase deploy --only firestore
```

Hem rules hem indexes deploy.

---

## 🧪 Deploy Sonrası Test

### Test 1: Admin Erişimi
1. PoCHub'a admin olarak giriş yap
2. Admin paneline git → Tüm sayfaları gez
3. Beklenen: Hiçbir hata yok, her şey çalışıyor ✅

### Test 2: Vendor Sınırları
1. Vendor olarak giriş yap
2. Kendi profilini güncelle → ✅ olmalı
3. Browser DevTools Console'da:
```javascript
// Başka vendor'ın profilini değiştirmeyi dene (test)
import { doc, updateDoc } from 'firebase/firestore';
updateDoc(doc(db, 'users', 'BASKA-VENDOR-UID'), { displayName: 'Hack' });
```
**Beklenen**: ❌ `permission-denied` hatası

### Test 3: Customer Sınırları
1. Customer olarak giriş yap
2. Kendi PoC'unu görüntüle → ✅
3. Başka customer'ın PoC'unu okumayı dene:
```javascript
const otherPoc = await getDoc(doc(db, 'poc_requests', 'BASKA-POC-ID'));
```
**Beklenen**: ❌ `permission-denied`

### Test 4: Index Eksikliği
Eğer bir sorgu yaparken Console'da şu hata çıkarsa:
```
The query requires an index. You can create it here: <link>
```
→ Link'e tıkla, Firebase Console otomatik index önerir → "Create Index"

`firestore.indexes.json`'a ekleyebilirsin, sonraki deploy'da gelecek.

---

## 🛡️ Rollback (Yanlış Giderse)

Eğer deploy sonrası PoCHub'da hatalar çıkarsa:

### Hızlı Rollback — Firebase Console
1. https://console.firebase.google.com/project/pochub-co/firestore/rules
2. Üst sağda **"Version history"** veya **"Rules Playground"**
3. Önceki versiyonu bul → **"Restore"**
4. PoCHub eski rules'a döner

### Bekle ve Düzelt
Eğer "minor bir alan eksik" tipi hatalar varsa:
1. `firestore.rules`'da düzeltme yap
2. `firebase deploy --only firestore:rules`
3. Tekrar test

---

## 🆘 Yaygın Sorunlar

### "Missing or insufficient permissions"
- Frontend'de bir sorgu RBAC'ı geçemiyor
- Çözüm: Console'daki hatayı incele, hangi koleksiyon → rules'ı kontrol et

### "The query requires an index"
- Composite index eksik
- Çözüm: Hata linkindeki "Create Index" tıkla VEYA `firestore.indexes.json`'a ekle

### Deploy Çok Yavaş
- Indexes 5-15 dakika sürebilir
- Console'da "Indexes" sayfasında durumu görürsün

### Rules Compilation Error
- Syntax hatası
- Çözüm: Hata mesajını paylaş, `firestore.rules` düzeltelim

---

## 📊 Bundan Sonra Ne Olacak?

✅ **Production-grade güvenlik aktif**  
✅ Audit trail kapalı (yazılamaz)  
✅ Vendor manipülasyonu engellenmiş  
✅ Customer gizliliği korunmuş  

Bir sonraki versiyon:
- **v4.80**: Premium Lazy-Load Mimari (HTML boyut optimizasyonu, ~1185 KB → ~1030 KB)

---

## ❓ Sorular

Deploy sırasında bir hata gelirse:
1. Hata mesajının **tam metnini** paylaş
2. `firebase deploy --only firestore --debug` çalıştır, çıktıyı paylaş
3. Console → Firestore → Rules → mevcut rules'ın **ekran görüntüsü**

— Claude (Anthropic)
