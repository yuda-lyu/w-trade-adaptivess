import path from 'path'
import { ENTRY_RULES, entryWrites } from './agentEntries.mjs'


//操作掃描(verify.mjs 之 scanTrace)所用之指令解析(自 verify.mjs 搬出; 判定不變): 皆為純函數(只依參數與 agentEntries.mjs 之表), 不讀檔、不起行程
//  ① stripSearchPatterns(規則 R-BT-8): 去掉搜尋類指令之樣式引數(做夢之禁區字樣比對); 搬移後另收嚴 —— 樣式取自檔或無位置樣式者(patFileOf、/G:)其後之路徑不去
//  ② listRootExempt(規則 R-BT-6): 工作夾之根之字樣只在搜尋指令之樣式引數內者不列
//  ③ entryExecOf(規則 R-BT-7 ①): 指令是否執行迴圈之寫檔入口(與各入口之拒跑共用 agentEntries.mjs 之表)
//  ④ recursiveRootOf / toolListsRoot / scriptListsRoot(規則 R-BT-7 ②): 是否遞迴列出狀態根或其上層
//  共用: maskQuotes / unmaskQuotes(引號內容以佔位符保護; 各解析函數於遮蔽之前後之檢查各依其保守原則, 不在此統一)、absOf
//  不入聚合入口(src/WTradeAdaptivess.mjs); 測試直接自本模組匯入

//absOf, 把 agent 所給之路徑(相對於專案根、Windows 絕對、或 Git Bash 之 /d/… 形式)轉為絕對路徑
let absOf = (root, p) => {
    let s = String(p).replace(/^["']|["']$/g, '')
    let m = /^\/([a-zA-Z])\/(.*)$/.exec(s)
    if (m) {
        s = `${m[1].toUpperCase()}:/${m[2]}`
    }
    return path.resolve(root, s)
}

//maskQuotes / unmaskQuotes, 引號內容(雙引號含跳脫、單引號)以佔位符 \u0001<序>\u0002 保護(其內之空白、|、;、& 不是分隔): 回 { masked, quoted(各引號原文) };
//  unmaskQuotes(s, quoted, f): 把 s 內之佔位符還原為 f(引號原文)(省略 f 時為原文本身)。呼叫端若須排除「原文已含佔位符所用之控制字元」者自行先以 MASK_CHARS 檢查
let QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g
let MASKS = /\u0001(\d+)\u0002/g // eslint-disable-line no-control-regex
let MASK_CHARS = /[\u0001\u0002]/ // eslint-disable-line no-control-regex
let maskQuotes = (s) => {
    let quoted = []
    let masked = s.replace(QUOTED, (m) => {
        quoted.push(m)
        return `\u0001${quoted.length - 1}\u0002`
    })
    return { masked, quoted }
}
let unmaskQuotes = (s, quoted, f = null) => s.replace(MASKS, (_, k) => (f ? f(quoted[Number(k)]) : quoted[Number(k)]))
//dropQuotes, 去掉字內之佔位符(只留引號外之部分)
let dropQuotes = (w) => w.replace(MASKS, '')
//stripSearchPatterns, 去掉指令內搜尋類指令(grep / egrep / fgrep / rg / ag / ack / findstr / git grep)之「搜尋樣式」引數; 其餘(含被搜尋之路徑)原樣保留
//  做夢 agent 會以禁區字樣為搜尋目標自檢(例: grep -rlE "g_backtest|ARSI_HARNESS" rsi/toolbox/): 樣式不是存取, 被搜尋之路徑仍照查
//  (例: 做夢交付前以 grep 自檢共用工具區與自己的腳本, 曾被記為觸及禁區 —— 誤報)
//  只認「該段指令以搜尋指令開頭」者(經 xargs、env 前綴等間接呼叫者不去, 寧可多報)
let SEARCH_CMD = /^(?:(?:\S*[\\/])?(?:grep|egrep|fgrep|rg|ag|ack|findstr)(?:\.exe)?|git(?:\s+-C\s+\S+)?\s+grep)(?=\s|$)/i
let SEARCH_OPT_VAL = /^(-[ABCmdDfgt]|--(?:max-count|after-context|before-context|context|include|exclude|exclude-dir|glob|type|file))$/
//patFileOf(head, t), 搜尋指令(head = 指令名部分; 只 grep 族與 rg)之選項字 t 是否「以檔給樣式」或「無位置樣式」—— 是者其後之第一個非選項引數是路徑、不是樣式(不得去掉):
//  回 2 = 值在下一個字(-f 檔、--file 檔、短選項群之末為 f)、1 = 值附於本字(--file=檔、-f檔)、3 = 無位置樣式(rg --files)、0 = 否
//  短選項群依該指令之帶值之短選項(LR_GNU 之 val: grep 為 ABCDdefm、rg 為 ABCEMTdefgjmrt —— rg 之 -r 為 --replace 帶值, 故 -rf 之 f 是其值)逐字判:
//  先遇到之帶值之選項為 f 者才算; 其他之帶值之選項(含 -e)回 0, 照既有之判法
//  ag / ack 之 -f 義異(不帶樣式檔)⇒ 不在此列; findstr 之 /G:檔 另於 stripSearchPatterns 內判
let patFileOf = (head, t) => {
    let fam = /(?:^|[\\/])rg(?:\.exe)?$/i.test(head) ? 'rg' : (/grep(?:\.exe)?$/i.test(head) ? 'grep' : null)
    if (!fam) {
        return 0
    }
    if (t === '--files') {
        return fam === 'rg' ? 3 : 0
    }
    if (t === '--file') {
        return 2
    }
    if (t.startsWith('--file=')) {
        return 1
    }
    if (/^-[A-Za-z0-9]/.test(t)) {
        for (let j = 1; j < t.length; j++) {
            if (LR_GNU[fam].val.includes(t[j])) {
                return t[j] === 'f' ? (j === t.length - 1 ? 2 : 1) : 0
            }
        }
    }
    return 0
}
let stripSearchPatterns = (cmd) => {
    //引號內之內容先以佔位符保護(樣式內之 |、;、& 不是指令分隔)
    let { masked, quoted } = maskQuotes(String(cmd))
    let segs = masked.split(/(&&|\|\||[;|\n])/).map((seg) => {
        let lead = /^\s*/.exec(seg)[0]
        let body = seg.slice(lead.length)
        let m0 = SEARCH_CMD.exec(body)
        if (!m0) {
            return seg
        }
        let isFindstr = /findstr/i.test(m0[0])
        let toks = body.slice(m0[0].length).split(/(\s+)/)
        let removed = false
        let skipNext = false
        for (let i = 0; i < toks.length; i++) {
            let t = toks[i]
            if (!t || /^\s+$/.test(t)) {
                continue
            }
            if (skipNext) {
                skipNext = false
                continue
            }
            if (/^(-e|--regexp)$/.test(t)) {
                //其後第一個引數即樣式
                for (let k = i + 1; k < toks.length; k++) {
                    if (toks[k] && !/^\s+$/.test(toks[k])) {
                        toks[k] = ' '
                        break
                    }
                }
                removed = true
                continue
            }
            if (/^--regexp=/.test(t)) {
                toks[i] = '--regexp='
                removed = true
                continue
            }
            if (isFindstr && /^\/[A-Za-z]+(:.*)?$/.test(t)) {
                if (/^\/C:/i.test(t)) {
                    toks[i] = '/C:'
                    removed = true
                }
                else if (/^\/G:/i.test(t)) {
                    //樣式取自檔(/G:檔; 檔名之字照留, 其讀取仍受查): 其後之非選項引數皆為路徑, 無位置樣式
                    removed = true
                }
                continue
            }
            //以檔給樣式(-f 檔、--file 檔、--file=檔、短選項群之 f)或無位置樣式(rg --files): 其後之第一個非選項引數是路徑、不是樣式; 檔名之字照留(讀取該檔仍受查)
            let pf = patFileOf(m0[0], t)
            if (pf) {
                removed = true
                skipNext = pf === 2
                continue
            }
            if (SEARCH_OPT_VAL.test(t)) {
                skipNext = true
                continue
            }
            if (t.startsWith('-')) {
                continue
            }
            //第一個非選項引數 = 樣式(已由 -e / --regexp / /C: / 檔給樣式者, 其餘皆為路徑)
            if (!removed) {
                //選項可置於運算元之後(GNU 之選項排列): 其後(至 -- 為止)另有以檔給樣式或無位置樣式之選項者, 此引數是路徑、不去(從嚴: 該字若為他選項之值亦不去 —— 只會多列)
                let later = false
                for (let k = i + 1; k < toks.length && toks[k] !== '--'; k++) {
                    if (toks[k] && !/^\s+$/.test(toks[k]) && (patFileOf(m0[0], toks[k]) || (isFindstr && /^\/G:/i.test(toks[k])))) {
                        later = true
                        break
                    }
                }
                if (!later) {
                    toks[i] = ' '
                }
                removed = true
            }
            break
        }
        return lead + m0[0] + toks.join('')
    })
    return unmaskQuotes(segs.join(''), quoted)
}
//listRootExempt(規則 R-BT-6), 一道指令內「工作夾之根」之字樣(reListRoot 之命中)是否**只**出現在搜尋指令之樣式引數內 —— 是 ⇒ 不列「存取其他節點之工作夾(列出工作夾之根)」
//  (例: 節點以 grep -c 'DONE <根>' <根>/<本節點>/agent_a1.log 在自己之紀錄檔內找含該字樣之列, 曾被列為越界 —— 誤報); 以之為列目錄、讀取或遞迴搜尋之路徑引數者照列
//  **保守**(寧可多列、不可漏列真越界): 只在能確定時回 true; 下列皆回 false(照現行之寬判列出):
//    ⓪指令本身含佔位符所用之控制字元(\u0001 / \u0002)①工作目錄不確定(opt.cwdKnown 為否; 或指令內有切換目錄之指令)②有跳脫之引號(\" \')或引號不成對
//    ③引號外有 $ ` ^ % < ( ) { }(變數、命令替換、輸入之重導向、群組), 雙引號內有變數展開或命令替換, 或字中夾有 >
//    ④去掉各搜尋指令之樣式後仍命中該字樣(同一指令之他段或路徑引數以之為目標)
//    ⑤樣式含該字樣之搜尋指令: 不是 grep / egrep / fgrep / rg / findstr / Select-String(sls)、選項不在已知之清單內(該段不去樣式 ⇒ 歸 ④)、
//      樣式於引號外含萬用字元、無路徑引數(grep 不遞迴者與 Select-String 讀標準輸入者除外)、或任一路徑引數以 ~ 起首、或其(萬用字元之前之)目錄為工作夾之根或其上層(含 .、專案根)
//  opt.base = 解析相對路徑之目錄(專案根); opt.workRoot = 工作夾之根
let LR_CD = /(?:^|[;&|\n(])\s*(?:cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)(?=$|[\s;&|)])/i
let LR_SEARCH = [
    [/^(?:\S*[\\/])?(?:grep|egrep|fgrep)(?:\.exe)?$/i, 'grep'],
    [/^(?:\S*[\\/])?rg(?:\.exe)?$/i, 'rg'],
    [/^(?:\S*[\\/])?findstr(?:\.exe)?$/i, 'findstr'],
    [/^(?:select-string|sls)$/i, 'sls'],
]
//LR_GNU, grep 與 rg 之選項: val = 帶值之短選項(其後之字或同一字之餘下為值; e = 樣式、f = 樣式檔), flag = 不帶值之短選項, rec = 遞迴者(grep 之 -d 帶值亦視為遞迴),
//  longVal / longFlag / longOpt(值只可附於 =)= 長選項(不收縮寫); longRec = 遞迴之長選項; stdinOk = 無路徑引數時讀標準輸入(不遞迴者)
//  (rg 之 -r 為 --replace〔帶值〕、-d 為 --max-depth、-E 為 --encoding、--files 為「只列檔」〔無樣式〕; 與 grep 同字母而義異者各列各的)
let LR_GNU = {
    grep: {
        val: 'ABCDdefm',
        flag: 'EFGPiyvwxcLloqsbHhnTZzaIrRUV0123456789',
        rec: 'rRd',
        longVal: ['regexp', 'file', 'after-context', 'before-context', 'context', 'max-count', 'devices', 'directories', 'include', 'exclude', 'exclude-dir', 'exclude-from', 'label', 'binary-files', 'group-separator'],
        longFlag: ['recursive', 'dereference-recursive', 'ignore-case', 'no-ignore-case', 'invert-match', 'word-regexp', 'line-regexp', 'count', 'files-with-matches', 'files-without-match', 'only-matching', 'quiet', 'silent', 'no-messages', 'byte-offset', 'with-filename', 'no-filename', 'line-number', 'initial-tab', 'null', 'null-data', 'text', 'extended-regexp', 'fixed-strings', 'basic-regexp', 'perl-regexp', 'line-buffered', 'no-group-separator'],
        longOpt: ['color', 'colour'],
        longRec: ['recursive', 'dereference-recursive', 'directories'],
        stdinOk: true,
    },
    rg: {
        val: 'ABCEMTdefgjmrt',
        flag: 'abcFHhIiLlNnoPpqSsUuVvwxz0',
        rec: '',
        longVal: ['regexp', 'file', 'glob', 'iglob', 'type', 'type-not', 'type-add', 'type-clear', 'max-count', 'after-context', 'before-context', 'context', 'max-columns', 'threads', 'encoding', 'replace', 'max-depth', 'max-filesize', 'sort', 'sortr', 'color', 'colors', 'context-separator', 'field-match-separator', 'field-context-separator', 'path-separator', 'pre', 'pre-glob', 'ignore-file', 'engine', 'regex-size-limit', 'dfa-size-limit'],
        longFlag: ['ignore-case', 'case-sensitive', 'smart-case', 'invert-match', 'word-regexp', 'line-regexp', 'count', 'count-matches', 'files-with-matches', 'files-without-match', 'only-matching', 'quiet', 'line-number', 'no-line-number', 'with-filename', 'no-filename', 'hidden', 'no-ignore', 'no-ignore-vcs', 'follow', 'fixed-strings', 'pcre2', 'multiline', 'text', 'null', 'no-heading', 'heading', 'column', 'vimgrep', 'json', 'stats', 'trim', 'unrestricted', 'search-zip', 'byte-offset', 'pretty', 'passthru', 'no-messages', 'files'],
        longOpt: [],
        longRec: [],
        stdinOk: false,
    },
}
//lrParse*, 一段搜尋指令(不含指令名)之字 → { pats(樣式所在之字之索引), paths(路徑引數之字), stdin(無路徑引數時是否只讀標準輸入) }; 不認得之選項或無樣式 ⇒ null
let lrParseGnu = (ws, tb) => {
    let pats = []
    let ops = []
    let given = false
    let rec = false
    for (let i = 0; i < ws.length; i++) {
        let w = ws[i]
        if (w === '--') {
            for (let k = i + 1; k < ws.length; k++) {
                ops.push(k)
            }
            break
        }
        if (w === '-' || !w.startsWith('-')) {
            ops.push(i)
            continue
        }
        if (w.startsWith('--')) {
            let m = /^--([a-z][a-z0-9-]*)(=[\s\S]*)?$/.exec(w)
            if (!m) {
                return null
            }
            let [, name, eq] = m
            if (tb.longVal.includes(name)) {
                let vi = eq !== undefined ? i : i + 1
                if (vi >= ws.length) {
                    return null
                }
                if (name === 'regexp') {
                    pats.push(vi)
                }
                given = given || name === 'regexp' || name === 'file'
                rec = rec || tb.longRec.includes(name)
                i = vi
                continue
            }
            if (tb.longOpt.includes(name) || (tb.longFlag.includes(name) && eq === undefined)) {
                given = given || name === 'files'
                rec = rec || tb.longRec.includes(name)
                continue
            }
            return null
        }
        for (let j = 1; j < w.length; j++) {
            let c = w[j]
            if (tb.val.includes(c)) {
                let vi = j + 1 < w.length ? i : i + 1
                if (vi >= ws.length) {
                    return null
                }
                if (c === 'e') {
                    pats.push(vi)
                }
                given = given || c === 'e' || c === 'f'
                rec = rec || tb.rec.includes(c)
                i = vi
                break
            }
            if (!tb.flag.includes(c)) {
                return null
            }
            rec = rec || tb.rec.includes(c)
        }
    }
    if (!given) {
        if (!ops.length) {
            return null
        }
        pats.push(ops.shift())
    }
    return { pats, paths: ops.map((k) => ws[k]), stdin: tb.stdinOk && !rec }
}
//findstr: /C:<樣式>(樣式)、/G:<檔>(樣式檔); 不帶值之選項與 /A:<色>; /F:(檔案清單)、/D:(目錄清單)與其他 ⇒ null
let lrParseFindstr = (ws) => {
    let pats = []
    let ops = []
    let given = false
    for (let i = 0; i < ws.length; i++) {
        let w = ws[i]
        if (!w.startsWith('/')) {
            ops.push(i)
            continue
        }
        if (/^\/[cg]:./i.test(w)) {
            if (/^\/c/i.test(w)) {
                pats.push(i)
            }
            given = true
            continue
        }
        if (!/^\/(?:off(?:line)?|[belrsixvnmop]+|a:[0-9a-f]{1,2})$/i.test(w)) {
            return null
        }
    }
    if (!given) {
        if (!ops.length) {
            return null
        }
        pats.push(ops.shift())
    }
    return { pats, paths: ops.map((k) => ws[k]), stdin: false }
}
//Select-String(sls): 參數名只收全名(不分大小寫; 不收縮寫與 -名:值); 位置引數依序為 -Pattern、-Path; 路徑引數以逗號分隔多個
let LR_SLS_FLAG = ['simplematch', 'casesensitive', 'notmatch', 'allmatches', 'list', 'quiet', 'raw', 'noemphasis']
let LR_SLS_VAL = ['context', 'encoding', 'include', 'exclude', 'culture']
let lrParseSls = (ws) => {
    let pats = []
    let pos = []
    let paths = null
    for (let i = 0; i < ws.length; i++) {
        let w = ws[i]
        if (!w.startsWith('-')) {
            pos.push(i)
            continue
        }
        let m = /^-([a-z]+)$/i.exec(w)
        let k = m ? m[1].toLowerCase() : null
        if (k && LR_SLS_FLAG.includes(k)) {
            continue
        }
        if (!k || i + 1 >= ws.length || !['pattern', 'path', 'literalpath', ...LR_SLS_VAL].includes(k)) {
            return null
        }
        if (k === 'pattern') {
            pats.push(i + 1)
        }
        else if (k === 'path' || k === 'literalpath') {
            paths = [...(paths || []), ...ws[i + 1].split(',')]
        }
        i++
    }
    if (!pats.length) {
        if (!pos.length) {
            return null
        }
        pats.push(pos.shift())
    }
    if (paths === null && pos.length) {
        paths = ws[pos.shift()].split(',')
    }
    if (pos.length) {
        return null
    }
    return { pats, paths: paths || [], stdin: true }
}
let LR_PARSE = { grep: (ws) => lrParseGnu(ws, LR_GNU.grep), rg: (ws) => lrParseGnu(ws, LR_GNU.rg), findstr: lrParseFindstr, sls: lrParseSls }
let listRootExempt = (cmd, re, { base, workRoot, cwdKnown = true }) => {
    let s = String(cmd)
    //指令本身已含佔位符所用之控制字元(\u0001 / \u0002)者無從確定: 偽造之佔位符會被還原成另一段引號之內容, 越界者還原時取不到值 ⇒ 照列(不得拋錯中斷掃描)
    if (MASK_CHARS.test(s)) {
        return false
    }
    if (!cwdKnown || LR_CD.test(s) || /\\["']/.test(s)) {
        return false
    }
    //引號內之內容先以佔位符保護(樣式內之空白、|、;、& 不是分隔); 其後仍有引號 = 不成對
    let { masked, quoted } = maskQuotes(s)
    if (/["'`$^%<(){}]/.test(masked) || quoted.some((q) => q[0] === '"' && /`|\$[\w{(@*#?!$-]/.test(q))) {
        return false
    }
    let unq = (w) => unmaskQuotes(w, quoted)
    let inner = (w) => unmaskQuotes(w, quoted, (x) => x.slice(1, -1))
    let rest = []
    let need = []
    for (let seg of masked.split(/&&|\|\||\|&|[|;\n]|(?<!>)&(?!>)/)) {
        let words = seg.trim().split(/\s+/).filter(Boolean)
        //輸出之重導向(> 檔、2> 檔、>> 檔、&> 檔、2>&1)不是搜尋之路徑引數(仍留在殘留內照查); 字中夾有 > 者無從判定 ⇒ 照列
        let ws = []
        for (let i = 0; i < words.length; i++) {
            let w = words[i]
            if (!w.includes('>')) {
                ws.push(i)
            }
            else if (/^(?:\d*|&)>>?$/.test(w)) {
                i++
            }
            else if (!(/^\d*>&(?:\d+|-)$/.test(w) || /^(?:\d*|&)>>?[^>&]/.test(w))) {
                return false
            }
        }
        let fam = ws.length ? LR_SEARCH.find(([r]) => r.test(words[ws[0]])) : null
        let r = fam ? LR_PARSE[fam[1]](ws.slice(1).map((k) => words[k])) : null
        let drop = new Set(r ? r.pats.map((k) => ws[k + 1]) : [])
        rest.push(words.filter((_, i) => !drop.has(i)).join(' '))
        if ([...drop].some((i) => re.test(unq(words[i])))) {
            need.push({ r, pats: [...drop].map((i) => words[i]) })
        }
    }
    if (!need.length || re.test(unq(rest.join(' ; ')))) {
        return false
    }
    let wr = path.resolve(workRoot)
    let coversRoot = (p) => {
        let rel = path.relative(absOf(base, p), wr)
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    }
    for (let { r, pats } of need) {
        if (pats.some((w) => /[*?[]/.test(dropQuotes(w))) || (!r.paths.length && !r.stdin)) {
            return false
        }
        for (let p of r.paths.map(inner)) {
            if (p === '-') {
                continue
            }
            let g = p.search(/[*?[]/)
            if (!p || p.startsWith('~') || coversRoot((g < 0 ? p : p.slice(0, g).replace(/[^\\/]*$/, '')) || '.')) {
                return false
            }
        }
    }
    return true
}
//── 執行迴圈之寫檔入口、遞迴列出狀態根(規則 R-BT-7)──
//SHELLS: 殼層(其 -c / /c 之後之字、或交給它之 here-doc 為指令; entryExecOf 與 recursiveRootOf 共用)
let SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd'])
//EVAL_WRAPS: 把其後之字串當指令執行之包裝(entryExecOf 與 recursiveRootOf 共用; entryExecOf 另把殼層、xargs、parallel 亦視為包裝 ⇒ EX_WRAPS)
let EVAL_WRAPS = new Set(['eval', 'start-process', 'watch', 'start', 'call', 'invoke-expression', 'iex'])
//CMD_PREFIXES: 不改變其後指令之解析之前綴; entryExecOf 另認 npx(EX_SKIP; npx 後之字為被執行之套件命令), recursiveRootOf 不認(RL_SKIP; 列目錄 / 搜尋之判定不經 npx)
let CMD_PREFIXES = ['env', 'time', 'nohup', 'command', 'exec', 'sudo', 'nice']
//SCRIPT_RUNNERS: 內嵌腳本 / here-doc 腳本之判定所認之直譯器(recursiveRootOf 之 scriptListsRoot 只理解 JavaScript 與 Python); entryExecOf 之 here-doc 另認 deno、bun(EX_RUNNERS; 其內文是否起子行程只看 EX_CHILD 之字樣)
let SCRIPT_RUNNERS = ['node', 'nodejs', 'python', 'python3', 'py']
let EX_RUNNERS = [...SCRIPT_RUNNERS, 'deno', 'bun']
//VAR_ASSIGN: 變數指派之字(NAME=值)
let VAR_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
//exQuote, 指令之引號內容以佔位符保護(用 maskQuotes; 與 listRootExempt 同一份遮蔽): 回 { masked, unq(字 → 含引號之原文), bare(字 → 去引號), dyn(字 → 是否含殼層之展開), sub };
//  雙引號內之跳脫(\" \\ \$ \`)照殼層之規則: bare 還原為字面, dyn / sub 不計被跳脫之 $ 與反引號
//  dyn: 引號外之 $ 或反引號、雙引號內之變數($名、${…}、$(…))或反引號 ⇒ 字之值無從靜態判定(單引號內者是字面)
//  sub: 指令任一處(單引號內除外)有命令替換或行程替換($(…)、反引號、<(…)、>(…))⇒ 分段亦不可信
//  含佔位符所用之控制字元、引號外之跳脫引號(\" \')或引號不成對者回 null(無法解析)
let exQuote = (s) => {
    if (MASK_CHARS.test(s)) {
        return null
    }
    let { masked, quoted } = maskQuotes(s)
    if (/["']|\\\u0001/.test(masked)) { // eslint-disable-line no-control-regex
        return null
    }
    //雙引號字串去掉跳脫之字元後之原文(判展開用)
    let live = quoted.map((x) => (x[0] === '"' ? x.replace(/\\[\s\S]/g, '') : ''))
    let dynQ = (k) => /`|\$[\w{(@*#?!$-]/.test(live[Number(k)])
    return {
        masked,
        unq: (w) => unmaskQuotes(w, quoted),
        bare: (w) => unmaskQuotes(w, quoted, (x) => (x[0] === '"' ? x.slice(1, -1).replace(/\\([$`"\\\n])/g, '$1') : x.slice(1, -1))),
        dyn: (w) => /[$`]/.test(dropQuotes(w)) || [...w.matchAll(MASKS)].some(([, k]) => dynQ(k)),
        sub: /`|\$\(|[<>]\(/.test(masked) || live.some((x) => /`|\$\(/.test(x)),
    }
}
//exSegs, 分段(&&、||、|&、|、;、換行、單獨之 &、括號、反引號)→ 各段之字(以空白切; 遮蔽後之字)
let exSegs = (masked) => masked.split(/&&|\|\||\|&|[|;\n()`]|(?<!>)&(?!>)/).map((seg) => seg.trim().split(/\s+/).filter(Boolean)).filter((ws) => ws.length)
//exHeredoc, 去掉 here-doc 之內文(只留其首列; 同「寫到允許範圍之外」之作法)→ { text, docs: [{ cmd(首列之指令名), body }] }
//  內文是交給首列之指令之輸入: 寫檔(cat > 檔 << 'EOF')時是文字; 交給殼層或 node 者(bash << 'EOF')才是指令, 由呼叫端另判
let exHeredoc = (s) => {
    let docs = []
    let text = s.replace(/(<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g, (m, head, q, tag, body, at, all) => {
        let line = all.slice(all.lastIndexOf('\n', at) + 1, at)
        let w = line.split(/&&|\|\||[|;]/).pop().trim().split(/\s+/)[0] || ''
        docs.push({ cmd: cmdName(w.replace(/^["']|["']$/g, '')), body })
        return head
    })
    return { text, docs }
}
//exArgs, 去掉輸出之重導向(> 檔、2>&1、&> 檔 …; 只有運算子者連同其後之字)之後之字
let exArgs = (ws) => {
    let out = []
    for (let i = 0; i < ws.length; i++) {
        if (/^(?:\d*|&)>>?$/.test(ws[i])) {
            i++
        }
        else if (!/^(?:\d*|&)>/.test(ws[i])) {
            out.push(ws[i])
        }
    }
    return out
}
//cmdName, 指令之名(去路徑前綴與 .exe; 小寫)
let cmdName = (w) => String(w).replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.exe$/i, '').toLowerCase()
//EX_TOOLS / EX_MENTION / entryNameOf, agentEntries.mjs 之表內之進入檔: g_rsi.mjs、g_launch.mjs、g_build.mjs(g_backtest.mjs 已由禁區字樣「回測期工具 g_backtest」列出, 不重列)、
//  直接執行套件之命令列(…/cli/{rsi,launch,build,backtest}.mjs)、…/tools/<表內之工具>.mjs、…/initProject.mjs; 名稱不分大小寫(Windows 之檔案系統)
let EX_TOOLS = Object.keys(ENTRY_RULES).filter((k) => !['rsi', 'launch', 'build', 'backtest', 'initProject'].includes(k))
let EX_TOOL_LC = new Map(EX_TOOLS.map((k) => [k.toLowerCase(), k]))
let EX_MENTION = new RegExp(`(?:^|[\\s"'=(\\\\/])(?:g_(?:rsi|launch|build)|cli[\\\\/]+(?:rsi|launch|build|backtest)|tools[\\\\/]+(?:${EX_TOOLS.join('|')})|initProject)\\.mjs`, 'i')
let entryNameOf = (w) => {
    let s = String(w).replace(/\\/g, '/')
    let m = /(?:^|\/)g_(rsi|launch|build)\.mjs$/i.exec(s) || /(?:^|\/)cli\/(rsi|launch|build|backtest)\.mjs$/i.exec(s)
    if (m) {
        return m[1].toLowerCase()
    }
    m = /(?:^|\/)tools\/([A-Za-z]+)\.mjs$/i.exec(s)
    if (m && EX_TOOL_LC.has(m[1].toLowerCase())) {
        return EX_TOOL_LC.get(m[1].toLowerCase())
    }
    return /(?:^|\/)initproject\.mjs$/i.test(s) ? 'initProject' : null
}
//EX_READERS: 讀取、搜尋、比較、複製類之指令(進入檔只是其引數 ⇒ 不是執行); EX_SKIP: 不改變其後指令之解析之前綴; EX_NODE_*: node 之帶值之選項與內嵌腳本之選項
let EX_READERS = new Set(['cat', 'type', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'findstr', 'select-string', 'sls', 'get-content', 'gc', 'ls', 'dir', 'wc', 'diff', 'cmp', 'file', 'stat', 'sha1sum', 'sha256sum', 'md5sum', 'echo', 'printf', 'git', 'sed', 'awk', 'cut', 'sort', 'uniq', 'xxd', 'od', 'strings', 'cp', 'copy', 'copy-item', 'mv', 'move'])
let EX_SKIP = new Set([...CMD_PREFIXES, 'npx'])
let EX_NODE_VAL = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file', '--input-type', '--title'])
let EX_NODE_INLINE = new Set(['-e', '--eval', '-p', '--print', '-pe'])
//entryExecOf(cmd), 指令是否執行 agentEntries.mjs 之表內之寫檔或起行程之進入檔與模式(判定同各入口之拒跑 —— entryWrites; 唯讀之模式不列)
//  保守: 提到進入檔而無法解析者(引號不成對、命令替換、指令名或進入檔之引數含變數、變數之值提到進入檔、殼層 / PowerShell / xargs 等其他指令包著、
//  直接執行進入檔而其模式會寫檔)⇒ 列; 讀取類之指令(cat、grep …)之引數 ⇒ 不列; 輸出重導向之目標不算該段之字
//  node 之後之第一個非選項之字為所執行之腳本: 不是進入檔者(進入檔只是其引數)不列; 經 env / npx / npm exec(x)/ time 等前綴者照判
//  node 之內嵌腳本(-e / -p): 腳本只是程式之文字 —— 腳本呼叫子行程(child_process、exec*、spawn*、fork)且該段提到進入檔者才列(例: 以內嵌腳本把含進入檔指令之文字寫入文件, 不列)
//  here-doc 之內文: 交給殼層或 node 者(bash << 'EOF'、node - << 'EOF')照指令或腳本判; 交給其他指令者(cat > 檔 << 'EOF')是文字, 不判
let EX_CHILD = /\bchild_process\b|\b(?:execSync|execFileSync|spawnSync|execFile|spawn|fork)\s*\(|\bexec\s*\(|\bsubprocess\b|\bos\.system\b|\bStart-Process\b/
let EX_WRAPS = new Set([...SHELLS, 'xargs', 'parallel', ...EVAL_WRAPS])
let entryExecOf = (cmd) => {
    let s0 = String(cmd)
    if (!EX_MENTION.test(s0)) {
        return false
    }
    let hd = exHeredoc(s0)
    for (let { cmd: hc, body } of hd.docs) {
        if (EX_MENTION.test(body) && (SHELLS.has(hc) ? entryExecOf(body) : EX_RUNNERS.includes(hc) && EX_CHILD.test(body))) {
            return true
        }
    }
    let s = hd.text
    if (!EX_MENTION.test(s)) {
        return false
    }
    let q = exQuote(s)
    if (!q || q.sub) {
        return true
    }
    let segs = exSegs(q.masked)
    //任一段為 xargs、殼層或 eval 類(其所執行之指令來自標準輸入或引號內之字串)而指令提到進入檔 ⇒ 從嚴列出
    if (segs.some((ws) => EX_WRAPS.has(cmdName(q.bare(ws.find((w) => !VAR_ASSIGN.test(w)) || ''))))) {
        return true
    }
    for (let ws0 of segs) {
        if (!ws0.some((w) => EX_MENTION.test(q.unq(w)) || entryNameOf(q.bare(w)))) {
            continue
        }
        let ws = exArgs(ws0)
        let i = 0
        while (i < ws.length && VAR_ASSIGN.test(ws[i])) {
            if (EX_MENTION.test(q.unq(ws[i]))) {
                return true
            }
            i++
        }
        //指令名含變數者不是下列任一已知之名 ⇒ 落入末之「其他指令」而列出
        let done = false
        while (i < ws.length && !done) {
            let c = cmdName(q.bare(ws[i]))
            let direct = entryNameOf(q.bare(ws[i]))
            if (direct) {
                if (entryWrites(direct, ws.slice(i + 1).map(q.bare)) || ws.slice(i + 1).some(q.dyn)) {
                    return true
                }
                done = true
            }
            else if (EX_READERS.has(c)) {
                done = true
            }
            else if (c === 'npm' && /^(exec|x)$/.test(q.bare(ws[i + 1] || ''))) {
                i += 2
                while (i < ws.length && ws[i].startsWith('-') && ws[i] !== '--') {
                    i++
                }
                i += ws[i] === '--' ? 1 : 0
            }
            else if (EX_SKIP.has(c)) {
                i++
                while (i < ws.length && (ws[i].startsWith('-') || VAR_ASSIGN.test(ws[i]))) {
                    i += (c === 'nice' && ws[i] === '-n') || (c === 'npx' && /^(-p|--package)$/.test(ws[i])) ? 2 : 1
                }
                i += ws[i] === '--' ? 1 : 0
            }
            else if (c === 'node' || c === 'nodejs') {
                let j = i + 1
                let inline = null
                while (j < ws.length && ws[j].startsWith('-')) {
                    if (EX_NODE_INLINE.has(ws[j])) {
                        inline = j + 1 < ws.length ? q.bare(ws[j + 1]) : ''
                        break
                    }
                    j += EX_NODE_VAL.has(ws[j]) ? 2 : 1
                }
                if (inline !== null) {
                    if (EX_CHILD.test(inline)) {
                        return true
                    }
                }
                else if (j < ws.length) {
                    if (q.dyn(ws[j])) {
                        return true
                    }
                    let name = entryNameOf(q.bare(ws[j]))
                    if (name && (entryWrites(name, ws.slice(j + 1).map(q.bare)) || ws.slice(j + 1).some(q.dyn))) {
                        return true
                    }
                }
                done = true
            }
            else {
                return true
            }
        }
    }
    return false
}
//RL_*(遞迴列出狀態根; 節點): 列目錄(ls、dir 帶 -R / --recursive / /s, gci / Get-ChildItem 帶 -Recurse / -Depth; find、tree 恆遞迴)與遞迴之搜尋(grep -r / -R / -d、rg、findstr /S)
//  以狀態根或其上層為路徑引數(未給路徑者 = 工作目錄)⇒ 列; 殼層之 -c(bash -c、cmd /c、pwsh -Command)與 here-doc 交給殼層者照其內之指令判; xargs 照其後之指令判;
//  eval / watch / start / call / Start-Process 包著者, 只要提到上列指令 ⇒ 從嚴列出; 指令名含變數者另於任一非選項之引數為狀態根或其上層時列出;
//  路徑引數含變數或以 ~ 起首、工作目錄不確定時之相對路徑 ⇒ 視為可能是
let RL_SKIP = new Set(CMD_PREFIXES)
//RL_CD: 切換目錄之指令名(popd / pop-location 另於 recursiveRootOf 內判; 與 LR_CD 為「文字內有無切換目錄」之粗判, 用途不同)
let RL_CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'])
let RL_LISTER = /(?:^|[\s"'(;&|`])(?:ls|dir|gci|get-childitem|find|tree|grep|egrep|fgrep|rg|findstr)(?:\.exe)?(?=$|[\s"';&|)`])/i
//RL_VAL: tree 之帶值之選項(其值不是路徑); RL_XARGS_VAL: xargs 之帶值之選項
let RL_VAL = new Set(['-L', '-P', '-I', '-o', '-H', '-T', '--filelimit', '--charset', '--sort', '--timefmt'])
let RL_XARGS_VAL = new Set(['-I', '-i', '-n', '-P', '-d', '-L', '-l', '-s', '-a', '-E', '-e', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--max-lines', '--max-chars', '--replace', '--eof'])
//rlCovers(p, base, stateRoot), 路徑(去引號)於目錄 base 解析後是否為狀態根或其上層; 含萬用字元者取萬用字元之前之目錄; 以 ~ 起首、含變數者、或 base 為 null 而為相對路徑者 ⇒ 無從確定 ⇒ 是
let rlCovers = (p, base, stateRoot) => {
    if (!p || p.startsWith('~') || /[$`]/.test(p)) {
        return true
    }
    let g = p.search(/[*?[]/)
    let d = g < 0 ? p : p.slice(0, g).replace(/[^\\/]*$/, '')
    let isAbs = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(d)
    if (!isAbs && base === null) {
        return true
    }
    let rel = path.relative(absOf(isAbs ? '.' : base, d || '.'), path.resolve(stateRoot))
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
//scriptListsRoot(src, base, stateRoot), 一段腳本(node / python 之內嵌腳本、here-doc 交給 node / python 者、寫入之程式檔之內容)是否遞迴列出狀態根或其上層:
//  列目錄之呼叫(readdir / opendir / glob / os.walk / scandir / listdir / iterdir / rglob 類)∧ 遞迴之線索(recursive、isDirectory、withFileTypes、**、walk、rglob、is_dir)
//  ∧ 起點為狀態根或其上層 —— 起點之線索: process.cwd()、os.getcwd()(其後未接「, 常值」或「+」之拼接者); 與狀態根同名之字串常值、含分隔符之字串常值(其後未接「, 常值」或「+」者 ——
//  拼接路徑之前段不是起點); 「.」「..」「./」「../」只在作為列目錄 / 走訪類之呼叫之第一個引數時算(split('.') 之類不算); 只含分隔符之常值、含空白或跳脫之常值不計
let SC_LIST = /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob|walkSync|readdirp|walk|scandir|listdir|iterdir|rglob|Get-ChildItem)\b/
let SC_REC = /\brecursive\b|\bisDirectory\b|\bis_dir\b|\bwithFileTypes\b|\*\*|\bwalk|\brglob\b|-Recurse\b/i
let SC_CALL = /(?:readdir\w*|opendir\w*|glob\w*|walk\w*|scan\w*|list\w*|rglob|iterdir|Path|resolve)\s*\(\s*$/i
let scriptListsRoot = (src, base, stateRoot) => {
    let s = String(src)
    if (!SC_LIST.test(s) || !SC_REC.test(s)) {
        return false
    }
    if (/\b(?:process\.cwd|os\.getcwd)\(\)(?!\s*(?:\+|,\s*['"`]))/.test(s) && rlCovers('.', base, stateRoot)) {
        return true
    }
    let rootName = path.basename(path.resolve(stateRoot))
    for (let m of s.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\$]*)`/g)) {
        let v = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3])
        let after = s.slice(m.index + m[0].length)
        if (/^\s*(?:\+|,\s*['"`])/.test(after)) {
            continue
        }
        let dots = ['.', './', '..', '../'].includes(v)
        let pathy = dots ? SC_CALL.test(s.slice(Math.max(0, m.index - 40), m.index)) : (v === rootName || (/[\\/]/.test(v) && !/^[\\/]+$/.test(v) && !/\s/.test(v)))
        if (pathy && rlCovers(v, base, stateRoot)) {
            return true
        }
    }
    return false
}
//recursiveRootOf(cmd, { base, stateRoot }) → { hit, dir }: 指令是否以遞迴方式列出狀態根或其上層; dir = 指令結束後之工作目錄(段內之 cd 依序解析; 不確定者 null)
let recursiveRootOf = (cmd, { base, stateRoot }) => {
    let hd = exHeredoc(String(cmd))
    let s = hd.text
    let hit = false
    for (let { cmd: hc, body } of hd.docs) {
        if (SHELLS.has(hc) ? recursiveRootOf(body, { base, stateRoot }).hit : SCRIPT_RUNNERS.includes(hc) && scriptListsRoot(body, base, stateRoot)) {
            hit = true
        }
    }
    let q = exQuote(s)
    if (!q) {
        return { hit: hit || RL_LISTER.test(s), dir: LR_CD.test(s) ? null : base }
    }
    let dir = base
    for (let ws0 of exSegs(q.masked)) {
        let i = 0
        while (i < ws0.length && VAR_ASSIGN.test(ws0[i])) {
            i++
        }
        //前綴(env、time …)與 xargs(其後之指令以標準輸入之各列為附加之路徑引數)
        let viaXargs = false
        for (;;) {
            let c0 = i < ws0.length ? cmdName(q.bare(ws0[i])) : ''
            if (RL_SKIP.has(c0)) {
                i++
                while (i < ws0.length && ws0[i].startsWith('-')) {
                    i++
                }
            }
            else if (c0 === 'xargs') {
                viaXargs = true
                i++
                while (i < ws0.length && ws0[i].startsWith('-')) {
                    i += RL_XARGS_VAL.has(ws0[i]) ? 2 : 1
                }
            }
            else {
                break
            }
        }
        if (i >= ws0.length) {
            continue
        }
        let txt = q.unq(ws0.slice(i).join(' '))
        let c = cmdName(q.bare(ws0[i]))
        let ws = exArgs(ws0.slice(i + 1))
        //指令名含變數(無從確定是哪個指令)⇒ 提到上列指令、或任一非選項之引數為狀態根或其上層者列出
        if (q.dyn(ws0[i])) {
            hit = hit || RL_LISTER.test(txt) || ws.some((w) => !w.startsWith('-') && rlCovers(q.bare(w), dir, stateRoot))
            continue
        }
        if (RL_CD.has(c)) {
            let t = ws.length ? q.bare(ws[0]) : ''
            dir = !t || t === '-' || /[$`~]/.test(t) || dir === null ? null : absOf(dir, t)
            continue
        }
        if (c === 'popd' || c === 'pop-location') {
            dir = null
            continue
        }
        if (EVAL_WRAPS.has(c)) {
            hit = hit || RL_LISTER.test(txt)
            continue
        }
        let paths = null
        if (SHELLS.has(c)) {
            //殼層: -c / -lc …(bash 類)、/c、/k(cmd)、-c / -Command(PowerShell)之後為指令; 其他(執行腳本檔)不判
            let k = ws.findIndex((w) => /^-[A-Za-z]*c$/.test(w) || /^\/[ck]$/i.test(w) || /^-c(ommand)?$/i.test(w))
            if (k >= 0 && k + 1 < ws.length) {
                let rest = ws.slice(k + 1)
                if (recursiveRootOf(rest.length === 1 ? q.bare(rest[0]) : rest.map(q.unq).join(' '), { base: dir, stateRoot }).hit) {
                    hit = true
                }
            }
        }
        else if (SCRIPT_RUNNERS.includes(c)) {
            let k = ws.findIndex((w) => EX_NODE_INLINE.has(w) || w === '-c')
            if (k >= 0 && k + 1 < ws.length && scriptListsRoot(q.bare(ws[k + 1]), dir, stateRoot)) {
                hit = true
            }
        }
        else if (c === 'ls' || c === 'dir' || c === 'gci' || c === 'get-childitem') {
            let isGci = c === 'gci' || c === 'get-childitem'
            let rec = (w) => (isGci ? /^-r(e(c(u(r(se?)?)?)?)?)?$/i.test(w) : /^-[A-Za-z]*R[A-Za-z]*$/.test(w) || w === '--recursive' || /^-rec(u(r(se?)?)?)?$/i.test(w) || (c === 'dir' && /^\/s$/i.test(w))) || /^-depth$/i.test(w)
            if (ws.some(rec)) {
                let ops = []
                for (let k = 0; k < ws.length; k++) {
                    if (/^-(path|literalpath)$/i.test(ws[k])) {
                        k++
                        if (k < ws.length) {
                            ops.push(ws[k])
                        }
                    }
                    else if (/^-(filter|include|exclude|depth)$/i.test(ws[k])) {
                        k++
                    }
                    else if (!ws[k].startsWith('-') && !/^\/[a-z](:\S*)?$/i.test(ws[k])) {
                        ops.push(ws[k])
                    }
                }
                paths = ops.length ? ops : ['.']
            }
        }
        else if (c === 'find') {
            let k = ws.findIndex((w) => /^[-(!]|^\\\(/.test(w))
            let ops = k < 0 ? ws : ws.slice(0, k)
            paths = ops.length ? ops : ['.']
        }
        else if (c === 'tree') {
            let ops = []
            for (let k = 0; k < ws.length; k++) {
                if (RL_VAL.has(ws[k])) {
                    k++
                }
                else if (!ws[k].startsWith('-') && !/^\/[a-z]$/i.test(ws[k])) {
                    ops.push(ws[k])
                }
            }
            paths = ops.length ? ops : ['.']
        }
        else if (['grep', 'egrep', 'fgrep', 'rg'].includes(c)) {
            //選項無法解析者: rg、或帶遞迴樣之選項之 grep ⇒ 從嚴(視為列出)
            let r = lrParseGnu(ws, LR_GNU[c === 'rg' ? 'rg' : 'grep'])
            if (r === null) {
                paths = c === 'rg' || ws.some((w) => /^-[A-Za-z]*[rRd]/.test(w) || /^--(recursive|dereference-recursive|directories)/.test(w)) ? ['~'] : null
            }
            else if (c === 'rg' || !r.stdin) {
                paths = r.paths.length ? r.paths : ['.']
            }
        }
        else if (c === 'findstr' && ws.some((w) => /^\/[a-z]*s[a-z]*$/i.test(w))) {
            let r = lrParseFindstr(ws)
            paths = r && r.paths.length ? r.paths : ['.']
        }
        //經 xargs 者另有來自標準輸入之路徑引數(無從確定 ⇒ 視為可能是)
        if (paths && viaXargs) {
            paths.push('~')
        }
        if (paths && paths.some((p) => rlCovers(q.bare(p), dir, stateRoot))) {
            hit = true
        }
    }
    return { hit, dir }
}
//toolListsRoot(tool, inp, base, stateRoot), 非殼層之搜尋 / 列目錄工具是否遞迴列出狀態根或其上層: grep / search 類(於起點下遞迴搜尋)、list / ls 類(列樹)、
//  glob 類而樣式含 **(只一層者不算)—— 起點 = path、directory 等欄(未給 = 工作目錄)接上 glob 樣式之萬用字元前之段
let toolListsRoot = (tool, inp, base, stateRoot) => {
    let isGlob = /glob/i.test(tool)
    if (!/grep|search|glob|^list$|^ls$/i.test(tool) || /bash|shell|command|exec/i.test(tool) || (isGlob && !(typeof inp.pattern === 'string' && inp.pattern.includes('**')))) {
        return false
    }
    let p = [inp.path, inp.directory, inp.dir, inp.cwd].find((x) => typeof x === 'string' && x.trim())
    let at = p ? p.trim() : '.'
    if (isGlob) {
        let pre = inp.pattern.slice(0, inp.pattern.search(/[*?[]/)).replace(/[^\\/]*$/, '')
        at = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(pre) ? pre : path.join(at, pre || '.')
    }
    return rlCovers(at, base, stateRoot)
}

export { absOf, stripSearchPatterns, listRootExempt, entryExecOf, recursiveRootOf, scriptListsRoot, toolListsRoot, LR_CD }
