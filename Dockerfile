FROM node:20-alpine

WORKDIR /app

# Install dependencies first for layer caching
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source code
COPY src/ ./src/

# Create exports directory
RUN mkdir -p /app/exports

EXPOSE 8080

CMD ["node", "src/index.js"]
