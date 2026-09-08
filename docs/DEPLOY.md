# Hosting a read-only instance

One container. It carries no exchange credential, no wallet session and no
signing key, so the two tools that could move money are refused twice over: by
the operator token, and by having nothing to execute with. What it serves is
everything else — live quotes on both venues, the policy, the recorded
evidence, the graded executions, and a ledger a visitor can verify in their own
browser — plus `POST /mcp`, so an agent anywhere can connect to it.

## The one variable that matters

`CRUCIBLE_MCP_TOKEN` does two things at once:

- The instance becomes **public read-only**. `quote`, `route`, `policy`,
  `evidence`, `calibration`, `check_claim`, `verify_ledger` and `status` answer
  anyone. `execute` and `reconcile` require the token in an
  `Authorization: Bearer` header.
- The server binds every interface rather than loopback.

Without it, a process started with `PORT` set **refuses to start** and says why.
That is deliberate: inside a container, binding loopback means the platform's
health check reaches nothing and the deploy fails for a reason nobody can see —
and the door on the other side of that mistake is a public instance with
`execute` ungated.

Generate one and keep it. Anyone holding it can place orders through the
instance:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## Vercel — how the live instance runs

`https://crucible-router.vercel.app` runs here. The dashboard handler already treats every request on its own
and the MCP transport is stateless, so a serverless invocation per request fits
without changing anything.

```bash
vercel link --yes
echo "<the token>" | vercel env add CRUCIBLE_MCP_TOKEN production
vercel --prod --yes
```

Three things are not obvious and each cost a deploy to find:

- **Pick a region Binance answers.** Vercel defaults to Washington, D.C., and
  Binance returns HTTP 451 to US addresses. `"regions": ["sin1"]` in
  `vercel.json` fixes it; the on-chain side works from anywhere.
- **Deployment protection is on by default**, which puts the whole thing behind
  Vercel's SSO and makes it useless as a public demo. Turn it off under
  Settings → Deployment Protection.
- **The ledger cannot live in a dot-directory**, because the bundler will not
  carry one. `CRUCIBLE_LEDGER_DIR=deploy/ledger` points at the copy that ships
  in `includeFiles`.

## Koyeb

A free instance, no card, and it stays up for an hour after the last request.

1. Sign in at [koyeb.com](https://www.koyeb.com) with GitHub.
2. **Create Web Service** → **GitHub** → pick this repository.
3. **Builder: Dockerfile.** Koyeb offers a buildpack first; this repository
   ships a Dockerfile and it is the one to use.
4. **Instance type: Free.** Region must be Frankfurt or Washington, D.C. — a
   free instance runs nowhere else.
5. **Environment variables** → add `CRUCIBLE_MCP_TOKEN` as a **secret**, set to
   the value generated above.
6. **Health check**: HTTP on the exposed port, path `/api/policy`. It answers
   without touching a venue, so it measures whether this process is up rather
   than whether Binance is reachable.
7. Deploy. Koyeb gives the service a `*.koyeb.app` URL.

The port needs no configuring: Koyeb passes `PORT`, and the server listens
there.

## Render

Free, no card, but it sleeps after 15 minutes of inactivity and takes the best
part of a minute to wake — long enough that a visitor may give up. `render.yaml`
in the repository root is a blueprint: **New** → **Blueprint** → pick the repo,
and Render prompts for `CRUCIBLE_MCP_TOKEN` because the blueprint deliberately
does not carry it.

## Fly.io

Fastest to wake, and the only one of the three that requires a credit card on
file. `fly.toml` is in the repository root; the machine stops when idle, so the
cost of a demo instance is pennies.

```bash
fly launch --no-deploy          # reads fly.toml
fly secrets set CRUCIBLE_MCP_TOKEN=<the token>
fly deploy
```

## Checking it afterwards

```bash
curl -s https://<your-host>/api/policy | head -c 200

# every tool, to anyone
curl -s -X POST https://<your-host>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# and the one that must refuse a stranger
curl -s -X POST https://<your-host>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"execute","arguments":{"planId":"x"}}}'
```

The last one should come back `isError: true` with a message about the instance
being read-only. If it does not, the token is not set, and the instance should
be taken down until it is.

## What ships in the image, and what never does

The decision ledger travels as evidence: the hash chain and its detached
signature. **The private key that signed it does not**, and must not — a signing
key in a public image is a signature anyone can forge. A visitor can still
recompute every hash and check the signature against the public key carried in
the signature file, and `verify_ledger` tells them plainly that this instance
cannot prove who holds the matching private key.

No exchange credential, no wallet session and no policy in `live` mode are in
the image either. A hosted instance is a thing to read, not a thing that trades.
