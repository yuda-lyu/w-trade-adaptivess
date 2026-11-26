import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { acquireRunLock } from '../src/arsi/runner.mjs'
import { roundLockPathOf, takeRoundLockOrExit } from '../src/arsi/roundLock.mjs'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'
import { makeSynthProject, runEntry, holdEntry } from './tools/synthProject.mjs'


//寫入型入口取輪次鎖(規則 R-RUN-15; 排程第 622 項 ②): 寫狀態根之入口一律取同一把鎖 <狀態根>/logs/round.lock, 與輪次、重算、前緣操作不得並行
//  規格之句 ⇒ 案:
//    ① 「取得後持有至結束;取鎖在首次寫入狀態根之前」= 十一個入口(g_rsi.mjs 之 init / board / validate / annotate / dirtype,tools 之 armDecide〔通過與不採〕/ armInactive / exposure / formSet / pickStore / searchMap)
//        各一案: 入口於結束時、釋放鎖之前暫停(預載 test/tools/holdAtExit.mjs; 以事件同步)⇒ 其時鎖檔記入口自己之 pid;首次寫狀態根之檔之那一刻鎖檔已記其 pid
//    ② 「另一個寫入型入口於其持有時不得執行」= 持有期間再起同一入口 ⇒ 離開碼 3、印既有慣例之訊息(g_rsi.mjs 之模式印「未執行: 有輪次或另一次重算執行中(pid …」於標準輸出、工具印「輪次進行中(pid …」於標準錯誤)、不寫任何檔; 持有者結束後鎖檔不殘留
//    ③ 「引數之錯不因鎖而改變」= 他人持有鎖時 annotate / dirtype 之用法錯誤照印用法(離開碼 0)、工具之用法錯誤照離開碼 2; 唯讀者(status、dry、工具之列出)照常
//    ④ 「殘留之鎖(行程已不在)⇒ 接手」= 與輪次相同之接手; 結束後鎖檔不殘留
//    ⑤ 「單一實作」= 十一個入口皆經 takeRoundLockOrExit(原始碼逐檔核對; 不再有 peekRunLock 之工具)
//    ⑥ 「永久例外不得取鎖」= tools/roundDigest.mjs(--out; 輪次行程持鎖時以 spawnSync 呼叫)與 g_toolbox.mjs 所載之 src/cli/toolbox.mjs(做夢 agent 於輪中執行)不取鎖; 且 pickStore / searchMap 不被輪次行程或 agent 以子行程呼叫
//        (原始碼:除其自身與 agent 拒跑之表〔agentEntries.mjs〕外,src 內無任何程式碼引用二者之檔名; 輪次內為行程內呼叫 buildPickStore / writeSearchMap; agent 之拒跑見 unit-agentGuard)
//  修前(tadm9 之工作樹): 五個模式不取鎖; 四個工具只 peekRunLock(看一眼即放手) ⇒ 其結束時鎖檔不存在、再起同一入口亦不被擋
//  修前(1.0.56 之工作樹; 排程第 655 項 ①): tools/pickStore.mjs、tools/searchMap.mjs 不取鎖(輪次進行中呼叫與輪末之同批檔寫入有競爭)
let ENTRIES = [
    { name: '--mode init(全新狀態根;rsi.init() 本身即寫)', rel: ['src', 'cli', 'rsi.mjs'], args: () => ['--mode', 'init'], fresh: true, code: 0, writes: true, msg: 'rsi' },
    { name: '--mode board', rel: ['src', 'cli', 'rsi.mjs'], args: () => ['--mode', 'board'], code: 0, writes: true, msg: 'rsi' },
    { name: '--mode validate', rel: ['src', 'cli', 'rsi.mjs'], args: () => ['--mode', 'validate'], code: 0, writes: false, msg: 'rsi' },
    { name: '--mode annotate', rel: ['src', 'cli', 'rsi.mjs'], args: (d) => ['--mode', 'annotate', '--round', '1', '--file', path.join(d, 'note.txt')], code: 0, writes: false, msg: 'rsi' },
    { name: '--mode dirtype', rel: ['src', 'cli', 'rsi.mjs'], args: (d) => ['--mode', 'dirtype', '--round', '1', '--file', path.join(d, 'types.json')], code: 0, writes: false, msg: 'rsi' },
    { name: 'tools/armInactive.mjs', rel: ['src', 'tools', 'armInactive.mjs'], args: () => ['--node', 'zzzzzz', '--arms', 'none', '--why', '測試'], code: 2, writes: false, msg: 'tool' },
    { name: 'tools/exposure.mjs', rel: ['src', 'tools', 'exposure.mjs'], args: () => ['--node', 'zzzzzz', '--why', '測試'], code: 2, writes: false, msg: 'tool' },
    { name: 'tools/formSet.mjs', rel: ['src', 'tools', 'formSet.mjs'], args: () => ['--node', 'zzzzzz', '--form', 'none', '--why', '測試'], code: 2, writes: false, msg: 'tool' },
    //armDecide: 持有者審定 P001(寫入後於結束時暫停); 持有期間之第二次呼叫審定另一筆待審之 P002(同一筆已被審定者於取鎖之前即以離開碼 2 拒絕, 不是鎖之效果)
    { name: 'tools/armDecide.mjs(通過)', rel: ['src', 'tools', 'armDecide.mjs'], args: () => ['--id', 'P001', '--accept', '--why', '測試'], args2: () => ['--id', 'P002', '--accept', '--why', '測試'], seed: true, code: 0, writes: true, msg: 'tool' },
    { name: 'tools/armDecide.mjs(不採)', rel: ['src', 'tools', 'armDecide.mjs'], args: () => ['--id', 'P001', '--reject', '--why', '測試'], args2: () => ['--id', 'P002', '--reject', '--why', '測試'], seed: true, code: 0, writes: true, msg: 'tool' },
    //排程第 655 項 ①: 共同儲存區(<狀態根>/picks/)與搜尋地圖(<狀態根>/SEARCH_MAP.md)之重產; 無引數 / --quiet, 執行成功(離開碼 0)
    { name: 'tools/pickStore.mjs', rel: ['src', 'tools', 'pickStore.mjs'], args: () => [], code: 0, writes: true, msg: 'tool' },
    { name: 'tools/searchMap.mjs', rel: ['src', 'tools', 'searchMap.mjs'], args: () => ['--quiet'], code: 0, writes: true, msg: 'tool' },
    //全新狀態根: rsi.init()(建狀態根、當前策略檔)本身即寫入 ⇒ 取鎖須先於它(同 --mode init)
    { name: 'tools/searchMap.mjs(全新狀態根;rsi.init() 本身即寫)', rel: ['src', 'tools', 'searchMap.mjs'], args: () => ['--quiet'], fresh: true, code: 0, writes: true, msg: 'tool' },
]

describe('寫入型入口取輪次鎖(R-RUN-15;排程第 622 項 ②)', function () {
    this.timeout(300000)
    let t
    let n = 0
    before(() => {
        t = makeTmp('roundLock')
    })
    after(() => {
        t.cleanup()
    })
    //建專案並備好各入口所需之檔(note.txt、types.json; armDecide 之待審提案)
    let mk = (e) => {
        let p = makeSynthProject(t.dir, `p${n++}`, { init: e.fresh !== true })
        fs.writeFileSync(path.join(p.root, 'note.txt'), '註記', 'utf8')
        fs.writeFileSync(path.join(p.root, 'types.json'), JSON.stringify([{ index: 0, type: 'explore', claim: null }]), 'utf8')
        if (e.seed) {
            let r = p.P.rsi.governance.propose({ round: 1, from: '測試', items: [{ kind: 'layer', title: '測試層一', mechanism: '驗一' }, { kind: 'layer', title: '測試層二', mechanism: '驗二' }] })
            assert.deepEqual(r.added.map((x) => x.id), ['P001', 'P002'], '前提: 待審提案 P001、P002')
        }
        let d = p.root
        let args = e.args(d)
        return { ...p, args, args2: e.args2 ? e.args2(d) : args, lockFp: roundLockPathOf(path.join(p.root, 'rsi')) }
    }
    let busyOk = (e, r, pid) => {
        let text = e.msg === 'rsi' ? r.out.join('\n') : r.err
        let re = e.msg === 'rsi' ? /未執行: 有輪次或另一次重算執行中\(pid (\d+);自 \S+\);等它結束再\S+/ : /輪次進行中\(pid (\d+)\): /
        let m = re.exec(text)
        assert.ok(m, `被擋之訊息(${e.msg}): ${text.slice(0, 300)}`)
        assert.equal(Number(m[1]), pid, '訊息所列之 pid 為持有者')
    }

    for (let e of ENTRIES) {
        it(`${e.name}: 持有至結束、首次寫入前已取得;持有期間再起同一入口 ⇒ 離開碼 3、不寫檔;持有者結束後鎖檔不殘留、可再執行`, async () => {
            let { root, args, args2, lockFp } = mk(e)
            let h = holdEntry(root, e.rel, args, `e${n}`)
            let r1 = null
            try {
                let sig = await h.waitSignal()
                assert.ok(sig !== null, '前提: 入口跑到結束(有信號)')
                //① 持有至結束(結束之時點、尚未釋放): 鎖檔記入口自己之 pid
                assert.ok(sig.lockAtExit !== null && sig.lockAtExit.pid === sig.pid, `結束時鎖檔應記入口之 pid ${sig.pid}: ${JSON.stringify(sig.lockAtExit)}`)
                //首次寫狀態根之檔之那一刻: 鎖已取得
                if (e.writes) {
                    assert.ok(sig.firstWrite !== null, '前提: 此入口於此情境確有寫入(否則本案無鑑別力)')
                }
                if (sig.firstWrite !== null) {
                    assert.ok(sig.firstWrite.lock !== null && sig.firstWrite.lock.pid === sig.pid, `首次寫入(${sig.firstWrite.op} ${sig.firstWrite.rel})時鎖應已取得: ${JSON.stringify(sig.firstWrite.lock)}`)
                }
                //② 持有期間再起同一入口(同步等其結束)⇒ 被擋
                let before = fs.readdirSync(path.join(root, 'rsi', 'logs')).sort()
                let r2 = runEntry(root, e.rel, args2)
                assert.equal(r2.status, 3, `持有期間再起同一入口: ${r2.out.join('|').slice(0, 200)} ${r2.err.slice(0, 200)}`)
                busyOk(e, r2, sig.pid)
                assert.deepEqual(fs.readdirSync(path.join(root, 'rsi', 'logs')).sort(), before, '被擋者不留檔(日誌夾之內容不變)')
            }
            finally {
                //無論成敗皆放行並等持有者結束(其工作目錄在暫存夾內, 不結束則暫存夾無法刪)
                h.release()
                r1 = await h.done
            }
            assert.equal(r1.status, e.code, `持有者之離開碼: ${r1.out.join('|').slice(0, 200)} ${r1.err.slice(0, 200)}`)
            assert.equal(fs.existsSync(lockFp), false, '持有者結束後鎖檔不殘留')
            //釋放後可再執行(鎖不卡住)
            if (!e.seed) {
                let r3 = runEntry(root, e.rel, args2)
                assert.equal(r3.status, e.code, `釋放後再執行: ${r3.out.join('|').slice(0, 200)} ${r3.err.slice(0, 200)}`)
                assert.equal(fs.existsSync(lockFp), false)
            }
        })
    }

    it('引數之錯不因鎖而改變、唯讀者不取鎖: 他人持有鎖時 annotate / dirtype 之用法錯誤照印用法(離開碼 0)、五個工具之用法錯誤照離開碼 2、status / dry / 工具之列出照常(離開碼 0)', () => {
        let { root, lockFp } = mk({ args: () => [] })
        let lk = acquireRunLock(lockFp)
        assert.equal(lk.ok, true)
        try {
            let cases = [
                [['src', 'cli', 'rsi.mjs'], ['--mode', 'annotate', '--round', '1'], 0, /^未註記\(用法: --mode annotate/],
                [['src', 'cli', 'rsi.mjs'], ['--mode', 'annotate', '--round', '1', '--file', path.join(root, 'none.txt')], 0, /^未註記\(用法: --mode annotate/],
                [['src', 'cli', 'rsi.mjs'], ['--mode', 'dirtype', '--round', '1'], 0, /^未補記\(用法: --mode dirtype/],
                [['src', 'tools', 'armInactive.mjs'], ['--node', 'abcdef'], 2, null],
                [['src', 'tools', 'exposure.mjs'], ['--node', 'abcdef'], 2, null],
                [['src', 'tools', 'formSet.mjs'], ['--node', 'abcdef', '--form', 'clue'], 2, null],
                //排程第 655 項 ①: 二者之引數檢查(cliGuard)先於取鎖 ⇒ 他人持有鎖時引數之錯照離開碼 2
                [['src', 'tools', 'pickStore.mjs'], ['--quiet'], 2, null],
                [['src', 'tools', 'searchMap.mjs'], ['--bad'], 2, null],
                [['src', 'cli', 'rsi.mjs'], ['--mode', 'status'], 0, null],
                [['src', 'cli', 'rsi.mjs'], ['--mode', 'dry'], 0, null],
                [['src', 'tools', 'armInactive.mjs'], [], 0, /^樹上有未作用之臂之節點 0 個/],
                [['src', 'tools', 'formSet.mjs'], [], 0, /^樹上已執行之節點 0 個/],
                [['src', 'tools', 'armDecide.mjs'], [], 0, /^待審 0 筆/],
            ]
            for (let [rel, args, code, re] of cases) {
                let r = runEntry(root, rel, args)
                assert.equal(r.status, code, `${rel.slice(-1)} ${args.join(' ')}: ${r.out.join('|').slice(0, 200)} ${r.err.slice(0, 200)}`)
                if (re) {
                    assert.ok(r.out.some((l) => re.test(l)), `${rel.slice(-1)} ${args.join(' ')}: ${r.out.join('|').slice(0, 300)}`)
                }
            }
        }
        finally {
            lk.release()
        }
    })

    it('殘留之鎖(行程已不在)⇒ 與輪次相同之接手: 工具與模式皆執行、結束後鎖檔不殘留', async () => {
        let { root, lockFp } = mk({ args: () => [] })
        //已結束之行程之 pid
        let dead = await new Promise((resolve) => {
            let c = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' })
            c.on('exit', () => resolve(c.pid))
        })
        for (let [rel, args, code] of [
            [['src', 'tools', 'formSet.mjs'], ['--node', 'zzzzzz', '--form', 'none', '--why', '測試'], 2],
            [['src', 'tools', 'exposure.mjs'], ['--node', 'zzzzzz', '--why', '測試'], 2],
            [['src', 'tools', 'armInactive.mjs'], ['--node', 'zzzzzz', '--arms', 'none', '--why', '測試'], 2],
            [['src', 'tools', 'pickStore.mjs'], [], 0],
            [['src', 'tools', 'searchMap.mjs'], ['--quiet'], 0],
            [['src', 'cli', 'rsi.mjs'], ['--mode', 'board'], 0],
        ]) {
            fs.mkdirSync(path.dirname(lockFp), { recursive: true })
            fs.writeFileSync(lockFp, JSON.stringify({ pid: dead, startedAt: '2026-01-01T00:00:00.000Z', beatAt: '2026-01-01T00:00:00.000Z' }), 'utf8')
            let r = runEntry(root, rel, args)
            assert.equal(r.status, code, `${rel.slice(-1)}: ${r.out.join('|').slice(0, 200)} ${r.err.slice(0, 200)}`)
            assert.equal(fs.existsSync(lockFp), false, `${rel.slice(-1)}: 殘留之鎖被接手後釋放(原: 工具只看一眼、殘留之鎖檔原樣留下)`)
        }
    })

    it('takeRoundLockOrExit / roundLockPathOf: 路徑為 <狀態根>/logs/round.lock(輪次、重算、前緣操作、工具共用之同一個檔); 取不到 ⇒ 呼叫 onBusy(lock) 後以離開碼 3 結束', async () => {
        assert.equal(roundLockPathOf(path.join('a', 'rsi')), path.join('a', 'rsi', 'logs', 'round.lock'))
        let root = path.join(t.dir, 'direct')
        let lockFp = roundLockPathOf(root)
        let lk = acquireRunLock(lockFp)
        assert.equal(lk.ok, true)
        //取不到: 於子行程呼叫(process.exit 不得波及本測試行程)
        let src = `import { takeRoundLockOrExit } from ${JSON.stringify(new URL('../src/arsi/roundLock.mjs', import.meta.url).href)}\ntakeRoundLockOrExit(${JSON.stringify(root)}, (lk) => console.log('BUSY ' + lk.why + ' ' + lk.pid))\nconsole.log('NOT-REACHED')\n`
        let fp = path.join(t.dir, 'direct.mjs')
        fs.writeFileSync(fp, src, 'utf8')
        let r = await new Promise((resolve) => {
            let c = spawn(process.execPath, [fp], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
            let out = ''
            c.stdout.on('data', (d) => {
                out += d
            })
            c.on('exit', (status) => resolve({ status, out }))
        })
        lk.release()
        assert.equal(r.status, 3)
        assert.equal(r.out.trim(), `BUSY running ${process.pid}`)
        assert.equal(typeof takeRoundLockOrExit, 'function')
    })

    it('單一實作(原始碼): 十一個入口皆經 takeRoundLockOrExit、取鎖之位置先於寫入(g_rsi.mjs 各區塊於引數檢查之後、首個寫入之前);工具不再 peekRunLock', () => {
        let read = (...p) => fs.readFileSync(path.join(FD_ROOT, ...p), 'utf8')
        for (let f of ['armDecide', 'armInactive', 'exposure', 'formSet', 'pickStore', 'searchMap']) {
            //註解內提到 peekRunLock(說明「原」之行為)不計: 只看程式碼
            let s = read('src', 'tools', `${f}.mjs`)
            assert.ok(/import \{ takeRoundLockOrExit \} from '\.\.\/arsi\/roundLock\.mjs'/.test(s), `${f}: 匯入`)
            assert.equal((s.match(/takeRoundLockOrExit\(/g) || []).length, 1, `${f}: 取鎖一處`)
            assert.ok(!/peekRunLock/.test(s.replace(/\/\/.*$/gm, '')), `${f}: 不再只 peekRunLock`)
        }
        //鎖檔之路徑只有一處定義: src 內「'round.lock'」之字面值只在 roundLock.mjs(其餘入口 —— 輪次、reverify、extfill、fill、frontier 與十一個入口 ——皆經 roundLockPathOf / takeRoundLockOrExit)
        let walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
        let lits = walk(path.join(FD_ROOT, 'src')).filter((fp) => fp.endsWith('.mjs') && /'round\.lock'/.test(fs.readFileSync(fp, 'utf8').replace(/^\s*\/\/.*$/gm, ''))).map((fp) => path.basename(fp))
        assert.deepEqual(lits, ['roundLock.mjs'], '鎖檔路徑之字面值只在 roundLock.mjs')
        let rsi = read('src', 'cli', 'rsi.mjs')
        assert.equal((rsi.match(/roundLockPathOf\(st\.rsi\.root\)/g) || []).length, 5, 'rsi.mjs 既有之 5 處取鎖(輪次、reverify、extfill、fill、frontier)皆經 roundLockPathOf')
        assert.ok(/let lockOrExit = \(doing\) => takeRoundLockOrExit\(st\.rsi\.root,/.test(rsi), 'rsi.mjs: 單一之取鎖函數')
        let at = (re) => {
            let m = re.exec(rsi)
            assert.ok(m, String(re))
            return m.index
        }
        assert.ok(at(/lockOrExit\('建立'\)/) < at(/\n\s*rsi\.init\(\)/), 'init: 取鎖先於 rsi.init()')
        assert.ok(at(/lockOrExit\('重產看板'\)/) < at(/JSON\.stringify\(P\.writeBoard\(\)\)/), 'board: 取鎖先於 writeBoard')
        assert.ok(at(/lockOrExit\('補算旗標'\)/) < at(/let nMig = P\.migrateDocs\(\)\r?\n\s*if \(nMig\)/), 'validate: 取鎖先於 migrateDocs')
        assert.ok(at(/lockOrExit\('註記'\)/) < at(/P\.annotateDream\(rd,/), 'annotate: 取鎖先於寫入')
        assert.ok(at(/lockOrExit\('補記'\)/) < at(/P\.setDirectionTypes\(rd, items\)/), 'dirtype: 取鎖先於寫入')
        //pickStore / searchMap(排程第 655 項 ①): 取鎖先於寫入 —— pickStore 先於 buildPickStore; searchMap 先於 rsi.init()(建狀態根)與 writeSearchMap; 二者之引數檢查(cliGuard)與 agent 拒跑(guardEntry)先於取鎖
        let code = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')
        let ps = code(read('src', 'tools', 'pickStore.mjs'))
        let sm = code(read('src', 'tools', 'searchMap.mjs'))
        let idx = (s, re, who) => {
            let m = re.exec(s)
            assert.ok(m, `${who}: ${re}`)
            return m.index
        }
        assert.ok(idx(ps, /guardEntry\('pickStore'\)/, 'pickStore') < idx(ps, /cliGuard\('pickStore'\)/, 'pickStore') && idx(ps, /cliGuard\('pickStore'\)/, 'pickStore') < idx(ps, /takeRoundLockOrExit\(/, 'pickStore'), 'pickStore: guardEntry、cliGuard 先於取鎖')
        assert.ok(idx(ps, /takeRoundLockOrExit\(/, 'pickStore') < idx(ps, /buildPickStore\(st\)/, 'pickStore'), 'pickStore: 取鎖先於 buildPickStore')
        assert.ok(idx(sm, /guardEntry\('searchMap'\)/, 'searchMap') < idx(sm, /cliGuard\('searchMap'\)/, 'searchMap') && idx(sm, /cliGuard\('searchMap'\)/, 'searchMap') < idx(sm, /takeRoundLockOrExit\(/, 'searchMap'), 'searchMap: guardEntry、cliGuard 先於取鎖')
        assert.ok(idx(sm, /takeRoundLockOrExit\(/, 'searchMap') < idx(sm, /P\.rsi\.init\(\)/, 'searchMap') && idx(sm, /P\.rsi\.init\(\)/, 'searchMap') < idx(sm, /P\.writeSearchMap\(\)/, 'searchMap'), 'searchMap: 取鎖先於 rsi.init() 與 writeSearchMap')
    })

    it('永久例外不得取鎖、pickStore / searchMap 不被輪次行程或 agent 以子行程呼叫(原始碼; 排程第 655 項 ①): roundDigest.mjs 與 toolbox.mjs 不取鎖; src 內除其自身與 agent 拒跑之表外無程式碼引用二者之檔名', () => {
        let code = (fp) => fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')
        let walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
        //永久例外(R-RUN-15): 輪次行程持鎖時以 spawnSync 呼叫 roundDigest.mjs --out; 做夢 agent 於輪中執行 g_toolbox.mjs(載入 src/cli/toolbox.mjs)—— 二者取鎖會擋住輪次自己或做夢 agent
        for (let rel of [['src', 'tools', 'roundDigest.mjs'], ['src', 'cli', 'toolbox.mjs']]) {
            let s = code(path.join(FD_ROOT, ...rel))
            assert.ok(!/takeRoundLockOrExit|acquireRunLock|roundLockPathOf|round\.lock/.test(s), `${rel.join('/')} 不得取輪次鎖(永久例外)`)
        }
        //輪次行程以 spawnSync 呼叫之腳本只有 roundDigest.mjs(g_rsi.mjs 之 FP_DIGEST); 引用 pickStore.mjs / searchMap.mjs 之檔名者只有二者自身之檔(說明文字)與 agentEntries.mjs 之拒跑表(標籤字串)
        let refs = walk(path.join(FD_ROOT, 'src')).filter((fp) => fp.endsWith('.mjs') && /tools\/(?:pickStore|searchMap)\.mjs|['"](?:pickStore|searchMap)\.mjs['"]/.test(code(fp))).map((fp) => path.relative(FD_ROOT, fp).replace(/\\/g, '/'))
        assert.deepEqual(refs, ['src/domain/agentEntries.mjs'], '以檔名引用二者之程式碼(不含註解)只有 agent 拒跑之表')
        let ent = code(path.join(FD_ROOT, 'src', 'domain', 'agentEntries.mjs'))
        assert.ok(/pickStore: \{ label: 'tools\/pickStore\.mjs', writes: always \}/.test(ent) && /searchMap: \{ label: 'tools\/searchMap\.mjs', writes: always \}/.test(ent), 'agent 一律拒跑(writes: always)')
        let rsiSrc = code(path.join(FD_ROOT, 'src', 'cli', 'rsi.mjs'))
        //g_rsi.mjs 內每一個 spawn / spawnSync / exec* / fork 之呼叫,其第一個陣列引數皆為 FP_DIGEST(不論寫法; 多一個起其他腳本之呼叫即紅)
        let calls = [...rsiSrc.matchAll(/(?<![.\w])(?:spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\((.*)$/gm)].map((m) => m[1])
        assert.equal(calls.length, 2, 'g_rsi.mjs 起子行程之呼叫只有 2 處(補做夢與輪末各一次之 roundDigest)')
        assert.deepEqual(calls.filter((c) => !/^process\.execPath, \[FP_DIGEST, /.test(c)), [], 'g_rsi.mjs 以子行程起之腳本只有 FP_DIGEST(roundDigest.mjs)')
        assert.ok(/let FP_DIGEST = fileURLToPath\(new URL\('\.\.\/tools\/roundDigest\.mjs', import\.meta\.url\)\)/.test(rsiSrc))
    })
})
