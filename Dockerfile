# Stage 0, based on Node.js, to build and compile React
#docker build -t adhario:console .
#docker run -d -p 80:80 adhario:console
#docker push adhario/console:latest
FROM node:lts as node
ARG env=prod
WORKDIR /app
COPY package.json /app/
COPY ./ /app/
RUN npm install
RUN npx nx build console

# Stage 1, based on Nginx, to have only the compiled app, ready for production with Nginx
FROM nginx:alpine
COPY --from=node /app/dist/apps/console/ /usr/share/nginx/html
COPY ./nginx.conf /etc/nginx/conf.d/default.conf