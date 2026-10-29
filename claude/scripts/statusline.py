#!/usr/bin/env python3
# statusline.py — Claude Code's status line without running ccusage. `ccusage statusline` re-read every transcript of the account
# each second per session (a 300-500 MB process per refresh; with five sessions open the box was in swap, 2026-10-29). Here the
# session's own figures come from Claude Code's stdin JSON, and today/block/quota from the dashboard, which already collects them
# every 10 min (/api/system on 127.0.0.1:3005), kept 60 s in a file so a refresh is one small read. Dashboard down: the last numbers
# it gave, else just the session's own.
import getpass, json, os, sys, time, urllib.request

CACHE = os.path.join(os.environ.get('XDG_RUNTIME_DIR') or '/tmp', f'cc-statusline-{getpass.getuser()}.json')
API = os.environ.get('CC_STATUSLINE_API', 'http://127.0.0.1:3005/api/system')


def usage():
    try:
        if time.time() - os.stat(CACHE).st_mtime < 60:
            with open(CACHE) as f:
                return json.load(f)
    except (OSError, ValueError):
        pass
    try:
        with urllib.request.urlopen(API, timeout=0.8) as r:
            u = json.load(r).get('usage') or {}
        tmp = f'{CACHE}.{os.getpid()}'
        with open(tmp, 'w') as f:
            json.dump(u, f)
        os.replace(tmp, CACHE)
        return u
    except Exception:
        try:
            with open(CACHE) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}


def ctx_tokens(c):
    # current_usage is the last request's input; total_input_tokens is the fallback older versions send
    cu = c.get('current_usage')
    if isinstance(cu, dict):
        return sum(cu.get(k) or 0 for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'))
    return c.get('total_input_tokens')


def line(j, u):
    m = j.get('model') or {}
    eff = j.get('effort')
    eff = eff.get('level') if isinstance(eff, dict) else eff
    out = [f"🤖 {m.get('display_name') or m.get('id') or '?'}{f' ({eff})' if eff else ''}"]
    # the dashboard's account ids are <user><profile suffix>: ~/.claude -> alonso, ~/.claude-work -> alonso-work
    suffix = os.path.basename(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')).removeprefix('.claude')
    a = (u.get('accts') or {}).get(getpass.getuser() + suffix) or {}
    money = [f"${(j.get('cost') or {}).get('total_cost_usd') or 0:.2f} session"]
    if a:
        money.append(f"${a.get('today') or 0:.2f} today")
        if a.get('block'):
            money.append(f"${a['block'].get('cost') or 0:.2f} block")
    out.append('💰 ' + ' / '.join(money))
    if a.get('block'):
        out.append(f"🔥 ${a['block'].get('rate') or 0:.2f}/hr")
    qs, qk = u.get('quota') or {}, a.get('qkey') or ''
    q = qs.get(qk) or qs.get(qk.rsplit('/', 1)[-1])  # claude-quota says "work" where the dashboard's label is "alonso/work"
    if q and q.get('h5') is not None:
        out.append(f"⏳ 5h {q['h5']:.0f}% · wk {q.get('wk') or 0:.0f}%")
    c = j.get('context_window') or {}
    n, size = ctx_tokens(c), c.get('context_window_size')
    if n is not None:
        out.append(f"🧠 {n // 1000}k" + (f" ({100 * n // size}%)" if size else ''))
    return ' | '.join(out)


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        u = {'accts': {getpass.getuser(): {'today': 1.5, 'qkey': 'personal', 'block': {'cost': 2, 'rate': 0.5}}},
             'quota': {'personal': {'h5': 19, 'wk': 71}}}
        os.environ['CLAUDE_CONFIG_DIR'] = os.path.expanduser('~/.claude')
        s = line({'model': {'display_name': 'Opus 5.5'}, 'effort': 'high', 'cost': {'total_cost_usd': 3},
                  'context_window': {'current_usage': {'input_tokens': 1000, 'cache_read_input_tokens': 49000}, 'context_window_size': 200000}}, u)
        assert s == '🤖 Opus 5.5 (high) | 💰 $3.00 session / $1.50 today / $2.00 block | 🔥 $0.50/hr | ⏳ 5h 19% · wk 71% | 🧠 50k (25%)', s
        assert line({}, {}) == '🤖 ? | 💰 $0.00 session', line({}, {})
        print('statusline self-test ok')
        sys.exit(0)
    try:
        j = json.load(sys.stdin)
    except ValueError:
        j = {}
    print(line(j, usage()))
