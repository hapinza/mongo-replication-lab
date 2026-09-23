FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# src/ 와 results/ 는 compose 에서 볼륨으로 마운트된다.
CMD ["node", "--version"]
