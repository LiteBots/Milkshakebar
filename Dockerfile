FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
# Dokładnie te wersje paczek, które są w package-lock.json (bez paczek do testów)
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Railway sprawdza, czy serwer i baza odpowiadają
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
