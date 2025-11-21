FROM node:22-alpine AS builder

WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend ./
RUN npm run build

FROM nginx:1.27-alpine

RUN apk add --no-cache openssl \
    && mkdir -p /etc/nginx/certs \
    && openssl req -x509 -nodes -days 365 \
        -newkey rsa:2048 \
        -keyout /etc/nginx/certs/charvi.ru.key \
        -out /etc/nginx/certs/charvi.ru.crt \
        -subj "/CN=charvi.ru"

COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=builder /frontend/dist /usr/share/nginx/html

EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
