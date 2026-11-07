# Milkshakebar i MilkMi

Strona Milkshakebar, aplikacja lojalnościowa MilkMi, zamawiarka i panel lokalu. Node.js (Express) i MongoDB, wdrażane na Railway.

## Adresy

| Adres | Co to jest |
|---|---|
| `/` | Strona główna |
| `/app` | Aplikacja MilkMi (klienci mają ją przypiętą na telefonie) |
| `/zamów` | Zamawiarka online |
| `/menu` | Menu |
| `/admin` | Panel lokalu (logowanie PIN-em) |

Pliki stron leżą w `public/`. Serwer udostępnia tylko ten folder i `uploads/`.

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
