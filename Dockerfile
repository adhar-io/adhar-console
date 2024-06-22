# Stage 1: Build the application
FROM node:lts-alpine as builder

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
RUN npx nx build console

# Stage 2: Serve the application with Nginx
FROM nginx:stable-alpine

# Copy the built application from the previous stage
COPY --from=builder /app/dist/apps/console /usr/share/nginx/html

# Copy nginx configuration
COPY /nginx/nginx.conf /etc/nginx/nginx.conf
COPY /nginx/default.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]






