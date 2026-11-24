"""Build an Erlang oracle from Kazoo's real source. Usage: build_oracle.py <kazoo-src-dir> <out-dir>

Copies Kazoo's next_rule_date/2 and helpers VERBATIM (only -spec annotations and the
kz_types include are stripped, since we don't have Kazoo's headers), plus a lager stub and a
driver that reads test cases and prints results.
"""
import os, re, sys

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)


def strip_specs(text):
    """Remove -spec blocks (a -spec runs until the first line ending in '.')."""
    lines, keep, in_spec = text.splitlines(), [], False
    for ln in lines:
        if ln.startswith('-spec '):
            in_spec = True
        if in_spec:
            if ln.rstrip().endswith('.'):
                in_spec = False
            continue
        keep.append(ln)
    return '\n'.join(keep) + '\n'


# --- kz_date: whole module, verbatim minus include/specs ---
kz = open(os.path.join(src, 'kz_date.erl'), encoding='utf-8').read()
kz = re.sub(r'^-include\(.*\)\.\s*$', '', kz, flags=re.M)
kz = strip_specs(kz)
open(os.path.join(out, 'kz_date.erl'), 'w', encoding='utf-8').write(kz)

# --- next_rule_date + helpers: lines from "-spec next_rule_date" to the end of sort_wdays ---
cf = open(os.path.join(src, 'cf_temporal_route_4.3.erl'), encoding='utf-8').read().splitlines()
start = next(i for i, l in enumerate(cf) if l.startswith('-spec next_rule_date('))
end = next(i for i, l in enumerate(cf) if l.startswith('-spec interdigit_timeout('))
body = strip_specs('\n'.join(cf[start:end]))

oracle = '''%% Generated from Kazoo 4.3 cf_temporal_route.erl — function bodies copied verbatim.
-module(crv_oracle).
-export([next_rule_date/2, sort_wdays/1]).
-record(rule, {id = <<>>, enabled, name = <<"no_name">>, cycle = <<>>, interval = 1,
               days = [], wdays = [], ordinal = <<"first">>, month = 1,
               start_date = {2011,1,1}, wtime_start = 0, wtime_stop = 86400}).
''' + body
open(os.path.join(out, 'crv_oracle.erl'), 'w', encoding='utf-8').write(oracle)

# --- lager stub ---
open(os.path.join(out, 'lager.erl'), 'w', encoding='utf-8').write('''-module(lager).
-export([debug/1, debug/2, info/1, info/2, warning/1, warning/2, error/1, error/2]).
debug(_) -> ok.  debug(_, _) -> ok.
info(_) -> ok.   info(_, _) -> ok.
warning(_) -> ok. warning(_, _) -> ok.
error(_) -> ok.  error(_, _) -> ok.
''')

# --- driver: cases.tsv -> results.tsv ---
open(os.path.join(out, 'crv_driver.erl'), 'w', encoding='utf-8').write(r'''-module(crv_driver).
-export([main/0]).
-record(rule, {id = <<>>, enabled, name = <<"no_name">>, cycle = <<>>, interval = 1,
               days = [], wdays = [], ordinal = <<"first">>, month = 1,
               start_date = {2011,1,1}, wtime_start = 0, wtime_stop = 86400}).

%% Line: cycle  interval  y0 m0 d0  month  ordinal  days|-  wdays|-  y1 m1 d1   (TAB separated)
main() ->
    {ok, Bin} = file:read_file("cases.tsv"),
    Lines = [L || L <- binary:split(Bin, <<"\n">>, [global]), L =/= <<>>],
    Out = [run(L) || L <- Lines],
    ok = file:write_file("results.tsv", Out).

%% Each case gets 100ms: some valid-looking rules make Kazoo loop forever.
run(Line) ->
    Self = self(),
    Pid = spawn(fun() -> Self ! {self(), compute(Line)} end),
    receive {Pid, Result} -> Result
    after 100 -> exit(Pid, kill), "hang\n"
    end.

compute(Line) ->
    [Cycle, I, Start, Month, Ord, Days, WDays, Date] = binary:split(Line, <<"\t">>, [global]),
    try
        %% build_rule/4 sorts weekdays before next_rule_date sees them.
        Rule = #rule{cycle = Cycle
                    ,interval = binary_to_integer(I)
                    ,start_date = triple(Start)
                    ,month = binary_to_integer(Month)
                    ,ordinal = Ord
                    ,days = [binary_to_integer(D) || D <- list(Days)]
                    ,wdays = crv_oracle:sort_wdays(list(WDays))
                    },
        {Y, M, D} = kz_date:normalize(crv_oracle:next_rule_date(Rule, triple(Date))),
        %% process_rules/3 immediately does this with the result, so a garbage date crashes there.
        _ = calendar:datetime_to_gregorian_seconds({{Y, M, D}, {0, 0, 0}}),
        io_lib:format("ok ~b ~b ~b~n", [Y, M, D])
    catch
        Class:Reason -> io_lib:format("crash ~p:~0p~n", [Class, Reason])
    end.

list(<<"-">>) -> [];
list(B) -> binary:split(B, <<",">>, [global]).

triple(B) ->
    [Y, M, D] = binary:split(B, <<" ">>, [global]),
    {binary_to_integer(Y), binary_to_integer(M), binary_to_integer(D)}.
''')
print('oracle sources written to', out)
for f in sorted(os.listdir(out)):
    print('  ', f, os.path.getsize(os.path.join(out, f)), 'bytes')
