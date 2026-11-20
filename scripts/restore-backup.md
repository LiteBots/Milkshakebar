# Odtworzenie bazy z kopii zapasowej

Kopie robi codziennie `.github/workflows/backup.yml` i wysyła je zaszyfrowane do prywatnego bucketu (S3 albo Cloudflare R2).

1. Pobierz plik z bucketu, np. `milkmi-2026-11-19_0330.archive.gz.enc` (panel R2/S3 albo `aws s3 cp`).
2. Odszyfruj go hasłem `BACKUP_PASSPHRASE`:

   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in milkmi-2026-11-19_0330.archive.gz.enc -out milkmi.archive.gz
   ```

3. Najpierw sprawdź kopię na osobnej, testowej bazie:

   ```bash
   mongorestore --uri="mongodb://127.0.0.1:27017" --archive=milkmi.archive.gz --gzip --dryRun
   ```

4. Odtworzenie na produkcji nadpisuje dane (`--drop` usuwa obecne kolekcje przed wgraniem kopii). Zrób to tylko wtedy, gdy na pewno trzeba, najlepiej przy wstrzymanych zamówieniach:

   ```bash
   mongorestore --uri="$MONGO_URL" --archive=milkmi.archive.gz --gzip --drop
   ```

Raz na kwartał warto przećwiczyć kroki 1–3, żeby mieć pewność, że kopie da się odczytać.
