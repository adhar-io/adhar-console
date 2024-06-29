# Stage 1: Build the application
FROM node:lts-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json pnpm*.json ./

# Install dependencies
RUN npm install -g pnpm && pnpm install

# Copy the rest of the application code
COPY . .

# Reset Nx cache
RUN npx nx reset

# Build the application
RUN npx nx build console --verbose

# Stage 2: Serve the application with Nginx
FROM nginx:stable-alpine

# Non previledge user
RUN  touch /var/run/nginx.pid && \
     chown -R nginx:nginx /var/cache/nginx /var/run/nginx.pid

USER nginx

# Copy the built application from the previous stage
COPY --chown=nginx:nginx --from=builder /app/dist/apps/console /usr/share/nginx/html

# Copy nginx configuration
COPY --chown=nginx:nginx /nginx/nginx.conf /etc/nginx/nginx.conf
COPY --chown=nginx:nginx /nginx/default.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]






