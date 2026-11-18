# github-core-clone-01

A standalone GitHub-compatible git forge in Node 22 TypeScript, standard
library only. One process, in-memory state, no dependencies, no git binary.

## Surfaces

- **Git smart HTTP** at `/<owner>/<repo>.git/`: `info/refs` (v0 and v2
  advertisements), `git-upload-pack` (v2 `ls-refs` and `fetch`, plus a v0
  fetch), and `git-receive-pack` v0 (pack ingest with OFS/REF delta
  resolution, fast-forward enforcement, report-status). Packs the forge
  writes are undeltified and checksummed.
- **REST v3** under `/api/v3/`: repositories, branches, commits, contents,
  labels, issues, comments, pull requests, files and merges, with GitHub's
  status codes, JSON error bodies, pagination `Link` headers and bearer auth.
- **GraphQL v4** at `/api/graphql`: the documents `gh` and
  `github-mcp-server` send (viewer, repository, issues, pull requests,
  mutations, introspection probes, Relay `node(id:)`, cursor pagination,
  operation batching).
- **MCP** at `/mcp`: streamable HTTP, the 2026-07-28 era
  (`server/discover`, no session) with the legacy `initialize` handshake
  answered too, and six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) that act on
  the same store the REST view reads.

## Running

The trial runs `node /bot/main.ts`: the entry binds an ephemeral port,
registers it with `$MAKEFUN_ENV_URL`, and polls `$MAKEFUN_ENV_URL/done`
until the suite finishes. `MAKEFUN_SHOP_TOKEN` is the one bearer token
every API call must present; `/healthz` takes none.

## Layout

- `main.ts` — the entry/env lifecycle (bind, register, poll, exit 0).
- `app.ts` — the HTTP server: routing, auth, body reading.
- `gitobj.ts` — the object model: SHA-1 objects, commit/tree/tag parsing,
  delta application, packfile read/write.
- `store.ts` — the in-memory forge: repositories, refs, issues, pull
  requests, history and tree operations.
- `gitproto.ts` — pkt-lines, advertisements, upload-pack and receive-pack.
- `rest.ts` — REST v3 handlers and the shared domain operations.
- `graphql.ts` — the GraphQL document router and Relay global ids.
- `mcp.ts` — the MCP endpoint and its six tools.
- `http.ts` — shared request context and response writers.

## Determinism

Responses carry one fixed timestamp, stable key order and creation-order
listings; request ids are a per-process counter. Nothing reads a clock or
a random source in a response path, so two runs of the same request
sequence answer identically.
