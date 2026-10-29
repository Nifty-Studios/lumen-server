# Build from the Lumen root so the sibling shared repo is in the context:
#   docker build -f server/Dockerfile -t lumen-server .
FROM oven/bun:1.3
WORKDIR /app

# Install the server's own deps (minus the pnpm link to shared) plus shared's runtime dep,
# then place shared's source directly in node_modules.
COPY server/package.json ./
RUN bun -e 'const f="package.json",p=JSON.parse(await Bun.file(f).text());delete p.dependencies["@lumen/shared"];await Bun.write(f,JSON.stringify(p))' \
 && bun install --production \
 && bun add zod@^4.6.7 fflate@^0.8.2
COPY shared/package.json node_modules/@lumen/shared/package.json
COPY shared/src node_modules/@lumen/shared/src
COPY server/src src

ENV LUMEN_DB=/data/lumen-server.db PORT=8787
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
EXPOSE 8787
# Volumes (Fly's in particular) can mount root-owned: fix ownership, then drop to the bun user.
CMD ["sh", "-c", "chown bun:bun /data && exec setpriv --reuid=bun --regid=bun --init-groups bun src/index.ts"]
