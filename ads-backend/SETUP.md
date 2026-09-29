# Фаза 1 — Firebase проект `ads` (стъпки за теб)

Проектът се създава в конзолата на Firebase; от тук не мога да го направя.
Папката съдържа готовите правила: `database.rules.json`, `storage.rules`,
`firebase.json`. В тях има `REPLACE_WITH_ADMIN_UID` — вижте стъпка 5.

1. **Нов проект.** console.firebase.google.com → Add project → име `tiapps-ads`
   (Google Analytics не е нужен).
2. **Blaze.** Upgrade → Blaze (нужен е за Storage и по-късно за Functions).
   Веднага след това: Google Cloud Console → Billing → Budgets & alerts →
   бюджет напр. 5 EUR/месец с известия на 50% / 90% / 100%.
3. **Realtime Database.** Build → Realtime Database → Create → регион
   `europe-west1` → Locked mode.
4. **Storage.** Build → Storage → Get started → същия регион (production mode).
5. **Authentication.** Build → Authentication → Sign-in method → Google →
   включи. В Settings → Authorized domains добави `tiapps.dev` (и домейна на
   сайта, ако е друг). Влез веднъж с Google (ще стане от `admin-ads.html`
   във Фаза 2, или ръчно от Users → Add user). Копирай **User UID** на своя
   акаунт от Authentication → Users. UID-ът е различен във всеки проект.
6. **Правилата.** Замени `REPLACE_WITH_ADMIN_UID` с UID-а във `database.rules.json`
   и `storage.rules`, после ги постави в конзолата (Realtime Database → Rules;
   Storage → Rules) или дай `firebase deploy --only database,storage`.
7. **Web app.** Project settings → Your apps → Add app → Web → копирай
   `firebaseConfig` (apiKey, databaseURL, storageBucket…) и ми го прати —
   тези стойности не са тайни (същите са в `admin.html`), но трябват на
   `admin-ads.html`.
8. **CORS/reCAPTCHA (по-късно, за `advertise.html`).** App Check + reCAPTCHA v3
   се настройват във Фаза 3.

Проверка: в Rules Playground: четене на `/feed/worldradio` без вход → разрешено;
четене на `/campaigns` без вход → отказано; запис в `/feed/worldradio` без вход
→ отказано.

Какво още не е включено нарочно: писане на `stats` от приложенията
(Фаза 4/5) — правилата за него се добавят заедно с приложенията.
