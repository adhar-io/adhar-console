# Stage 1: Build the application
FROM node:lts-alpine as builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json pnpm*.json ./

# Print Node version
RUN node -v

# Install dependencies
RUN npm install -g pnpm && pnpm install

# Copy the rest of the application code
COPY . .

# Reset Nx cache
RUN npx nx reset

# Build the application
RUN npx nx build console

# Stage 2: Serve the application with Nginx
FROM nginx:stable-alpine

# Copy the built application from the previous stage
COPY --from=builder /app/dist/apps/console /usr/share/nginx/html

# Copy nginx configuration
COPY /nginx/nginx.conf /etc/nginx/nginx.conf
COPY /nginx/default.conf /etc/nginx/conf.d/default.conf

# Create 'nginxuser' and necessary directories
RUN addgroup -S nginxuser && adduser -S nginxuser -G nginxuser && \
    mkdir -p /var/cache/nginx/client_temp /var/cache/nginx/proxy_temp /var/cache/nginx/fastcgi_temp /var/cache/nginx/uwsgi_temp /var/cache/nginx/scgi_temp && \
    chown -R nginxuser:nginxuser /var/cache/nginx && \
    touch /var/cache/nginx/nginx.pid && \
    chown nginxuser:nginxuser /var/cache/nginx/nginx.pid

# Switch to 'nginxuser'
USER nginxuser

# Expose port 8080
EXPOSE 8080

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]






