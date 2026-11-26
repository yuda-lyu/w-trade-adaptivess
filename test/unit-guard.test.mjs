import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { stripSearchPatterns } from '../src/domain/verifyCmdScan.mjs'
import { scanTrace, deniedHalt, datedIn, evalsLogged, evalsDistinct, noLogTried, lostVersions, notesOf, isHalfOf, shortShareOf, sideFlowIssue, extSurfaceOf, extFlagIssue, setGuardExtra, guardExtraOf, EXT_FLAG_HEAD } from '../src/domain/verify.mjs'
import { backtestCfg } from '../src/domain/backtestCfg.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//守門: 架構邊界與禁區(sgud/rule/rulebook.md 之 R-REC-3、R-RSI-1、R-OPS-1、R-BT-2、R-BT-3)
let walk = (dir, out = []) => {
    for (let f of fs.readdirSync(dir, { withFileTypes: true })) {
        let fp = path.join(dir, f.name)
        if (f.isDirectory()) {
            walk(fp, out)
        }
        else if (/\.mjs$/.test(f.name)) {
            out.push(fp)
        }
    }
    return out
}
let rel = (fp) => path.relative(FD_ROOT, fp).replace(/\\/g, '/')
let read = (fp) => fs.readFileSync(fp, 'utf8')

describe('守門:架構邊界', function () {
    it('通用層 src/arsi 不匯入 src/domain、src/eval,且不含領域指標名', () => {
        //R-REC-3: src/arsi/ 不含領域用語; 領域數字由專案之 verify 以 summary / notes / raw / validation 提供
        for (let fp of walk(path.join(FD_ROOT, 'src', 'arsi'))) {
            let src = read(fp)
            assert(!/from\s+['"][^'"]*(\/domain\/|\/eval\/|engineApi|engineProtocol)/.test(src), `${rel(fp)} 不得匯入領域層、評估器或引擎`)
            if (!/dispatchers\.mjs$/.test(fp)) {
                for (let w of ['等效年化', '新鮮度', 'selHash', '挑選模組', '回測期', '策略庫', '持倉']) {
                    assert(!src.includes(w), `${rel(fp)} 含領域用語「${w}」`)
                }
            }
        }
    })

    it('引擎(w-recursi)只經 src/engineApi.mjs、src/engineProtocol.mjs 取用', () => {
        //R-RSI-1
        let files = [...walk(path.join(FD_ROOT, 'src')), ...fs.readdirSync(FD_ROOT).filter((f) => /^g_.*\.mjs$/.test(f)).map((f) => path.join(FD_ROOT, f))]
        for (let fp of files) {
            if (/engine(Api|Protocol)\.mjs$/.test(fp)) {
                continue
            }
            assert(!/from\s+['"]w-recursi/.test(read(fp)), `${rel(fp)} 直接匯入 w-recursi`)
        }
    })

    //R-OPS-1 之守門: 背景行程再起之子行程一律隱藏視窗
    //  codeKeepLines, 去註解(只認行首或空白之後之 //, 免把字串內之 'file:///…' 當成註解而連同其後之選項刪掉; 區塊註解保留換行使行號不變)
    let codeKeepLines = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (x) => x.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/[^\n]*/g, '$1 ')
    //  spawnCallsOf, 起子行程之呼叫(spawn、spawnSync、exec、execSync、execFile、execFileSync、fork; 前一字元為「.」者是其他物件之方法, 如正規式之 re.exec, 不計):
    //    呼叫之範圍以括號配對取得(略過引號字串與樣板字串), 只看該次呼叫自己之引數 —— 不借用其後另一個呼叫之選項;
    //    windowsHide 只認「引數之頂層物件」之屬性(巢狀物件如 env 內、字串內之字樣不算); 字串內組出之程式(脫離式之包裝)同樣比對
    //    限制: 以字元掃描而非語法樹 —— 區塊註解之記號出現在字串內、或描述文字內含「spawn(」者可能誤判(誤判之方向多為報出, 需人工核對)
    let RE_CALL = /(?<![.\w$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g
    //skipTpl, 自樣板字串之開頭反引號(src[i] === '`')起, 回傳其結尾反引號之下一個位置(略過跳脫字元與 ${…} 內之程式, 含其內之字串與巢狀樣板)
    let skipTpl = (src, i) => {
        for (i++; i < src.length; i++) {
            let c = src[i]
            if (c === '\\') {
                i++
            }
            else if (c === '`') {
                return i + 1
            }
            else if (c === '$' && src[i + 1] === '{') {
                let depth = 1
                for (i += 2; i < src.length && depth > 0; i++) {
                    let d = src[i]
                    if (d === '`') {
                        i = skipTpl(src, i) - 1
                    }
                    else if (d === '\'' || d === '"') {
                        for (i++; i < src.length && src[i] !== d; i++) {
                            if (src[i] === '\\') {
                                i++
                            }
                        }
                    }
                    else if (d === '{') {
                        depth++
                    }
                    else if (d === '}') {
                        depth--
                    }
                }
                i--
            }
        }
        return i
    }
    let spawnCallsOf = (src) => {
        let out = []
        let m
        RE_CALL.lastIndex = 0
        while ((m = RE_CALL.exec(src))) {
            let i = m.index + m[0].length
            let stack = ['(']
            let top = ''
            while (i < src.length && stack.length > 0) {
                let c = src[i]
                if (c === '\'' || c === '"') {
                    for (i++; i < src.length && src[i] !== c; i++) {
                        if (src[i] === '\\') {
                            i++
                        }
                    }
                    i++
                    continue
                }
                if (c === '`') {
                    i = skipTpl(src, i)
                    continue
                }
                if ('([{'.includes(c)) {
                    stack.push(c)
                }
                else if (')]}'.includes(c)) {
                    stack.pop()
                }
                else if (stack.length === 2 && stack[1] === '{') {
                    //引數之頂層物件之內容(不含其內之字串、樣板與巢狀之括號)
                    top += c
                }
                i++
            }
            out.push({ fn: m[1], line: src.slice(0, m.index).split('\n').length, hidden: /\bwindowsHide\s*:\s*true\b/.test(top) && !/\bwindowsHide\s*:\s*false\b/.test(top) })
        }
        return out
    }
    //  importIssuesOf, child_process(含 node:child_process)之取用只准「具名且不改名」: import { a, b } from …、const { a, b } = require(…);
    //    預設匯入、命名空間匯入、改名(as / 解構之冒號)、重新匯出(export … from)、動態 import(…)、以變數承接 require(…)(含無宣告之賦值、加括號者)、
    //    require(…) 後直接取方法(含 ?.)者, 其呼叫不會以上列函數名出現, 一律列為問題
    let MOD = `['"](?:node:)?child_process['"]`
    let importIssuesOf = (src) => {
        let out = []
        for (let m of src.matchAll(new RegExp(`import\\s+([^'";]*?)\\s*from\\s*${MOD}`, 'g'))) {
            if (!/^\{[^}]*\}$/.test(m[1].trim()) || /\bas\b/.test(m[1])) {
                out.push(`import ${m[1].trim()}`)
            }
        }
        if (new RegExp(`\\bexport\\s*(?:\\{[^}]*\\}|\\*(?:\\s*as\\s+[\\w$]+)?)\\s*from\\s*${MOD}`).test(src)) {
            out.push('重新匯出')
        }
        for (let m of src.matchAll(new RegExp(`(?:\\b(?:let|const|var)\\s+|,\\s*)(\\{[^}]*\\})\\s*=\\s*\\(?\\s*require\\s*\\(\\s*${MOD}\\s*\\)`, 'g'))) {
            if (/:/.test(m[1])) {
                out.push(`require ${m[1].trim()}`)
            }
        }
        if (new RegExp(`(?<![.\\w$])[\\w$]+\\s*=\\s*\\(?\\s*require\\s*\\(\\s*${MOD}`).test(src)) {
            out.push('以變數承接 require')
        }
        if (new RegExp(`\\bimport\\s*\\(\\s*${MOD}`).test(src)) {
            out.push('動態 import')
        }
        if (new RegExp(`require\\s*\\(\\s*${MOD}\\s*\\)\\s*\\)?\\s*(?:\\?\\.|[.[])`).test(src)) {
            out.push('require(…).方法')
        }
        return out
    }

    it('守門本身:未隱藏之呼叫(含緊接另一個已隱藏之呼叫、字串內組出者)、改名或命名空間之取用皆被指出;合規之寫法不誤判', () => {
        //樣本於執行時組出(本檔原文不含這些呼叫, 免被下一案當成本檔之呼叫)
        let S = ['sp', 'awn'].join('')
        let CP = ['child', '_process'].join('')
        let flagged = (src) => spawnCallsOf(src).filter((c) => !c.hidden).length
        assert.equal(flagged(`${S}('x', [], { windowsHide: false })`), 1)
        assert.equal(flagged(`${S}('x', [])\n${S}Sync('y', [], { windowsHide: true })`), 1, '不借用其後之呼叫之選項')
        assert.equal(flagged(`let w = \`\nconst c = ${S}(process.execPath, \${JSON.stringify(a)}, { stdio: ['ignore', fd, fd], windowsHide: false, cwd: \${JSON.stringify(d)} });\n\`\nlet c2 = ${S}(process.execPath, ['-e', w], { detached: true, windowsHide: true })`), 1, '字串內組出之呼叫')
        assert.equal(flagged(`${S}Sync(process.execPath, ['-e', \`import('file:///x').then((m) => m)\`], { cwd, windowsHide: true, encoding: 'utf8' })`), 0, '字串內之 file:/// 不影響')
        assert.equal(spawnCallsOf('let m = re.exec(s)').length, 0, '其他物件之 exec 方法不計')
        //樣板字串內之括號不影響呼叫之範圍
        assert.equal(flagged(`${S}('x', [\`a(\${b}\`])\n${S}('y', [], { windowsHide: true })`), 1, '樣板字串內之「(」')
        assert.equal(flagged(`${S}('x', [\`a)\`], { windowsHide: true })`), 0, '樣板字串內之「)」')
        //windowsHide 只認引數之頂層物件
        assert.equal(flagged(`${S}('x', [], { env: { windowsHide: true } })`), 1, '巢狀物件內者不算')
        assert.equal(flagged(`${S}('x', ['windowsHide: true'])`), 1, '字串內者不算')
        assert.equal(flagged(`${S}('x', [], { cwd: d, windowsHide : true })`), 0, '冒號前之空白')
        let bad = [
            `import { ${S} as run } from '${CP}'`,
            `import * as cp from 'node:${CP}'`,
            `import cp from '${CP}'`,
            `import cp, { ${S} } from '${CP}'`,
            `const cp = require('${CP}')`,
            `const { ${S}: run } = require('node:${CP}')`,
            `let m = await import('${CP}')`,
            `require('${CP}').${S}('x')`,
            `export { ${S} as run } from 'node:${CP}'`,
            `export * as cp from '${CP}'`,
            `let cp; cp = require('${CP}'); cp.${S}('x')`,
            `const cp = (require('${CP}'))`,
            `require('${CP}')?.${S}('x')`,
        ]
        for (let x of bad) {
            assert(importIssuesOf(x).length > 0, `應指出: ${x}`)
        }
        for (let x of [`import { ${S}, ${S}Sync } from '${CP}'`, `const fs = require('fs'), { ${S} } = require('${CP}');`, `import { ${S} } from 'node:${CP}'`]) {
            assert.deepEqual(importIssuesOf(x), [], `不應誤判: ${x}`)
        }
    })

    it('專案內每一處起子行程之呼叫皆設 windowsHide: true;child_process 只以具名且不改名之方式取用', () => {
        //範圍 = src、套件根之 g*.mjs、test(含 test/tools; 不含 test/_tmp)
        let files = [
            ...walk(path.join(FD_ROOT, 'src')),
            ...walk(path.join(FD_ROOT, 'test')).filter((f) => !/[\\/]_tmp[\\/]/.test(f)),
            ...fs.readdirSync(FD_ROOT).filter((f) => /^g.*\.mjs$/.test(f)).map((f) => path.join(FD_ROOT, f)),
        ]
        let seen = {}
        for (let fp of files) {
            let src = codeKeepLines(read(fp))
            assert.deepEqual(importIssuesOf(src), [], `${rel(fp)} 之 child_process 取用方式`)
            for (let c of spawnCallsOf(src)) {
                seen[rel(fp)] = (seen[rel(fp)] || 0) + 1
                assert(c.hidden, `${rel(fp)}:${c.line} 之 ${c.fn}( 未設 windowsHide: true`)
            }
        }
        //範圍未壞: 代表之呼叫點皆被找到(脫離式之包裝與其字串內之呼叫、子行程之共用函數、測試內之呼叫)
        for (let [f, k] of [['src/cli/launch.mjs', 2], ['src/domain/proc.mjs', 1], ['src/arsi/runner.mjs', 1], ['test/unit-package.test.mjs', 2]]) {
            assert((seen[f] || 0) >= k, `${f} 應掃到至少 ${k} 處呼叫, 實得 ${seen[f] || 0}`)
        }
    })

    it('回測期之私有根預設在專案夾之外;g_backtest.mjs 未授權即拒絕', () => {
        //R-BT-2
        let bt = backtestCfg({})
        let r = path.relative(FD_ROOT, bt.privateRoot)
        assert(r.startsWith('..'), `私有根 ${bt.privateRoot} 應在專案夾 ${FD_ROOT} 之外`)
        assert(path.relative(bt.privateRoot, bt.ledgerDir) === path.join('ledger', 'full') && !path.relative(bt.privateRoot, bt.resultDir).startsWith('..'))
        //backtestCfg 檔頭: 預設啟用; minLadder 預設 0(凡可評估且未超過硬上限之成品皆算); 旗標判準為七相位平均 > 0 且最差相位 > 0
        assert.deepEqual([bt.enabled, bt.minLadder, bt.rule], [true, 0, { meanMin: 0, worstPhaseMin: 0 }])
        let src = read(path.join(FD_ROOT, 'src', 'cli', 'backtest.mjs'))
        assert(/process\.env\.ARSI_HARNESS !== '1'/.test(src) && /process\.exit\(4\)/.test(src))
        assert(src.indexOf('process.env.ARSI_HARNESS !== \'1\'') < src.indexOf('loadLedger(bt.ledgerDir)'), '授權檢查須在讀全期帳本之前')
    })
})

describe('守門:節點 agent 之操作紀錄掃描', function () {
    let t
    //專案另加之禁區字樣(verify.mjs 之 guardExtraOf): 策略庫位於專案夾之外 ⇒ 其所在之資料夾名列為「策略庫專案」(套件本身不寫死專案名)
    before(() => {
        setGuardExtra(guardExtraOf({ FD_ROOT, source: { libraryRoot: 'D:/demo-strategy-lib/data' } }))
    })
    after(() => {
        setGuardExtra([])
    })
    beforeEach(() => {
        t = makeTmp('trace')
    })
    afterEach(() => {
        t.cleanup()
    })
    let ev = (input) => JSON.stringify({ type: 'tool_use', part: { state: { input } } })
    let privateRoot = path.resolve(FD_ROOT, '..', 'proj-private')

    it('專案另加之禁區字樣:策略庫在專案夾外 ⇒ 取其所在之資料夾名(末段為通用名者取上一層);在專案夾內 ⇒ 不另加(data 夾之規則已涵蓋);settings.guard.forbidden 照加;未設定 ⇒ 無', () => {
        //verify.mjs 之 guardExtraOf / setGuardExtra: 禁區字樣中與專案有關者由設定推得, 不寫死於套件
        assert.deepEqual(guardExtraOf({ FD_ROOT, source: { libraryRoot: 'D:/demo-strategy-lib/data' } }), [{ pattern: 'demo-strategy-lib', label: '策略庫專案' }])
        assert.deepEqual(guardExtraOf({ FD_ROOT, source: { libraryRoot: path.resolve(FD_ROOT, '..', 'someLib') } }), [{ pattern: 'someLib', label: '策略庫專案' }])
        assert.deepEqual(guardExtraOf({ FD_ROOT, source: { libraryRoot: './data/library' } }), [], '策略庫在專案夾內')
        assert.deepEqual(guardExtraOf({ FD_ROOT, guard: { forbidden: [{ pattern: 'secret[-_]zone', label: '另加之禁區' }] } }), [{ pattern: 'secret[-_]zone', label: '另加之禁區' }])
        //R-EV-54 ①: 給了而無效(缺樣式、空樣式、缺 label、非法正則)⇒ 拋(原: 靜默略過而該禁區失效); 逐項之案見 unit-inputGates
        assert.throws(() => guardExtraOf({ FD_ROOT, guard: { forbidden: [{ pattern: 'secret[-_]zone', label: '另加之禁區' }, { pattern: '', label: 'x' }, { label: '缺樣式' }] } }), /^Error: invalid guard\.forbidden\[1\]: must be/)
        assert.deepEqual(guardExtraOf({}), [])
        //未設定時不含「策略庫專案」; 設定後才有
        setGuardExtra([])
        fs.writeFileSync(path.join(t.dir, 'agent_a1.log'), ev({ command: 'ls D:/demo-strategy-lib/data/strategies | head' }))
        assert(!scanTrace({ workDir: t.dir, attempt: 1, privateRoot }).issues.some((x) => x.includes('策略庫專案')))
        assert.equal(setGuardExtra(guardExtraOf({ FD_ROOT, source: { libraryRoot: 'D:/demo-strategy-lib/data' }, guard: { forbidden: [{ pattern: 'secret[-_]zone', label: '另加之禁區' }] } })), 2)
        fs.writeFileSync(path.join(t.dir, 'agent_a1.log'), [ev({ command: 'ls D:/demo-strategy-lib/data/strategies | head' }), ev({ filePath: 'x/Secret_Zone/a.txt' })].join('\n'))
        let r = scanTrace({ workDir: t.dir, attempt: 1, privateRoot })
        assert(r.issues.some((x) => x.includes('策略庫專案')) && r.issues.some((x) => x.includes('另加之禁區')), JSON.stringify(r.issues))
        setGuardExtra(guardExtraOf({ FD_ROOT, source: { libraryRoot: 'D:/demo-strategy-lib/data' } }))
    })

    it('觸及禁區之指令與所寫之程式檔 ⇒ 列為問題;正常之評估與讀文件不列;評估次數只計實際執行者', () => {
        //R-BT-3: 帳本檔、data 夾、策略庫專案、私有根、g_backtest、迴圈專用之環境變數
        fs.writeFileSync(path.join(t.dir, 'agent_a1.log'), [
            'not json',
            ev({ command: 'node g_eval.mjs --pick rsi/work/x/pick.mjs --mode quick' }),
            ev({ command: 'node g_eval.mjs --pick rsi/work/x/a.mjs --mode full --out rsi/work/x/a.json && node g_eval.mjs --pick rsi/work/x/b.mjs --mode full' }),
            ev({ command: 'grep -n nullDraws g_eval.mjs' }),
            ev({ filePath: 'docs/pick-contract.md' }),
            ev({ filePath: 'rsi/work/x/metadata/notes.md' }),
        ].join('\n'))
        fs.writeFileSync(path.join(t.dir, 'pick.mjs'), 'export default function pick(ctx) { return [] } // data/ledger/train 只在註解')
        let ok = scanTrace({ workDir: t.dir, attempt: 1, privateRoot })
        assert.deepEqual(ok.issues, [])
        assert.equal(ok.nEvals, 3)

        fs.writeFileSync(path.join(t.dir, 'agent_a1.log'), [
            ev({ command: 'ARSI_HARNESS=1 node g_backtest.mjs --pick p.mjs --name x' }),
            ev({ command: 'cat data/ledger/train/meta.json' }),
            ev({ filePath: `${privateRoot}/backtest/n1_a1.json` }),
            ev({ command: 'ls D:/demo-strategy-lib/data/strategies | head' }),
        ].join('\n'))
        fs.writeFileSync(path.join(t.dir, 'helper.mjs'), 'import fs from \'fs\'\nlet b = fs.readFileSync(\'./data/ledger/train/pnl.f32\')\n')
        let bad = scanTrace({ workDir: t.dir, attempt: 1, privateRoot })
        for (let label of ['回測期工具', '迴圈專用之環境變數', '帳本檔', '專案之 data 夾', '私有根', '策略庫專案']) {
            assert(bad.issues.some((x) => x.includes(label)), `應指出「${label}」: ${JSON.stringify(bad.issues)}`)
        }
        assert(bad.issues.some((x) => x.includes('檔 helper.mjs')), '所寫之程式檔亦掃')
    })

    it('做夢 agent 之逐步事件紀錄(工具呼叫之輸入在 message.content[*].input)同樣可掃;可指定紀錄檔', () => {
        //R-BT-2: 做夢 agent 之操作亦受稽核(與節點同一套禁區)
        let cl = (input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'Bash', input }] } })
        let fp = path.join(t.dir, 'agent.log')
        fs.writeFileSync(fp, [cl({ command: 'node g_eval.mjs --pick rsi/work/n/pick.mjs --mode full --out rsi/work/dream_r001/recheck.json' }), cl({ file_path: 'rsi/records/nodes/n.md' })].join('\n'))
        let ok = scanTrace({ workDir: t.dir, logFile: fp, privateRoot })
        assert.deepStrictEqual([ok.issues, ok.nEvals, ok.note], [[], 1, null])
        fs.writeFileSync(fp, cl({ file_path: `${privateRoot}/backtest/n_a1.json` }))
        let bad = scanTrace({ workDir: t.dir, logFile: fp, privateRoot })
        assert(bad.issues.some((x) => x.includes('私有根')))
    })

    it('寫到允許範圍之外(寫檔工具之路徑、指令之 --out 與重導向)⇒ 列為問題;範圍內與讀檔不列', () => {
        //R-BT-3 之延伸: 節點只能寫自己的工作夾
        let root = path.join(t.dir, 'proj')
        let wd = path.join(root, 'rsi', 'work', 'n1')
        fs.mkdirSync(wd, { recursive: true })
        let evt = (tool, input) => JSON.stringify({ type: 'tool_use', part: { tool, state: { input } } })
        let fp = path.join(wd, 'agent_a1.log')
        fs.writeFileSync(fp, [
            evt('write', { filePath: path.join(wd, 'pick.mjs'), content: 'x > y' }),
            evt('read', { filePath: path.join(root, 'docs', 'c.md') }),
            evt('bash', { command: 'node g_eval.mjs --pick rsi/work/n1/pick.mjs --mode full --out rsi/work/n1/full_a.json 2>&1 | tail -5' }),
            evt('bash', { command: 'echo hi > rsi/work/n1/note.txt 2>/dev/null' }),
            //內嵌程式之箭頭函數與比較運算子不是輸出重導向(誤報樣貌)
            evt('bash', { command: 'node -e "const fs=require(\'fs\'); let R=(f)=>JSON.parse(fs.readFileSync(\'rsi/work/n1/\'+f,\'utf8\')).metrics; let a=[1,2].map((x,i)=>+(x-1)); console.log(a.reduce((s,x)=>s+x,0) > 0)"' }),
            evt('bash', { command: 'node -e \'for (const [k,v] of Object.entries({a:1})) { if (v >= 1) console.log([k,v]) }\'' }),
        ].join('\n'))
        let ok = scanTrace({ workDir: wd, attempt: 1, privateRoot, root, writeRoots: [wd] })
        assert.deepEqual(ok.issues, [])
        fs.writeFileSync(fp, [
            evt('bash', { command: 'node g_eval.mjs --pick rsi/work/n1/pick.mjs --mode full --out tmp/recheck_final.json' }),
            evt('write', { filePath: path.join(root, 'lib', 'x.mjs'), content: 'x' }),
            evt('bash', { command: 'echo 1 >> rsi/work/n2/steal.txt' }),
        ].join('\n'))
        let bad = scanTrace({ workDir: wd, attempt: 1, privateRoot, root, writeRoots: [wd] })
        for (let where of ['tmp/recheck_final.json', 'lib/x.mjs', 'rsi/work/n2/steal.txt']) {
            assert(bad.issues.some((x) => x.startsWith('寫到工作夾外') && x.includes(where)), `應指出 ${where}: ${JSON.stringify(bad.issues)}`)
        }
    })

    it('重導向之目標:相對路徑以其前之 cd 為準;here-doc 之內文不算重導向(曾有之誤報);cd 到範圍外、here-doc 寫到範圍外者照列', () => {
        //R-BT-3 之延伸: 允許範圍之判定須以實際落點為準 —— cd 進自己之工作夾後以相對路徑寫檔是範圍內; here-doc 之內文(文件之文字)含 > 不是寫檔
        let root = path.join(t.dir, 'proj2')
        let wd = path.join(root, 'rsi', 'work', 'dream_r001')
        let sgud = path.join(root, 'sgud')
        fs.mkdirSync(wd, { recursive: true })
        fs.mkdirSync(sgud, { recursive: true })
        let cl = (input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } })
        let fp = path.join(wd, 'agent.log')
        let posix = `/${root[0].toLowerCase()}/${root.slice(3).replace(/\\/g, '/')}`
        fs.writeFileSync(fp, [
            //cd 進工作夾(Git Bash 之 /d/… 形式與相對形式)後以相對路徑重導向
            cl({ command: `cd ${posix}/rsi/work/dream_r001 && sed -e '1s#.*#// 註解 a > b#' -e 's#^const B = 0#const B = 1#' p0.mjs > p1.mjs && node -e "console.log(1 > 0)"` }),
            cl({ command: 'cd rsi/work/dream_r001; echo x >> notes.txt' }),
            //here-doc 追加文件: 內文含 >、=> 與引號
            cl({ command: 'cat >> sgud/exp/experience.md << \'EOF\'\n## 條目\n159. 內容 a > b、門檻取正 => c;他說 "x > y" 與 it\'s ok\nEOF' }),
        ].join('\n'))
        let ok = scanTrace({ workDir: wd, logFile: fp, privateRoot, root, writeRoots: [wd, sgud] })
        assert.deepEqual(ok.issues, [])
        fs.writeFileSync(fp, [
            cl({ command: 'cd lib && echo x > hacked.mjs' }),
            cl({ command: 'cat > docs/note.md << \'EOF\'\n內文 a > b\nEOF' }),
            cl({ command: `cd ${posix}/rsi/work/dream_r001 && echo x > ../n2/steal.txt` }),
        ].join('\n'))
        let bad = scanTrace({ workDir: wd, logFile: fp, privateRoot, root, writeRoots: [wd, sgud] })
        for (let where of ['lib/hacked.mjs', 'docs/note.md', 'rsi/work/n2/steal.txt']) {
            assert(bad.issues.some((x) => x.startsWith('寫到工作夾外') && x.includes(`(${where})`)), `應指出 ${where}: ${JSON.stringify(bad.issues)}`)
        }
        assert.equal(bad.issues.filter((x) => x.startsWith('寫到工作夾外')).length, 3, JSON.stringify(bad.issues))
    })

    it('存取其他節點之工作夾 ⇒ 列為問題;自己的、任務書列為參考者不列', () => {
        //任務書 §8: 不得讀取或列出其他節點之工作夾(例外: 起點與參考節點)
        let workRoot = path.join(t.dir, 'rsi', 'work')
        let wd = path.join(workRoot, 'aaaa111122223333')
        fs.mkdirSync(wd, { recursive: true })
        let evt = (tool, input) => JSON.stringify({ type: 'tool_use', part: { tool, state: { input } } })
        fs.writeFileSync(path.join(wd, 'agent_a1.log'), [
            evt('read', { filePath: path.join(workRoot, 'aaaa111122223333', 'brief.md') }),
            evt('read', { filePath: 'rsi/work/bbbb111122223333/pick.mjs' }),
            evt('bash', { command: 'ls rsi/work/cccc111122223333/ && cat rsi/work/dream_r002/dream.json' }),
        ].join('\n'))
        let r = scanTrace({ workDir: wd, attempt: 1, privateRoot, workRoot, allowWork: ['bbbb111122223333'] })
        assert.equal(r.issues.length, 2)
        assert(r.issues.some((x) => x.startsWith('存取其他節點之工作夾(cccc11112222')) && r.issues.some((x) => x.startsWith('存取其他節點之工作夾(dream_r002')))
    })

    it('評估次數以評估器之紀錄(.evals.log)為準:每次執行一列;無此檔回 null', () => {
        assert.strictEqual(evalsLogged(t.dir), null)
        fs.writeFileSync(path.join(t.dir, '.evals.log'), '{"at":"a","pick":"p.mjs","mode":"full","ok":true}\n{"at":"b","pick":"q.mjs","mode":"quick","ok":false}\n\n')
        assert.equal(evalsLogged(t.dir), 2)
    })

    it('評估紀錄只計至節點之 agent 結束之時刻(事後重跑時):其後寫入之列是做夢或主控之評估,不計為節點之操作', () => {
        //例: 直接評估節點工作夾內之模組且誤帶 --no-log ⇒ 該節點之 .evals.log 多一列 noLogIgnored; 事後重跑不得把它算在節點頭上
        let d = path.join(t.dir, 'evalsUntil')
        fs.mkdirSync(d, { recursive: true })
        fs.writeFileSync(path.join(d, 'a.mjs'), 'export default 1\n')
        let h = crypto.createHash('sha1').update(fs.readFileSync(path.join(d, 'a.mjs'))).digest('hex').slice(0, 12)
        let row = (o) => JSON.stringify(o)
        fs.writeFileSync(path.join(d, '.evals.log'), [
            row({ at: '2026-11-13T15:40:00.000Z', pick: 'a.mjs', mode: 'full', ok: true, selHash: 's1', h }),
            row({ at: '2026-11-13T17:10:18.000Z', pick: 'gone.mjs', mode: 'full', ok: true, selHash: 's2', h: 'ffffffffffff', noLogIgnored: true }),
        ].join('\n') + '\n')
        let until = '2026-11-13T15:48:09.000Z'
        assert.deepEqual([evalsLogged(d), noLogTried(d), evalsDistinct(d).nFull, lostVersions(d).length], [2, 1, 2, 1])
        assert.deepEqual([evalsLogged(d, until), noLogTried(d, until), evalsDistinct(d, until).nFull, lostVersions(d, until).length], [1, 0, 1, 0])
        //reverifyAll 須把節點文件之 agent.endedAt 交給重跑
        assert(/evalsUntil = d0 && d0\.agent/.test(read(path.join(FD_ROOT, 'src', 'domain', 'domain.mjs'))))
    })

    it('--no-log 只供迴圈重跑:非迴圈之呼叫者帶此旗標者照記並標記,迴圈據以列為問題', () => {
        //g_eval.mjs 檔頭: --no-log 只在 ARSI_HARNESS=1 時生效; 其他呼叫者照樣記錄並標記 noLogIgnored
        assert.equal(noLogTried(t.dir), 0)
        fs.writeFileSync(path.join(t.dir, '.evals.log'), '{"at":"a","pick":"p.mjs","mode":"full","ok":true}\n{"at":"b","pick":"p.mjs","mode":"full","ok":true,"noLogIgnored":true}\n')
        assert.deepEqual([evalsLogged(t.dir), noLogTried(t.dir)], [2, 1])
        let src = read(path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'))
        assert(/noLog && process\.env\.ARSI_HARNESS === '1'/.test(src) && /noLogIgnored: true/.test(src))
        //迴圈之重跑須帶該環境變數, 否則其 --no-log 不生效而把自己的重跑記入節點之評估次數
        assert(/'--no-log'\], \{[^}]*ARSI_HARNESS: '1'/.test(read(path.join(FD_ROOT, 'src', 'domain', 'verify.mjs'))))
    })

    it('做夢 agent 所寫之程式檔內含禁區字樣(自寫之稽核腳本以其為搜尋目標)⇒ 列為待核對而非問題;其工具呼叫之輸入仍列為問題', () => {
        //scanTrace 檔頭: fileHits 'note' 時, 檔內之禁區字樣另列於 fileNotes
        let cl = (input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } })
        let fp = path.join(t.dir, 'agent.log')
        fs.writeFileSync(fp, cl({ command: 'node rsi/work/dream_r004/scanOps.mjs abc' }))
        fs.writeFileSync(path.join(t.dir, 'scanOps.mjs'), 'let flags = []\nif (/g_backtest/.test(s)) flags.push(\'g_backtest\')\nif (/demo-strategy-lib/i.test(s)) flags.push(\'lib\')\n')
        let asNote = scanTrace({ workDir: t.dir, logFile: fp, privateRoot, fileHits: 'note' })
        assert.deepEqual(asNote.issues, [])
        assert(asNote.fileNotes.length >= 2 && asNote.fileNotes.every((x) => x.includes('檔 scanOps.mjs')))
        let asIssue = scanTrace({ workDir: t.dir, logFile: fp, privateRoot })
        assert(asIssue.issues.length >= 2 && asIssue.fileNotes.length === 0, '預設(節點)仍列為問題')
        fs.writeFileSync(fp, cl({ command: 'ARSI_HARNESS=1 node g_backtest.mjs --pick x.mjs --name y' }))
        let bad = scanTrace({ workDir: t.dir, logFile: fp, privateRoot, fileHits: 'note' })
        assert(bad.issues.some((x) => x.includes('回測期工具')), '工具呼叫之輸入仍列為問題')
    })

    it('做夢 agent 以禁區字樣為搜尋樣式之自檢(grep / rg / 搜尋工具)不是存取 ⇒ 不列;被搜尋之路徑與非搜尋指令照查;節點搜尋禁區字樣照列', () => {
        //scanTrace / stripSearchPatterns: 做夢交付前以 grep 自檢共用工具區與自己的腳本, 被記為觸及禁區之誤報樣貌
        let cl = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
        let fp = path.join(t.dir, 'agent.log')
        let dream = { workDir: t.dir, logFile: fp, privateRoot, fileHits: 'note' }
        fs.writeFileSync(fp, [
            cl('Bash', { command: 'node rsi/work/dream_r007/checkToolbox.mjs && grep -rlE "g_backtest|ARSI_HARNESS|demo-strategy-lib|ledger[\\\\/](train|full)" rsi/work/dream_r007/*.mjs rsi/toolbox/ ; echo "grep-exit $?"', description: '自檢: 有無 g_backtest 字樣' }),
            cl('Grep', { pattern: 'ARSI_HARNESS|g_backtest', path: 'rsi/toolbox' }),
            cl('Bash', { command: 'rg -n -e "demo-strategy-lib" -g "*.mjs" rsi/toolbox | head -5' }),
        ].join('\n'))
        assert.deepEqual(scanTrace(dream).issues, [])
        assert(scanTrace({ workDir: t.dir, logFile: fp, privateRoot, nodeRules: true }).issues.some((x) => x.includes('回測期工具')), '節點搜尋禁區字樣屬探查, 照列')
        fs.writeFileSync(fp, cl('Bash', { command: `grep -r "foo" ${privateRoot.replace(/\\/g, '/')}/backtest` }))
        assert(scanTrace(dream).issues.some((x) => x.includes('私有根')), '被搜尋之路徑照查(指令)')
        fs.writeFileSync(fp, cl('Grep', { pattern: 'foo', path: `${privateRoot}/backtest` }))
        assert(scanTrace(dream).issues.some((x) => x.includes('私有根')), '被搜尋之路徑照查(搜尋工具)')
        fs.writeFileSync(fp, cl('Bash', { command: 'grep -c x a.txt && ARSI_HARNESS=1 node g_backtest.mjs --pick x.mjs --name y' }))
        assert(scanTrace(dream).issues.some((x) => x.includes('回測期工具')), '同一指令內之非搜尋段照查')
        //只去「樣式」: 被搜尋之檔、管線前段、帶值之選項皆保留
        assert.equal(stripSearchPatterns('grep -A 3 -n "g_backtest" lib/x.mjs').includes('g_backtest'), false)
        assert(stripSearchPatterns('grep -n foo g_backtest.mjs').includes('g_backtest.mjs'))
        assert(stripSearchPatterns('cat g_backtest.mjs | grep foo').includes('g_backtest.mjs'))
        assert.equal(stripSearchPatterns('git -C . grep -n "ARSI_HARNESS" -- lib').includes('ARSI_HARNESS'), false)
        assert.equal(stripSearchPatterns('findstr /S /C:"g_backtest" *.mjs').includes('g_backtest'), false)
        assert(stripSearchPatterns('xargs grep -l "g_backtest"').includes('g_backtest'), '間接呼叫者不去(寧可多報)')
    })

    it('守門:舊版之備份與評估帳本為禁區;--seed 只在迴圈之重放生效;原始碼含評估期間內之日期字樣者列出', () => {
        //舊版之節點、做夢文件與經驗不得作為參考 ⇒ 備份夾列為節點與做夢之禁區
        fs.writeFileSync(path.join(t.dir, 'agent_a1.log'), [
            ev({ command: 'cat tmp/archive_20261111_regime1/rsi/records/dreams/r007.md' }),
            ev({ filePath: 'data/ledger/eval/pnl.f32' }),
        ].join('\n'))
        let bad = scanTrace({ workDir: t.dir, attempt: 1, privateRoot, nodeRules: true })
        assert(bad.issues.some((x) => x.includes('舊制之備份')) && bad.issues.some((x) => x.includes('帳本檔')), JSON.stringify(bad.issues))
        let cl = (input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input }] } })
        let fp = path.join(t.dir, 'agent.log')
        fs.writeFileSync(fp, cl({ file_path: 'tmp/archive_20261111_regime1/sgud/exp/experience.md' }))
        assert(scanTrace({ workDir: t.dir, logFile: fp, privateRoot, fileHits: 'note' }).issues.some((x) => x.includes('舊制之備份')), '做夢亦不得讀')
        //g_eval.mjs 檔頭: --seed 只在 ARSI_HARNESS=1 時生效(節點不得藉換種子挑結果); 預設評估回測期
        let src = read(path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'))
        //(排程第 606 項: 值之檢查〔須為整數〕已移至檔首、不合者拒收; 此處 seedOverride 只在迴圈之重放時取旗標之值)
        assert(/if \(process\.env\.ARSI_HARNESS === '1'\) \{\s*seedOverride = seedArg/.test(src))
        assert(/typeof seedArg === 'number' && Number\.isSafeInteger\(seedArg\)/.test(src), '值須為(安全)整數')
        assert(/periodArg === 'train' \? \{ toBar: trainEndBar \} : \{ fromBar: btStartBar \}/.test(src), '預設之評估期間 = 回測期')
        //合約 §2「不得把回測期之答案寫進模組」之粗篩
        let bt = { start: '2025-10-06T00:00:00', end: '2026-07-31T00:00:00' }
        assert.equal(datedIn('if (ctx.time >= \'2026-03-01\') { side = \'short\' }', bt), '2026-03-01')
        assert.equal(datedIn('let cut = "2025/11"', bt), '2025/11')
        assert.strictEqual(datedIn('let fitEnd = \'2025-04-08\'; let t0 = \'2022-07-01\'', bt), null, '訓練期內之日期不列')
        assert.strictEqual(datedIn('let x = 2026 - 3; let v = 20251', bt), null)
    })

    it('完整評估之相異版本數:只計成功之 full 列;只差 tag、只加 --ref 或同一內容重跑者不算新版本', () => {
        //verify.mjs 之 evalsDistinct: 「試得越多, 最佳者越可能只是運氣」以相異 selHash 數衡量(例: 5 個節點之完整評估 21 次只有 13 個相異 selHash)
        assert.strictEqual(evalsDistinct(t.dir), null)
        fs.writeFileSync(path.join(t.dir, '.evals.log'), [
            { mode: 'quick', ok: true, h: 'a', selHash: 's0' },
            { mode: 'full', ok: true, h: 'a', selHash: 's1' },
            { mode: 'full', ok: true, h: 'a', selHash: 's1', ref: 'control.mjs' },
            { mode: 'full', ok: true, h: 'b', selHash: 's1' },
            { mode: 'full', ok: true, h: 'c', selHash: 's2' },
            { mode: 'full', ok: false, h: 'd', code: 'PICK_RUN' },
            { mode: 'full', period: 'train', ok: true, h: 'e', selHash: 's9' },
        ].map((x) => JSON.stringify(x)).join('\n') + '\n')
        assert.deepEqual(evalsDistinct(t.dir), { nFull: 4, nFullSel: 2, nFullMod: 3 }, '訓練期之診斷(--period train)不算版本之評估')
        assert.equal(evalsLogged(t.dir), 7, '總次數照記')
    })

    it('指令之 --out 後接純數字者不是路徑(agent 自寫腳本之數量參數),不列為寫到工作夾外', () => {
        //scanTrace: 「--out 2500」為做夢稽核之誤報樣貌
        let root = path.join(t.dir, 'proj')
        let wd = path.join(root, 'rsi', 'work', 'dream_r005')
        fs.mkdirSync(wd, { recursive: true })
        let cl = (input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } })
        let fp = path.join(wd, 'agent.log')
        fs.writeFileSync(fp, cl({ command: 'node rsi/work/dream_r005/listOps.mjs rsi/work/n1/agent_a1.log --idx 9,22 --in 900 --out 2500' }))
        assert.deepEqual(scanTrace({ workDir: wd, logFile: fp, privateRoot, root, writeRoots: [wd] }).issues, [])
        fs.writeFileSync(fp, cl({ command: 'node rsi/work/dream_r005/listOps.mjs --out lib/2500.json' }))
        assert(scanTrace({ workDir: wd, logFile: fp, privateRoot, root, writeRoots: [wd] }).issues.some((x) => x.startsWith('寫到工作夾外(lib/2500.json)')))
    })

    it('節點專用規則(nodeRules):讀取回測期重放 / 迴圈驗證之程式、列出工作夾之根 ⇒ 列為問題;自己的工作夾與未啟用時不列', () => {
        //任務書 §8: 不得讀取回測期重放程式與迴圈驗證程式之原始碼; 不得列出 rsi/work/
        let root = path.join(t.dir, 'proj')
        let workRoot = path.join(root, 'rsi', 'work')
        let wd = path.join(workRoot, 'aaaa111122223333')
        fs.mkdirSync(wd, { recursive: true })
        let evt = (tool, input) => JSON.stringify({ type: 'tool_use', part: { tool, state: { input } } })
        let fp = path.join(wd, 'agent_a1.log')
        let base = { workDir: wd, attempt: 1, privateRoot, root, writeRoots: [wd], workRoot }
        fs.writeFileSync(fp, [
            evt('read', { filePath: 'rsi/work/aaaa111122223333/brief.md' }),
            evt('bash', { command: 'ls rsi/work/aaaa111122223333/ && grep -n claimed src/arsi/records.mjs' }),
            evt('read', { filePath: 'src/eval/evalCore.mjs' }),
        ].join('\n'))
        assert.deepEqual(scanTrace({ ...base, nodeRules: true }).issues, [])
        fs.writeFileSync(fp, [
            evt('read', { filePath: 'src/domain/backtest.mjs' }),
            evt('bash', { command: 'grep -n scanTrace src/domain/verify.mjs' }),
            evt('bash', { command: 'ls rsi/work | head -30' }),
        ].join('\n'))
        let bad = scanTrace({ ...base, nodeRules: true })
        assert(bad.issues.some((x) => x.startsWith('觸及禁區: 回測期重放 / 迴圈驗證之程式')), JSON.stringify(bad.issues))
        assert(bad.issues.some((x) => x.startsWith('存取其他節點之工作夾(列出工作夾之根)')), JSON.stringify(bad.issues))
        assert.deepEqual(scanTrace(base).issues, [], '未啟用 nodeRules(做夢 agent)不列')
        //以目錄或萬用字元涵蓋迴圈驗證之程式、讀迴圈之日誌 ⇒ 亦列出; 單一之其他 lib 檔不列; 做夢不適用
        for (let [cmd, label] of [
            ['grep -rn "首次寫入|planAt" g_rsi.mjs src/arsi/*.mjs src/domain/*.mjs', '以目錄或萬用字元涵蓋迴圈驗證之程式'],
            ['rg -n firstFull src/domain', '以目錄或萬用字元涵蓋迴圈驗證之程式'],
            ['grep -rn planTime lib', '以目錄或萬用字元涵蓋迴圈驗證之程式'],
            ['ls src/domain/', '以目錄或萬用字元涵蓋迴圈驗證之程式'],
            ['ls rsi/logs/ && grep round-done rsi/logs/events.jsonl', '迴圈之日誌 rsi/logs'],
        ]) {
            fs.writeFileSync(fp, evt('bash', { command: cmd }))
            assert(scanTrace({ ...base, nodeRules: true }).issues.some((x) => x.startsWith(`觸及禁區: ${label}`)), `${cmd} ⇒ ${JSON.stringify(scanTrace({ ...base, nodeRules: true }).issues)}`)
            assert.deepEqual(scanTrace(base).issues, [], `做夢不適用: ${cmd}`)
        }
        fs.writeFileSync(fp, [evt('bash', { command: 'grep -n claimed src/arsi/records.mjs src/domain/texts.mjs && cat src/eval/evalCore.mjs | head -5' }), evt('read', { filePath: 'src/domain/pickStore.mjs' })].join('\n'))
        assert.deepEqual(scanTrace({ ...base, nodeRules: true }).issues, [], '指名之其他 lib 檔不列')
        //套件安裝於專案後, 迴圈驗證之程式位於 node_modules/w-trade-adaptivess/src/domain(verify.mjs 之 PKG_NAME): 同樣之三類規則須涵蓋此配置
        let pk = 'node_modules/w-trade-adaptivess'
        for (let [input, label] of [
            [{ filePath: `${pk}/src/domain/verify.mjs` }, '回測期重放 / 迴圈驗證之程式'],
            [{ command: `grep -n scanTrace ${pk}/src/domain/backtest.mjs` }, '回測期重放 / 迴圈驗證之程式'],
            [{ command: `rg -n firstFull ${pk}/src/domain` }, '以目錄或萬用字元涵蓋迴圈驗證之程式'],
            [{ command: `ls ${pk}/src/domain/` }, '以目錄或萬用字元涵蓋迴圈驗證之程式'],
            [{ command: `grep -rn planTime ${pk}/src` }, '以目錄或萬用字元涵蓋迴圈驗證之程式'],
            [{ command: `grep -rn planTime ${pk}/src/*` }, '以目錄或萬用字元涵蓋迴圈驗證之程式'],
            [{ command: `ls ${pk}` }, '以目錄或萬用字元涵蓋迴圈驗證之程式'],
            [{ path: `${pk}/src`, pattern: 'scanTrace' }, '以目錄或萬用字元涵蓋迴圈驗證之程式'],
            [{ command: 'grep -rn planTime src' }, '以目錄或萬用字元涵蓋迴圈驗證之程式'],
        ]) {
            fs.writeFileSync(fp, evt(input.command ? 'bash' : (input.pattern ? 'grep' : 'read'), input))
            assert(scanTrace({ ...base, nodeRules: true }).issues.some((x) => x.startsWith(`觸及禁區: ${label}`)), `${JSON.stringify(input)} ⇒ ${JSON.stringify(scanTrace({ ...base, nodeRules: true }).issues)}`)
        }
        fs.writeFileSync(fp, [evt('bash', { command: `grep -n claimed ${pk}/src/arsi/records.mjs && cat ${pk}/src/eval/evalCore.mjs | head -5` }), evt('read', { filePath: `${pk}/src/domain/pickStore.mjs` }), evt('bash', { command: 'node g_eval.mjs --pick rsi/work/aaaa111122223333/pick.mjs --mode quick' })].join('\n'))
        assert.deepEqual(scanTrace({ ...base, nodeRules: true }).issues, [], '套件內指名之其他檔與經進入檔之評估不列')
        fs.writeFileSync(fp, evt('glob', { path: path.join(workRoot), pattern: '*/pick.mjs' }))
        assert(scanTrace({ ...base, nodeRules: true }).issues.some((x) => x.includes('列出工作夾之根')), '以絕對路徑列出亦同')
        //寫入文件之內容是文字不是存取(例: 節點文件之揭露句「未列出 rsi/work/ …」被誤報); 寫入程式檔之內容照查
        fs.writeFileSync(fp, [
            evt('write', { filePath: path.join(wd, 'node.json'), content: '{ "conclusion": { "limitations": ["未列出 rsi/work/ 或讀其他節點之工作夾(例如 rsi/work/cccc111122223333/)"] } }' }),
            evt('edit', { filePath: 'rsi/work/aaaa111122223333/notes.md', oldString: 'x', newString: '未列出 rsi/work/ 本身' }),
        ].join('\n'))
        assert.deepEqual(scanTrace({ ...base, nodeRules: true }).issues, [], '文件內容之揭露句不列')
        fs.writeFileSync(fp, evt('write', { filePath: path.join(wd, 'peek.mjs'), content: 'import fs from \'fs\'\nconsole.log(fs.readdirSync(\'rsi/work/cccc111122223333\'))' }))
        assert(scanTrace({ ...base, nodeRules: true }).issues.some((x) => x.startsWith('存取其他節點之工作夾(cccc11112222')), '程式檔之內容照查')
        //寫入程式檔之內容先去註解: 共用片段之檔頭註解含他人工作夾之出處者不是存取(例: 照方向複製 snippets/tieAlt.mjs 原文而被誤報); 非註解之程式碼照查
        fs.writeFileSync(fp, evt('write', { filePath: path.join(wd, 't1.mjs'), content: '//出處: rsi/work/dream_r003/t5_205a_tie0.mjs\n/* 另見 rsi/work/cccc111122223333/pick.mjs */\nexport let pick = (ctx) => ({ ids: [] })\n' }))
        assert.deepEqual(scanTrace({ ...base, nodeRules: true }).issues, [], '程式檔之註解不列')
        fs.writeFileSync(fp, evt('edit', { filePath: path.join(wd, 't1.mjs'), oldString: '//x', newString: '//出處: rsi/work/dream_r003/a.mjs\nlet d = JSON.parse(fs.readFileSync(\'rsi/work/cccc111122223333/x.json\', \'utf8\'))' }))
        let mix = scanTrace({ ...base, nodeRules: true }).issues
        assert(mix.some((x) => x.startsWith('存取其他節點之工作夾(cccc11112222')) && !mix.some((x) => x.includes('dream_r003')), `註解不列、程式碼照列: ${JSON.stringify(mix)}`)
    })

    it('寫到工作夾外:工具呼叫被權限拒絕(未寫出)者另標為企圖;成功寫出者照原文列', () => {
        //寫檔工具以打錯專案名之絕對路徑呼叫, 狀態 error「The user rejected permission …」, 未寫出任何檔
        let root = path.join(t.dir, 'projDenied')
        let wd = path.join(root, 'rsi', 'work', 'aaaa111122223333')
        fs.mkdirSync(wd, { recursive: true })
        let fp = path.join(wd, 'agent_a1.log')
        let evtS = (tool, input, state = {}) => JSON.stringify({ type: 'tool_use', part: { tool, state: { input, ...state } } })
        let outside = path.join(t.dir, 'projDenide', 'rsi', 'work', 'aaaa111122223333', 'node.json')
        fs.writeFileSync(fp, evtS('edit', { filePath: outside, oldString: 'a', newString: 'b' }, { status: 'error', error: 'The user rejected permission to use this specific tool call.' }))
        let denied = scanTrace({ workDir: wd, logFile: fp, privateRoot, root, writeRoots: [wd] }).issues
        assert(denied.length === 1 && denied[0].startsWith('寫到工作夾外之企圖') && denied[0].includes('未寫出') && denied[0].includes('projDenide'), JSON.stringify(denied))
        fs.writeFileSync(fp, evtS('edit', { filePath: outside, oldString: 'a', newString: 'b' }, { status: 'completed' }))
        let done = scanTrace({ workDir: wd, logFile: fp, privateRoot, root, writeRoots: [wd] }).issues
        assert(done.length === 1 && done[0].startsWith('寫到工作夾外') && !done[0].includes('企圖'), JSON.stringify(done))
        //其他原因之錯誤(非權限拒絕)不當成被拒: 照原文列
        fs.writeFileSync(fp, evtS('edit', { filePath: outside, oldString: 'a', newString: 'b' }, { status: 'error', error: 'oldString not found in content' }))
        assert(!scanTrace({ workDir: wd, logFile: fp, privateRoot, root, writeRoots: [wd] }).issues[0].includes('企圖'))
    })

    it('工作階段結束於被權限拒絕之工具呼叫(規則 R-RUN-7):最後一個工具呼叫被拒 ⇒ 回工具與目標;其後仍有呼叫、非權限之錯誤、無紀錄 ⇒ null', () => {
        //write 之絕對路徑打錯專案夾名而被拒, opencode 隨即結束工作階段(離開碼 0), 未交付 pick.mjs
        let wd = path.join(t.dir, 'projHalt', 'rsi', 'work', 'bbbb111122223333')
        fs.mkdirSync(wd, { recursive: true })
        let fp = path.join(wd, 'agent_a1.log')
        let evtS = (tool, input, state = {}) => JSON.stringify({ type: 'tool_use', part: { tool, state: { input, ...state } } })
        let bad = evtS('write', { filePath: 'D:\\projHalf\\rsi\\work\\x\\v1.mjs', content: 'x' }, { status: 'error', error: 'The user rejected permission to use this specific tool call.' })
        let ok = evtS('bash', { command: 'node g_eval.mjs --mode quick' }, { status: 'completed' })
        fs.writeFileSync(fp, [ok, bad, JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } })].join('\n'))
        let h = deniedHalt(fp)
        assert(h && h.tool === 'write' && h.target.includes('projHalf'), JSON.stringify(h))
        fs.writeFileSync(fp, [bad, ok].join('\n'))
        assert.strictEqual(deniedHalt(fp), null)
        fs.writeFileSync(fp, evtS('edit', { filePath: 'a' }, { status: 'error', error: 'oldString not found in content' }))
        assert.strictEqual(deniedHalt(fp), null)
        assert.strictEqual(deniedHalt(path.join(wd, 'none.log')), null)
        //同一步並行發出數個呼叫: 被拒者不一定是最後一筆(#141 結案留言); 被拒後另起一步續做者不算
        let step = JSON.stringify({ type: 'step_start', part: { type: 'step-start' } })
        fs.writeFileSync(fp, [step, ok, step, bad, ok, JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } })].join('\n'))
        assert(deniedHalt(fp) && deniedHalt(fp).tool === 'write')
        fs.writeFileSync(fp, [step, bad, step, ok].join('\n'))
        assert.strictEqual(deniedHalt(fp), null)
    })

    it('規劃於評估後才寫(nodeRules):節點文件之首次寫入晚於第一次完整評估 ⇒ 列出;先寫、只評估起點複本、看不到寫入、未啟用 ⇒ 不列', () => {
        //任務書 §6「交付版先定再跑」之機械核對(全部評估之後才寫 node.json 者; 只列不否決)
        let root = path.join(t.dir, 'proj')
        let workRoot = path.join(root, 'rsi', 'work')
        let wd = path.join(workRoot, 'aaaa111122223333')
        fs.mkdirSync(wd, { recursive: true })
        let evt = (tool, input) => JSON.stringify({ type: 'tool_use', part: { tool, state: { input } } })
        let fp = path.join(wd, 'agent_a1.log')
        let base = { workDir: wd, attempt: 1, privateRoot, root, writeRoots: [wd], workRoot, nodeRules: true }
        let W = 'rsi/work/aaaa111122223333'
        let full = (f) => evt('bash', { command: `node g_eval.mjs --pick ${W}/${f}.mjs --mode full --out ${W}/full_${f}.json 2>&1 | tail -20` })
        let quick = (f) => evt('bash', { command: `node g_eval.mjs --pick ${W}/${f}.mjs --mode quick` })
        let doc = evt('write', { filePath: path.join(wd, 'node.json'), content: '{ "plan": { "approach": "x" } }' })
        let run = (rows, opt = {}) => {
            fs.writeFileSync(fp, rows.join('\n')); return scanTrace({ ...base, ...opt })
        }
        //先寫規劃再評估; 快速模式與起點複本之完整評估不算
        assert.deepEqual(run([quick('try_a'), full('base_pick'), doc, full('try_a')]).issues, [])
        //操作紀錄看不到節點文件之寫入 ⇒ 不判
        let unseen = run([full('try_a')])
        assert.deepStrictEqual([unseen.issues, unseen.planAfterEval], [[], null])
        //評估後才寫: 寫檔工具、改檔工具、指令之重導向皆算; 以 cp 複製範本不算寫規劃
        let bad = run([full('try_a'), doc])
        assert(bad.issues.length === 1 && bad.issues[0].startsWith('規劃於評估後才寫'), JSON.stringify(bad.issues))
        assert.deepEqual(bad.planAfterEval, { docCall: 2, evalCall: 1 })
        assert(run([full('try_a'), evt('bash', { command: `cat > ${W}/node.json << 'EOF'\n{}\nEOF` })]).planAfterEval)
        assert.deepEqual(run([evt('bash', { command: `cp ${W}/node.template.json ${W}/node.json` }), full('try_a'), evt('edit', { filePath: `${W}/node.json`, oldString: 'a', newString: 'b' })]).planAfterEval, { docCall: 3, evalCall: 2 })
        //重掃舊節點(其任務書尚無此要求)時可單獨關閉; 做夢 agent(未啟用 nodeRules)不適用
        assert.deepEqual(run([full('try_a'), doc], { planRule: false }).issues, [])
        assert.deepEqual(run([full('try_a'), doc], { nodeRules: false }).issues, [])
    })

    it('已完整評估而現無檔可重現之版本(評估後覆寫該檔)⇒ 依檔名列出;內容仍存於任一檔者、快速模式、舊紀錄無雜湊者不列', () => {
        //g_eval.mjs: .evals.log 每列記模組內容之雜湊 h; verify.lostVersions 與工作夾內現有程式檔之雜湊比對(任務書「一實驗一檔」)
        let h = (s) => crypto.createHash('sha1').update(Buffer.from(s)).digest('hex').slice(0, 12)
        assert.deepEqual(lostVersions(t.dir), [])
        fs.writeFileSync(path.join(t.dir, 'pick.mjs'), 'v2')
        fs.writeFileSync(path.join(t.dir, 'try_a.mjs'), 'v1')
        fs.writeFileSync(path.join(t.dir, '.evals.log'), [
            { pick: 'pick.mjs', mode: 'full', ok: true, h: h('v1') }, //內容現存於 try_a.mjs ⇒ 可重現
            { pick: 'pick.mjs', mode: 'full', ok: true, h: h('v0') }, //已無檔
            { pick: 'pick.mjs', mode: 'quick', ok: true, h: h('vq') }, //快速模式不計
            { pick: 'control.mjs', mode: 'full', ok: true, h: h('c0') }, //已無檔
            { pick: 'control.mjs', mode: 'full', ok: true, h: h('c0') }, //同一版本只計一次
            { pick: 'old.mjs', mode: 'full', ok: true }, //舊紀錄無 h
            { pick: 'pick.mjs', mode: 'full', ok: true, h: h('v2') }, //現檔
        ].map((x) => JSON.stringify(x)).join('\n'))
        assert.deepEqual(lostVersions(t.dir).sort((a, b) => a.pick.localeCompare(b.pick)), [{ pick: 'control.mjs', n: 1 }, { pick: 'pick.mjs', n: 1 }])
        let src = read(path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'))
        assert(/h: pickHash/.test(src), 'g_eval.mjs 須於 .evals.log 記模組內容之雜湊')
    })

    it('操作紀錄無法解析或不存在 ⇒ 不給評估次數並註明', () => {
        fs.writeFileSync(path.join(t.dir, 'agent_a1.log'), 'plain text log\n')
        let a = scanTrace({ workDir: t.dir, attempt: 1, privateRoot })
        assert.deepStrictEqual([a.nEvals, a.issues.length], [null, 0])
        assert.match(a.note, /無可解析/)
        let b = scanTrace({ workDir: t.dir, attempt: 2, privateRoot })
        assert.match(b.note, /無操作紀錄檔/)
    })

    it('節點文件之補充列:組成對照(同側同活躍度虛無)、損益依多空與 tag 之歸因、評估期間三等分、訓練期與回測期之做多比例;無此欄者不出現', () => {
        //verify.mjs notesOf(規則 R-EV-18 / R-REC-12): 節點與做夢由節點文件即可看出績效是否來自組成、來自哪一側、是否集中於某一段、側別是否固定
        let m = {
            op: { eqYr: { mean: 48.8, min: 37.9, byPhase: [45.3, 37.9] }, nDecisions: [42, 42], acceptRate: 0.2, winRate: 0.44, pnl: 11.7, bySide: { long: { orders: 476.7, pnl: -3.5, winRate: 0.37 }, short: { orders: 536.7, pnl: 15.2, winRate: 0.5 } }, thirds: [{ from: '2025-10-06T00:00:00', to: '2026-01-16T00:00:00', eqYr: { mean: 88.1, min: 69.1 }, nullMean: 4.1 }] },
            sel: { sizeMean: 40, sizeMin: 40, sizeMax: 40, turnoverJaccard: 0.87, longRatio: 0.56, tags: [{ tag: 'S', share: 0.8 }], tagPerf: [{ tag: 'S', decisions: 33, orders: 800, pnl: 12 }] },
            nullSideAct: { half: 50, mean: 47.9, sd: 6.6, excess: 0.9, z: 0.14, p: 0.3692, share: 0.98 },
        }
        let ns = notesOf(m, [], { longRatio: 0.05, tags: [{ tag: 'S', share: 0.9 }] })
        let has = (re) => ns.some((s) => re.test(s))
        assert(has(/^同側同活躍度虛無.*超額 0\.9 個百分點.*p 0\.3692.*組成可重現之比例 98\.0%/))
        assert(has(/^損益歸因.*合計 11\.7.*做多 476\.7 單、損益 -3\.5.*做空 536\.7 單、損益 15\.2.*依 tag.*S 33 次決策/))
        assert(has(/^評估期間三等分.*2025-10-06 ~ 2026-01-16 均 88\.1%.*隨機挑 4\.1/))
        let lr = ns.find((s) => s.startsWith('選集之做多比例'))
        assert(lr && lr.includes('0.05 / 回測期 0.56') && lr.includes('訓練期 S 0.9 / 回測期 S 0.8'))
        //舊結果(無此欄)與未重放訓練期者: 這幾列不出現
        let old = notesOf({ op: { eqYr: { mean: 1, min: 0, byPhase: [1, 0] }, nDecisions: [1], acceptRate: 1, winRate: 0.5 }, sel: { sizeMean: 1, sizeMin: 1, sizeMax: 1, turnoverJaccard: 1 } })
        assert(!old.some((s) => /^(同側同活躍度虛無|損益歸因|評估期間三等分|選集之做多比例)/.test(s)))
        //重放之 S(同時換亂數種子與同分次序; 規則 R-EV-22): 有重放才列; 文字須寫明兩者皆換
        let rp = notesOf(m, [-6.5, -12.5]).find((s) => s.startsWith('換亂數種子與同分次序之重放'))
        assert(rp && rp.includes('S -6.5 / -12.5') && rp.includes('ctx.meta.tie'))
        assert(!ns.some((s) => s.startsWith('換亂數種子')))
        //各次重放另附組成對照與近期活躍度版之超額(規則 R-EV-24): 有給 replays 時一併列出, 並寫明以平均判內容
        let m2 = { ...m, ext: { nullRecentAct: { side: { excess: 13.8 } } } }
        let rp2 = notesOf(m2, [46.3, 45.9], null, [{ S: 46.3, comp: 39.4, recent: 18.4 }, { S: 45.9, comp: 41.2, recent: null }]).find((s) => s.startsWith('換亂數種子與同分次序之重放'))
        assert(rp2 && rp2.includes('S 46.3 / 45.9') && rp2.includes('組成對照之超額 39.4 / 41.2') && rp2.includes('正本 0.9') && rp2.includes('近期活躍度之組成對照之超額 18.4 / —') && rp2.includes('正本 13.8') && rp2.includes('不以單抽'))
        assert(!rp.includes('組成對照之超額'), '未給 replays 者維持舊式之一列')
    })

    it('下單流量偏一側(規則 R-REC-15):做空單之比例兩期皆 ≥ 全體隨機基準之 2.5 倍(或皆 ≤ 0.4 倍)才列;只有一期偏者不列;節點文件列兩期之比例', () => {
        //席次之做多比例正常(固定側別之檢查不列), 仍可經由兩側活躍度之不對稱使下單集中於一側 = 把回測期之方向寫進模組
        let mk = (l, s) => ({ op: { bySide: { long: { orders: l }, short: { orders: s } } } })
        assert.equal(shortShareOf(mk(470, 530)), 0.53)
        assert.strictEqual(shortShareOf(mk(0, 0)), null)
        assert.strictEqual(shortShareOf({ op: {} }), null)
        //基準: 回測期 0.16、訓練期 0.22(verify.mjs 之 SIDE_FLOW 預設); 以下為示意之比例
        assert.match(sideFlowIssue(0.530, 0.728), /^下單流量偏一側: 做空單之比例 訓練期 0\.728 \/ 回測期 0\.53.*偏做空側/)
        assert.match(sideFlowIssue(0.700, 0.850), /^下單流量偏一側/) //分側組合之探針
        assert.strictEqual(sideFlowIssue(0.337, 0.389), null)
        assert.strictEqual(sideFlowIssue(0.109, 0.225), null)
        assert.strictEqual(sideFlowIssue(0.891, 0.433), null, '只有回測期偏者不列(兩期不同向)')
        assert.match(sideFlowIssue(0.05, 0.08), /偏做多側/)
        assert.strictEqual(sideFlowIssue(null, 0.5), null)
        assert.strictEqual(sideFlowIssue(0.3, 0.5), null)
        assert.match(String(sideFlowIssue(0.3, 0.5, { hi: 1.5 })), /≥ 1\.5 倍/, '門檻可由設定覆寫')
        let m = { op: { eqYr: { mean: 1, min: 0, byPhase: [1, 0] }, nDecisions: [1], acceptRate: 1, winRate: 0.5, bySide: { long: { orders: 470, pnl: 1, winRate: 0.5 }, short: { orders: 530, pnl: 1, winRate: 0.5 } }, pnl: 2 }, sel: { sizeMean: 1, sizeMin: 1, sizeMax: 1, turnoverJaccard: 1, longRatio: 0.67 } }
        let ns = notesOf(m, [], { longRatio: 0.66, tags: [], shortShare: 0.728 })
        assert(ns.some((s) => /^下單之做空比例.*訓練期.診斷.0\.728 \/ 回測期 0\.53;全體隨機約 0\.22 \/ 0\.16/.test(s)))
        assert(!notesOf(m, [], { longRatio: 0.66, tags: [] }).some((s) => s.startsWith('下單之做空比例')), '舊紀錄(無 shortShare)不列')
        //該列所附之基準與機械判讀取同一份(settings.score.sideFlow 與內建值之合併; 規則 R-REC-36): 設定覆寫者隨之、只覆寫一期者另一期取內建值、未給或未覆寫基準者為內建值
        let lineOf = (cfg) => notesOf(m, [], { longRatio: 0.66, tags: [], shortShare: 0.728 }, null, false, cfg).find((s) => s.startsWith('下單之做空比例'))
        let set = lineOf({ baseShort: { train: 0.33, backtest: 0.27 } })
        assert(set.includes(';全體隨機約 0.33 / 0.27 ——') && !set.includes('0.22 / 0.16'), set)
        assert(lineOf({ baseShort: { train: 0.31 } }).includes(';全體隨機約 0.31 / 0.16 ——'), '只覆寫訓練期')
        assert(lineOf(null).includes(';全體隨機約 0.22 / 0.16 ——') && lineOf({ hi: 3 }).includes(';全體隨機約 0.22 / 0.16 ——'), '未給或未覆寫基準 ⇒ 內建值')
        assert.equal(lineOf(undefined), ns.find((s) => s.startsWith('下單之做空比例')), '未給第 6 個參數者與改前逐字相同')
        //與改前逐字相同: 以改前(未帶第 6 個參數之舊簽章)之原文為固定字面值, 不取被測碼自己之輸出當期望值(含「——」與其後之說明; 基準以外之字一字不差)
        let tail = ' —— 席次之做多比例正常而下單偏在一側者,是兩側活躍度不對稱所致之組成;兩期皆遠高(或遠低)於隨機者,回測期之方向可能經此寫進模組'
        assert.equal(ns.find((s) => s.startsWith('下單之做空比例')), `下單之做空比例(做空單 ÷ 全部下單): 訓練期(診斷)0.728 / 回測期 0.53;全體隨機約 0.22 / 0.16${tail}`, '未給設定者之該列與改前逐字相同')
        assert.equal(set, `下單之做空比例(做空單 ÷ 全部下單): 訓練期(診斷)0.728 / 回測期 0.53;全體隨機約 0.33 / 0.27${tail}`, '設定覆寫者只有基準之數字不同')
    })

    it('半庫版之判定(isHalfOf):成品自述 meta.params.half 為 0 或 1 者才是半庫版(迴圈之驗證與補算取同一判定);notesOf 於半庫版且有重放之 S 時多一列「半庫版」之說明', () => {
        //補算(rescanSideFlow)重產之補充列須與迴圈之驗證所產者一致 ⇒ 兩處之半庫版判定取同一函數; 判定值只有 0 與 1(數字), 其餘一律否
        assert.strictEqual(isHalfOf({ params: { half: 0 } }), true, 'half = 0(甲半)')
        assert.strictEqual(isHalfOf({ params: { half: 1 } }), true, 'half = 1(乙半)')
        for (let x of [null, undefined, {}, { arms: ['a'] }, { params: null }, { params: {} }, { params: { half: 2 } }, { params: { half: -1 } }, { params: { half: '0' } }, { params: { half: '1' } }, { params: { half: true } }, { params: { half: null } }, { params: { half: 0.5 } }, { params: { other: 0 } }, 0, 1, 'half']) {
            assert.strictEqual(isHalfOf(x), false, `${JSON.stringify(x)} 非半庫版`)
        }
        let m = { op: { eqYr: { mean: 1, min: 0, byPhase: [1, 0] }, nDecisions: [1], acceptRate: 1, winRate: 0.5, pnl: 2 } }
        let hl = (ns) => ns.filter((s) => s.startsWith('半庫版'))
        let on = notesOf(m, [1.1, 1.3], null, null, true)
        assert.equal(hl(on).length, 1, '半庫版且有重放之 S ⇒ 一列')
        assert(on.indexOf(hl(on)[0]) < on.findIndex((s) => s.startsWith('換亂數種子與同分次序之重放')), '說明列在重放之 S 列之前')
        assert.equal(hl(notesOf(m, [1.1, 1.3], null, null, false)).length, 0, '非半庫版 ⇒ 無')
        assert.equal(hl(notesOf(m, [1.1, 1.3])).length, 0, '未給 half ⇒ 無(與改前相同)')
        assert.equal(hl(notesOf(m, [], null, null, true)).length, 0, '無重放之 S ⇒ 無')
        assert.equal(hl(notesOf(m, null, null, null, true)).length, 0, '未給重放之 S ⇒ 無')
    })

    it('擴充診斷自帶之看板值與提示(規則 R-REC-21):board / boardLabel 成看板之值與欄名、flag 成迴圈檢查之提示(不否決);出錯或未帶者略過;直線與換行不入表格', () => {
        //做夢所建之診斷要上看板、列入迴圈檢查, 原須主控改迴圈; 改為診斷自帶
        let m = {
            ext: {
                restartGap: { text: 'x', board: '98.5 / +13.4', boardLabel: '自空倉重啟之均 / 承接 − 重啟之均', flag: '路徑依賴(全期之 S 含承接之持倉簿;承接 − 重啟之均 +13.4)', ms: 3 },
                num: { board: 12.5 },
                quiet: { text: '無看板值', flag: null },
                boom: { error: '壞了', board: '不應出現', flag: '不應出現' },
                dirty: { board: 'a|b\nc', boardLabel: `欄|名${'長'.repeat(60)}`, flag: `提示|含直線\n與換行${'長'.repeat(300)}` },
                arr: [1, 2],
                blank: { board: '   ', flag: '  ' },
            },
        }
        let s = extSurfaceOf(m)
        assert.deepEqual(s.cells.map((c) => c.name), ['dirty', 'num', 'restartGap'], '依名稱排序;出錯、未帶、空白者略過')
        let rg = s.cells.find((c) => c.name === 'restartGap')
        assert(rg.value === '98.5 / +13.4' && rg.label === '自空倉重啟之均 / 承接 − 重啟之均')
        assert.deepEqual(s.cells.find((c) => c.name === 'num'), { name: 'num', label: 'num', value: '12.5' }, '未給欄名者用診斷名;數字轉字串')
        let d = s.cells.find((c) => c.name === 'dirty')
        assert(d.value === 'a b c' && !d.label.includes('|') && d.label.length <= 32)
        assert.deepEqual(s.flags.map((f) => f.name), ['dirty', 'restartGap'])
        assert(s.flags[0].text.length <= 160 && !/[|\n]/.test(s.flags[0].text))
        let iss = extFlagIssue(s.flags[1])
        assert(iss.startsWith(EXT_FLAG_HEAD) && iss.startsWith('提示(擴充診斷 restartGap): 路徑依賴') && iss.includes('不否決'))
        //無擴充診斷之舊結果: 空
        assert.deepEqual(extSurfaceOf({ op: {} }), { cells: [], flags: [], notContent: [], subsets: [] })
        assert.deepEqual(extSurfaceOf(null), { cells: [], flags: [], notContent: [], subsets: [] })
        assert.deepEqual(s.notContent, [], '未帶 notContent 者為空')
        assert.deepEqual(s.subsets, [], '未帶 subset 者為空')
    })

    it('擴充診斷自述「此成品屬於某個子集」(規則 R-REC-27):subset 為非空字串者列出診斷名與子集之名稱(至多 32 字元);空白、非字串、出錯者略過;直線與換行不入表格', () => {
        //合約 §7「另帶 subset」: 搜尋地圖於量尺旁另列各子集內「有內容且可信」之最高者; 子集之定義由診斷自述, 迴圈不寫死哪一個診斷
        let s = extSurfaceOf({
            ext: {
                timeliness: { board: '+22.5', subset: '時效 ≥ 15' },
                quiet: { board: '+3.1', subset: null },
                blank: { subset: '   ' },
                num: { subset: 15 },
                boom: { error: '壞了', subset: '不應出現' },
                dirty: { subset: `子集|含直線\n與換行${'長'.repeat(100)}` },
            },
        })
        assert.deepEqual(s.subsets.map((x) => x.name), ['dirty', 'timeliness'], '依名稱排序;空白、非字串、出錯者略過')
        assert.deepEqual(s.subsets[1], { name: 'timeliness', label: '時效 ≥ 15' })
        assert(s.subsets[0].label.length <= 32 && !/[|\n]/.test(s.subsets[0].label))
        //看板值照舊(互不影響)
        assert.deepEqual(s.cells.map((c) => c.name), ['quiet', 'timeliness'])
    })

    it('擴充診斷自述「組成對照不是挑選內容之量」(規則 R-REC-22):notContent 為非空字串者列出診斷名與理由;空白、非字串、出錯者略過;直線與換行不入表格', () => {
        //執行規則非中性且本身帶來大增益之成品, 其組成對照共用該規則 ⇒ 不應以組成對照之超額列為挑選內容; 判準由診斷自述, 迴圈不寫死哪一個診斷
        let s = extSurfaceOf({
            ext: {
                execPair: { board: '+72.9 / +49.1 / +33.1', notContent: '執行規則非中性且配對差 +72.9;組成對照共用成品之執行規則' },
                quiet: { board: '1', notContent: null },
                blank: { notContent: '   ' },
                num: { notContent: 1 },
                boom: { error: '壞了', notContent: '不應出現' },
                dirty: { notContent: `理由|含直線\n與換行${'長'.repeat(300)}` },
            },
        })
        assert.deepEqual(s.notContent.map((x) => x.name), ['dirty', 'execPair'], '依名稱排序;空白、非字串、出錯者略過')
        assert(s.notContent[1].text === '執行規則非中性且配對差 +72.9;組成對照共用成品之執行規則')
        assert(s.notContent[0].text.length <= 160 && !/[|\n]/.test(s.notContent[0].text))
        //看板值照舊(兩者互不影響)
        assert.deepEqual(s.cells.map((c) => c.name), ['execPair', 'quiet'])
    })

    it('g_eval.mjs:--tie-salt 與 --seed 同樣只在迴圈之重放(ARSI_HARNESS=1)時生效;迴圈之重放同時帶兩者', () => {
        let src = fs.readFileSync(path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), 'utf8')
        //(排程第 606 項: 值之檢查〔須為整數〕已移至檔首、不合者拒收; 此處 tieSalt 只在迴圈之重放時取旗標之值)
        assert(/tie-salt/.test(src) && /if \(process\.env\.ARSI_HARNESS === '1'\) \{\s*tieSalt = tieArg/.test(src))
        assert(/typeof tieArg === 'number' && Number\.isSafeInteger\(tieArg\)/.test(src), '值須為(安全)整數')
        let vsrc = fs.readFileSync(path.join(FD_ROOT, 'src', 'domain', 'verify.mjs'), 'utf8')
        assert(/'--seed', String\(seed0 \+ i\), '--tie-salt', String\(i\)/.test(vsrc))
        assert(/分數不穩/.test(vsrc))
        //R-BT-4: 保留期之檢定(主控專用)之帳本與起點覆寫同樣只在迴圈專用之環境下生效(節點與做夢之任務不使用; 其操作紀錄含 ARSI_HARNESS 即被稽核列出)
        assert(src.includes('let harnessEnv = process.env.ARSI_HARNESS === \'1\'') && src.includes('harnessEnv && process.env.ARSI_LEDGER_DIR') && src.includes('harnessEnv && process.env.ARSI_EVAL_FROM'))
    })
})
