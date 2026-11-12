FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.25.0 --ignore-scripts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir /app/data && chown -R node:node /app
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5300 DATABASE_PATH=/app/data/feishu.sqlite
EXPOSE 5300
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:5300/api/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/main.mjs"]
