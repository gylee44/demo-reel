FROM mcr.microsoft.com/playwright:v1.63.0-noble
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* && npm install --global pnpm@11.19.0
WORKDIR /app
RUN chown pwuser:pwuser /app
USER pwuser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --chown=pwuser:pwuser package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY --chown=pwuser:pwuser apps/worker ./apps/worker
COPY --chown=pwuser:pwuser apps/api ./apps/api
COPY --chown=pwuser:pwuser packages ./packages
COPY --chown=pwuser:pwuser scripts/migrate.ts ./scripts/migrate.ts
RUN mkdir -p /app/output
ENV NODE_ENV=production POC_MODE=false HOST=0.0.0.0 DATA_DIR=/app/output
EXPOSE 4002
CMD ["pnpm", "start:worker"]
