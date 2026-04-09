FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npx aai build --skipTests

ENV PORT=8080
EXPOSE 8080

CMD ["npx", "aai", "start", "--port", "8080"]
