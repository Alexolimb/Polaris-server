# -*- coding: utf-8 -*-
"""Патч боевого воркфлоу polaris-api (n8n).

Три правки, каждая — в КАЖДОЙ Code-ноде (в них лежат независимые копии
одного и того же движка котировок):

1. dividendsFor — календарь был «от сейчас» (ex-date = now + 5..40 дней и
   пересчитывался при каждом запросе), поэтому отсечка вечно убегала вперёд, а
   приложение начисляет только при exDate <= now. Дивиденды не начислялись ни
   разу. Делаем якорную квартальную сетку и отдаём прошедшую + следующую.
2. candlesFor — RP[range] регистрозависим: '1M' молча проваливался в фолбэк
   '1d', и месячный график показывал сутки.
3. mktOpen — часы сессии были зашиты как 13:30-20:00 UTC (только летний EDT);
   зимой сессия идёт 14:30-21:00 UTC, и полгода индикатор врал на час.

Запуск:  python patch_polaris_api.py <файл-воркфлоу.json>
"""
import sys
import io
import json

OLD_MKT = (
    "function mktOpen(sym,now){const a=BY[sym];if(a&&a.type==='crypto')return true;"
    "const d=new Date(now),day=d.getUTCDay();if(day===0||day===6)return false;"
    "const m=d.getUTCHours()*60+d.getUTCMinutes();return m>=810&&m<1200;}"
)
NEW_MKT = (
    "const DAYI={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};\n"
    "function nyParts(now){try{const f=new Intl.DateTimeFormat('en-US',"
    "{timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false});"
    "const p={};for(const x of f.formatToParts(new Date(now)))p[x.type]=x.value;"
    "const day=DAYI[p.weekday],h=Number(p.hour)%24,mi=Number(p.minute);"
    "if(day===undefined||!Number.isFinite(h)||!Number.isFinite(mi))return null;"
    "return{day,mins:h*60+mi};}catch(e){return null;}}\n"
    "function nthSunUtc(y,m,n){const f=new Date(Date.UTC(y,m,1)),sh=(7-f.getUTCDay())%7;"
    "return new Date(Date.UTC(y,m,1+sh+(n-1)*7,7));}\n"
    "function usDst(d){const y=d.getUTCFullYear();"
    "return d>=nthSunUtc(y,2,2)&&d<nthSunUtc(y,10,1);}\n"
    "// Сессия считается по Нью-Йорку (09:30-16:00), а не зашитым UTC-минутам:\n"
    "// иначе зимой индикатор «рынок открыт» врёт на час.\n"
    "function mktOpen(sym,now){const a=BY[sym];if(a&&a.type==='crypto')return true;"
    "const ny=nyParts(now);"
    "if(ny){if(ny.day===0||ny.day===6)return false;return ny.mins>=570&&ny.mins<960;}"
    "const d=new Date(now),day=d.getUTCDay();if(day===0||day===6)return false;"
    "const open=(usDst(d)?13:14)*60+30,m=d.getUTCHours()*60+d.getUTCMinutes();"
    "return m>=open&&m<open+390;}"
)

OLD_RANGE = "const p=RP[range]||RP['1d']"
NEW_RANGE = "const p=RP[String(range||'').toLowerCase()]||RP['1d']"

OLD_DIV = (
    "function dividendsFor(sym,now){if(!DIV.has(sym))return[];"
    "const sd=hsym(sym),dte=5+Math.floor(r01(sd+101)*35),"
    "ex=new Date(now+dte*24*HOUR),pay=new Date(ex.getTime()+7*24*HOUR);"
    "return[{symbol:sym,exDate:ex.toISOString().slice(0,10),"
    "payDate:pay.toISOString().slice(0,10),"
    "perShareCents:Math.max(1,Math.round(bp(sym)*0.004*(0.6+r01(sd+202))))}];}"
)
NEW_DIV = (
    "// Якорный дивидендный календарь. Было: ex-date = now + 5..40 дней, и дата\n"
    "// пересчитывалась при КАЖДОМ запросе, поэтому отсечка вечно убегала вперёд,\n"
    "// а приложение начисляет выплату только когда exDate <= now — дивиденды не\n"
    "// начислялись НИ РАЗУ. Теперь сетка привязана к фиксированной эпохе и\n"
    "// отдаём и прошедшую выплату (её начислят), и следующую (для календаря).\n"
    "const DIV_EPOCH=Date.UTC(2026,0,1);\n"
    "const QDAYS=91;\n"
    "function dividendsFor(sym,now){if(!DIV.has(sym))return[];"
    "const sd=hsym(sym),off=Math.floor(r01(sd+101)*QDAYS),"
    "step=QDAYS*24*HOUR,anchor=DIV_EPOCH+off*24*HOUR,"
    "k=Math.floor((now-anchor)/step),"
    "per=Math.max(1,Math.round(bp(sym)*0.004*(0.6+r01(sd+202)))),"
    "mk=(i)=>{const ex=new Date(anchor+i*step),pay=new Date(ex.getTime()+7*24*HOUR);"
    "return{symbol:sym,exDate:ex.toISOString().slice(0,10),"
    "payDate:pay.toISOString().slice(0,10),perShareCents:per};},"
    "out=[];if(k>=0)out.push(mk(k));out.push(mk(k+1));return out;}"
)

REPLACEMENTS = [
    ("дивиденды: якорный календарь", OLD_DIV, NEW_DIV),
    ("range: регистронезависимость", OLD_RANGE, NEW_RANGE),
    ("часы биржи: по Нью-Йорку", OLD_MKT, NEW_MKT),
]


def main():
    path = sys.argv[1]
    w = json.load(io.open(path, encoding="utf-8-sig"))
    total = 0
    for node in w["nodes"]:
        params = node.get("parameters") or {}
        code = params.get("jsCode")
        if not code:
            continue
        applied = []
        for label, old, new in REPLACEMENTS:
            if new.split("\n")[-1][:40] in code and old not in code:
                applied.append(label + " (уже был)")
                continue
            if old in code:
                code = code.replace(old, new, 1)
                applied.append(label)
                total += 1
        params["jsCode"] = code
        print("  %-32s %s" % (node["name"], ", ".join(applied) or "— без изменений"))
    io.open(path, "w", encoding="utf-8").write(
        json.dumps(w, ensure_ascii=False, indent=2)
    )
    print("всего правок применено:", total)
    if total == 0:
        raise SystemExit("НИ ОДНОЙ правки не применилось — проверь шаблоны!")


main()
