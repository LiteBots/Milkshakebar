# Milkshakebar i MilkMi

Strona Milkshakebar, aplikacja lojalnościowa MilkMi, zamawiarka i panel lokalu. Node.js (Express) i MongoDB, wdrażane na Railway.

## Adresy

| Adres | Co to jest |
|---|---|
| `/` | Strona główna |
| `/app` | Aplikacja MilkMi (klienci mają ją przypiętą na telefonie) |
| `/zamow` | Zamawiarka online (stary adres `/zamów` przekierowuje tutaj) |
| `/menu`, `/menu/shake`, `/menu/burgery`… | Menu i strony kategorii z cenami (dla Google) |
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

`data/menu-karta.json` to drukowana karta: 160 pozycji z rozmiarami, cenami, dodatkami i oznaczeniami (nowość, wege, ostre). Panel → Menu → **„Wczytaj kartę menu”** (osobno dla Słupska i Rowów) najpierw pokazuje, co się zmieni, a po potwierdzeniu:

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

## Zdjęcia

Zdjęcia wgrane w panelu trafiają do `uploads/`. Na Railway ten folder znika przy każdym wdrożeniu, jeśli nie jest podpięty jako wolumen. Podepnij wolumen pod ścieżkę `/app/uploads`, żeby zdjęcia zostawały.

## Uruchomienie lokalnie

```bash
npm install
ADMIN_PIN=1234567 MONGO_URL=mongodb://127.0.0.1:27017/milkmi npm start
```
