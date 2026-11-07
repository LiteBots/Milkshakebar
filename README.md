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
- Zasady i bony zmienia właściciel w panelu: zakładka „Program”.

## Panel: role

- **Kasjer:** kasa (Milkosy, portfel), zamówienia, rezerwacje, podgląd klientów.
- **Manager:** do tego menu, lokal (godziny, banery, dostawa), korekty punktów, cofanie nabić, dziennik.
- **Właściciel** (PIN z `ADMIN_PIN`): do tego zespół, zasady programu, usuwanie kont.

Każda operacja na punktach i saldzie trafia do dziennika z imieniem pracownika.

## Zdjęcia

Zdjęcia wgrane w panelu trafiają do `uploads/`. Na Railway ten folder znika przy każdym wdrożeniu, jeśli nie jest podpięty jako wolumen. Podepnij wolumen pod ścieżkę `/app/uploads`, żeby zdjęcia zostawały.

## Uruchomienie lokalnie

```bash
npm install
ADMIN_PIN=1234567 MONGO_URL=mongodb://127.0.0.1:27017/milkmi npm start
```
