# The hosted instance: the dashboard, and the MCP server on the same port.
#
# Deliberately spare. This image runs one process, holds no exchange key, no
# wallet session and no signing key, and cannot execute anything: the operator
# token gates the two tools that could, and neither credential it would need is
# present. What it serves is the read-only half — live quotes on both venues,
# the policy, the recorded evidence, and a ledger a visitor can verify.

FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a source change does not reinstall them. `npm ci`
# needs the lockfile, and `--omit=dev` leaves out the type checker: nothing at
# runtime compiles anything, since Node strips the types itself.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY data ./data
COPY docs ./docs

# The decision ledger, as evidence. The chain and its signature travel; the
# private key that signed it does not, and must never. A visitor can therefore
# recompute every hash and check the signature against the public key inside
# the signature file, while being told plainly that this instance cannot prove
# who holds the corresponding private key.
COPY deploy/ledger/ ./.crucible/

# Read-only in every sense that matters: no credentials, and a policy that
# refuses to transmit even if any appeared.
COPY deploy/crucible.config.json ./crucible.config.json

ENV NODE_ENV=production
ENV CRUCIBLE_DASHBOARD_PORT=8787
EXPOSE 8787

# Fails the health check rather than serving a half-started process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/api/policy || exit 1

CMD ["node", "--experimental-strip-types", "src/dashboard/server.ts"]
