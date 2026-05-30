FROM node:20-alpine

LABEL description="企业内网测速系统 - Enterprise Intranet Speed Test System"

WORKDIR /app

# 安装中文字体支持（用于 PDF 报告）
RUN apk add --no-cache fontconfig ttf-dejavu && \
    mkdir -p /usr/share/fonts && \
    fc-cache -f

COPY package*.json ./
RUN npm install --no-audit --no-fund --production

COPY . .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "server.js"]
