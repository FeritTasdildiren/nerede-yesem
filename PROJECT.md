# Nerede Yesem?

## Proje Özeti
Konum bazlı yemek öneri uygulaması. Kullanıcının bulunduğu veya seçtiği lokasyondaki restoranların Google Maps yorumlarını analiz ederek, istediği yemek türü için en iyi mekanları öneren akıllı bir web uygulaması.

## Temel Özellikler

### v1.0 (MVP)
1. **Konum Belirleme**
   - Kullanıcının mevcut konumunu algılama (Geolocation API)
   - Manuel adres/bölge girişi
   - Harita üzerinden bölge seçimi

2. **Yemek Tercihi**
   - Kullanıcıdan yemek türü alma (örn: lahmacun, pizza, döner)
   - Popüler yemek önerileri

3. **Restoran Analizi**
   - Google Maps/Places API entegrasyonu
   - 50+ yorumu olan mekanları filtreleme
   - Son 50 yorumu çekme

4. **Yorum Analizi (AI)**
   - Yorumlarda belirtilen yemek türünü arama
   - Sentiment analizi (olumlu/olumsuz)
   - Puan hesaplama

5. **Öneri Sistemi**
   - En iyi alternatifleri sıralama
   - Detaylı bilgi gösterimi (adres, telefon, yol tarifi)

## Hedef Kitle
- Yemek yemek için mekan arayan herkes
- Özellikle yeni bir şehirde/semtte olan kullanıcılar
- Kaliteli yemek deneyimi arayanlar

## Başarı Kriterleri
- Doğru ve güncel restoran bilgileri
- Güvenilir yorum analizi
- Hızlı yanıt süresi (<5 saniye)
- Kullanıcı dostu arayüz

## Durum
- **Başlangıç**: 2025-01-28
- **Mevcut Aşama**: Planlama
- **Platform**: Web
