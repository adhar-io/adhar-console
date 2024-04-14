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
FROM nginx:stable-alpine-slim

# Copy the built application from the previous stage
COPY --from=builder /app/dist/apps/console /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Create a user and group 'nginxuser'
RUN addgroup -S nginxuser && adduser -S nginxuser -G nginxuser

# Change the ownership of the Nginx directories to 'nginxuser'
RUN chown -R nginxuser:nginxuser /var/cache/nginx /var/run /var/log/nginx

# Switch to 'nginxuser'
USER nginxuser

# Expose port 8080
EXPOSE 8080

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]






