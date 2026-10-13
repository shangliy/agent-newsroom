FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/var/lib/newsroom PLATFORM_ONLY=1
COPY package.json ./
COPY server ./server
COPY web ./web
COPY sim ./sim
COPY data/sources.json ./data/sources.json
RUN mkdir -p /var/lib/newsroom && chown node:node /var/lib/newsroom
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
