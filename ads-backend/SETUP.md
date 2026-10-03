> **Внимание:** проектът вече съществува и работи. Името му е `tiapps-ads`, **Project ID е `tiapps-ads`**
> (бакет `tiapps-ads.firebasestorage.app`). Фаза 1 по-долу е ИЗПЪЛНЕНА, не я повтаряй и не създавай
> нов проект. Ако в списъка с проекти видиш друг със същото име (напр. `tiapps-ads-be27d`), това е
> грешка. Работи се само с този, чийто ID е точно `tiapps-ads`. Следващата ти стъпка е „Фаза A“ най-долу.

# Фаза 1 — Firebase проект `ads` (стъпки за теб)

Проектът се създава в конзолата на Firebase; от тук не мога да го направя.
Папката съдържа готовите правила: `database.rules.json`, `storage.rules`,
`firebase.json`. UID-ът на админа (`5bCbdUU29cPtffTXwNJw5DzigSd2`) е вече попълнен; остава правилата да се публикуват в конзолата (стъпка 6).

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

---

# Фаза A — Cloud Functions, имейл, App Check (стъпки за теб)

Код: `ads-backend/functions/`. Функции в тази стъпка:

| Функция | Какво прави |
|---------|-------------|
| `rebuildFeed` | всяко записване в `campaigns/` прегражда `feed/{app}` (пише само ако нещо се е променило) |
| `republishFeed` | за бутона „Republish feed“ (само админ) |
| `sendTestEmail` | праща тестов имейл, за да се провери Resend и DNS (само админ) |

Админ страницата засега продължава да пише feed-а и от браузъра. Сървърът го пише успоредно, резултатът е същият. Браузърният запис се маха в следващата стъпка, след като потвърдиш, че сървърният работи.

## 1. Инструменти (веднъж)

```
npm install -g firebase-tools
firebase login
```

В папката `ads-backend`: `firebase use tiapps-ads` (проектът е вече в `.firebaserc`).
Node трябва да е 22 или по-нов: `node -v`.

## 2. Resend

1. resend.com → регистрация → Domains → Add domain → `tiapps.dev`, регион EU (Ireland).
2. Resend показва DNS записи (SPF, DKIM, по желание DMARC). Добави ги при доставчика на домейна.
   Не пипай съществуващите MX и SPF записи за личната си поща: ако вече има SPF (`v=spf1 …`),
   Resend ще покаже как да се добави към него вместо нов втори запис.
3. Изчакай статус **Verified** в Resend.
4. API Keys → Create → право „Sending access“, само за домейна `tiapps.dev`. Копирай ключа
   (показва се един път).

## 3. Ключът и настройките

```
firebase functions:secrets:set RESEND_API_KEY
```

(поставяш ключа; не се записва в кода). Адресите са в `functions/.env` (по желание; имат подразбиращи се стойности):

```
MAIL_FROM=TI Apps <noreply@tiapps.dev>
ADMIN_EMAIL=todorilinov@googlemail.com
```

## 4. Разгръщане

```
cd functions
npm install
cd ..
firebase deploy --only functions
```

При първото разгръщане Firebase може да поиска да включи API-та (Cloud Functions,
Cloud Build, Artifact Registry, Secret Manager, Eventarc): отговори „yes“. Ако покаже
грешка за Eventarc/разрешения, изчакай 2–3 минути и повтори командата.

Проверка на `rebuildFeed`: в `admin-ads.html` промени нещо в кампания и я запиши, после в
конзолата: Functions → Logs → `rebuildFeed` трябва да покаже `written: [...]` (празен
списък значи, че браузърът е написал същото преди сървъра, и това е нормално).

## 5. Бюджет

Google Cloud Console → Billing → Budgets & alerts: бюджетът от Фаза 1 остава (напр. 5 EUR).
Функциите са с `maxInstances: 5`.

## 6. App Check за сайта (reCAPTCHA)

Ще се ползва от `advertise.html` (фаза B). Сега само регистриране, без включване:

1. Google Cloud Console → Security → reCAPTCHA → Create key → **Website**, домейни `tiapps.dev`,
   тип score-based (v3). Копирай **site key**.
2. Firebase Console → Build → App Check → Apps → уеб приложението → **reCAPTCHA v3** →
   поставяш **secret key** от същата страница (reCAPTCHA v3 в Firebase иска ключ от
   reCAPTCHA v3 консолата: https://www.google.com/recaptcha/admin ; ако избереш Enterprise, ползвай
   ключа от Cloud Console).
3. Не натискай Enforce за Realtime Database и Storage: оставя се **Unenforced**. Проверката
   на `submit` и `track` е в кода на функциите (фази B и F). Включването върху цялата база ще
   счупи приложенията, които още не пращат App Check токен.
4. Прати ми **site key** (не е тайна).

---

# Бележки от първото разгръщане (Фаза A)

- **Първо разгръщане на 2nd gen функции:** `firebase deploy` може да се провали с Eventarc или
  Secret Manager грешка. Включи API-то от линка в съобщението, изчакай 3–5 минути и пусни пак.
- **„Forbidden“ или CORS грешка в админа:** функциите `republishFeed` и `sendTestEmail` трябва
  да са публично достъпни за извикване (Cloud Run → услугата → Security → **Allow public access**
  → View diff & redeploy → Deploy changes). Проверка: адресът `https://<функция>-….run.app` в
  браузъра трябва да отговаря „Bad Request“, не „Forbidden“.
- **Имейл:** Resend с домейна `tiapps.dev` (DNS през Cloudflare, Auto configure). Click tracking
  остава изключен, защото писмата ще съдържат тайни линкове. Ключът е в Secret Manager:
  `firebase functions:secrets:set RESEND_API_KEY` (името е точно това, ключът се въвежда на
  следващия ред и никога не се показва или пише в чата).
- **Проект:** само `tiapps-ads` (ID `tiapps-ads`).

---

# Фаза B — форма за рекламодатели (стъпки за теб)

Нови неща: `advertise.html` (скрита страница), функциите `submit` и `cleanupUploads`, нови
правила за Storage и базата, раздел „Requests“ в `admin-ads.html`.

## 1. Свали новия код

Свали ZIP на `main` и го разархивирай в **нова** папка, например `C:\tiapps\v2`:
`https://github.com/todorilinov/todorilinov.github.io/archive/refs/heads/main.zip`
Вътре отиди в `ads-backend` (при разархивиране може да има две вложени папки със същото име).

## 2. Разгърни

В PowerShell, в папката `ads-backend`:

```
firebase use tiapps-ads
cd functions
npm install
cd ..
firebase deploy --only functions,database,storage
```

- В новата папка няма старите настройки, затова ще те попита за `MAIL_FROM`, `ADMIN_EMAIL` и
  `APPCHECK_REQUIRED`. На всичките натисни **Enter** (подразбиращите се стойности са правилни).
  Тайната `RESEND_API_KEY` е вече записана и няма да я пита.
- Ако поиска да включи API (Cloud Scheduler и други): `y`. Ако даде грешка за права, изчакай
  3 минути и повтори.
- `database` и `storage` качват новите правила (публичното качване вече е само в `uploads/`).

## 3. Направи функцията публична (както миналия път)

Cloud Run → услугата **submit** → Security → **Allow public access** → View diff & redeploy →
Deploy changes. Проверка: адресът на `submit` (от Functions страницата) в браузъра трябва да
каже „Bad Request“, не „Forbidden“. `cleanupUploads` се вика от Google, не от браузъра: не я пипай.

## 4. Проба от край до край

1. Отвори `https://tiapps.dev/advertise.html` (линк към нея няма отникъде).
2. Попълни формата със свой друг имейл, качи банер с точния размер и изпрати.
3. Трябва да видиш „Request received“ с референтен номер и да получиш два имейла: потвърждение
   (на имейла от формата) и известие за теб.
4. В `admin-ads.html` → таб **Requests** заявката се вижда с файловете. Линкът за статус в
   писмото още не работи: страницата `ad-status.html` идва във фаза C.
5. Изтрий пробната заявка с бутона **Delete**.

## 5. App Check (по-късно, когато има reCAPTCHA ключ)

Сложи ключа в `APP_CHECK_SITE_KEY` в `advertise.html`, а във функциите стойност `true` на
`APPCHECK_REQUIRED` (пита се при разгръщане). Докато ключът е празен, защитата са скритото поле,
ограничението на заявките (5 на час за адрес, 100 на ден общо) и проверката на файловете.
