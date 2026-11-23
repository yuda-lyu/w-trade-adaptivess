import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import * as CFG from '../src/cfg.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'
//具名匯出以命名空間取得(修前之複本無此匯出時, 本檔仍可載入, 各案以斷言失敗呈現而非整檔載入失敗)
let { CLI_FLAGS, CLI_ENUMS, CLI_MODE_FLAGS, CLI_MODE_OWN, CLI_MODE_NEEDS, cliMsgOf } = CFG


//命令列之「模式 × 旗標」(排程第 595 項之接續; 主控裁定 ③; R-EV-53): g_rsi.mjs 之各模式只讀取其所列之旗標; 命令列給了不屬所選模式之旗標(`--mode status --rounds 3`、`--mode validate --only <id>`、
//  `--mode reverify --null 4`、`--mode frontier --close A --base X` 等; 原被靜默忽略)⇒ 拒收(離開碼 2、固定單行訊息不帶輸入值、於讀設定與任何寫入之前; 與未列之旗標、重複、等號寫法同一檢查點)
//  另: g_backtest.mjs --seed 給了而不是整數 ⇒ 拒收(原: 說明後忽略而沿用設定之種子; 決定回測期旗標之結果, R-EV-44 ④之二)
//  規格之句 ⇒ 案: 「不屬該模式之旗標拒收」= 純函數之全格(模式 11 × 旗標 23)、「同一檢查點」= 空之專案根實跑、「模式表 = 各模式實際讀取者」= 原始碼盤點、「frontier 之 --to / --base / --why / --claim 只隨其所屬之動作」= 相依案
let NODE = process.execPath
let SECRET = 'secret-token-xyz'
let RSI_SRC = path.join(FD_ROOT, 'src', 'cli', 'rsi.mjs')
let MODES = ['status', 'init', 'board', 'dry', 'round', 'validate', 'reverify', 'extfill', 'fill', 'frontier', 'annotate', 'dirtype']

//獨立之預期(依 src/cli/rsi.mjs 各模式區塊實際讀取之旗標逐一寫成; 下「原始碼盤點」案核對其與原始碼一致, 並核對 CFG.CLI_MODE_FLAGS 與此相同)
let LEGAL = {
    status: [],
    init: [],
    board: [],
    dry: ['nodes', 'arms', 'parallel', 'workers', 'rounds'],
    round: ['nodes', 'arms', 'parallel', 'workers', 'rounds', 'dream-only', 'file', 'force'],
    validate: ['force'],
    reverify: ['why', 'keep-flags', 'only'],
    extfill: ['ext', 'only', 'force', 'null'],
    fill: ['dry', 'only', 'force', 'no-postfit', 'ext', 'null', 'par', 'no-member'],
    frontier: ['close', 'rearm', 'to', 'why', 'base', 'claim'],
    annotate: ['round', 'file'],
    dirtype: ['round', 'file'],
}
//--file 之模式相容由進入檔自己檢查(取決於 --dream-only; CLI_MODE_OWN), 通用檢查不判
let OWN_SKIP = ['file']
//frontier 內之相依(獨立之預期): --to、--base 須隨 --rearm; --why、--claim 須隨 --close 或 --rearm
let NEEDS = { to: ['rearm'], base: ['rearm'], why: ['close', 'rearm'], claim: ['close', 'rearm'] }
let modesOf = (flag) => MODES.filter((m) => LEGAL[m].includes(flag))
let said = (ms) => (ms.length > 1 ? `${ms.slice(0, -1).join(', ')} or ${ms[ms.length - 1]}` : ms[0])
let valOf = (flag) => (CLI_FLAGS.rsi[flag] === null ? [] : [SECRET])

describe('命令列之「模式 × 旗標」與 g_backtest.mjs --seed 之拒收(排程第 595 項之接續)', function () {
    this.timeout(300000)
    let t = makeTmp('cliModeFlags')
    after(() => t.cleanup())

    describe('表之一致與原始碼盤點', () => {
        it('CLI_MODE_FLAGS.rsi 之模式 = CLI_ENUMS.rsi.mode 之集合; 各模式所列之旗標在 CLI_FLAGS.rsi 內且不重複; 每個旗標(--mode 除外)至少屬一個模式; 與獨立之預期逐模式相同', () => {
            assert(CLI_MODE_FLAGS && CLI_MODE_FLAGS.rsi, '有 CLI_MODE_FLAGS.rsi')
            assert.deepEqual(Object.keys(CLI_MODE_FLAGS.rsi).sort(), [...CLI_ENUMS.rsi.mode].sort())
            assert.deepEqual(Object.keys(CLI_MODE_FLAGS.rsi).sort(), [...MODES].sort())
            let used = new Set()
            for (let [m, list] of Object.entries(CLI_MODE_FLAGS.rsi)) {
                assert.strictEqual(new Set(list).size, list.length, `${m}: 旗標不重複`)
                for (let f of list) {
                    assert(f in CLI_FLAGS.rsi, `${m}: --${f} 在 CLI_FLAGS.rsi 內`)
                    used.add(f)
                }
                assert.deepEqual([...list].sort(), [...LEGAL[m]].sort(), `${m}: 與獨立之預期相同`)
            }
            assert.deepEqual(Object.keys(CLI_FLAGS.rsi).filter((f) => f !== 'mode' && !used.has(f)), [], '每個旗標至少屬一個模式')
            assert.deepEqual(CLI_MODE_OWN, { rsi: OWN_SKIP })
            assert.deepEqual(CLI_MODE_NEEDS, { rsi: { frontier: NEEDS } })
        })

        it('原始碼盤點: src/cli/rsi.mjs 各模式區塊內讀取之旗標 ⊆ 該模式之表(新增讀取而未列於表者即失敗); 表內未見於區塊者只限於區塊外讀取之旗標(--nodes 等五個規模旗標於組裝專案時讀、--dream-only 與 --file 於檔首之只做夢輪次檢查)', () => {
            let src = fs.readFileSync(RSI_SRC, 'utf8').split(/\r?\n/)
            //區塊: `if (mode === 'x') {` 或 `else if (mode === 'x') {` 起至下一個同形之行(頂層; 無縮排)
            let starts = []
            src.forEach((l, i) => {
                let m = /^(?:else )?if \(mode === '([a-z]+)'\) \{/.exec(l)
                if (m) {
                    starts.push({ mode: m[1], i })
                }
            })
            assert.deepEqual(starts.map((s) => s.mode).sort(), [...MODES].sort(), '全部模式各有一個區塊')
            let blocks = {}
            starts.forEach((s, k) => {
                let end = k + 1 < starts.length ? starts[k + 1].i : src.length
                blocks[s.mode] = src.slice(s.i, end).join('\n')
            })
            let flagsIn = (txt) => {
                let out = new Set()
                for (let m of txt.matchAll(/(?:argOf|argStrOf|list)\('([a-z][\w-]*)'/g)) {
                    out.add(m[1])
                }
                for (let m of txt.matchAll(/process\.argv\.(?:includes|indexOf)\('--([a-z][\w-]*)'\)/g)) {
                    out.add(m[1])
                }
                if (/\bonlyOf\(\)/.test(txt)) {
                    out.add('only')
                }
                out.delete('mode')
                return [...out].sort()
            }
            let topLevel = { dry: ['nodes', 'arms', 'parallel', 'workers', 'rounds'], round: ['nodes', 'arms', 'parallel', 'workers', 'rounds', 'dream-only', 'file'] }
            let nScanned = 0
            for (let m of MODES) {
                let read = flagsIn(blocks[m])
                nScanned += read.length
                for (let f of read) {
                    assert(LEGAL[m].includes(f), `${m} 區塊讀取 --${f}, 但表未列`)
                }
                let rest = LEGAL[m].filter((f) => !read.includes(f))
                assert.deepEqual(rest.filter((f) => !(topLevel[m] || []).includes(f)), [], `${m}: 表內之旗標未見於區塊(區塊外讀取者須列於此測試之 topLevel)`)
            }
            assert(nScanned >= 20, `掃描之範圍: ${nScanned} 個旗標讀取`) //鑑別前提: 掃描確實找到讀取(範圍壞掉時之空結果不算數)
            //區塊外之讀取確實存在: 規模旗標以 cliInt('<名>') 於組裝專案時讀(只用於 dry 與 round 之 P.run), --dream-only 與 --file 於檔首
            let head = src.slice(0, starts[0].i).join('\n')
            for (let f of ['nodes', 'arms', 'parallel', 'workers', 'rounds']) {
                assert(head.includes(`cliInt('${f}')`), `cliInt('${f}')`)
            }
            assert(head.includes('process.argv.includes(\'--dream-only\')') && head.includes('process.argv.indexOf(\'--file\')'), '--dream-only 與 --file 於檔首讀取')
            assert(blocks.dry.includes('P.run.nodesPerRound') && blocks.round.includes('P.run'), 'dry 與 round 使用 P.run(規模旗標之去處)')
            for (let m of MODES.filter((x) => x !== 'dry' && x !== 'round')) {
                assert(!blocks[m].includes('P.run'), `${m} 不使用 P.run`)
            }
        })

        it('本套件自己之文字與程式內 `g_rsi.mjs --mode <單一模式> …` 之呼叫: 其後所寫之旗標皆屬該模式(盤點守門; 新增之文字寫了不屬該模式之旗標即失敗; 主控裁定 ③ 之「先核對文字與呼叫皆合表」)', () => {
            let walk = (dir, exts, out = []) => {
                for (let f of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (['node_modules', 'dist', 'docs', 'tmp', '_tmp', 'testPending', 'sgud'].includes(f.name)) {
                        continue
                    }
                    let fp = path.join(dir, f.name)
                    if (f.isDirectory()) {
                        walk(fp, exts, out)
                    }
                    else if (exts.some((e) => f.name.endsWith(e))) {
                        out.push(fp)
                    }
                }
                return out
            }
            let files = [
                ...walk(path.join(FD_ROOT, 'src'), ['.mjs']),
                ...walk(path.join(FD_ROOT, 'contract'), ['.md']),
                ...walk(path.join(FD_ROOT, 'examples'), ['.mjs', '.md', '.json']),
                ...walk(path.join(FD_ROOT, 'arms'), ['.json']),
                path.join(FD_ROOT, 'README.md'),
                path.join(FD_ROOT, 'settings.json'),
            ].filter((f) => fs.existsSync(f)) //變異檢查之複本不含 README.md 等
            let bad = []
            let nCall = 0
            let nFlag = 0
            for (let fp of files) {
                fs.readFileSync(fp, 'utf8').split(/\r?\n/).forEach((line, li) => {
                    //單一模式: `--mode <名>` 之後不接 `|`(列舉全部模式之用法行不是單一呼叫)
                    for (let m of line.matchAll(/g_rsi\.mjs\s+--mode\s+([a-z]+)(?![\w|-])/g)) {
                        if (!(m[1] in LEGAL)) {
                            continue
                        }
                        let seg = line.slice(m.index + m[0].length).split(/[`'"”)）。;;、]| — /)[0]
                        nCall++
                        for (let f of seg.matchAll(/(?:^|\s|\[)--([A-Za-z][\w-]*)(?=[\s\]|,.;:]|$)/g)) {
                            nFlag++
                            if (f[1] !== 'mode' && !LEGAL[m[1]].includes(f[1])) {
                                bad.push(`${path.relative(FD_ROOT, fp)}:${li + 1} g_rsi.mjs --mode ${m[1]} --${f[1]}`)
                            }
                        }
                    }
                })
            }
            assert(nCall >= 25 && nFlag >= 30, `掃描之範圍: ${nCall} 個呼叫、${nFlag} 個旗標`) //鑑別前提(本庫 40 / 53; 變異之複本不含 README 時之下限)
            assert.deepEqual(bad, [])
            //鑑別力: 植入之違規(`--mode status --rounds 3`)被同一掃描抓到
            let seg = 'node g_rsi.mjs --mode status --rounds 3'
            let mm = /g_rsi\.mjs\s+--mode\s+([a-z]+)(?![\w|-])/.exec(seg)
            let fl = [...seg.slice(mm.index + mm[0].length).matchAll(/(?:^|\s|\[)--([A-Za-z][\w-]*)(?=[\s\]|,.;:]|$)/g)].map((x) => x[1])
            assert.deepEqual(fl.filter((f) => !LEGAL[mm[1]].includes(f)), ['rounds'])
        })

        it('進入檔以 cliMsgOf(\'rsi\') 檢查(模式 × 旗標在其內), 且於讀設定與組裝專案之前', () => {
            let src = fs.readFileSync(RSI_SRC, 'utf8')
            let i = src.indexOf('cliMsgOf(\'rsi\')')
            let j = src.search(/=\s*getSettings\(\)|makeProjectOrExit\(st/)
            assert(i > 0 && j > i, '檢查在讀設定之前')
        })
    })

    describe('cliMsgOf(純函數): 模式 × 旗標之全格', () => {
        it('每個模式 × 每個旗標(--mode 除外): 屬該模式者(與 --file 之交給進入檔者)合格; 不屬者 ⇒ invalid --<旗標>: must be used with --mode <所屬之模式>(固定訊息、不帶輸入值)', () => {
            let nOk = 0
            let nBad = 0
            for (let m of MODES) {
                for (let f of Object.keys(CLI_FLAGS.rsi).filter((x) => x !== 'mode')) {
                    let argv = ['--mode', m, `--${f}`, ...valOf(f)]
                    let got = cliMsgOf('rsi', argv)
                    let ok = LEGAL[m].includes(f) || OWN_SKIP.includes(f)
                    //frontier 之相依: 單獨給之 --to、--base、--why、--claim(無 --close / --rearm)⇒ 相依之訊息
                    let want
                    if (ok && m === 'frontier' && f in NEEDS) {
                        want = `invalid --${f}: must be used with ${NEEDS[f].map((x) => `--${x}`).join(' or ')}`
                    }
                    else if (ok) {
                        want = null
                    }
                    else {
                        want = `invalid --${f}: must be used with --mode ${said(modesOf(f))}`
                    }
                    assert.strictEqual(got, want, `${m} --${f}`)
                    assert(got === null || !got.includes(SECRET), `${m} --${f}: 不回顯輸入值`)
                    if (want === null) {
                        nOk++
                    }
                    else {
                        nBad++
                    }
                }
            }
            //鑑別前提: 全格中合格與不合格皆有相當之個數
            assert(nOk >= 30 && nBad >= 150, `合格 ${nOk}、拒收 ${nBad}`)
        })

        it('被點名之原靜默寫法: --rounds 於 status(含未給 --mode)、--only 於 validate、--null 於 reverify、--keep-flags 於 extfill、--base 於 --close、--no-member 於 extfill、--force 於 reverify、--par 於 round、--close 於 fill', () => {
            let M = (a) => cliMsgOf('rsi', a)
            assert.strictEqual(M(['--rounds', '3']), 'invalid --rounds: must be used with --mode dry or round')
            assert.strictEqual(M(['--mode', 'status', '--rounds', '3']), 'invalid --rounds: must be used with --mode dry or round')
            assert.strictEqual(M(['--rounds', '3', '--mode', 'round']), null, '--mode 置於其後亦以所選之模式判定')
            assert.strictEqual(M(['--mode', 'validate', '--only', 'abcdef']), 'invalid --only: must be used with --mode reverify, extfill or fill')
            assert.strictEqual(M(['--mode', 'reverify', '--why', 'x', '--null', '4']), 'invalid --null: must be used with --mode extfill or fill')
            assert.strictEqual(M(['--mode', 'extfill', '--keep-flags']), 'invalid --keep-flags: must be used with --mode reverify')
            assert.strictEqual(M(['--mode', 'frontier', '--close', 'A', '--why', 'x', '--base', 'abc']), 'invalid --base: must be used with --rearm')
            assert.strictEqual(M(['--mode', 'extfill', '--no-member']), 'invalid --no-member: must be used with --mode fill')
            assert.strictEqual(M(['--mode', 'reverify', '--why', 'x', '--force']), 'invalid --force: must be used with --mode round, validate, extfill or fill')
            assert.strictEqual(M(['--mode', 'round', '--par', '2']), 'invalid --par: must be used with --mode fill')
            assert.strictEqual(M(['--mode', 'fill', '--close', 'A']), 'invalid --close: must be used with --mode frontier')
            assert.strictEqual(M(['--mode', 'status', '--dream-only']), 'invalid --dream-only: must be used with --mode round', '與進入檔既有之訊息相同')
            assert.strictEqual(M(['--mode', 'status', '--claim', '0123abcd']), 'invalid --claim: must be used with --mode frontier', '與進入檔既有之訊息相同')
        })

        it('合格之寫法不拒: 各模式之常用組合(含 --dream-only --file、frontier 之 --close / --rearm 全組合)', () => {
            let M = (a) => cliMsgOf('rsi', a)
            for (let a of [
                [],
                ['--mode', 'init'],
                ['--mode', 'board'],
                ['--mode', 'dry', '--nodes', '3', '--parallel', '2', '--rounds', '1', '--arms', '3', '--workers', '2'],
                ['--mode', 'round', '--nodes', '2', '--rounds', '4', '--force'],
                ['--mode', 'round', '--dream-only', '--file', 'x.txt'],
                ['--mode', 'validate', '--force'],
                ['--mode', 'reverify', '--why', 'x', '--keep-flags', '--only', 'abcdef'],
                ['--mode', 'extfill', '--ext', 'a,b', '--only', 'abcdef', '--force', '--null', '3'],
                ['--mode', 'fill', '--dry', '--only', 'abcdef', '--force', '--no-postfit', '--ext', 'none', '--null', '3', '--par', '2', '--no-member'],
                ['--mode', 'frontier'],
                ['--mode', 'frontier', '--close', 'A+B', '--why', 'x'],
                ['--mode', 'frontier', '--close', 'A', '--why', 'x', '--claim', '0123abcd'],
                ['--mode', 'frontier', '--rearm', 'A', '--to', 'B', '--why', 'x', '--base', 'abcdef01', '--claim', '0123abcd'],
                ['--mode', 'frontier', '--close', 'A', '--rearm', 'B', '--to', 'C', '--why', 'x'],
                ['--mode', 'annotate', '--round', '1', '--file', 'x.txt'],
                ['--mode', 'dirtype', '--round', '1', '--file', 'x.json'],
            ]) {
                assert.strictEqual(M(a), null, a.join(' '))
            }
        })

        it('檢查之次序: 命令列次序之第一個不屬該模式者先報; 未列之旗標、重複與等號寫法仍先於模式 × 旗標', () => {
            let M = (a) => cliMsgOf('rsi', a)
            assert.strictEqual(M(['--mode', 'status', '--only', 'abcdef', '--rounds', '3']), 'invalid --only: must be used with --mode reverify, extfill or fill')
            assert.strictEqual(M(['--mode', 'status', '--rounds', '3', '--only', 'abcdef']), 'invalid --rounds: must be used with --mode dry or round')
            assert.strictEqual(M(['--mode', 'status', '--rounds', '3', '--bogus', 'x']), `invalid option: must be one of ${Object.keys(CLI_FLAGS.rsi).map((x) => `--${x}`).join(', ')}`)
            assert.strictEqual(M(['--mode', 'status', '--rounds', '3', '--rounds', '4']), 'invalid --rounds: must be given at most once')
            assert.strictEqual(M(['--mode', 'status', '--rounds=3']), 'invalid --rounds: must be written as --rounds <M> (a space, not =)')
        })
    })

    describe('各進入檔實跑(空之專案根: 離開碼 2、與 cliMsgOf 相同之單行固定訊息、不寫任何檔; 合格之組合通過此檢查)', () => {
        let emptyRoot = path.join(t.dir, 'empty')
        fs.mkdirSync(emptyRoot, { recursive: true })
        let runIn = (entry, args, env = {}) => {
            let e = { ...process.env, ARSI_ROOT: emptyRoot, ...env }
            delete e.ARSI_AGENT_ROLE
            if (!('ARSI_HARNESS' in env)) {
                delete e.ARSI_HARNESS
            }
            let r = spawnSync(NODE, [path.join(FD_ROOT, 'src', 'cli', `${entry}.mjs`), ...args], { cwd: emptyRoot, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), err: `${r.stderr}` }
        }

        it('rsi: 被點名之原靜默寫法 ⇒ 離開碼 2、固定訊息、不寫任何檔、不回顯輸入值', () => {
            for (let args of [
                ['--mode', 'status', '--rounds', '3'],
                ['--mode', 'validate', '--only', 'abcdef'],
                ['--mode', 'reverify', '--why', SECRET, '--null', '4'],
                ['--mode', 'frontier', '--close', 'A', '--why', SECRET, '--base', 'abcdef01'],
                ['--mode', 'extfill', '--keep-flags'],
                ['--mode', 'round', '--par', '2'],
            ]) {
                let want = cliMsgOf('rsi', args)
                assert(typeof want === 'string' && want.startsWith('invalid --'), `${args.join(' ')}: 規格上應被拒`)
                let r = runIn('rsi', args)
                assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.out.join(' | ').slice(0, 200)} ${r.err.slice(0, 200)}`)
                assert.deepEqual(r.out, [want], args.join(' '))
                assert(!r.out.join('\n').includes(SECRET) && !r.err.includes(SECRET), `${args.join(' ')}: 不回顯`)
                assert.deepEqual(fs.readdirSync(emptyRoot), [], `${args.join(' ')}: 不寫任何檔`)
            }
        })

        it('rsi: 對照 —— 合格之組合通過此檢查(空之專案根無 settings.json ⇒ 其後於讀設定時離開碼 1, 不是 2; 原靜默之寫法若被忽略亦同, 故以上案之離開碼 2 為證)', () => {
            for (let args of [
                ['--mode', 'status'],
                ['--mode', 'dry', '--nodes', '2'],
                ['--mode', 'round', '--nodes', '2', '--rounds', '1', '--force'],
                ['--mode', 'validate', '--force'],
                ['--mode', 'reverify', '--why', 'x', '--keep-flags'],
                ['--mode', 'extfill', '--ext', 'a', '--force', '--null', '3'],
                ['--mode', 'fill', '--dry', '--par', '2', '--no-member'],
                ['--mode', 'frontier', '--rearm', 'A', '--to', 'B', '--why', 'x', '--base', 'abcdef01'],
                ['--mode', 'annotate', '--round', '1', '--file', 'x.txt'],
            ]) {
                let r = runIn('rsi', args)
                assert.notStrictEqual(r.status, 2, `${args.join(' ')}: ${r.out.join(' | ').slice(0, 200)}`)
                assert(!r.out.some((l) => l.startsWith('invalid ')), `${args.join(' ')}: ${r.out.join(' | ').slice(0, 200)}`)
            }
        })
    })

    describe('g_backtest.mjs --seed: 給了而不是整數 ⇒ 拒收(排程第 595 項之接續; R-EV-44 ④之二)', () => {
        let emptyRoot = path.join(t.dir, 'btEmpty')
        fs.mkdirSync(emptyRoot, { recursive: true })
        let runBt = (args) => {
            let e = { ...process.env, ARSI_ROOT: emptyRoot, ARSI_HARNESS: '1' }
            delete e.ARSI_AGENT_ROLE
            let r = spawnSync(NODE, [path.join(FD_ROOT, 'src', 'cli', 'backtest.mjs'), ...args], { cwd: emptyRoot, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), err: `${r.stderr}` }
        }

        it('小數、非數字、超出安全整數 ⇒ invalid --seed: must be an integer、離開碼 2、不寫任何檔(於讀設定之前; 空之專案根無 settings.json 者離開碼為 2 而非 1 即證)', () => {
            for (let v of ['1.5', 'abc', '9007199254740993', '1e3', '0x10', 'NaN']) {
                let r = runBt(['--pick', 'p.mjs', '--name', 'n', '--seed', v])
                assert.strictEqual(r.status, 2, `--seed ${v}: ${r.out.join(' | ').slice(0, 200)} ${r.err.slice(0, 200)}`)
                assert.deepEqual(r.out, ['invalid --seed: must be an integer'], `--seed ${v}`)
                assert(!r.out.join('\n').includes(v) || v.length <= 1, `--seed ${v}: 不回顯`)
                assert.deepEqual(fs.readdirSync(emptyRoot), [], '不寫任何檔')
            }
        })

        it('整數(含負數、帶小數點但值為整數者 1.0、安全整數之上限)通過此檢查(其後於讀設定時離開碼 1); 無值仍由通用檢查拒收(離開碼 2)', () => {
            for (let v of ['7', '0', '-5', '1.0', '9007199254740991']) {
                let r = runBt(['--pick', 'p.mjs', '--name', 'n', '--seed', v])
                assert.notStrictEqual(r.status, 2, `--seed ${v}: ${r.out.join(' | ').slice(0, 200)}`)
                assert(!r.out.some((l) => l.includes('invalid --seed')), `--seed ${v}`)
            }
            let r = runBt(['--pick', 'p.mjs', '--name', 'n', '--seed'])
            assert.strictEqual(r.status, 2)
            assert.deepEqual(r.out, [cliMsgOf('backtest', ['--pick', 'p.mjs', '--name', 'n', '--seed'])])
        })

        it('原始碼: 檔首之檢查在讀設定之前; 其後之取值不再有「忽略並沿用設定」之分支', () => {
            let src = fs.readFileSync(path.join(FD_ROOT, 'src', 'cli', 'backtest.mjs'), 'utf8')
            let i = src.indexOf('invalid --seed: must be an integer')
            let j = src.search(/=\s*getSettings\(\)/)
            assert(i > 0 && j > i, '檢查在讀設定之前')
            assert(!src.includes('已忽略(沿用設定之亂數種子)'), '無忽略之分支')
        })
    })
})
