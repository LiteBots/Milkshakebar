# Milkshakebar i MilkMi

Strona Milkshakebar, aplikacja lojalnościowa MilkMi, zamawiarka i panel lokalu. Node.js (Express) i MongoDB, wdrażane na Railway.

## Co nowego w 4.0

- **Śniadania** (karta ze zdjęcia, te same ceny) w zamawiarce i na stronie `/menu/sniadania`. Zamówienie ze śniadaniem można złożyć i odebrać najpóźniej o 13:00: nie da się zamówić śniadania o 9:00 z odbiorem o 14:00. Godzinę zmienisz w panelu: Zamówienia → Ustawienia zamawiarki → „Śniadania do godziny”. Serwer sprawdza to sam, nie tylko strona.
- **Zamówienia w panelu**: tablica na żywo (Nowe / W przygotowaniu / Gotowe), przyjęcie z czasem (10–60 min), „+10 min” z powiadomieniem dla klienta, anulowanie z powodem, notatka obsługi, wydruk bonu, historia zmian. Przy każdej pozycji widać wariant, **zestaw (dodatek i napój)** i **dodatki** z cenami, uwagi klienta, adres z mapą i kwotę do pobrania. Do tego szybkie przełączniki: wstrzymanie zamówień na 15/30/60 min, tryb „dużo zamówień” (+15/30/45 min) i wyłączanie produktów, których zabrakło.
- **Paragony w MilkMi**: Profil → Moje zamówienia → dotknij zamówienia. Data, co zamówiono (z zestawem i dodatkami), odbiór czy dostawa, adres, płatność i jej status, opakowania, dostawa, saldo MilkMi, Milkosy.
- **Bez ukrytych kosztów**: koszyk, podsumowanie i status zamówienia zawsze pokazują produkty, opakowania (także 0 zł), dostawę (przy dostawie), saldo i kwotę do zapłaty.
- **Godziny zamówień online** (Zamówienia → Ustawienia zamawiarki): jak godziny otwarcia, własne godziny na każdy dzień albo całą dobę. Do tego: ostatnie zamówienie X min przed końcem (np. zamykamy 21:00, zamówienia do 20:30), najpóźniejszy odbiór/dostawa, na ile do przodu i czy przed otwarciem można zamówić na później. Godziny na stronie i w Google się nie zmieniają. Serwer sam sprawdza te zasady, a zamawiarka dostaje gotowe terminy i odświeża je co minutę.
- **MilkMi**: na ekranie startowym jest jeden duży, pomarańczowy przycisk „Zamów”. Numer do kasy otwiera środkowy przycisk na dolnym pasku.
- **Powrót do MilkMi** z zamawiarki: przycisk „Wróć do MilkMi” na górze (na telefonie aplikacja z ekranu początkowego nie ma przycisku „wstecz”).
- **Nowe statystyki**: karty z trendem, wykres z poprzednim okresem, struktura sprzedaży (kategorie, zestawy, dodatki, śniadania), wykresy kołowe płatności i odbiór/dostawa.
- **Fundamenty i bezpieczeństwo**: testy automatyczne, GitHub Actions, transakcje przy operacjach na saldzie, kwoty liczone w groszach, limity prób logowania w bazie, zdjęcia w chmurze (S3/R2), sprawdzanie plików, CSP i CORS, mocniejsze PIN-y, szyfrowana kopia bazy.

## Adresy

| Adres | Co to jest |
|---|---|
| `/` | Strona główna |
| `/app` | Aplikacja MilkMi (klienci mają ją przypiętą na telefonie) |
| `/zamow` | Zamawiarka online (stary adres `/zamów` przekierowuje tutaj) |
| `/menu` | Przekierowuje do zamawiarki `/zamow` (tam jest aktualne menu z cenami) |
| `/menu/shake`, `/menu/burgery`, `/menu/sniadania`… | Strony kategorii z cenami (dla Google) |
| `/slupsk`, `/rowy` | Strony lokali: godziny z panelu, mapa, dojazd |
| `/milkmi` | Opis programu: poziomy, polecenia, urodziny, misje, happy hours |
| `/karty-podarunkowe` | Zakup karty podarunkowej online (PayU) |
| `/dostawa`, `/regulamin-milkmi`, `/cookies` | Informacje i regulaminy |
| `/sitemap.xml`, `/robots.txt` | Dla wyszukiwarek |
| `/admin` | Panel lokalu (logowanie PIN-em) |

Pliki stron leżą w `public/` (nazwy plików bez polskich znaków: macOS zapisuje „ó” inaczej niż serwer na Linuksie). Podstrony SEO generuje `seo.js` (treść widoczna dla Google bez JavaScriptu). Serwer udostępnia tylko `public/` i `uploads/`.

## Po wdrożeniu: Google

1. Załóż lub przejmij profile w Google (Google Business Profile) dla Słupska i Rowów, z linkiem do `/zamow`.
2. W Google Search Console dodaj domenę i zgłoś `https://www.milkshakebar.pl/sitemap.xml`.
3. W panelu: Program lojalnościowy → „Dane firmy do regulaminu” (nazwa, adres, NIP, e-mail). Bez tego regulamin pokazuje tylko „Milkshakebar” i adres lokalu.

## Zmienne na Railway

| Zmienna | Opis |
|---|---|
| `MONGO_URL` | Adres bazy (ustawia Railway) |
| `ADMIN_PIN` | PIN właściciela do panelu |
| `PAYU_POS_ID`, `PAYU_CLIENT_ID`, `PAYU_CLIENT_SECRET`, `PAYU_ENV` | Płatności PayU (`PAYU_ENV=secure` = produkcja) |
| `PAYU_SECOND_KEY` | Drugi klucz PayU: bez niego powiadomienia o płatności są odrzucane |
| `APP_URL` | Opcjonalnie, domyślnie `https://www.milkshakebar.pl` |
| `JWT_SECRET` | Opcjonalnie. Gdy brak, serwer tworzy klucz przy pierwszym starcie i zapisuje go w bazie |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL` | Zalecane. Zdjęcia z panelu w chmurze (Cloudflare R2 albo AWS S3), żeby nie znikały przy wdrożeniu. Dla R2 dodaj `S3_ENDPOINT=https://<id-konta>.r2.cloudflarestorage.com`; `S3_PUBLIC_URL` to publiczny adres bucketu (np. `https://zdjecia.milkshakebar.pl`). Bez nich zdjęcia trafiają do `uploads/` |
| `CORS_ORIGINS` | Opcjonalnie: dodatkowe domeny (po przecinku), z których przeglądarka może wołać API. Nasza domena (z `www` i bez) jest dozwolona zawsze |
| `CSP` | Opcjonalnie: `report-only` (tylko zgłasza naruszenia) albo `off`. Domyślnie CSP jest włączone |

`ADMIN_PIN` ustaw na co najmniej 8 cyfr: serwer ostrzega w logach, gdy jest krótszy. Nowe PIN-y pracowników mają 6–8 cyfr (bez samych tych samych i kolejnych cyfr, każdy inny); stare 4-cyfrowe dalej działają, ale warto je zmienić w zakładce Zespół.

## Testy i kontrola jakości

```bash
npm install
npm test
```

Testy (`test/`) uruchamiają serwer na tymczasowej bazie MongoDB (pierwsze uruchomienie pobiera ją raz, ok. 100 MB) i sprawdzają m.in.: ceny z zestawami i dodatkami, regułę śniadań do 13:00, płatność saldem i zwrot przy anulowaniu, wymianę Milkosów, powiadomienia PayU z podpisem, limity prób logowania, PIN-y, uploady i nagłówki bezpieczeństwa. GitHub Actions (`.github/workflows/ci.yml`) robi to samo przy każdym wypchnięciu zmian.

Podgląd bez instalowania MongoDB, z przykładowymi zamówieniami: `npm run dev:memory`, potem `http://localhost:3000/zamow` i `/admin` (PIN `12345678`).

## Struktura kodu

| Plik | Co zawiera |
|---|---|
| `server.js` | Uruchomienie, logowanie, klienci, program MilkMi, PayU, karty podarunkowe, pozostałe trasy |
| `models.js` | Modele bazy danych |
| `routes/orders.js` | Zamówienia: składanie, status i paragony dla klienta, obsługa w panelu |
| `analytics.js`, `seo.js` | Analityka panelu i podstrony dla Google |
| `lib/` | Wspólna logika bez Expressa: ceny (`pricing.js`), grosze (`money.js`), czas polski (`time.js`), śniadania (`breakfast.js`), limity prób (`rateLimit.js`), zdjęcia (`storage.js`), transakcje (`tx.js`), nagłówki (`security.js`) |

Kolejne trasy z `server.js` (program MilkMi, karty podarunkowe, zespół) można przenosić do `routes/` w ten sam sposób co zamówienia.

## Kopie zapasowe bazy

`.github/workflows/backup.yml` codziennie robi zaszyfrowaną kopię bazy i wysyła ją do prywatnego bucketu S3/R2 (repozytorium jest publiczne, więc kopia nie trafia do GitHuba). Potrzebne sekrety są opisane na górze pliku, a odtworzenie w `scripts/restore-backup.md`.

## Transakcje

Operacje na saldzie (wpłata w kasie, płatność saldem przy zamówieniu, zwrot, wymiana Milkosów, karta podarunkowa do portfela) zapisują się w całości albo wcale, gdy baza obsługuje transakcje (MongoDB Atlas albo zestaw replik). Na pojedynczym serwerze MongoDB działają jak dotąd, bez transakcji. Stan widać w panelu: System.

## Program MilkMi

- 10 zł wydane = 1 Milkos (kasa w panelu nalicza po numerze telefonu; zamówienie online po oznaczeniu jako „Wydane”).
- 1 Milkos = 1 vPLN przy wymianie w aplikacji.
- Zasady i bony zmienia właściciel w panelu: zakładka „Program lojalnościowy”.
- **Poziomy** (Bronze / Silver / Gold, ustawiane w panelu): liczone z wydatków z ostatnich 12 miesięcy, wyższy poziom mnoży Milkosy.
- **Happy hours** (zakładka „Happy hours”): w wybranych dniach i godzinach Milkosy ×2 (albo inny mnożnik). Łączy się z poziomem.
- **Polecenia**: każdy klient ma kod. Po pierwszych zakupach poleconej osoby obie strony dostają Milkosy.
- **Urodziny**: klient zapisuje datę raz; w dniu urodzin dostaje prezent (vPLN i/lub Milkosy). Datę zmienia obsługa w karcie klienta.
- **Misje i odznaki** (zakładka „Misje i odznaki”): np. „3 wizyty w 30 dni” → nagroda i odznaka.
- **Ważność**: Milkosy wygasają po 12 miesiącach (najstarsze najpierw), 30 dni wcześniej klient dostaje powiadomienie. Punkty zebrane przed tą wersją liczą 12 miesięcy od dnia wdrożenia.
- Wygasanie, prezenty urodzinowe i porzucone płatności sprawdza serwer co godzinę.

## Karty podarunkowe

- Online: `/karty-podarunkowe`, płatność PayU, kod od razu po opłaceniu. W lokalu: panel → „Karty podarunkowe” → „Sprzedaż karty w kasie”.
- Płatność kartą w lokalu: panel → wpisz kod → pobierz kwotę (można częściami).
- Klient może też dodać kartę do salda vPLN w aplikacji (Portfel → Karta podarunkowa).
- Karta ważna 12 miesięcy.

## Karta menu

`data/menu-karta.json` to drukowana karta: 160 pozycji z rozmiarami, cenami, dodatkami i oznaczeniami (nowość, wege, ostre).

**Serwer wgrywa kartę sam** przy pierwszym starcie po wdrożeniu (i ponownie tylko wtedy, gdy plik karty się zmieni). Późniejsze zmiany w panelu nie są nadpisywane przy kolejnych restartach. Zmienna `KARTA_AUTO=off` na Railway wyłącza to wgrywanie. Ręcznie: Panel → Menu → **„Wczytaj kartę menu”** (najpierw pokazuje, co się zmieni). Za każdym razem:

- pozycje o tej samej nazwie dostają nazwy, opisy, rozmiary, ceny, kategorię i dodatki z karty; zdjęcie, „bestseller” i „tylko odbiór” zostają,
- brakujące pozycje są dodawane (z ilustracją zamiast zdjęcia; w dostawie bez shake'ów, lodów, deserów i napojów poza butelkowanymi),
- pozycje spoza karty są chowane, nie usuwane. Przycisk „Niedostępny” przy takiej pozycji przywraca ją do menu.

Import można powtarzać: niczego nie dubluje. Po zmianie cen na karcie popraw plik i wczytaj kartę jeszcze raz, albo zmień pojedyncze pozycje w panelu.

**Zestaw** (kanapka, burger, hot-dog, burrito): z frytkami, sałatką lub gorącym chilli 12 zł, z batatami 15 zł, z krążkami cebulowymi 16 zł, z mini nachos 18 zł; lemoniada cytrusowa +10 zł (czyli 22 zł za zestaw z lemoniadą). Dopłaty do dodatków i lemoniady są w pliku karty, cena podstawowa w ustawieniach sklepu.

## Zamawiarka (`/zamow`)

Pliki: `public/zamow.html`, `public/zamow/app.js`, `public/zamow/styles.css`, ilustracje kategorii w `public/img/zamow/`. Menu, ceny, godziny i ustawienia pochodzą z serwera; serwer liczy cenę zamówienia od nowa.

Panel → „Zamówienia & Sklep” → „Ustawienia Sklepu” (osobno dla Słupska i Rowów, wymaga roli manager):

- **Przełączniki** (zapis od razu): przyjmowanie zamówień, odbiór osobisty, dostawa, płatność online (PayU), kartą przy odbiorze, gotówką, saldem MilkMi.
- **Kwoty i czas** (przycisk „Zapisz opłaty i teksty”): opłata za dostawę, darmowa dostawa od, minimum na dostawę, opakowania (domyślnie 0 zł, bo karta mówi, że opłata jest wliczona w cenę), cena zestawu (domyślnie 12 zł), czas przygotowania przy odbiorze i czas dostawy.
- **Komunikat**, gdy zamówienia są wyłączone (widzi go klient), i **zdjęcie okładki** (bez zdjęcia jest pomarańczowy pas).
- Pozycje „tylko odbiór”, „dostępny” i „bestseller” ustawiasz w menu. Zdjęcie użyte przy 3 lub więcej produktach traktujemy jako zastępcze i pokazujemy zamiast niego ilustrację kategorii.

Klient zalogowany do MilkMi (ta sama sesja co w `/app`) ma wpisane imię i telefon i może zapłacić saldem vPLN, całością albo częścią. Część zapłacona saldem nie daje Milkosów. Anulowane albo nieopłacone (2 godziny) zamówienie oddaje saldo automatycznie. Terminy odbioru biorą się z „Godzin otwarcia”.

## Konto klienta

- Klient wpisuje numer telefonu. Jeśli konto istnieje, podaje hasło; jeśli nie, podaje imię i hasło (e-mail jest opcjonalny).
- Zapomniane hasło: w panelu otwórz klienta i wybierz „Resetuj hasło”. Panel pokaże 6-cyfrowe hasło tymczasowe, które podajesz klientowi przy kasie.
- Klienci zalogowani w starej wersji aplikacji zostają zalogowani po aktualizacji.

## Powiadomienia (PWA)

- Klucze powiadomień serwer tworzy sam przy pierwszym starcie i zapisuje w bazie. Nie trzeba niczego ustawiać na Railway.
- Klient dostaje powiadomienie po nabiciu Milkosów, zmianie salda, zmianie statusu zamówienia i decyzji o rezerwacji.
- Kampanie wysyłasz w panelu w zakładce „Powiadomienia push”: do wszystkich, do osób z Milkosami albo do nieaktywnych od 30 dni.
- iPhone: powiadomienia działają tylko z aplikacji dodanej do ekranu początkowego (iOS 16.4 lub nowszy).
- Nazwa na ekranie to „MilkMi”. Kto ma na iPhonie starą ikonę „MojaApp”, musi ją usunąć i dodać ponownie. Android aktualizuje nazwę sam po otwarciu aplikacji.

## Panel: role

- **Kasjer:** kasa (Milkosy, portfel), zamówienia, rezerwacje, podgląd klientów, swój czas pracy, magazyn (zdejmowanie ze stanu).
- **Manager:** do tego menu (z flagami „tylko odbiór”, „dostępny”, „bestseller”), godziny, banery, powiadomienia push, newsletter, korekty punktów, cofanie nabić, reset haseł klientów, dziennik zmian.
- **Właściciel** (PIN z `ADMIN_PIN`): do tego zespół (PIN-y, stawki), koszty pracy, zasady programu, usuwanie kont.

Każda operacja na punktach, saldzie i magazynie trafia do dziennika z imieniem pracownika.

## Panel: statystyki i analityka

- **Dashboard:** dziś / tydzień / miesiąc / łącznie dla użytkowników, rezerwacji, wydanych Milkosów, zamówień, obrotu i wpłat prepaid. Strzałki porównują z tym samym odcinkiem czasu wczoraj, w zeszłym tygodniu i w zeszłym miesiącu. Okresy liczone w czasie polskim.
- **Zakładka „Analityka”** (manager, kod w `analytics.js`): wykres dzień po dniu, porównanie z poprzednim okresem, średnia wartość zamówienia, top i najsłabsze produkty, godziny szczytu, płatności, aktywni klienci, klienci, którzy przestali przychodzić, top klienci, poziomy, wygasające Milkosy, polecenia, urodziny, karty podarunkowe, zobowiązania wobec klientów, czas realizacji, odrzucone i anulowane, skuteczność push. Eksport CSV (średnik, otwiera się w Excelu).
- **Rachunek wyników** (tylko właściciel): wpływy (zamówienia bez części opłaconej saldem, wpłaty prepaid, karty podarunkowe) minus wynagrodzenia z czasu pracy. Sprzedaż z kasy fiskalnej i inne koszty (towar, czynsz) wpisuje się ręcznie dla każdego miesiąca.
- „Zarobek z prepaid” to tylko wpłaty pieniędzy przez obsługę (i PayU, gdy powstanie doładowanie online). Wymiana Milkosów, karty podarunkowe, zwroty, misje i prezenty się nie liczą.
- Czas realizacji liczy się od tej wersji (zamówienia zapisują godzinę każdej zmiany statusu). Skuteczność push liczy się dla kampanii wysłanych od tej wersji.

## Zdjęcia

Najlepiej ustawić zmienne `S3_*` (patrz wyżej): wtedy zdjęcia trafiają do chmury i nie znikają przy wdrożeniu. Bez nich zdjęcia trafiają do `uploads/`, a na Railway ten folder znika przy każdym wdrożeniu, jeśli nie jest podpięty jako wolumen (ścieżka `/app/uploads`). Serwer przyjmuje tylko prawdziwe pliki JPG, PNG, WebP i GIF (sprawdza zawartość, nie nazwę).

## Uruchomienie lokalnie

```bash
npm install
ADMIN_PIN=1234567 MONGO_URL=mongodb://127.0.0.1:27017/milkmi npm start
```
