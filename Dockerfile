FROM node:20

# Set working directory
WORKDIR /botpress

# Copy project files
COPY . .

# Install dependencies
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --frozen-lockfile
RUN pnpm run build

# Expose port (Botpress default is 3000)
EXPOSE 3000

# Start Botpress
CMD ["pnpm", "start"]
