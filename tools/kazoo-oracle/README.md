# Kazoo oracle

Runs Kazoo's **real** `next_rule_date/2` (from Kazoo 4.3, copied verbatim — only `-spec`
annotations and the `kz_types` include are stripped) in Docker, and compares every answer with
`app/lib/temporal.js`: same date, same crash, same infinite loop.

Last run: **310,296 cases, 0 mismatches.**

## Rebuild

1. Fetch the Kazoo sources into a directory:

```bash
mkdir kazoo-src
```

```bash
curl -sL -o kazoo-src/cf_temporal_route_4.3.erl https://raw.githubusercontent.com/2600hz/kazoo/4.3/applications/callflow/src/module/cf_temporal_route.erl
```

```bash
curl -sL -o kazoo-src/cf_temporal_route.hrl https://raw.githubusercontent.com/2600hz/kazoo/4.3/applications/callflow/src/module/cf_temporal_route.hrl
```

```bash
curl -sL -o kazoo-src/kz_date.erl https://raw.githubusercontent.com/2600hz/kazoo/4.3/core/kazoo_stdlib/src/kz_date.erl
```

2. Generate the oracle (Erlang sources + driver):

```bash
python tools/kazoo-oracle/build_oracle.py kazoo-src oracle
```

3. Run (pulls/uses `erlang:26-alpine`; args: oracle dir, random case count, optional seed):

```bash
node tools/kazoo-oracle/diff.js oracle 300000 20261120
```

Each case gets 100 ms in Erlang — some valid-looking rules make Kazoo loop forever, reported as
`hang`. The JS port stops those at a loop guard and reports `hang` too.
