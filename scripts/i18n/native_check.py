#!/usr/bin/env python3
"""Checks and merges the native translations.

  python3 scripts/i18n/native_check.py android <dir>      e.g. values-ru: every translatable string,
                                                          plural and string-array of values/ present,
                                                          with the same %1$s / %d placeholders.
  python3 scripts/i18n/native_check.py ios <code>         ios/l10n/<code>.json covers every key of
                                                          Localizable.xcstrings and InfoPlist.xcstrings
                                                          (except shouldTranslate=false) with the same
                                                          %@ / %lld placeholders in the same order.
  python3 scripts/i18n/native_check.py ios-merge          writes every ios/l10n/*.json into the two
                                                          catalogs (state "translated").

ios/l10n/<code>.json is {"Localizable": {key: value-or-{plural category: value}}, "InfoPlist": {key: value}}.
"""
import json, re, sys, os, xml.etree.ElementTree as ET

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
CAT = {'Localizable': os.path.join(ROOT, 'ios', 'RandWallet', 'Localizable.xcstrings'),
       'InfoPlist': os.path.join(ROOT, 'ios', 'RandWallet', 'InfoPlist.xcstrings')}
A_PH = re.compile(r'%(\d+\$)?[-#+ 0,(]*\d*(\.\d+)?[sdfxXc%]')
I_PH = re.compile(r'%(\d+\$)?(lld|ld|d|@|f|\.\d+f|%)')

def android_entries(d):
    out = {}
    for f in ('strings.xml', 'arrays.xml'):
        p = os.path.join(RES, d, f)
        if not os.path.exists(p): continue
        for el in ET.parse(p).getroot():
            if el.get('translatable') == 'false': continue
            n = el.get('name')
            if el.tag == 'string': out[('s', n)] = [el.text or '']
            elif el.tag == 'plurals': out[('p', n)] = {i.get('quantity'): i.text or '' for i in el}
            elif el.tag == 'string-array': out[('a', n)] = [i.text or '' for i in el]
    return out

def ph(s, rx): return sorted(m.group(0) for m in rx.finditer(s) if m.group(0) != '%%')

def check_android(d):
    base, tr = android_entries('values'), android_entries(d)
    errs = []
    for k, v in base.items():
        if k not in tr: errs.append(f'missing {k[0]}:{k[1]}'); continue
        if k[0] == 'p':
            want = ph(v.get('other', ''), A_PH)
            for q, s in tr[k].items():
                if ph(s, A_PH) != want and not (q == 'one' and ph(s, A_PH) == []): errs.append(f'placeholders {k[1]}[{q}]')
            if 'other' not in tr[k]: errs.append(f'no other form {k[1]}')
        else:
            if len(tr[k]) != len(v): errs.append(f'length {k[1]}')
            for a, b in zip(v, tr[k]):
                if ph(a, A_PH) != ph(b, A_PH): errs.append(f'placeholders {k[1]}: {a!r} -> {b!r}')
                if "'" in b.replace("\\'", ''): errs.append(f'unescaped apostrophe {k[1]}')
    extra = [k for k in tr if k not in base]
    errs += [f'extra {k[1]}' for k in extra]
    return errs

def ios_keys(name):
    d = json.load(open(CAT[name]))
    return {k: v for k, v in d['strings'].items() if v.get('shouldTranslate', True) is not False}

def check_ios(code):
    p = os.path.join(ROOT, 'ios', 'l10n', f'{code}.json')
    t = json.load(open(p))
    errs = []
    for name in CAT:
        got = t.get(name, {})
        for k in ios_keys(name):
            if k not in got: errs.append(f'missing {name}: {k!r}'); continue
            v = got[k]
            vals = v.values() if isinstance(v, dict) else [v]
            for s in vals:
                if not isinstance(s, str) or not s.strip(): errs.append(f'empty {k!r}'); continue
                if [m.group(0) for m in I_PH.finditer(s)] != [m.group(0) for m in I_PH.finditer(k)] and name == 'Localizable':
                    if not (isinstance(v, dict)): errs.append(f'placeholders {k!r} -> {s!r}')
    return errs

def merge_ios():
    codes = sorted(f[:-5] for f in os.listdir(os.path.join(ROOT, 'ios', 'l10n')) if f.endswith('.json'))
    for name, path in CAT.items():
        d = json.load(open(path))
        for code in codes:
            t = json.load(open(os.path.join(ROOT, 'ios', 'l10n', f'{code}.json'))).get(name, {})
            for k, entry in d['strings'].items():
                if k not in t: continue
                v = t[k]
                loc = entry.setdefault('localizations', {})
                if isinstance(v, dict):
                    loc[code] = {'variations': {'plural': {c: {'stringUnit': {'state': 'translated', 'value': s}} for c, s in v.items()}}}
                else:
                    loc[code] = {'stringUnit': {'state': 'translated', 'value': v}}
        with open(path, 'w') as f:
            json.dump(d, f, ensure_ascii=False, indent=2, separators=(',', ' : '))
            f.write('\n')
    print('merged', ', '.join(codes))

if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'ios-merge': merge_ios(); sys.exit(0)
    errs = check_android(sys.argv[2]) if mode == 'android' else check_ios(sys.argv[2])
    for e in errs[:60]: print(e)
    print(f'{len(errs)} problem(s)')
    sys.exit(1 if errs else 0)
