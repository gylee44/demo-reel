FROM mcr.microsoft.com/playwright:v1.63.0-noble
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.19.0
WORKDIR /app
RUN chown pwuser:pwuser /app
USER pwuser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --chown=pwuser:pwuser package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY --chown=pwuser:pwuser . .
RUN pnpm build && mkdir -p /app/output
ENV HOST=0.0.0.0 DATA_DIR=/app/output
EXPOSE 4000
CMD ["pnpm", "dev:api"]
