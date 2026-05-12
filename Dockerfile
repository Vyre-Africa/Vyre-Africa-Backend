FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install --ignore-scripts --legacy-peer-deps

RUN npx prisma generate

COPY . .

RUN npm run gcp-build

EXPOSE 8080

CMD ["npm", "start"]