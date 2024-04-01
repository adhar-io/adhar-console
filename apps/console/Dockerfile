# Dependencies stage
FROM docker.io/node:lts-alpine as dependencies
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --only=production
RUN npm install react-scripts@4.0.3 -g --silent
COPY . .
RUN npm run build

# Production image, copy all the files and run next
FROM docker.io/node:lts-alpine as runner
RUN apk add --no-cache dumb-init

ENV NODE_ENV production
ENV PORT 3000
ENV HOST 0.0.0.0

WORKDIR /usr/src/app

# Copy installed dependencies from dependencies stage
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
COPY --from=dependencies /usr/src/app/build ./build

# Run the application under "node" user by default
RUN chown -R node:node .
USER node
EXPOSE 3000

CMD ["dumb-init", "npx", "serve", "-s", "build", "-l", "3000"]