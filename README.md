# tiapps.github.io — Инструкции за качване

## 1. Създай GitHub акаунт "tiapps" (ако още нямаш)
GitHub → Sign up → username: **tiapps**

## 2. Създай repo с точното име
- New repository → име: **tiapps.github.io** (точно това, с .io накрая)
- Public ✓
- Create repository

## 3. Качи файловете
През уеб интерфейса (Add file → Upload files) качи:
- `index.html`
- `privacy.html`
- `app-ads.txt`

Commit → готово.

## 4. Провери, че Pages е активен
Settings → Pages → Source трябва да е "Deploy from a branch" / main.
За repo с име username.github.io обикновено е автоматично.

След 1-2 минути сайтът е жив на: **https://tiapps.github.io**
Провери и: **https://tiapps.github.io/app-ads.txt**

## 5. Свържи с Google Play (и за двете приложения!)
Play Console → приложение → Grow → Store presence → Store listing
→ поле "Website" → въведи: **https://tiapps.github.io**
→ Запази (може да мине преглед до 24ч)

Направи го и за TV DSP Center, и за World Radio.

## 6. Обнови и Privacy Policy URL (препоръчително)
Play Console → App content → Privacy policy
→ въведи: **https://tiapps.github.io/privacy.html**

## 7. Потвърди в AdMob
След като Play обявата се обнови (изчакай ~24ч):
AdMob → Apps → TV DSP Center → App settings
→ "Проверка за актуализации" при app-ads.txt
Статусът трябва да стане "Потвърдено" ✓

## ВАЖНО — имейлът за поддръжка
В index.html и privacy.html е сложен placeholder: **support@tiapps.dev**
Замени го с реалния си имейл (търси "support@tiapps.dev" в двата файла
и го замени, напр. с Gmail-а, който ползваш за Play Console).

## По-късно: собствен домейн
Ако си купиш домейн (напр. tiapps.dev):
- Settings → Pages → Custom domain → въведи домейна
- При регистратора: CNAME запис към tiapps.github.io
- app-ads.txt автоматично ще важи на новия домейн
- Смени Website URL-а в Play Console на новия домейн
