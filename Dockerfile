# Stage 0, based on Node.js, to build and compile React

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
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Create temp cache folder
RUN mkdir /var/cache/nginx/client_temp \
    /var/cache/nginx/proxy_temp \ 
    /var/cache/nginx/fastcgi_temp \ 
    uwsgi_temp

# Expose port 80 & 443
EXPOSE 80 443

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]






